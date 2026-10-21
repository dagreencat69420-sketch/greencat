import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  airdropPoolWithdrawable,
  airdropPostDeadline,
  airdropReclaimOpensAt,
  airdropUnclaimed,
  buildAirdropPoolDepositIxs,
  buildAirdropPoolWithdrawIxs,
  deriveAirdropDistributionPda,
  deriveConfigPda,
  deriveTreasuryPda,
  deriveTreasuryVaultAta,
  GREENCAT_PROGRAM_ID,
  IX_DISCRIMINATORS,
  parseGcAmount,
  PoolId,
} from "../src";

const pid = new PublicKey(GREENCAT_PROGRAM_ID);
const mint = Keypair.generate().publicKey;
const admin = Keypair.generate().publicKey;

describe("airdrop pool admin helpers", () => {
  it("withdrawable never dips into the reserved floor", () => {
    expect(airdropPoolWithdrawable(1_000n, 0n)).toBe(1_000n);
    expect(airdropPoolWithdrawable(1_000n, 400n)).toBe(600n);
    expect(airdropPoolWithdrawable(1_000n, 1_000n)).toBe(0n);
    expect(airdropPoolWithdrawable(500n, 1_000n)).toBe(0n);
    // bundling a reclaim releases that round's unclaimed part, capped at the vault balance
    expect(airdropPoolWithdrawable(1_000n, 1_000n, 300n)).toBe(300n);
    expect(airdropPoolWithdrawable(1_000n, 400n, 900n)).toBe(1_000n);
  });

  it("unclaimed is 0 once reclaimed", () => {
    expect(airdropUnclaimed({ totalAmount: 100n, claimedAmount: 30n, reclaimed: false })).toBe(70n);
    expect(airdropUnclaimed({ totalAmount: 100n, claimedAmount: 30n, reclaimed: true })).toBe(0n);
  });

  it("parses UI amounts strictly", () => {
    expect(parseGcAmount("1", 6)).toBe(1_000_000n);
    expect(parseGcAmount("1,000.5", 6)).toBe(1_000_500_000n);
    expect(parseGcAmount(".25", 6)).toBe(250_000n);
    expect(parseGcAmount("0.000001", 6)).toBe(1n);
    for (const bad of ["", "0", "0.0", "-1", "1e6", "abc", "1.0000001", "1.", "99999999999999999999"]) expect(parseGcAmount(bad, 6)).toBeNull();
  });

  it("deposit = deposit_treasury(pool 5) from the signer's own ATA", () => {
    const [ix] = buildAirdropPoolDepositIxs({ depositor: admin, gcMint: mint, amountRaw: 42n, tokenProgramId: TOKEN_PROGRAM_ID });
    expect(ix.programId.equals(pid)).toBe(true);
    expect(ix.data.subarray(0, 8).equals(IX_DISCRIMINATORS.deposit_treasury)).toBe(true);
    expect(ix.data[8]).toBe(PoolId.Airdrop);
    expect(ix.data.readBigUInt64LE(9)).toBe(42n);
    const [treasury] = deriveTreasuryPda(PoolId.Airdrop, pid);
    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toEqual([
      admin.toBase58(),
      deriveConfigPda(pid)[0].toBase58(),
      mint.toBase58(),
      treasury.toBase58(),
      deriveTreasuryVaultAta(mint, treasury, TOKEN_PROGRAM_ID).toBase58(),
      getAssociatedTokenAddressSync(mint, admin, false, TOKEN_PROGRAM_ID).toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ]);
    expect(ix.keys[0].isSigner).toBe(true);
  });

  it("withdraw = [ATA idempotent] [reclaim] withdraw_treasury(pool 5) to the authority's own ATA", () => {
    const ata = getAssociatedTokenAddressSync(mint, admin, false, TOKEN_PROGRAM_ID);
    const plain = buildAirdropPoolWithdrawIxs({ authority: admin, gcMint: mint, amountRaw: 7n, tokenProgramId: TOKEN_PROGRAM_ID });
    expect(plain).toHaveLength(2);
    expect(plain[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(plain[0].data[0]).toBe(1); // CreateIdempotent
    const w = plain[1];
    expect(w.data.subarray(0, 8).equals(IX_DISCRIMINATORS.withdraw_treasury)).toBe(true);
    expect(w.data[8]).toBe(PoolId.Airdrop);
    expect(w.data.readBigUInt64LE(9)).toBe(7n);
    expect(w.keys[0].pubkey.equals(admin) && w.keys[0].isSigner).toBe(true);
    expect(w.keys[5].pubkey.equals(ata)).toBe(true);

    const withReclaim = buildAirdropPoolWithdrawIxs({ authority: admin, gcMint: mint, amountRaw: 7n, reclaimDistributionId: 3n, tokenProgramId: TOKEN_PROGRAM_ID });
    expect(withReclaim).toHaveLength(3);
    expect(withReclaim[1].data.equals(IX_DISCRIMINATORS.reclaim_airdrop)).toBe(true);
    expect(withReclaim[1].keys[2].pubkey.equals(deriveAirdropDistributionPda(3n, pid)[0])).toBe(true);
    expect(withReclaim[2].data.subarray(0, 8).equals(IX_DISCRIMINATORS.withdraw_treasury)).toBe(true);
  });
});

describe("airdrop window helpers (match airdrop.rs production constants)", () => {
  const rs = fs.readFileSync(path.resolve(__dirname, "../../../programs/greencat/src/airdrop.rs"), "utf8");
  const prod = (name: string) => {
    const m = rs.match(new RegExp(`#\\[cfg\\(not\\(feature = "localnet-short-windows"\\)\\)\\]\\s*pub const ${name}: i64 = ([\\d_ *]+);`));
    if (!m) throw new Error(`${name} not found`);
    return m[1].split("*").map((x) => Number(x.trim().replace(/_/g, ""))).reduce((a, b) => a * b, 1);
  };
  it("post deadline = expiry - 7 days", () => {
    expect(prod("MIN_AIRDROP_WINDOW_SECS")).toBe(7 * 86_400);
    expect(airdropPostDeadline(1_000_000)).toBe(1_000_000 - prod("MIN_AIRDROP_WINDOW_SECS"));
  });
  it("reclaim opens at max(expiry, last pause change + 3 days); never while paused", () => {
    const g = prod("RECLAIM_GRACE_AFTER_UNPAUSE_SECS");
    expect(g).toBe(3 * 86_400);
    expect(airdropReclaimOpensAt(1_000_000, 0, false)).toBe(1_000_000);
    expect(airdropReclaimOpensAt(1_000_000, 999_000, false)).toBe(999_000 + g);
    expect(airdropReclaimOpensAt(1_000_000, 0, true)).toBeNull();
  });
});
