#!/usr/bin/env -S npx tsx
/** Usage: npx tsx scripts/list-nft.ts <NFT_MINT> <PRICE_UI> */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildListNftIx } from "@greencat/sdk";
import { PROGRAM_ID, die, loadKeypair, send, uiToRawGc } from "./lib/common";

const [mintStr, priceUi] = process.argv.slice(2);
if (!mintStr || !priceUi) die("Usage: list-nft.ts <NFT_MINT> <PRICE_UI>");
const seller = loadKeypair();
const nftMint = new PublicKey(mintStr);
send([seller], [
  buildListNftIx({
    seller: seller.publicKey,
    nftMint,
    sellerNftAta: getAssociatedTokenAddressSync(nftMint, seller.publicKey, false, TOKEN_PROGRAM_ID),
    priceRaw: uiToRawGc(priceUi),
    programId: PROGRAM_ID,
  }),
]).then((s) => console.log(`list_nft ${s}`), (e) => die(String(e?.stack ?? e)));
