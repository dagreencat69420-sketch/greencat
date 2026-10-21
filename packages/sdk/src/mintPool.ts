/**
 * Per-mint reveal state (audit GC-17): the `["mint_pool"]` PDA holds the remaining-ids pool
 * (swap-and-pop over 1..=10_000, `0` = identity) and a 256-slot FIFO reveal queue.
 * Layout mirrors `MintPool` in programs/greencat/src/nft.rs.
 */
import { PublicKey } from "@solana/web3.js";
import { getProgramId } from "./treasuries";

export const MINT_POOL_SEED = Buffer.from("mint_pool");
export const MINT_POOL_IDS = 10_000;
export const MINT_QUEUE_LEN = 256;
export const MINT_SLOT_LEN = 48;
/** 8 (disc) + 2·10_000 (ids) + 48·256 (queue) */
export const MINT_POOL_LEN = 8 + 2 * MINT_POOL_IDS + MINT_SLOT_LEN * MINT_QUEUE_LEN;
/** `init_mint_pool` grows the PDA by ≤ 10 KiB per call → 4 calls (fit in one transaction). */
export const MINT_POOL_INIT_STEPS = Math.ceil(MINT_POOL_LEN / 10_240);
/** sha256("account:MintPool")[0..8] */
export const MINT_POOL_DISC = Buffer.from("233bef9eacfe1582", "hex");

export function deriveMintPoolPda(programId: PublicKey = getProgramId()): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([MINT_POOL_SEED], programId);
}

export type MintSlot = { nftMint: string | null; requestedTs: bigint; attempt: number };

export type DecodedMintPool = {
  /** raw ids (0 = identity); only the first `remaining` entries are live */
  ids: Uint16Array;
  queue: MintSlot[];
};

/** Decode the pool. Returns null while it is missing or still being grown (no discriminator yet). */
export function decodeMintPool(data: Buffer | Uint8Array | null | undefined): DecodedMintPool | null {
  if (!data) return null;
  const d = Buffer.from(data);
  if (d.length < MINT_POOL_LEN || !d.subarray(0, 8).equals(MINT_POOL_DISC)) return null;
  const ids = new Uint16Array(MINT_POOL_IDS);
  for (let i = 0; i < MINT_POOL_IDS; i++) ids[i] = d.readUInt16LE(8 + 2 * i);
  const queue: MintSlot[] = [];
  const q0 = 8 + 2 * MINT_POOL_IDS;
  for (let i = 0; i < MINT_QUEUE_LEN; i++) {
    const o = q0 + i * MINT_SLOT_LEN;
    const key = new PublicKey(d.subarray(o, o + 32));
    queue.push({
      nftMint: key.equals(PublicKey.default) ? null : key.toBase58(),
      requestedTs: d.readBigInt64LE(o + 32),
      attempt: d[o + 40],
    });
  }
  return { ids, queue };
}

/** Mirror of on-chain `pool_get`. */
export function poolGet(ids: Uint16Array | number[], i: number): number {
  return ids[i] === 0 ? i + 1 : ids[i];
}

/** Mirror of on-chain `pool_take` (mutates `ids`). */
export function poolTake(ids: Uint16Array | number[], j: number, remaining: number): number {
  const id = poolGet(ids, j);
  ids[j] = poolGet(ids, remaining - 1);
  return id;
}
