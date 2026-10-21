/**
 * Collection PDA helpers for NFT mint slice.
 */

import { PublicKey } from "@solana/web3.js";
import { GREENCAT_PROGRAM_ID } from "./constants";
import { getProgramId } from "./treasuries";

export const COLLECTION_SEED = Buffer.from("collection");
export const NFT_RECORD_SEED = Buffer.from("nft_record");

/** Metaplex Token Metadata program id */
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

export function deriveCollectionPda(
  programId: PublicKey = getProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([COLLECTION_SEED], programId);
}

export function deriveNftRecordPda(
  nftMint: PublicKey,
  programId: PublicKey = getProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [NFT_RECORD_SEED, nftMint.toBuffer()],
    programId
  );
}

export function deriveMetadataPda(nftMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      nftMint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
}

export function deriveMasterEditionPda(nftMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      nftMint.toBuffer(),
      Buffer.from("edition"),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
}

export const NFT_AUTHORITY_SEED = Buffer.from("nft_authority");
export const COLLECTION_MINT_SEED = Buffer.from("collection_mint");
export const RARITY_UNREVEALED = 255;
/** Legacy collection-wide reveal state; always 0 since the per-mint reveal upgrade. */
export const REVEAL_NONE = 0;
export const DEFAULT_ROYALTY_BPS = 500;
export const MAX_ROYALTY_BPS = 1000;

/** PDA that is update authority of every NFT + the collection (audit GC-18). */
export function deriveNftAuthorityPda(programId: PublicKey = getProgramId()): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([NFT_AUTHORITY_SEED], programId);
}

/** Verified sized-collection NFT mint (PDA). */
export function deriveCollectionMintPda(programId: PublicKey = getProgramId()): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([COLLECTION_MINT_SEED], programId);
}

export type DecodedCollection = {
  bump: number;
  metadataBaseUriLen: number;
  revealState: number;
  mintClosed: boolean;
  collectionNftCreated: boolean;
  revealAttempts: number;
  royaltyBps: number;
  mintedCount: bigint;
  collectionSize: bigint;
  mintPriceRaw: bigint;
  metadataBaseUri: string;
  collectionMint: string;
  royaltyRecipient: string;
  /** legacy (unused) */
  revealSeed: Buffer;
  /** legacy (unused) */
  revealOffset: bigint;
  /** legacy (unused) */
  revealRequestedTs: bigint;
  /** settled (revealed) NFTs = mint_index of the reveal-queue head */
  revealedCount: bigint;
};

/** Decode zero-copy Collection (2824 bytes; see programs/greencat/src/nft.rs). */
export function decodeCollectionAccount(data: Buffer): DecodedCollection | null {
  if (data.length < 2824) return null;
  let o = 8;
  const bump = data[o++];
  const uriLen = data[o++];
  const revealState = data[o++];
  const mintClosed = data[o++] !== 0;
  const collectionNftCreated = data[o++] !== 0;
  const revealAttempts = data[o++];
  const royaltyBps = data.readUInt16LE(o); o += 2;
  const mintedCount = data.readBigUInt64LE(o); o += 8;
  const collectionSize = data.readBigUInt64LE(o); o += 8;
  const mintPriceRaw = data.readBigUInt64LE(o); o += 8;
  const metadataBaseUri = data.subarray(o, o + uriLen).toString("utf8");
  o += 128 + 2504;
  const pk = () => { const k = new PublicKey(data.subarray(o, o + 32)).toBase58(); o += 32; return k; };
  const collectionMint = pk();
  const royaltyRecipient = pk();
  const revealSeed = Buffer.from(data.subarray(o, o + 32)); o += 32;
  o += 32; // reveal_randomness (first half)
  const revealOffset = data.readBigUInt64LE(o); o += 8;
  const revealRequestedTs = data.readBigInt64LE(o); o += 8;
  const revealedCount = data.readBigUInt64LE(o);
  return {
    bump, metadataBaseUriLen: uriLen, revealState, mintClosed, collectionNftCreated, revealAttempts,
    royaltyBps, mintedCount, collectionSize, mintPriceRaw, metadataBaseUri, collectionMint,
    royaltyRecipient, revealSeed, revealOffset, revealRequestedTs, revealedCount,
  };
}

export function deriveProgramId(override?: string): PublicKey {
  return new PublicKey(override || GREENCAT_PROGRAM_ID);
}

export type DecodedNftRecord = {
  mint: string;
  buyer: string;
  /** final token id 1..10000; 0 until revealed */
  tokenId: number;
  /** 0 common · 1 uncommon · 2 rare · 3 legendary · 255 unrevealed */
  rarity: number;
  bump: number;
  mintIndex: number;
  revealed: boolean;
};

/** Decode NftRecord PDA (`["nft_record", mint]`, 84 bytes). */
export function decodeNftRecordAccount(data: Buffer): DecodedNftRecord | null {
  if (data.length < 8 + 32 + 32 + 2 + 1 + 1) return null;
  let o = 8;
  const mint = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const buyer = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const tokenId = data.readUInt16LE(o);
  o += 2;
  const rarity = data[o++];
  const bump = data[o++];
  const mintIndex = data.length >= o + 2 ? data.readUInt16LE(o) : 0;
  o += 2;
  const revealed = data.length > o ? data[o] !== 0 : tokenId !== 0;
  return { mint, buyer, tokenId, rarity, bump, mintIndex, revealed };
}
