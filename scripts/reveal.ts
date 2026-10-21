#!/usr/bin/env -S npx tsx
/**
 * Per-mint reveal crank (audit GC-17). Every mint requests its own ORAO VRF; `settle_mint` reveals
 * the FIFO queue head once ORAO fulfilled. Anyone may run any of these (the web UI settles too).
 *
 *   npx tsx scripts/reveal.ts status          # queue head, pending entries, ORAO state
 *   npx tsx scripts/reveal.ts init-pool       # create the remaining-ids pool PDA (once, after the upgrade)
 *   npx tsx scripts/reveal.ts request         # VRF for NFTs minted before the upgrade + re-request expired ones
 *   npx tsx scripts/reveal.ts settle          # settle every fulfilled entry from the head, in order
 *   npx tsx scripts/reveal.ts crank [SECS]    # loop: request + settle every SECS (default 5)
 *
 * A re-request is only accepted for an EXPIRED + UNFULFILLED request (the program checks the old ORAO
 * account), so a known randomness can never be re-rolled.
 */
import { PublicKey } from "@solana/web3.js";
import {
  MINT_POOL_INIT_STEPS,
  SETTLE_MINT_COMPUTE_UNITS,
  buildInitMintPoolIx,
  buildRequestMintVrfIx,
  decodeNftRecordAccount,
  deriveNftRecordPda,
  fetchOraoTreasury,
  fetchRevealQueue,
  settleIxsFromQueue,
} from "@greencat/sdk";
import bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha256";
import { PROGRAM_ID, conn, die, loadKeypair, readConfig, send } from "./lib/common";

const [cmd = "status", arg] = process.argv.slice(2);

/** mint_index → NFT mint for NftRecords whose queue slot is still empty (pre-upgrade mints). */
async function legacyMints(indices: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!indices.length) return out;
  const disc = bs58.encode(Buffer.from(sha256("account:NftRecord")).subarray(0, 8));
  const recs = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: disc } }] });
  for (const r of recs) {
    const d = decodeNftRecordAccount(Buffer.from(r.account.data));
    if (d && !d.revealed && indices.includes(d.mintIndex)) out.set(d.mintIndex, d.mint);
  }
  return out;
}

async function request(): Promise<number> {
  const payer = loadKeypair();
  const q = await fetchRevealQueue(conn, PROGRAM_ID);
  if (!q.poolReady) die("mint pool not initialized: run `reveal.ts init-pool`");
  const cfg = await readConfig();
  const now = Math.floor(Date.now() / 1000);
  const treasury = await fetchOraoTreasury(conn);
  const legacy = await legacyMints(q.entries.filter((e) => !e.nftMint).map((e) => e.mintIndex));
  let n = 0;
  for (const e of q.entries) {
    let nftMint: string | undefined;
    let attempt = 1;
    let prev: number | null = null;
    if (!e.nftMint) {
      nftMint = legacy.get(e.mintIndex);
      if (!nftMint) die(`no NftRecord found for legacy mint_index ${e.mintIndex}`);
    } else if (!e.fulfilled && now >= e.requestedTs + Number(cfg?.vrfExpirySecs ?? 86_400n)) {
      nftMint = e.nftMint;
      attempt = e.attempt + 1;
      prev = e.attempt;
    } else continue;
    const sig = await send([payer], [buildRequestMintVrfIx({ payer: payer.publicKey, nftMint: new PublicKey(nftMint), attempt, previousAttempt: prev, vrfTreasury: treasury, programId: PROGRAM_ID })]);
    console.log(`request_mint_vrf #${e.mintIndex} ${nftMint} attempt=${attempt} ${sig}`);
    n++;
  }
  return n;
}

async function settle(): Promise<number> {
  const payer = loadKeypair();
  let n = 0;
  for (;;) {
    const q = await fetchRevealQueue(conn, PROGRAM_ID, 3);
    const ixs = settleIxsFromQueue(q, PROGRAM_ID, { max: 3 });
    if (!ixs.length) break;
    const sig = await send([payer], ixs, SETTLE_MINT_COMPUTE_UNITS * ixs.length);
    for (let i = 0; i < ixs.length; i++) {
      const m = ixs[i].keys[3].pubkey;
      const rec = decodeNftRecordAccount(Buffer.from((await conn.getAccountInfo(deriveNftRecordPda(m, PROGRAM_ID)[0]))!.data))!;
      console.log(`settle_mint #${rec.mintIndex} ${m.toBase58()} → GreenCat #${rec.tokenId} (rarity ${rec.rarity}) ${sig}`);
    }
    n += ixs.length;
  }
  console.log(`settled ${n} NFT(s)`);
  return n;
}

async function main() {
  if (cmd === "status") {
    const q = await fetchRevealQueue(conn, PROGRAM_ID);
    console.log({
      poolReady: q.poolReady,
      minted: q.minted,
      revealed: q.head,
      pending: q.minted - q.head,
      remainingIds: q.size - q.head,
      queue: q.entries.slice(0, 10).map((e) => `#${e.mintIndex} ${e.nftMint ?? "(legacy, not requested)"} attempt=${e.attempt} ${e.fulfilled ? "fulfilled" : "pending"}`),
    });
  } else if (cmd === "init-pool") {
    const payer = loadKeypair();
    const sig = await send([payer], Array.from({ length: MINT_POOL_INIT_STEPS }, () => buildInitMintPoolIx({ payer: payer.publicKey, programId: PROGRAM_ID })));
    console.log(`init_mint_pool ×${MINT_POOL_INIT_STEPS} ${sig}`);
  } else if (cmd === "request") {
    console.log(`requested ${await request()} VRF(s)`);
  } else if (cmd === "settle") {
    await settle();
  } else if (cmd === "crank") {
    const secs = Number(arg || 5);
    // web3.js 1.x `sendAndConfirmTransaction` leaves an un-awaited getSignatureStatus() behind after the
    // websocket confirms; if that RPC call later fails (429 / connect timeout) it is an unhandled rejection,
    // which kills Node 20 and silently stops the crank (seen in the 2026-10-03 Devnet oracle-stall drill).
    // The crank is a long-running safety net, so log it and keep looping.
    process.on("unhandledRejection", (e) => {
      console.error(`${new Date().toISOString()} ignored unhandled rejection: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    });
    for (;;) {
      try {
        await request();
        await settle();
      } catch (e) {
        console.error(`${new Date().toISOString()} ${String((e as Error)?.message ?? e).slice(0, 500)}`);
      }
      await new Promise((r) => setTimeout(r, secs * 1000));
    }
  } else die(`unknown command ${cmd}`);
}
main().catch((e) => die(String(e?.stack ?? e)));
