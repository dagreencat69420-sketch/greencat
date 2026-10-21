import { rarityFromU8, rawToUi, RARITY_U8, type Rarity } from "@greencat/sdk";
import type { Db } from "../db";

export type ListingSort = "price_asc" | "price_desc" | "recent" | "token_id";
export const LISTING_SORTS: ListingSort[] = ["price_asc", "price_desc", "recent", "token_id"];

export type ListingQuery = {
  rarity?: Rarity[];
  minPriceRaw?: bigint;
  maxPriceRaw?: bigint;
  seller?: string;
  sort?: ListingSort;
  limit?: number;
  offset?: number;
};

export type ListingItem = {
  nftMint: string;
  seller: string;
  priceRaw: string;
  priceUi: number;
  tokenId: number | null;
  rarity: Rarity | null;
  listedSig: string | null;
  listedSlot: number | null;
  updatedAt: string;
};

const ORDER: Record<ListingSort, string> = {
  price_asc: "l.price_raw ASC, l.nft_mint ASC",
  price_desc: "l.price_raw DESC, l.nft_mint ASC",
  recent: "l.listed_slot DESC NULLS LAST, l.nft_mint ASC",
  token_id: "n.token_id ASC NULLS LAST, l.nft_mint ASC",
};

export async function queryListings(db: Db, q: ListingQuery, gcDecimals: number) {
  const where: string[] = ["l.active = TRUE"];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (q.rarity?.length) where.push(`n.rarity = ANY(${p(q.rarity.map((r) => RARITY_U8[r]))}::smallint[])`);
  if (q.minPriceRaw !== undefined) where.push(`l.price_raw >= ${p(q.minPriceRaw.toString())}::numeric`);
  if (q.maxPriceRaw !== undefined) where.push(`l.price_raw <= ${p(q.maxPriceRaw.toString())}::numeric`);
  if (q.seller) where.push(`l.seller = ${p(q.seller)}`);
  const whereSql = where.join(" AND ");
  const limit = Math.min(100, Math.max(1, q.limit ?? 24));
  const offset = Math.max(0, q.offset ?? 0);
  const order = ORDER[q.sort ?? "price_asc"];

  const { rows } = await db.query<{
    nft_mint: string;
    seller: string;
    price_raw: string;
    listed_sig: string | null;
    listed_slot: string | number | null;
    updated_at: string | Date;
    token_id: number | null;
    rarity: number | null;
  }>(
    `SELECT l.nft_mint, l.seller, l.price_raw::text AS price_raw, l.listed_sig, l.listed_slot,
            l.updated_at, n.token_id, n.rarity
       FROM listings l LEFT JOIN nfts n ON n.mint = l.nft_mint
      WHERE ${whereSql}
      ORDER BY ${order}
      LIMIT ${p(limit)} OFFSET ${p(offset)}`,
    params
  );
  const countParams = params.slice(0, params.length - 2);
  const { rows: cnt } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM listings l LEFT JOIN nfts n ON n.mint = l.nft_mint WHERE ${whereSql}`,
    countParams
  );
  const items: ListingItem[] = rows.map((r) => ({
    nftMint: r.nft_mint,
    seller: r.seller,
    priceRaw: r.price_raw,
    priceUi: rawToUi(BigInt(r.price_raw), gcDecimals),
    tokenId: r.token_id ?? null,
    rarity: r.rarity === null || r.rarity === undefined ? null : rarityFromU8(Number(r.rarity)),
    listedSig: r.listed_sig,
    listedSlot: r.listed_slot === null ? null : Number(r.listed_slot),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
  return { items, total: Number(cnt[0]?.n ?? 0), limit, offset };
}

export async function getNft(db: Db, mint: string, gcDecimals: number) {
  const { rows: n } = await db.query<{
    mint: string;
    token_id: number | null;
    rarity: number | null;
    minter: string | null;
    owner: string | null;
    minted_sig: string | null;
    minted_slot: string | number | null;
  }>("SELECT mint, token_id, rarity, minter, owner, minted_sig, minted_slot FROM nfts WHERE mint = $1", [mint]);
  const { rows: l } = await db.query<{
    seller: string;
    price_raw: string;
    active: boolean;
    listed_sig: string | null;
    listed_slot: string | number | null;
  }>("SELECT seller, price_raw::text AS price_raw, active, listed_sig, listed_slot FROM listings WHERE nft_mint = $1", [mint]);
  const { rows: o } = await db.query<{ bidder: string; amount_raw: string; sig: string | null }>(
    "SELECT bidder, amount_raw::text AS amount_raw, sig FROM offers WHERE nft_mint = $1 AND active = TRUE ORDER BY amount_raw DESC",
    [mint]
  );
  const { rows: t } = await db.query<{
    kind: string;
    buyer: string | null;
    seller: string | null;
    price_raw: string;
    fee_raw: string | null;
    sig: string;
    slot: string | number | null;
    traded_at: string | Date;
  }>(
    `SELECT kind, buyer, seller, price_raw::text AS price_raw, fee_raw::text AS fee_raw, sig, slot, traded_at
       FROM trades WHERE nft_mint = $1 ORDER BY slot DESC NULLS LAST LIMIT 20`,
    [mint]
  );
  if (!n.length && !l.length && !o.length && !t.length) return null;
  const nft = n[0];
  const ui = (raw: string) => rawToUi(BigInt(raw), gcDecimals);
  return {
    mint,
    tokenId: nft?.token_id ?? null,
    rarity: nft?.rarity === null || nft?.rarity === undefined ? null : rarityFromU8(Number(nft.rarity)),
    minter: nft?.minter ?? null,
    owner: nft?.owner ?? null,
    mintedSig: nft?.minted_sig ?? null,
    mintedSlot: nft?.minted_slot == null ? null : Number(nft.minted_slot),
    listing: l[0]
      ? {
          seller: l[0].seller,
          priceRaw: l[0].price_raw,
          priceUi: ui(l[0].price_raw),
          active: l[0].active,
          listedSig: l[0].listed_sig,
          listedSlot: l[0].listed_slot == null ? null : Number(l[0].listed_slot),
        }
      : null,
    offers: o.map((x) => ({ bidder: x.bidder, amountRaw: x.amount_raw, amountUi: ui(x.amount_raw), sig: x.sig })),
    trades: t.map((x) => ({
      kind: x.kind,
      buyer: x.buyer,
      seller: x.seller,
      priceRaw: x.price_raw,
      priceUi: ui(x.price_raw),
      feeRaw: x.fee_raw,
      sig: x.sig,
      slot: x.slot == null ? null : Number(x.slot),
      tradedAt: new Date(x.traded_at).toISOString(),
    })),
  };
}
