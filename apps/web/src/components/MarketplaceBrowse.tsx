"use client";

import { useCallback, useEffect, useState } from "react";
import {
  RARITY_COLORS,
  RARITY_LABELS,
  type ApiListingsPage,
  type ApiListingsQuery,
  type Rarity,
} from "@greencat/sdk";
import { publicApi } from "@/lib/api";
import { formatGc } from "@/lib/balances";
import { NftImage, NftTraits } from "@/components/NftArt";
import { btn, EmptyState, ErrorNotice, Skeleton, focusRing } from "@/components/ui";

const RARITIES: Rarity[] = ["legendary", "rare", "uncommon", "common"];
const PAGE = 12;

/** Indexer-backed browse (GET /listings). Rendered only when NEXT_PUBLIC_API_URL is set. */
export function MarketplaceBrowse({ onSelect }: { onSelect: (mint: string) => void }) {
  const [rarity, setRarity] = useState<Rarity[]>([]);
  const [sort, setSort] = useState<NonNullable<ApiListingsQuery["sort"]>>("price_asc");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ApiListingsPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!publicApi) return;
    setLoading(true);
    setErr(null);
    try {
      setData(
        await publicApi.listings({
          rarity,
          sort,
          minPrice: minPrice.trim() || undefined,
          maxPrice: maxPrice.trim() || undefined,
          limit: PAGE,
          offset,
        })
      );
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, [rarity, sort, minPrice, maxPrice, offset]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(t);
  }, [load]);

  const toggleRarity = (r: Rarity) => {
    setOffset(0);
    setRarity((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));
  };

  const total = data?.total ?? 0;
  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-gc-lime">Browse listings</p>
        <span className="text-[11px] text-gc-mute">{total} active · indexer API</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {RARITIES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => toggleRarity(r)}
            aria-pressed={rarity.includes(r)}
            className={`min-h-[36px] rounded-full border px-3 text-xs ${focusRing} ${
              rarity.includes(r) ? "border-gc-lime bg-gc-lime/15 text-gc-lime" : "border-gc-border text-gc-mute"
            }`}
          >
            {RARITY_LABELS[r]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2 text-[11px] text-gc-mute min-[420px]:grid-cols-3">
        <label>
          Sort
          <select
            value={sort}
            onChange={(e) => {
              setOffset(0);
              setSort(e.target.value as typeof sort);
            }}
            className="mt-1 w-full rounded-lg border border-gc-border bg-black/40 min-h-[40px] px-2 py-1 text-sm text-white"
          >
            <option value="price_asc">Price ↑</option>
            <option value="price_desc">Price ↓</option>
            <option value="recent">Recently listed</option>
            <option value="token_id">Token #</option>
          </select>
        </label>
        <label>
          Min $GC
          <input
            value={minPrice}
            inputMode="decimal"
            onChange={(e) => {
              setOffset(0);
              setMinPrice(e.target.value);
            }}
            className="mt-1 w-full rounded-lg border border-gc-border bg-black/40 min-h-[40px] px-2 py-1 text-sm text-white"
          />
        </label>
        <label>
          Max $GC
          <input
            value={maxPrice}
            inputMode="decimal"
            onChange={(e) => {
              setOffset(0);
              setMaxPrice(e.target.value);
            }}
            className="mt-1 w-full rounded-lg border border-gc-border bg-black/40 min-h-[40px] px-2 py-1 text-sm text-white"
          />
        </label>
      </div>

      {err ? <ErrorNotice error={err} onRetry={() => void load()} /> : null}
      {loading && !data && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="status">
          <span className="sr-only">Loading listings…</span>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="aspect-[3/4]" />
          ))}
        </div>
      )}
      {data && data.items.length === 0 && (
        <EmptyState icon="🔍" title="No listings match">
          Try clearing a filter or widening the price range.
        </EmptyState>
      )}
      {data && data.items.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {data.items.map((l) => (
            <li key={l.nftMint}>
              <button
                type="button"
                onClick={() => onSelect(l.nftMint)}
                className={`w-full rounded-lg border border-gc-border bg-gc-panel/60 p-2 text-left hover:border-gc-lime/50 ${focusRing}`}
              >
                {l.tokenId !== null && (
                  <NftImage tokenId={l.tokenId} rarity={l.rarity ?? undefined} className="mb-2" />
                )}
                <p className="text-xs font-semibold text-white">
                  {l.tokenId !== null ? `GreenCat #${l.tokenId}` : `${l.nftMint.slice(0, 4)}…${l.nftMint.slice(-4)}`}
                </p>
                {l.rarity && (
                  <p className="text-[10px] uppercase" style={{ color: RARITY_COLORS[l.rarity] }}>
                    {RARITY_LABELS[l.rarity]}
                  </p>
                )}
                {l.tokenId !== null && (
                  <div className="mt-1">
                    <NftTraits tokenId={l.tokenId} compact />
                  </div>
                )}
                <p className="mt-1 text-xs font-bold text-gc-neon">{formatGc(l.priceUi)} $GC</p>
              </button>
            </li>
          ))}
        </ul>
      )}
      {total > PAGE && (
        <div className="flex items-center justify-between text-[11px] text-gc-mute">
          <button
            type="button"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
            className={btn.small}
          >
            ← Prev
          </button>
          <span>
            Page {page} / {pages}
          </span>
          <button
            type="button"
            disabled={offset + PAGE >= total || loading}
            onClick={() => setOffset(offset + PAGE)}
            className={btn.small}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
