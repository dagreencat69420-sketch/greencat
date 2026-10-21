#!/usr/bin/env -S npx tsx
/**
 * Steps 2–4 of init (docs/HOSTING.md):
 *   initialize_collection (10k rarity bitmap from seed greencat-meme-collection-v1: 100/900/2000/7000)
 *   → create_collection_nft (sized, verified collection; update authority = program PDA `nft_authority`)
 *   → set_royalty (only before the first mint). Devnet: optional (program default 500 bps → nft_fee_treasury PDA).
 *     MAINNET (detected by genesis hash): always runs, recipient = MAINNET_ROYALTY_RECIPIENT (the owner's wallet
 *     13zew…fyj6, owner decision 2026-10-02); any other ROYALTY_RECIPIENT is refused unless
 *     ALLOW_OTHER_ROYALTY_RECIPIENT=1. The script then checks the on-chain recipient.
 *   → init_mint_pool (permissionless; remaining-ids pool + reveal queue for the per-mint reveal)
 *
 *   KEYPAIR_PATH=<config authority> RPC_URL=… METADATA_BASE_URI=https://…/nft/ \
 *   [ROYALTY_BPS=500 ROYALTY_RECIPIENT=<pubkey>] npx tsx scripts/initialize-collection.ts
 */
import { PublicKey } from "@solana/web3.js";
import {
  DEFAULT_METADATA_BASE_URI,
  DEFAULT_ROYALTY_BPS,
  MAINNET_GENESIS_HASH,
  MAINNET_ROYALTY_RECIPIENT,
  INIT_COLLECTION_COMPUTE_UNITS,
  buildCreateCollectionNftIx,
  buildInitializeCollectionIx,
  buildSetRoyaltyIx,
  buildInitMintPoolIx,
  decodeCollectionAccount,
  decodeMintPool,
  deriveMintPoolPda,
  MINT_POOL_INIT_STEPS,
  deriveCollectionMintPda,
  deriveCollectionPda,
  deriveNftAuthorityPda,
} from "@greencat/sdk";
import { PROGRAM_ID, conn, die, loadKeypair, send } from "./lib/common";

async function main() {
  const authority = loadKeypair();
  const mainnet = (await conn.getGenesisHash()) === MAINNET_GENESIS_HASH;
  if (mainnet && process.env.ROYALTY_RECIPIENT && process.env.ROYALTY_RECIPIENT !== MAINNET_ROYALTY_RECIPIENT && process.env.ALLOW_OTHER_ROYALTY_RECIPIENT !== "1") {
    die(`mainnet royalty recipient must be ${MAINNET_ROYALTY_RECIPIENT} (owner decision); got ${process.env.ROYALTY_RECIPIENT}. Set ALLOW_OTHER_ROYALTY_RECIPIENT=1 only if the owner changed this.`);
  }
  const [colPda] = deriveCollectionPda(PROGRAM_ID);
  let col = await conn.getAccountInfo(colPda);
  if (!col) {
    const uri = process.env.METADATA_BASE_URI || DEFAULT_METADATA_BASE_URI;
    const sig = await send([authority], [buildInitializeCollectionIx({ authority: authority.publicKey, metadataBaseUri: uri, programId: PROGRAM_ID })], INIT_COLLECTION_COMPUTE_UNITS);
    console.log(`initialize_collection ${sig} (base URI ${uri})`);
    col = await conn.getAccountInfo(colPda);
  }
  let decoded = decodeCollectionAccount(Buffer.from(col!.data))!;
  if (!decoded.collectionNftCreated) {
    const sig = await send([authority], [buildCreateCollectionNftIx({ authority: authority.publicKey, programId: PROGRAM_ID })], 400_000);
    console.log(`create_collection_nft ${sig}`);
  }
  const wantRecipient = process.env.ROYALTY_RECIPIENT ?? (mainnet ? MAINNET_ROYALTY_RECIPIENT : undefined);
  if (process.env.ROYALTY_BPS || wantRecipient) {
    const bps = Number(process.env.ROYALTY_BPS ?? (mainnet ? DEFAULT_ROYALTY_BPS : decoded.royaltyBps));
    const recipient = new PublicKey(wantRecipient ?? decoded.royaltyRecipient);
    if (decoded.royaltyBps === bps && decoded.royaltyRecipient === recipient.toBase58()) {
      console.log(`royalty already ${bps} bps → ${recipient.toBase58()}`);
    } else {
      const sig = await send([authority], [buildSetRoyaltyIx({ authority: authority.publicKey, royaltyBps: bps, recipient, programId: PROGRAM_ID })]);
      console.log(`set_royalty ${bps} bps → ${recipient.toBase58()} ${sig}`);
    }
  }
  if (!decodeMintPool((await conn.getAccountInfo(deriveMintPoolPda(PROGRAM_ID)[0]))?.data)) {
    const sig = await send([authority], Array.from({ length: MINT_POOL_INIT_STEPS }, () => buildInitMintPoolIx({ payer: authority.publicKey, programId: PROGRAM_ID })), 200_000);
    console.log(`init_mint_pool ×${MINT_POOL_INIT_STEPS} ${sig}`);
  }
  decoded = decodeCollectionAccount(Buffer.from((await conn.getAccountInfo(colPda))!.data))!;
  console.log({
    collection: colPda.toBase58(),
    collectionMint: deriveCollectionMintPda(PROGRAM_ID)[0].toBase58(),
    updateAuthority: deriveNftAuthorityPda(PROGRAM_ID)[0].toBase58(),
    royaltyBps: decoded.royaltyBps,
    royaltyRecipient: decoded.royaltyRecipient,
    minted: decoded.mintedCount.toString(),
  });
  if (mainnet && decoded.royaltyRecipient !== (process.env.ROYALTY_RECIPIENT ?? MAINNET_ROYALTY_RECIPIENT)) {
    die(`MAINNET royalty recipient is ${decoded.royaltyRecipient}, expected ${MAINNET_ROYALTY_RECIPIENT}. Fix it with set_royalty BEFORE the first mint.`);
  }
}
main().catch((e) => die(String(e?.stack ?? e)));
