/**
 * Apply parsed program events to the marketplace tables. Idempotent per tx signature
 * (indexed_txs) and slot-guarded so out-of-order delivery (webhooks) can't regress state.
 */
import { parseProgramLogs, type IndexerEvent } from "@greencat/sdk";
import type { Db, Queryable } from "../db";

export type RawTxLike = {
  signature: string;
  slot: number;
  blockTime?: number | null;
  err?: unknown;
  logMessages?: readonly string[] | null;
};

export async function applyEventsTx(
  q: Queryable,
  events: IndexerEvent[],
  meta: { sig: string; slot: number; blockTime?: number | null }
): Promise<void> {
  const { sig, slot } = meta;
  const at = meta.blockTime ? new Date(meta.blockTime * 1000).toISOString() : new Date().toISOString();
  for (const e of events) {
    switch (e.type) {
      case "nft_minted": {
        // Unrevealed mints (audit GC-17) carry token_id 0 / rarity 255 → store NULL until
        // nft_revealed (emitted by settle_mint seconds after the mint since the instant-reveal upgrade). Never overwrite an already-revealed id (out-of-order delivery).
        const unrevealed = e.tokenId === 0 || e.rarity === 255;
        await q.query(
          `INSERT INTO nfts (mint, token_id, rarity, minter, owner, minted_sig, minted_slot, updated_at)
           VALUES ($1, $2, $3, $4, $4, $5, $6, $7)
           ON CONFLICT (mint) DO UPDATE SET
             token_id = COALESCE(nfts.token_id, EXCLUDED.token_id),
             rarity = COALESCE(nfts.rarity, EXCLUDED.rarity),
             minter = EXCLUDED.minter, minted_sig = EXCLUDED.minted_sig, minted_slot = EXCLUDED.minted_slot,
             owner = COALESCE(nfts.owner, EXCLUDED.owner), updated_at = EXCLUDED.updated_at`,
          [e.nftMint, unrevealed ? null : e.tokenId, unrevealed ? null : e.rarity, e.buyer, sig, slot, at]
        );
        break;
      }
      case "nft_revealed":
        await q.query(
          `INSERT INTO nfts (mint, token_id, rarity, updated_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (mint) DO UPDATE SET token_id = EXCLUDED.token_id, rarity = EXCLUDED.rarity,
             updated_at = EXCLUDED.updated_at`,
          [e.nftMint, e.tokenId, e.rarity, at]
        );
        break;
      case "list_nft":
        await q.query(
          `INSERT INTO listings (nft_mint, seller, price_raw, active, listed_slot, listed_sig, updated_slot, updated_at)
           VALUES ($1, $2, $3::numeric, TRUE, $4, $5, $4, $6)
           ON CONFLICT (nft_mint) DO UPDATE SET seller = EXCLUDED.seller, price_raw = EXCLUDED.price_raw,
             active = TRUE, listed_slot = EXCLUDED.listed_slot, listed_sig = EXCLUDED.listed_sig,
             updated_slot = EXCLUDED.updated_slot, updated_at = EXCLUDED.updated_at
           WHERE listings.updated_slot <= EXCLUDED.updated_slot`,
          [e.nftMint, e.seller, e.priceRaw, slot, sig, at]
        );
        await q.query(
          `INSERT INTO nfts (mint, owner) VALUES ($1, $2) ON CONFLICT (mint) DO NOTHING`,
          [e.nftMint, e.seller]
        );
        break;
      case "cancel_listing":
        await q.query(
          `INSERT INTO listings (nft_mint, seller, price_raw, active, updated_slot, updated_at)
           VALUES ($1, $2, 0, FALSE, $3, $4)
           ON CONFLICT (nft_mint) DO UPDATE SET active = FALSE, updated_slot = EXCLUDED.updated_slot,
             updated_at = EXCLUDED.updated_at
           WHERE listings.updated_slot <= EXCLUDED.updated_slot`,
          [e.nftMint, e.seller, slot, at]
        );
        break;
      case "buy_nft": {
        const { rows } = await q.query<{ seller: string }>(
          "SELECT seller FROM listings WHERE nft_mint = $1",
          [e.nftMint]
        );
        await q.query(
          `UPDATE listings SET active = FALSE, updated_slot = $2, updated_at = $3
            WHERE nft_mint = $1 AND updated_slot <= $2`,
          [e.nftMint, slot, at]
        );
        await q.query(
          `INSERT INTO trades (nft_mint, buyer, seller, price_raw, fee_raw, kind, sig, slot, traded_at)
           VALUES ($1, $2, $3, $4::numeric, $5::numeric, 'buy', $6, $7, $8) ON CONFLICT DO NOTHING`,
          [e.nftMint, e.buyer, rows[0]?.seller ?? null, e.priceRaw, e.feeRaw, sig, slot, at]
        );
        await setOwner(q, e.nftMint, e.buyer, at);
        break;
      }
      case "make_offer":
        await q.query(
          `INSERT INTO offers (nft_mint, bidder, amount_raw, active, sig, updated_slot, updated_at)
           VALUES ($1, $2, $3::numeric, TRUE, $4, $5, $6)
           ON CONFLICT (nft_mint, bidder) DO UPDATE SET amount_raw = EXCLUDED.amount_raw, active = TRUE,
             sig = EXCLUDED.sig, updated_slot = EXCLUDED.updated_slot, updated_at = EXCLUDED.updated_at
           WHERE offers.updated_slot <= EXCLUDED.updated_slot`,
          [e.nftMint, e.bidder, e.amountRaw, sig, slot, at]
        );
        break;
      case "cancel_offer":
        await q.query(
          `UPDATE offers SET active = FALSE, updated_slot = $3, updated_at = $4
            WHERE nft_mint = $1 AND bidder = $2 AND updated_slot <= $3`,
          [e.nftMint, e.bidder, slot, at]
        );
        break;
      case "accept_offer":
        await q.query(
          `UPDATE offers SET active = FALSE, updated_slot = $3, updated_at = $4
            WHERE nft_mint = $1 AND bidder = $2 AND updated_slot <= $3`,
          [e.nftMint, e.bidder, slot, at]
        );
        if (e.fromListing) {
          await q.query(
            `UPDATE listings SET active = FALSE, updated_slot = $2, updated_at = $3
              WHERE nft_mint = $1 AND updated_slot <= $2`,
            [e.nftMint, slot, at]
          );
        }
        await q.query(
          `INSERT INTO trades (nft_mint, buyer, seller, price_raw, fee_raw, kind, sig, slot, traded_at)
           VALUES ($1, $2, $3, $4::numeric, $5::numeric, 'accept_offer', $6, $7, $8) ON CONFLICT DO NOTHING`,
          [e.nftMint, e.bidder, e.owner, e.amountRaw, e.feeRaw, sig, slot, at]
        );
        await setOwner(q, e.nftMint, e.bidder, at);
        break;
      default:
        // other events are not marketplace state
        break;
    }
  }
}

async function setOwner(q: Queryable, mint: string, owner: string, at: string) {
  await q.query(
    `INSERT INTO nfts (mint, owner, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (mint) DO UPDATE SET owner = EXCLUDED.owner, updated_at = EXCLUDED.updated_at`,
    [mint, owner, at]
  );
}

/**
 * Ingest one transaction. Returns number of events applied (0 if already indexed/failed).
 */
export async function ingestTransaction(db: Db, programId: string, tx: RawTxLike): Promise<number> {
  const events = tx.err ? [] : parseProgramLogs(tx.logMessages ?? [], programId);
  return db.tx(async (q) => {
    const ins = await q.query(
      `INSERT INTO indexed_txs (sig, slot, block_time, events, failed) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sig) DO NOTHING RETURNING sig`,
      [tx.signature, tx.slot, tx.blockTime ?? null, events.length, !!tx.err]
    );
    if (!ins.rows.length) return 0;
    if (events.length) {
      await applyEventsTx(q, events, { sig: tx.signature, slot: tx.slot, blockTime: tx.blockTime });
    }
    return events.length;
  });
}
