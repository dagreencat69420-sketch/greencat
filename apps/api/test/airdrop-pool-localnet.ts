/**
 * Localnet check for the /admin airdrop-pool buttons (not run in CI; needs solana-test-validator).
 *
 * Uses the exact instruction builders the web app sends (`buildAirdropPoolDepositIxs`,
 * `buildAirdropPoolWithdrawIxs` from @greencat/sdk) against the short-window build
 * (target/deploy/greencat-short.so: airdrop window ≥ 2 s, reclaim grace 1 s) with a throw-away test admin
 * (the validator's upgrade authority → config.authority). Proves:
 *   deposit works · non-admin withdraw is refused · withdraw can't touch funds reserved for an open
 *   round (LiabilityFloor) · unreserved funds can be withdrawn · claims still pay · reclaim+withdraw in
 *   one tx is refused before expiry and works after it · deposits are refused while paused.
 *
 *   npx tsx apps/api/test/airdrop-pool-localnet.ts      (from the repo root)
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  airdropPoolWithdrawable,
  buildAirdropPoolDepositIxs,
  buildAirdropPoolWithdrawIxs,
  buildClaimAirdropIx,
  buildCreateAirdropIx,
  buildMerkleTree,
  buildSetPausedIx,
  decodeConfigAccount,
  deriveAirdropDistributionPda,
  deriveConfigPda,
  deriveTreasuryPda,
  deriveTreasuryVaultAta,
  PoolId,
} from "@greencat/sdk";
import { PID, SO_SHORT, airdrop, assert, errText, initProgram, sendIxs, startLocalnet } from "./localnet";

const UI = 1_000_000n;
const TOKEN = TOKEN_PROGRAM_ID; // devnet test $GC is classic SPL
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ln = await startLocalnet({ so: process.env.POOL_SO || SO_SHORT, port: Number(process.env.E2E_RPC_PORT || 19299), tag: "pool" });
  const { conn } = ln;
  const admin = ln.upgradeAuthority;
  let pass = 0;
  const ok = (m: string) => {
    pass++;
    console.log(`  ✓ ${m}`);
  };
  const rejects = async (m: string, want: RegExp, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      const t = errText(e);
      assert(want.test(t), `${m}: expected ${want}, got:\n${t.slice(0, 800)}`);
      return ok(`${m} → refused (${want.source})`);
    }
    throw new Error(`${m}: expected failure ${want}, but it succeeded`);
  };
  try {
    const mint = await createMint(conn, admin, admin.publicKey, null, 6, Keypair.generate(), undefined, TOKEN);
    const adminAta = await getOrCreateAssociatedTokenAccount(conn, admin, mint, admin.publicKey, false, undefined, undefined, TOKEN);
    await mintTo(conn, admin, mint, adminAta.address, admin, 1_000_000n * UI, [], undefined, TOKEN);
    await initProgram(ln, mint, TOKEN, { collection: false });

    const [pool] = deriveTreasuryPda(PoolId.Airdrop, PID);
    const vault = deriveTreasuryVaultAta(mint, pool, TOKEN);
    const bal = async (a: PublicKey) => BigInt((await conn.getTokenAccountBalance(a, "confirmed")).value.amount);
    const cfg = async () => decodeConfigAccount(Buffer.from((await conn.getAccountInfo(deriveConfigPda(PID)[0]))!.data))!;
    const withdrawIxs = (amount: bigint, who = admin.publicKey, reclaim?: bigint) =>
      buildAirdropPoolWithdrawIxs({ authority: who, gcMint: mint, amountRaw: amount, tokenProgramId: TOKEN, reclaimDistributionId: reclaim });

    // 1. deposit (button a)
    await sendIxs(conn, [admin], buildAirdropPoolDepositIxs({ depositor: admin.publicKey, gcMint: mint, amountRaw: 100_000n * UI, tokenProgramId: TOKEN }));
    assert((await bal(vault)) === 100_000n * UI, "vault after deposit");
    assert((await bal(adminAta.address)) === 900_000n * UI, "admin after deposit");
    ok("deposit 100,000 $GC from the admin wallet into the airdrop pool");

    // 2. non-admin withdraw
    const intruder = Keypair.generate();
    await airdrop(conn, intruder.publicKey, 2);
    await rejects("non-admin withdraw from the airdrop pool", /Unauthorized|0x1770|6000/, () => sendIxs(conn, [intruder], withdrawIxs(1n * UI, intruder.publicKey)));

    // 3. open a round reserving 60,000 (expires in ~8 s on the short build)
    const alice = Keypair.generate();
    await airdrop(conn, alice.publicKey, 1);
    const [dist] = deriveAirdropDistributionPda(1n, PID);
    const tree = buildMerkleTree(dist, [
      { claimant: alice.publicKey.toBase58(), amount: 10_000n * UI },
      { claimant: Keypair.generate().publicKey.toBase58(), amount: 50_000n * UI },
    ]);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 8);
    await sendIxs(conn, [admin], [
      buildCreateAirdropIx({ authority: admin.publicKey, gcMint: mint, id: 1n, merkleRoot: tree.root, totalAmountRaw: 60_000n * UI, expiryTs: expiry, tokenProgramId: TOKEN }),
    ]);
    assert((await cfg()).airdropReserved === 60_000n * UI, "reserved");
    ok("round #1 posted: 60,000 reserved of 100,000");

    // 4. floor
    assert(airdropPoolWithdrawable(await bal(vault), (await cfg()).airdropReserved) === 40_000n * UI, "UI withdrawable = 40,000");
    await rejects("withdraw 40,001 while 60,000 is reserved for an open round", /LiabilityFloor/, () => sendIxs(conn, [admin], withdrawIxs(40_001n * UI)));
    await sendIxs(conn, [admin], withdrawIxs(40_000n * UI));
    assert((await bal(vault)) === 60_000n * UI && (await bal(adminAta.address)) === 940_000n * UI, "after free withdraw");
    ok("withdraw the 40,000 unreserved $GC back to the admin wallet (button b)");
    await rejects("withdraw even 1 more $GC (all remaining is owed to claimants)", /LiabilityFloor/, () => sendIxs(conn, [admin], withdrawIxs(1n * UI)));

    // 5. claimants are unaffected
    await sendIxs(conn, [alice], [
      buildClaimAirdropIx({ claimant: alice.publicKey, gcMint: mint, distributionId: 1n, index: 0n, amountRaw: 10_000n * UI, proof: tree.proof(0), tokenProgramId: TOKEN }),
    ], 200_000);
    ok("holder claim still pays 10,000 from the pool");

    // 6. reclaim + withdraw bundled (what the button does once the loaded round has ended)
    await rejects("reclaim+withdraw before the round's expiry", /AirdropNotExpired/, () => sendIxs(conn, [admin], withdrawIxs(50_000n * UI, admin.publicKey, 1n)));
    while (BigInt(Math.floor(Date.now() / 1000)) < expiry + 2n) await sleep(500);
    await sleep(1500);
    const c = await cfg();
    const unclaimed = 50_000n * UI;
    assert(airdropPoolWithdrawable(await bal(vault), c.airdropReserved, unclaimed) === 50_000n * UI, "UI withdrawable with reclaim");
    await sendIxs(conn, [admin], withdrawIxs(50_000n * UI, admin.publicKey, 1n));
    assert((await cfg()).airdropReserved === 0n && (await bal(vault)) === 0n, "after reclaim+withdraw");
    assert((await bal(adminAta.address)) === 990_000n * UI, "admin final");
    ok("after expiry: one tx reclaims round #1 (50,000 unclaimed) and withdraws it to the admin");

    // 7. pause gate on deposit
    await sendIxs(conn, [admin], [buildSetPausedIx({ authority: admin.publicKey, paused: true })]);
    await rejects("deposit while paused", /Paused|0x1771|6001/, () =>
      sendIxs(conn, [admin], buildAirdropPoolDepositIxs({ depositor: admin.publicKey, gcMint: mint, amountRaw: 1n * UI, tokenProgramId: TOKEN }))
    );
    console.log(`[airdrop-pool] ${pass} checks passed`);
  } finally {
    ln.stop();
  }
}

// web3.js keeps re-opening its websocket after the validator stops; exit explicitly.
main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
