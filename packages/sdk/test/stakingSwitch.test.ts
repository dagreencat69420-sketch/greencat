import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildSetStakingEnabledIx,
  CONFIG_ACCOUNT_LEN,
  CONFIG_STAKING_ENABLED_OFFSET,
  CONFIG_STAKING_FLAG_SET_OFFSET,
  decodeConfigAccount,
  deriveConfigPda,
  findProgramError,
  GREENCAT_PROGRAM_ID,
  IX_DISCRIMINATORS,
  isStakingEnabled,
} from "../src";

const pid = new PublicKey(GREENCAT_PROGRAM_ID);
const admin = Keypair.generate().publicKey;
/** Devnet Config bytes captured 2026-10-03 PT, right before the staking-switch upgrade. */
const devnetPre = Buffer.from(fs.readFileSync(path.join(__dirname, "fixtures/devnet-config-pre-staking-switch.b64"), "utf8").trim(), "base64");

describe("staking switch (Config.staking_enabled)", () => {
  it("layout matches lib.rs (two bools right after wheel_house_edge_bps, 28 reserved bytes left)", () => {
    const rs = fs.readFileSync(path.resolve(__dirname, "../../../programs/greencat/src/lib.rs"), "utf8");
    expect(rs).toMatch(/pub wheel_house_edge_bps: u16,[\s\S]*?pub staking_enabled: bool,[\s\S]*?pub staking_flag_set: bool,[\s\S]*?pub _reserved: \[u8; 28\],/);
    expect(CONFIG_ACCOUNT_LEN).toBe(312);
    expect(CONFIG_STAKING_ENABLED_OFFSET).toBe(8 + 96 + 7 + 1 + 13 * 8 + 32 + 4 * 8 + 2);
    expect(CONFIG_STAKING_FLAG_SET_OFFSET).toBe(CONFIG_STAKING_ENABLED_OFFSET + 1);
  });

  it("the pre-upgrade Devnet Config reads as OPEN (migration default) and keeps every other field", () => {
    expect(devnetPre.length).toBe(312);
    const c = decodeConfigAccount(devnetPre)!;
    expect(c.authority).toBe("13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfyj6");
    expect(c.wheelHouseEdgeBps).toBe(300);
    expect(c.stakingFlagSet).toBe(false);
    expect(c.stakingEnabled).toBe(true);
  });

  it("explicit flag: locked / open", () => {
    const locked = Buffer.from(devnetPre);
    locked[CONFIG_STAKING_ENABLED_OFFSET] = 0;
    locked[CONFIG_STAKING_FLAG_SET_OFFSET] = 1; // what initialize_treasuries writes (new deployments)
    expect(decodeConfigAccount(locked)!.stakingEnabled).toBe(false);
    const open = Buffer.from(locked);
    open[CONFIG_STAKING_ENABLED_OFFSET] = 1;
    expect(decodeConfigAccount(open)!.stakingEnabled).toBe(true);
    expect(isStakingEnabled({ stakingFlagSet: false, stakingEnabledRaw: false })).toBe(true);
    expect(isStakingEnabled({ stakingFlagSet: true, stakingEnabledRaw: false })).toBe(false);
    expect(isStakingEnabled({ stakingFlagSet: true, stakingEnabledRaw: true })).toBe(true);
  });

  it("builds set_staking_enabled (admin signer + writable Config, bool arg)", () => {
    for (const enabled of [true, false]) {
      const ix = buildSetStakingEnabledIx({ authority: admin, enabled });
      expect(ix.programId.equals(pid)).toBe(true);
      expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
        [admin.toBase58(), true, false],
        [deriveConfigPda(pid)[0].toBase58(), false, true],
      ]);
      const disc = createHash("sha256").update("global:set_staking_enabled").digest().subarray(0, 8);
      expect(ix.data.subarray(0, 8).equals(disc)).toBe(true);
      expect(ix.data.subarray(0, 8).equals(IX_DISCRIMINATORS.set_staking_enabled)).toBe(true);
      expect([...ix.data.subarray(8)]).toEqual([enabled ? 1 : 0]);
    }
  });

  it("StakingLocked maps to the lock message", () => {
    expect(findProgramError("Error Code: StakingLocked. Error Number: 6086")?.friendly).toMatch(/Staking opens after the launch airdrop/);
    expect(findProgramError('{"InstructionError":[0,{"Custom":6086}]}')?.name).toBe("StakingLocked");
  });
});
