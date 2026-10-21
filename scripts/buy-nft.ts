#!/usr/bin/env -S npx tsx
/**
 * Usage: npx tsx scripts/buy-nft.ts <NFT_MINT> <EXPECTED_PRICE_UI>
 * Audit GC-21: the tx reverts (PriceMismatch) unless the listing price is exactly EXPECTED_PRICE_UI.
 */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildBuyNftIx, decodeListingAccount, deriveListingPda } from "@greencat/sdk";
import { PROGRAM_ID, conn, die, gcMintAndProgram, loadKeypair, send, uiToRawGc } from "./lib/common";

const [mintStr, expectedUi] = process.argv.slice(2);
if (!mintStr || !expectedUi) die("Usage: buy-nft.ts <NFT_MINT> <EXPECTED_PRICE_UI>");

async function main() {
  const buyer = loadKeypair();
  const nftMint = new PublicKey(mintStr);
  const { gcMint, tokenProgram } = await gcMintAndProgram();
  const info = await conn.getAccountInfo(deriveListingPda(nftMint, PROGRAM_ID)[0]);
  const listing = info ? decodeListingAccount(Buffer.from(info.data)) : null;
  if (!listing || !listing.active) die("no active listing");
  const seller = new PublicKey(listing.seller);
  const expected = uiToRawGc(expectedUi);
  if (BigInt(listing.price) !== expected) console.warn(`warning: listing price is ${listing.price} raw; tx will revert with PriceMismatch`);
  const sig = await send([buyer], [
    buildBuyNftIx({
      buyer: buyer.publicKey,
      seller,
      nftMint,
      gcMint,
      buyerGcAta: getAssociatedTokenAddressSync(gcMint, buyer.publicKey, false, tokenProgram),
      sellerGcAta: getAssociatedTokenAddressSync(gcMint, seller, false, tokenProgram),
      buyerNftAta: getAssociatedTokenAddressSync(nftMint, buyer.publicKey, false, TOKEN_PROGRAM_ID),
      expectedPriceRaw: expected,
      tokenProgramId: tokenProgram,
      programId: PROGRAM_ID,
    }),
  ], 400_000);
  console.log(`buy_nft ${sig}`);
}
main().catch((e) => die(String(e?.stack ?? e)));
