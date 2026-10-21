/**
 * Staking switch: in-place upgrade rehearsal (mirrors the Devnet upgrade of 2026-10-03 PT), fully offline.
 *
 *  OLD program = the binary deployed on Devnet before the switch (`solana program dump`, OLD_SO) →
 *  init + a separate Config admin (like Devnet: upgrade authority ≠ admin) → daily + 365-day stakes on the
 *  old program → `solana program extend` + `deploy` (SBPF v0; SIMD-0500 deactivated to match Devnet/Mainnet)
 *  → Config bytes unchanged and the legacy Config reads as OPEN (migration default) → new stakes still work
 *  → the upgrade authority can NOT toggle (admin only) → admin locks: stake_daily / add_daily / stake_long
 *  fail with StakingLocked while unstake_daily / claim_daily / claim_long are never StakingLocked
 *  → admin re-opens → staking works again.
 *
 *   OLD_SO=/workspace/tmp/greencat-devnet-pre-staking.so npx tsx test/staking-switch-upgrade-localnet.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent, createMint, mintTo } from "@solana/spl-token";
import {
  PoolId,
  buildAcceptAuthorityIx,
  buildAddDailyIx,
  buildClaimDailyIx,
  buildClaimLongIx,
  buildDepositTreasuryIx,
  buildProposeAuthorityIx,
  buildSetStakingEnabledIx,
  buildStakeDailyIx,
  buildStakeLongIx,
  buildUnstakeDailyIx,
  decodeConfigAccount,
  deriveConfigPda,
} from "@greencat/sdk";
import { PID, SIMD_0500_FEATURE, SO_DEFAULT, airdrop, assert, errText, expectFail, initProgram, sendIxs, sleep, startLocalnet } from "./localnet";

const UI = 1_000_000n;
const TOKEN = TOKEN_PROGRAM_ID;
const OLD_SO = process.env.OLD_SO || "/workspace/tmp/greencat-devnet-pre-staking.so";

async function main() {
  assert(fs.existsSync(OLD_SO), `missing ${OLD_SO} (solana program dump <PID> ${OLD_SO} -ud)`);
  const port = Number(process.env.E2E_RPC_PORT || 19400);
  const ln = await startLocalnet({ so: OLD_SO, port, tag: "staking-upg", deactivateFeatures: [SIMD_0500_FEATURE] });
  const { conn, rpcUrl } = ln;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gc-stk-"));
  try {
    const up = ln.upgradeAuthority;
    const admin = Keypair.generate(); // Config authority (Devnet: the MetaMask wallet), not the upgrade authority
    const alice = Keypair.generate(); // existing daily + 365 staker
    const bob = Keypair.generate(); // new staker
    for (const k of [admin, alice, bob]) await airdrop(conn, k.publicKey, 5);
    const gcMint = await createMint(conn, up, up.publicKey, null, 6, undefined, undefined, TOKEN);
    const ata = async (k: Keypair, ui: bigint) => {
      const a = await createAssociatedTokenAccountIdempotent(conn, up, gcMint, k.publicKey, {}, TOKEN);
      if (ui) await mintTo(conn, up, gcMint, a, up, Number(ui * UI), [], undefined, TOKEN);
      return a;
    };
    const upAta = await ata(up, 1_000_000n);
    const aliceAta = await ata(alice, 20_000n);
    const bobAta = await ata(bob, 20_000n);
    const st = (k: Keypair, a: PublicKey) => ({ staker: k.publicKey, gcMint, stakerAta: a, tokenProgramId: TOKEN });

    // ── OLD program (no switch): init, hand Config to a separate admin, stake ──
    await initProgram(ln, gcMint, TOKEN, { collection: false, staking: "locked" /* old binary has no set_staking_enabled */ });
    await sendIxs(conn, [up], [buildDepositTreasuryIx({ depositor: up.publicKey, depositorAta: upAta, gcMint, poolId: PoolId.LongRewards, amountRaw: 100_000n * UI, tokenProgramId: TOKEN })]);
    await sendIxs(conn, [up], [buildDepositTreasuryIx({ depositor: up.publicKey, depositorAta: upAta, gcMint, poolId: PoolId.DailyRewards, amountRaw: 100_000n * UI, tokenProgramId: TOKEN })]);
    await sendIxs(conn, [up], [buildProposeAuthorityIx({ authority: up.publicKey, newAuthority: admin.publicKey })]);
    await sendIxs(conn, [admin], [buildAcceptAuthorityIx({ newAuthority: admin.publicKey })]);
    await sendIxs(conn, [alice], [buildStakeDailyIx({ ...st(alice, aliceAta), amountRaw: 5_000n * UI })]);
    await sendIxs(conn, [alice], [buildStakeLongIx({ ...st(alice, aliceAta), amountRaw: 1_000n * UI, trancheId: 0 })]);
    const cfgBefore = Buffer.from((await conn.getAccountInfo(deriveConfigPda(PID)[0]))!.data);
    assert(cfgBefore.subarray(282).every((b) => b === 0), "old Config: reserved bytes all zero");
    await expectFail(
      sendIxs(conn, [admin], [buildSetStakingEnabledIx({ authority: admin.publicKey, enabled: false })]),
      /InstructionFallbackNotFound|101|0x65/,
      "old binary has no set_staking_enabled"
    );
    console.log("[staking-upg] old program: admin handed over, alice has a daily + a 365-day stake");

    // ── in-place upgrade (same commands as Devnet) ──
    const key = path.join(tmp, "upgrade-authority.json");
    fs.writeFileSync(key, JSON.stringify(Array.from(up.secretKey)));
    const bin = process.env.SOLANA_BIN || path.join(os.homedir(), ".local/share/solana/install/active_release/bin");
    const sol = (args: string[]) => execFileSync(path.join(bin, "solana"), [...args, "-u", rpcUrl, "-k", key], { encoding: "utf8" });
    const oldLen = fs.statSync(OLD_SO).size;
    const newLen = fs.statSync(SO_DEFAULT).size;
    // ExtendProgram now enforces a 10,240-byte minimum (Agave 4.x), so a small growth is rounded up.
    if (newLen > oldLen) console.log(sol(["program", "extend", PID.toBase58(), String(Math.max(newLen - oldLen, 10_240))]).trim());
    console.log(sol(["program", "deploy", SO_DEFAULT, "--program-id", PID.toBase58(), "--upgrade-authority", key]).trim());
    await sleep(1500);

    const cfgRaw = async () => Buffer.from((await conn.getAccountInfo(deriveConfigPda(PID)[0], "confirmed"))!.data);
    const cfgAfter = await cfgRaw();
    assert(cfgAfter.equals(cfgBefore), "Config bytes unchanged by the upgrade");
    const c0 = decodeConfigAccount(cfgAfter)!;
    assert(c0.stakingEnabled && !c0.stakingFlagSet && c0.authority === admin.publicKey.toBase58(), "legacy Config reads as OPEN (migration default)");

    // ── after upgrade, without any admin action: staking still open ──
    await sendIxs(conn, [alice], [buildAddDailyIx({ ...st(alice, aliceAta), amountRaw: 500n * UI })]);
    await sendIxs(conn, [bob], [buildStakeDailyIx({ ...st(bob, bobAta), amountRaw: 1_000n * UI })]);
    console.log("[staking-upg] upgraded: legacy Config = open; add_daily + new stake_daily work");

    // ── admin only ──
    await expectFail(sendIxs(conn, [up], [buildSetStakingEnabledIx({ authority: up.publicKey, enabled: false })]), "Unauthorized", "upgrade authority cannot toggle");
    await expectFail(sendIxs(conn, [bob], [buildSetStakingEnabledIx({ authority: bob.publicKey, enabled: false })]), "Unauthorized", "user cannot toggle");

    // ── admin locks ──
    await sendIxs(conn, [admin], [buildSetStakingEnabledIx({ authority: admin.publicKey, enabled: false })]);
    const c1 = decodeConfigAccount(await cfgRaw())!;
    assert(!c1.stakingEnabled && c1.stakingFlagSet, "locked");
    const carol = Keypair.generate();
    await airdrop(conn, carol.publicKey, 2);
    const carolAta = await ata(carol, 5_000n);
    await expectFail(sendIxs(conn, [carol], [buildStakeDailyIx({ ...st(carol, carolAta), amountRaw: 1_000n * UI })]), "StakingLocked", "stake_daily locked");
    await expectFail(sendIxs(conn, [alice], [buildAddDailyIx({ ...st(alice, aliceAta), amountRaw: 100n * UI })]), "StakingLocked", "add_daily locked");
    await expectFail(sendIxs(conn, [alice], [buildStakeLongIx({ ...st(alice, aliceAta), amountRaw: 100n * UI, trancheId: 1 })]), "StakingLocked", "stake_long locked");
    // exits: only their own time locks apply (the 24 h / 365 d windows can't elapse on a test validator)
    const exitErr = async (p: Promise<unknown>) => {
      try {
        await p;
        return "OK";
      } catch (e) {
        return errText(e);
      }
    };
    const un = await exitErr(sendIxs(conn, [bob], [buildUnstakeDailyIx(st(bob, bobAta))]));
    const cd = await exitErr(sendIxs(conn, [alice], [buildClaimDailyIx(st(alice, aliceAta))]));
    const cl = await exitErr(sendIxs(conn, [alice], [buildClaimLongIx({ ...st(alice, aliceAta), trancheId: 0 })]));
    assert(!un.includes("StakingLocked") && (un === "OK" || un.includes("MinLockNotMet")), `unstake_daily while locked: ${un.slice(0, 400)}`);
    assert(!cd.includes("StakingLocked") && (cd === "OK" || cd.includes("NothingToClaim")), `claim_daily while locked: ${cd.slice(0, 400)}`);
    assert(!cl.includes("StakingLocked") && (cl === "OK" || cl.includes("StillLocked")), `claim_long while locked: ${cl.slice(0, 400)}`);
    console.log("[staking-upg] locked: stake_daily/add_daily/stake_long → StakingLocked; unstake/claim never StakingLocked");

    // ── admin re-opens ──
    await sendIxs(conn, [admin], [buildSetStakingEnabledIx({ authority: admin.publicKey, enabled: true })]);
    const c2 = decodeConfigAccount(await cfgRaw())!;
    assert(c2.stakingEnabled && c2.stakingFlagSet, "open (explicit)");
    await sendIxs(conn, [carol], [buildStakeDailyIx({ ...st(carol, carolAta), amountRaw: 1_000n * UI })]);
    await sendIxs(conn, [alice], [buildStakeLongIx({ ...st(alice, aliceAta), amountRaw: 100n * UI, trancheId: 1 })]);
    console.log("[staking-upg] re-opened: new stakes work again");
    console.log("STAKING SWITCH UPGRADE PASS");
  } finally {
    ln.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
