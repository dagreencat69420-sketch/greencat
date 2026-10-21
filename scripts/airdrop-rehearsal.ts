#!/usr/bin/env -S npx tsx
/**
 * Airdrop rehearsal on a LOCAL validator that runs a clone of the live devnet state with a temporary admin.
 * Nothing is sent to devnet. Used to check a proofs file before the real admin posts it in /admin.
 *
 * Setup (see docs/AIRDROP-TUTORIAL.md "Rehearsal"): dump the devnet Config / $GC mint / airdrop vault /
 * recipient wallets + ATAs with `solana account --output json`, overwrite Config.authority (bytes 8..40) with
 * a temp keypair, and start `solana-test-validator --bpf-program <id> <so> --account <addr> <json> ...`.
 *
 *   RPC_URL=http://127.0.0.1:8899 TEMP_ADMIN=temp-admin.json MODE=prod|short \
 *     npx tsx scripts/airdrop-rehearsal.ts airdrops/airdrop-1-proofs.json
 *
 * MODE=prod  (greencat.so, 7-day minimum): posts the file exactly as /admin would, claims, and checks the
 *            guards that must hold while the window is open (double claim, wrong wallet, reserved floor, early reclaim).
 * MODE=short (greencat-short.so): same root with a 20 s window, then reclaim + withdraw after expiry.
 * The claimant listed in DRILL_KEYPAIR (default keys/devnet-drill-wallet.json) claims for real; every other
 * claimant's exact claim transaction is simulated with signature checks off (we don't hold their keys).
 */
import fs from "node:fs";
import path from "node:path";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotent, getAssociatedTokenAddressSync, mintTo } from "@solana/spl-token";
import {
  airdropPoolWithdrawable,
  buildAirdropPoolDepositIxs,
  buildAirdropPoolWithdrawIxs,
  buildClaimAirdropIx,
  buildCreateAirdropIx,
  buildReclaimAirdropIx,
  decodeAirdropDistributionAccount,
  deriveAirdropDistributionPda,
  deriveTreasuryPda,
  deriveTreasuryVaultAta,
  PoolId,
} from "@greencat/sdk";
import { PROGRAM_ID, ROOT, conn, die, gcMintAndProgram, loadKeypair, readConfig, send } from "./lib/common";

const MODE = (process.env.MODE ?? "prod") as "prod" | "short";
const file = JSON.parse(fs.readFileSync(process.argv[2] ?? die("proofs file required"), "utf8"));
const admin = loadKeypair(process.env.TEMP_ADMIN ?? die("TEMP_ADMIN required"));
const mintAuthority = loadKeypair(path.join(ROOT, "keys/devnet-authority.json"));
const drill = loadKeypair(process.env.DRILL_KEYPAIR ?? path.join(ROOT, "keys/devnet-drill-wallet.json"));
const ok = (m: string) => console.log(`  ✔ ${m}`);
const fail = (m: string) => {
  console.error(`  ✘ ${m}`);
  process.exitCode = 1;
};

async function simulate(payer: PublicKey, ixs: TransactionInstruction[]) {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ixs] }).compileToV0Message();
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
  return { err: r.value.err, logs: (r.value.logs ?? []).join("\n") };
}
async function expectFail(label: string, code: RegExp, f: () => Promise<unknown>) {
  try {
    await f();
    fail(`${label}: unexpectedly succeeded`);
  } catch (e) {
    const s = String((e as { logs?: string[] })?.logs?.join("\n") ?? "") + String(e);
    if (code.test(s)) ok(`${label}: rejected (${code.source})`);
    else fail(`${label}: wrong error ${s.slice(0, 300)}`);
  }
}

(async () => {
  const cfg = await readConfig();
  if (!cfg) die("no Config on this cluster");
  if (!(await conn.getGenesisHash()) || !/127\.0\.0\.1|localhost/.test(conn.rpcEndpoint)) die("refusing: RPC_URL must be a local validator");
  if (cfg.authority !== admin.publicKey.toBase58()) die(`Config.authority is ${cfg.authority}, not the temp admin`);
  const { gcMint, tokenProgram } = await gcMintAndProgram();
  const [pool] = deriveTreasuryPda(PoolId.Airdrop, PROGRAM_ID);
  const vault = deriveTreasuryVaultAta(gcMint, pool, tokenProgram);
  const bal = async (a: PublicKey) => BigInt((await conn.getTokenAccountBalance(a).catch(() => ({ value: { amount: "0" } }))).value.amount);
  const total = BigInt(file.totalAmountRaw);
  const id = BigInt(file.distributionId);
  console.log(`MODE=${MODE} program=${PROGRAM_ID.toBase58()} temp admin=${admin.publicKey.toBase58()} paused=${cfg.paused} reserved=${cfg.airdropReserved}`);

  for (const k of [admin.publicKey, mintAuthority.publicKey, drill.publicKey]) await conn.confirmTransaction(await conn.requestAirdrop(k, 5 * LAMPORTS_PER_SOL), "confirmed");
  const adminAta = await createAssociatedTokenAccountIdempotent(conn, admin, gcMint, admin.publicKey, { commitment: "confirmed" }, tokenProgram);
  await mintTo(conn, mintAuthority, gcMint, adminAta, mintAuthority, total, [], { commitment: "confirmed" }, tokenProgram);

  console.log("1. Deposit (the /admin 'Deposit to airdrop pool' instruction)");
  const realAdmin = new PublicKey("13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfyj6");
  const sim = await simulate(realAdmin, buildAirdropPoolDepositIxs({ depositor: realAdmin, gcMint, amountRaw: total, tokenProgramId: tokenProgram }));
  sim.err ? fail(`MetaMask deposit simulation: ${JSON.stringify(sim.err)}\n${sim.logs}`) : ok("MetaMask wallet's deposit of the round total simulates OK");
  const v0 = await bal(vault);
  await send([admin], buildAirdropPoolDepositIxs({ depositor: admin.publicKey, gcMint, amountRaw: total, tokenProgramId: tokenProgram }));
  (await bal(vault)) - v0 === total ? ok(`pool +${total} raw (now ${await bal(vault)})`) : fail("pool balance didn't go up by the total");

  console.log("2. Post root (the /admin 'Post root' instruction)");
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  const expiry = MODE === "short" ? nowS + 20n : BigInt(file.expiryTs);
  if (MODE === "prod") {
    await expectFail("1-hour window", /InvalidExpiry|6060/, () =>
      send([admin], [buildCreateAirdropIx({ authority: admin.publicKey, gcMint, id: 777n, merkleRoot: Buffer.from(file.merkleRoot, "hex"), totalAmountRaw: 1n, expiryTs: nowS + 3600n, tokenProgramId: tokenProgram })])
    );
  }
  const reservedBefore = (await readConfig())!.airdropReserved;
  await send([admin], [buildCreateAirdropIx({ authority: admin.publicKey, gcMint, id, merkleRoot: Buffer.from(file.merkleRoot, "hex"), totalAmountRaw: total, expiryTs: expiry, tokenProgramId: tokenProgram })]);
  const [distPk] = deriveAirdropDistributionPda(id, PROGRAM_ID);
  const d = decodeAirdropDistributionAccount(Buffer.from((await conn.getAccountInfo(distPk))!.data))!;
  Buffer.from(d.merkleRoot).toString("hex") === file.merkleRoot && distPk.toBase58() === file.distribution ? ok(`distribution ${distPk.toBase58()} root matches the file`) : fail("root / PDA mismatch");
  (await readConfig())!.airdropReserved - reservedBefore === total ? ok(`reserved +${total}`) : fail("reserved didn't go up by the total");

  console.log("3. Claims (the /airdrop 'Claim' instruction)");
  const claimIx = (c: { index: number; claimant: string; amountRaw: string; proof: string[] }, who = new PublicKey(c.claimant)) =>
    buildClaimAirdropIx({ claimant: who, gcMint, distributionId: id, index: BigInt(c.index), amountRaw: BigInt(c.amountRaw), proof: c.proof.map((h: string) => Buffer.from(h, "hex")), tokenProgramId: tokenProgram });
  let claimedReal = 0n;
  for (const c of file.claims) {
    if (c.claimant === drill.publicKey.toBase58()) {
      const ata = getAssociatedTokenAddressSync(gcMint, drill.publicKey, false, tokenProgram);
      const b0 = await bal(ata);
      await send([drill], [claimIx(c)]);
      (await bal(ata)) - b0 === BigInt(c.amountRaw) ? ok(`#${c.index} ${c.claimant} claimed for real: +${c.amountRaw} raw`) : fail("drill claim amount wrong");
      claimedReal += BigInt(c.amountRaw);
      await expectFail(`#${c.index} double claim`, /already in use|0x0|custom program error/, () => send([drill], [claimIx(c)]));
    } else {
      const s = await simulate(new PublicKey(c.claimant), [claimIx(c)]);
      s.err ? fail(`#${c.index} ${c.claimant} claim simulation: ${JSON.stringify(s.err)}\n${s.logs}`) : ok(`#${c.index} ${c.claimant} claim simulates OK (${c.amountRaw} raw)`);
      await expectFail(`#${c.index} claimed by the wrong wallet (drill)`, /InvalidMerkleProof/, () => send([drill], [claimIx(c, drill.publicKey)]));
    }
  }

  const unclaimed = total - claimedReal;
  if (MODE === "prod") {
    console.log("4. Guards while the window is open");
    const c2 = (await readConfig())!;
    const w = airdropPoolWithdrawable(await bal(vault), c2.airdropReserved);
    await expectFail("withdraw more than 'Withdrawable now'", /LiabilityFloor/, () =>
      send([admin], buildAirdropPoolWithdrawIxs({ authority: admin.publicKey, gcMint, amountRaw: w + 1n, tokenProgramId: tokenProgram }))
    );
    await expectFail("reclaim before the deadline", /AirdropNotExpired/, () => send([admin], [buildReclaimAirdropIx({ authority: admin.publicKey, distributionId: id })]));
  } else {
    console.log("4. After the deadline: claim refused, reclaim, withdraw");
    while (BigInt((await conn.getBlockTime(await conn.getSlot()))!) <= expiry + 1n) await new Promise((r) => setTimeout(r, 2000));
    const late = file.claims.find((c: { claimant: string }) => c.claimant !== drill.publicKey.toBase58());
    const s = await simulate(new PublicKey(late.claimant), [claimIx(late)]);
    /AirdropExpired/.test(s.logs) ? ok("claim after the deadline is refused (AirdropExpired)") : fail(`late claim: ${JSON.stringify(s.err)}`);
    const r0 = (await readConfig())!.airdropReserved;
    await send([admin], [buildReclaimAirdropIx({ authority: admin.publicKey, distributionId: id })]);
    r0 - (await readConfig())!.airdropReserved === unclaimed ? ok(`reclaim released ${unclaimed} raw (unclaimed)`) : fail("reclaim released the wrong amount");
    await expectFail("reclaim twice", /AirdropAlreadyReclaimed/, () => send([admin], [buildReclaimAirdropIx({ authority: admin.publicKey, distributionId: id })]));
    const a0 = await bal(adminAta);
    await send([admin], buildAirdropPoolWithdrawIxs({ authority: admin.publicKey, gcMint, amountRaw: unclaimed, tokenProgramId: tokenProgram }));
    (await bal(adminAta)) - a0 === unclaimed ? ok(`withdrew the ${unclaimed} raw unclaimed back to the admin wallet`) : fail("withdraw amount wrong");
  }
  console.log(process.exitCode ? "REHEARSAL FAILED" : "REHEARSAL PASSED");
})().catch((e) => die(String(e?.stack ?? e) + "\n" + (e?.logs ?? []).join("\n")));
