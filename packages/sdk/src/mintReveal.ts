/**
 * Client helpers for the per-mint reveal queue (audit GC-17). Anyone may crank `settle_mint`;
 * only the queue head (mint_index == collection.revealedCount) can settle, once ORAO fulfilled.
 */
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { decodeCollectionAccount, deriveCollectionPda } from "./collection";
import { buildSettleMintIx } from "./instructions";
import { decodeMintPool, deriveMintPoolPda, MINT_QUEUE_LEN } from "./mintPool";
import { decodeOraoNetworkState, decodeOraoRandomness, deriveOraoNetworkStatePda, deriveOraoRandomnessPda, mintVrfSeed } from "./vrf";

/** ORAO treasury from the on-chain network state (needed by mint_nft / request_mint_vrf). */
export async function fetchOraoTreasury(conn: Connection): Promise<PublicKey> {
  const net = decodeOraoNetworkState((await conn.getAccountInfo(deriveOraoNetworkStatePda(), "confirmed"))?.data);
  if (!net) throw new Error("ORAO VRF network state not found on this cluster");
  return new PublicKey(net.treasury);
}

export type RevealQueueEntry = {
  mintIndex: number;
  /** null = minted before the per-mint upgrade and never requested (needs request_mint_vrf) */
  nftMint: string | null;
  attempt: number;
  requestedTs: number;
  fulfilled: boolean;
};

export type RevealQueue = {
  /** false until init_mint_pool completed */
  poolReady: boolean;
  head: number;
  minted: number;
  size: number;
  entries: RevealQueueEntry[];
};

/** Read collection + pool + the ORAO accounts of every pending entry (head … minted-1). */
export async function fetchRevealQueue(conn: Connection, programId: PublicKey, maxEntries = MINT_QUEUE_LEN): Promise<RevealQueue> {
  const [colInfo, poolInfo] = await conn.getMultipleAccountsInfo(
    [deriveCollectionPda(programId)[0], deriveMintPoolPda(programId)[0]],
    "confirmed"
  );
  const col = colInfo ? decodeCollectionAccount(Buffer.from(colInfo.data)) : null;
  if (!col) throw new Error("Collection not initialized");
  const pool = decodeMintPool(poolInfo?.data);
  const head = Number(col.revealedCount);
  const minted = Number(col.mintedCount);
  const size = Number(col.collectionSize);
  const entries: RevealQueueEntry[] = [];
  if (pool) {
    for (let i = head; i < minted && entries.length < maxEntries; i++) {
      const s = pool.queue[i % MINT_QUEUE_LEN];
      entries.push({ mintIndex: i, nftMint: s.nftMint, attempt: s.attempt, requestedTs: Number(s.requestedTs), fulfilled: false });
    }
    const req = entries.filter((e) => e.nftMint && e.attempt > 0);
    for (let k = 0; k < req.length; k += 100) {
      const chunk = req.slice(k, k + 100);
      const infos = await conn.getMultipleAccountsInfo(
        chunk.map((e) => deriveOraoRandomnessPda(mintVrfSeed(new PublicKey(e.nftMint!), e.attempt, programId))),
        "confirmed"
      );
      infos.forEach((inf, j) => {
        chunk[j].fulfilled = !!decodeOraoRandomness(inf?.data)?.randomness;
      });
    }
  }
  return { poolReady: !!pool, head, minted, size, entries };
}

/**
 * settle_mint instructions for the consecutive fulfilled entries starting at the head
 * (stops at the first unfulfilled / unrequested one, after `upToMintIndex`, or after `max`).
 */
export function settleIxsFromQueue(
  q: RevealQueue,
  programId: PublicKey,
  opts: { max?: number; upToMintIndex?: number } = {}
): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  for (const e of q.entries) {
    if (out.length >= (opts.max ?? 3)) break;
    if (opts.upToMintIndex !== undefined && e.mintIndex > opts.upToMintIndex) break;
    if (!e.nftMint || !e.fulfilled) break;
    out.push(buildSettleMintIx({ nftMint: new PublicKey(e.nftMint), attempt: e.attempt, programId }));
  }
  return out;
}
