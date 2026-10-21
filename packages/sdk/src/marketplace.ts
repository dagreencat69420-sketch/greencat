/**
 * Marketplace fee helpers + PDA derivation (REAL-APP-SPEC §D / demo parity).
 * Fee bps = 100 (1%). Integer floor: fee = price * 100 / 10000; seller = price - fee.
 */

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getProgramId } from "./treasuries";

/** Marketplace fee in basis points (100 bps = 1%). */
export const MARKETPLACE_FEE_BPS = 100n;

export const LISTING_SEED = Buffer.from("listing");
export const OFFER_SEED = Buffer.from("offer");

/** 1% of trade price, floored (raw u64 amounts). */
export function marketplaceFee(price: bigint | number): bigint {
  const p = typeof price === "bigint" ? price : BigInt(price);
  if (p <= 0n) return 0n;
  return (p * MARKETPLACE_FEE_BPS) / 10000n;
}

/** Seller proceeds after 1% platform cut. Buyer still pays full sticker/offer price. */
export function sellerNetAfterFee(price: bigint | number): bigint {
  const p = typeof price === "bigint" ? price : BigInt(price);
  const fee = marketplaceFee(p);
  return p - fee > 0n ? p - fee : 0n;
}

export function deriveListingPda(
  nftMint: PublicKey,
  programId: PublicKey = getProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [LISTING_SEED, nftMint.toBuffer()],
    programId
  );
}

export function deriveOfferPda(
  nftMint: PublicKey,
  bidder: PublicKey,
  programId: PublicKey = getProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [OFFER_SEED, nftMint.toBuffer(), bidder.toBuffer()],
    programId
  );
}

/** Escrow NFT ATA owned by listing PDA (classic SPL). */
export function deriveListingEscrowNftAta(
  nftMint: PublicKey,
  listingPda: PublicKey
): PublicKey {
  return getAssociatedTokenAddressSync(
    nftMint,
    listingPda,
    true,
    TOKEN_PROGRAM_ID
  );
}

/** Offer $GC escrow ATA owned by offer PDA. */
export function deriveOfferGcEscrowAta(
  gcMint: PublicKey,
  offerPda: PublicKey,
  tokenProgramId: PublicKey
): PublicKey {
  return getAssociatedTokenAddressSync(gcMint, offerPda, true, tokenProgramId);
}

export type DecodedListing = {
  seller: string;
  nftMint: string;
  price: bigint;
  bump: number;
  active: boolean;
};

export function decodeListingAccount(data: Buffer): DecodedListing | null {
  // disc(8) + seller(32) + mint(32) + price(8) + bump(1) + active(1) = 82
  if (data.length < 82) return null;
  let o = 8;
  const seller = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const nftMint = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const price = data.readBigUInt64LE(o);
  o += 8;
  const bump = data[o++];
  const active = data[o] !== 0;
  return { seller, nftMint, price, bump, active };
}

export type DecodedOffer = {
  bidder: string;
  nftMint: string;
  amount: bigint;
  bump: number;
  active: boolean;
};

export function decodeOfferAccount(data: Buffer): DecodedOffer | null {
  if (data.length < 82) return null;
  let o = 8;
  const bidder = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const nftMint = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const amount = data.readBigUInt64LE(o);
  o += 8;
  const bump = data[o++];
  const active = data[o] !== 0;
  return { bidder, nftMint, amount, bump, active };
}
