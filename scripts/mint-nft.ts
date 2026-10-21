#!/usr/bin/env -S npx tsx
/**
 * Mint one GreenCat NFT for 10,000 $GC and wait for its instant reveal (settles the queue up to it).
 *   KEYPAIR_PATH=… RPC_URL=… [NO_SETTLE=1] npx tsx scripts/mint-nft.ts
 */
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  MINT_NFT_COMPUTE_UNITS,
  SETTLE_MINT_COMPUTE_UNITS,
  buildMintNftIx,
  decodeNftRecordAccount,
  deriveNftRecordPda,
  fetchOraoTreasury,
  fetchRevealQueue,
  settleIxsFromQueue,
} from "@greencat/sdk";
import { PROGRAM_ID, conn, die, gcMintAndProgram, loadKeypair, send } from "./lib/common";

async function main() {
  const buyer = loadKeypair();
  const { gcMint, tokenProgram } = await gcMintAndProgram();
  const nft = Keypair.generate();
  const sig = await send(
    [buyer, nft],
    [
      buildMintNftIx({
        buyer: buyer.publicKey,
        nftMint: nft.publicKey,
        gcMint,
        buyerGcAta: getAssociatedTokenAddressSync(gcMint, buyer.publicKey, false, tokenProgram),
        buyerNftAta: getAssociatedTokenAddressSync(nft.publicKey, buyer.publicKey, false, TOKEN_PROGRAM_ID),
        vrfTreasury: await fetchOraoTreasury(conn),
        tokenProgramId: tokenProgram,
        programId: PROGRAM_ID,
      }),
    ],
    MINT_NFT_COMPUTE_UNITS
  );
  console.log(`mint_nft ${sig}\nnft mint ${nft.publicKey.toBase58()}`);
  if (process.env.NO_SETTLE) return;
  const recPda = deriveNftRecordPda(nft.publicKey, PROGRAM_ID)[0];
  const deadline = Date.now() + Number(process.env.SETTLE_TIMEOUT_MS || 120_000);
  // web3.js 1.x can leave a dangling getSignatureStatus() rejection after a confirmed send (429 / timeout);
  // don't let it kill the auto-settle loop (seen in the 2026-10-03 Devnet oracle-stall drill).
  process.on("unhandledRejection", (e) => console.error(`ignored unhandled rejection: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
  while (Date.now() < deadline) {
    let rec, q;
    try {
      rec = decodeNftRecordAccount(Buffer.from((await conn.getAccountInfo(recPda, "confirmed"))!.data))!;
      if (rec.revealed) {
        console.log(`revealed GreenCat #${rec.tokenId} (rarity ${rec.rarity})`);
        return;
      }
      q = await fetchRevealQueue(conn, PROGRAM_ID, 4);
    } catch (e) {
      // transient RPC error (e.g. public Devnet 429 / connect timeout): the mint already landed, keep polling
      console.error(`RPC read failed, retrying: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const ixs = settleIxsFromQueue(q, PROGRAM_ID, { max: 3, upToMintIndex: rec.mintIndex });
    if (ixs.length) {
      try {
        console.log(`settle_mint ×${ixs.length} ${await send([buyer], ixs, SETTLE_MINT_COMPUTE_UNITS * ixs.length)}`);
        continue;
      } catch (e) {
        console.error(`settle failed (someone else may have settled): ${String((e as Error).message).slice(0, 200)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  die("not revealed yet (oracle slow?) — run `npx tsx scripts/reveal.ts settle` later");
}
main().catch((e) => die(String(e?.stack ?? e)));
