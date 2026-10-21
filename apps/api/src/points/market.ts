/**
 * Marketplace points — anti-farming rules (fixes the list → delist → relist loop).
 *
 * LISTING POINTS (deferred, indexer-verified)
 *  - POST /bonus {kind:"list"} only REGISTERS a pending award after verifying the list tx.
 *  - The settler credits it once the indexer shows that SAME listing (listings.listed_sig = tx)
 *    stayed active for ≥ listMinActiveSec (default 10 min). Cancelled/replaced sooner → void.
 *  - At most one listing award per NFT mint per listNftWindowSec (default 24h rolling), across
 *    ALL wallets and including voided attempts — so cancel+relist, relisting, or handing the NFT
 *    to a second wallet and relisting all earn nothing inside the window.
 *  - Per wallet: listing points for at most listMaxNftsPerDay distinct NFTs per rolling 24h.
 *  - Delisting never deducts.
 *
 * SALE POINTS (indexer-driven, no client call)
 *  - Every indexed trade (buy / accept_offer) gets exactly one decision row in sale_awards.
 *  - Seller gets salePointsSeller, buyer gets salePointsBuyer, unless:
 *      buyer == seller · price < saleMinPriceRaw · the same two wallets (either direction)
 *      traded this NFT within salePairCooldownSec · the NFT already earned sale points within
 *      saleNftCooldownSec (stops A→B→C→A rings) · trade older than saleMaxAgeSec (backfill).
 *  - Per wallet per role: at most saleMaxPerDay rewarded sales per rolling 24h.
 */
import { vancouverDateKey, vancouverMonthKey } from "@greencat/sdk";
import type { MarketPointsConfig } from "../config";
import type { Db, Queryable } from "../db";
import { awardInTx, lockWallet, PointsError } from "./service";

const DAY_MS = 86_400_000;

type ListingAwardRow = {
  id: string;
  wallet: string;
  nft_mint: string;
  tx_sig: string;
  listed_at: Date | string;
  created_at: Date | string;
};

type TradeRow = {
  id: string;
  nft_mint: string;
  buyer: string | null;
  seller: string | null;
  price_raw: string;
  sig: string;
  traded_at: Date | string;
};

const ms = (d: Date | string) => (d instanceof Date ? d.getTime() : Date.parse(d));
const iso = (t: number) => new Date(t).toISOString();

export type SettleResult = { listAwarded: number; listVoided: number; salesDecided: number; salePointsAwarded: number };

export class MarketPoints {
  constructor(
    private db: Db,
    private cfg: MarketPointsConfig,
    private nowFn: () => Date = () => new Date()
  ) {}

  private now() {
    return this.nowFn();
  }

  /** Register a verified list tx. Throws PointsError when the NFT window / wallet cap blocks it. */
  async registerListing(wallet: string, txSig: string, nftMint: string, listedAtSec: number | null) {
    const now = this.now();
    const nowMs = now.getTime();
    const listedAtMs = listedAtSec ? listedAtSec * 1000 : nowMs;
    const month = vancouverMonthKey(now);
    const cfg = this.cfg;
    return this.db.tx(async (q) => {
      const state = await lockWallet(q, wallet, month); // serialises per-wallet cap checks
      const { rows: dup } = await q.query("SELECT 1 FROM listing_awards WHERE tx_sig = $1", [txSig]);
      if (dup.length) throw new PointsError(409, "replay", "This transaction signature was already used for a bonus");
      const { rows: recent } = await q.query<{ status: string; listed_at: string }>(
        `SELECT status, listed_at FROM listing_awards
          WHERE nft_mint = $1 AND listed_at > $2 ORDER BY listed_at DESC LIMIT 1`,
        [nftMint, iso(Math.max(nowMs, listedAtMs) - cfg.listNftWindowSec * 1000)]
      );
      if (recent.length) {
        throw new PointsError(
          409,
          "list_nft_window",
          `This NFT already had a listing-points attempt in the last ${Math.round(cfg.listNftWindowSec / 3600)}h — relisting or cancel+relist earns nothing until the window passes`,
          { nextEligibleAt: iso(ms(recent[0].listed_at) + cfg.listNftWindowSec * 1000) }
        );
      }
      const { rows: cnt } = await q.query<{ n: number }>(
        `SELECT COUNT(DISTINCT nft_mint)::int AS n FROM listing_awards
          WHERE wallet = $1 AND status IN ('pending','awarded') AND created_at > $2`,
        [wallet, iso(nowMs - DAY_MS)]
      );
      if (Number(cnt[0]?.n ?? 0) >= cfg.listMaxNftsPerDay) {
        throw new PointsError(
          429,
          "list_daily_cap",
          `Listing points are limited to ${cfg.listMaxNftsPerDay} different NFTs per 24h`
        );
      }
      await q.query(
        `INSERT INTO listing_awards (wallet, nft_mint, tx_sig, listed_at, status, created_at)
         VALUES ($1, $2, $3, $4, 'pending', $5)`,
        [wallet, nftMint, txSig, iso(listedAtMs), iso(nowMs)]
      );
      const creditAt = iso(listedAtMs + cfg.listMinActiveSec * 1000);
      const mins = Math.round(cfg.listMinActiveSec / 60);
      return {
        kind: "list" as const,
        gained: 0,
        pending: true,
        creditAt,
        nftMint,
        total: state.points ?? 0,
        toast: `+${cfg.listPoints} listing points will be credited if it stays listed for ${mins} min`,
      };
    });
  }

  /** Credit / void pending listing awards and decide new trades. Safe to run concurrently. */
  async settle(): Promise<SettleResult> {
    const out: SettleResult = { listAwarded: 0, listVoided: 0, salesDecided: 0, salePointsAwarded: 0 };
    const { rows: pending } = await this.db.query<{ id: string }>(
      "SELECT id FROM listing_awards WHERE status = 'pending' ORDER BY id LIMIT 500"
    );
    for (const p of pending) {
      const r = await this.settleListing(p.id);
      if (r === "awarded") out.listAwarded++;
      else if (r === "void") out.listVoided++;
    }
    const { rows: trades } = await this.db.query<{ id: string }>(
      `SELECT t.id FROM trades t LEFT JOIN sale_awards s ON s.trade_id = t.id
        WHERE s.trade_id IS NULL ORDER BY t.id LIMIT 500`
    );
    for (const t of trades) {
      const r = await this.decideTrade(t.id);
      if (r !== null) {
        out.salesDecided++;
        out.salePointsAwarded += r;
      }
    }
    return out;
  }

  private async settleListing(id: string): Promise<"awarded" | "void" | "wait"> {
    const now = this.now();
    const nowMs = now.getTime();
    const cfg = this.cfg;
    return this.db.tx(async (q) => {
      const { rows } = await q.query<ListingAwardRow>(
        "SELECT * FROM listing_awards WHERE id = $1 AND status = 'pending' FOR UPDATE",
        [id]
      );
      const p = rows[0];
      if (!p) return "wait";
      const voidIt = async (reason: string) => {
        await q.query("UPDATE listing_awards SET status = 'void', reason = $2, settled_at = $3 WHERE id = $1", [
          id,
          reason,
          iso(nowMs),
        ]);
        return "void" as const;
      };
      const listedAt = ms(p.listed_at);
      const { rows: ls } = await q.query<{ listed_sig: string | null; active: boolean; updated_at: Date | string }>(
        "SELECT listed_sig, active, updated_at FROM listings WHERE nft_mint = $1",
        [p.nft_mint]
      );
      const L = ls[0];
      if (!L || L.listed_sig !== p.tx_sig) {
        const { rows: seen } = await q.query("SELECT 1 FROM indexed_txs WHERE sig = $1", [p.tx_sig]);
        if (seen.length) return voidIt("replaced_before_min_active");
        if (nowMs - ms(p.created_at) > DAY_MS) return voidIt("not_indexed");
        return "wait";
      }
      const activeUntil = L.active ? nowMs : ms(L.updated_at);
      if (activeUntil - listedAt < cfg.listMinActiveSec * 1000) {
        return L.active ? "wait" : voidIt("delisted_before_min_active");
      }
      // Re-check the invariants at credit time (defence in depth).
      const { rows: other } = await q.query(
        `SELECT 1 FROM listing_awards WHERE nft_mint = $1 AND id <> $2 AND status = 'awarded' AND listed_at > $3`,
        [p.nft_mint, id, iso(listedAt - cfg.listNftWindowSec * 1000)]
      );
      if (other.length) return voidIt("nft_window");
      const { rows: cnt } = await q.query<{ n: number }>(
        `SELECT COUNT(DISTINCT nft_mint)::int AS n FROM listing_awards
          WHERE wallet = $1 AND status = 'awarded' AND settled_at > $2`,
        [p.wallet, iso(nowMs - DAY_MS)]
      );
      if (Number(cnt[0]?.n ?? 0) >= cfg.listMaxNftsPerDay) return voidIt("wallet_daily_cap");
      const r = await awardInTx(q, p.wallet, "list", cfg.listPoints, {
        month: vancouverMonthKey(now),
        today: vancouverDateKey(now),
        txSig: p.tx_sig,
        meta: { nftMint: p.nft_mint, listedAt: iso(listedAt), activeSec: Math.floor((activeUntil - listedAt) / 1000) },
      });
      if (!r.awarded) return voidIt("replay");
      await q.query(
        "UPDATE listing_awards SET status = 'awarded', amount = $2, reason = NULL, settled_at = $3 WHERE id = $1",
        [id, cfg.listPoints, iso(nowMs)]
      );
      return "awarded";
    });
  }

  /** Returns points awarded for this trade (0 if none), or null if another worker already decided it. */
  private async decideTrade(tradeId: string): Promise<number | null> {
    const now = this.now();
    const nowMs = now.getTime();
    const cfg = this.cfg;
    return this.db.tx(async (q) => {
      const { rows } = await q.query<TradeRow>(
        "SELECT id, nft_mint, buyer, seller, price_raw::text AS price_raw, sig, traded_at FROM trades WHERE id = $1",
        [tradeId]
      );
      const t = rows[0];
      if (!t) return null;
      const tradedAt = ms(t.traded_at);
      const ins = await q.query(
        `INSERT INTO sale_awards (trade_id, nft_mint, buyer, seller, traded_at, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (trade_id) DO NOTHING RETURNING trade_id`,
        [t.id, t.nft_mint, t.buyer, t.seller, iso(tradedAt), iso(nowMs)]
      );
      if (!ins.rows.length) return null;
      const decide = async (reason: string, sellerPts = 0, buyerPts = 0) => {
        await q.query(
          "UPDATE sale_awards SET reason = $2, seller_points = $3, buyer_points = $4 WHERE trade_id = $1",
          [t.id, reason, sellerPts, buyerPts]
        );
        return sellerPts + buyerPts;
      };
      if (nowMs - tradedAt > cfg.saleMaxAgeSec * 1000) return decide("too_old");
      if (!t.buyer || !t.seller) return decide("unknown_party");
      if (t.buyer === t.seller) return decide("self_trade");
      if (BigInt(t.price_raw) < cfg.saleMinPriceRaw) return decide("below_min_price");
      const { rows: pair } = await q.query(
        `SELECT 1 FROM trades
          WHERE nft_mint = $1 AND id <> $2 AND traded_at <= $3 AND traded_at > $4
            AND ((buyer = $5 AND seller = $6) OR (buyer = $6 AND seller = $5)) LIMIT 1`,
        [t.nft_mint, t.id, iso(tradedAt), iso(tradedAt - cfg.salePairCooldownSec * 1000), t.buyer, t.seller]
      );
      if (pair.length) return decide("pair_cooldown");
      const { rows: nftRecent } = await q.query(
        `SELECT 1 FROM sale_awards
          WHERE nft_mint = $1 AND trade_id <> $2 AND (seller_points > 0 OR buyer_points > 0)
            AND traded_at > $3 LIMIT 1`,
        [t.nft_mint, t.id, iso(tradedAt - cfg.saleNftCooldownSec * 1000)]
      );
      if (nftRecent.length) return decide("nft_cooldown");

      const since = iso(nowMs - DAY_MS);
      const count = async (col: "seller" | "buyer") => {
        const { rows: c } = await q.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM sale_awards WHERE ${col} = $1 AND ${col}_points > 0 AND decided_at > $2`,
          [col === "seller" ? t.seller : t.buyer, since]
        );
        return Number(c[0]?.n ?? 0);
      };
      const ctx = { month: vancouverMonthKey(now), today: vancouverDateKey(now) };
      // Lock both wallets in a stable order (no deadlocks between concurrent settlers).
      for (const w of [t.buyer, t.seller].sort()) await lockWallet(q, w, ctx.month);
      let sellerPts = (await count("seller")) < cfg.saleMaxPerDay ? cfg.salePointsSeller : 0;
      let buyerPts = (await count("buyer")) < cfg.saleMaxPerDay ? cfg.salePointsBuyer : 0;
      const meta = (role: string) => ({ role, nftMint: t.nft_mint, tradeSig: t.sig, priceRaw: t.price_raw });
      if (sellerPts > 0) {
        const r = await awardInTx(q, t.seller, "sale", sellerPts, { ...ctx, txSig: `sale:seller:${t.sig}:${t.nft_mint}`, meta: meta("seller") });
        if (!r.awarded) sellerPts = 0;
      }
      if (buyerPts > 0) {
        const r = await awardInTx(q, t.buyer, "sale", buyerPts, { ...ctx, txSig: `sale:buyer:${t.sig}:${t.nft_mint}`, meta: meta("buyer") });
        if (!r.awarded) buyerPts = 0;
      }
      const capped = [
        ...(cfg.salePointsSeller > 0 && sellerPts === 0 ? ["seller_daily_cap"] : []),
        ...(cfg.salePointsBuyer > 0 && buyerPts === 0 ? ["buyer_daily_cap"] : []),
      ];
      const reason = sellerPts + buyerPts > 0 ? ["awarded", ...capped].join(";") : capped.join(";") || "no_points_configured";
      return decide(reason, sellerPts, buyerPts);
    });
  }
}

/** Periodic settler (in-process). Returns a stop() handle. */
export function startPointsSettler(mp: MarketPoints, everyMs: number, log = console) {
  if (!everyMs || everyMs <= 0) return { stop: async () => undefined };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await mp.settle();
      if (r.listAwarded || r.listVoided || r.salesDecided) log.log(`[points] settle ${JSON.stringify(r)}`);
    } catch (e) {
      log.warn("[points] settle failed:", (e as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref?.();
  void tick();
  return {
    stop: async () => {
      clearInterval(timer);
    },
  };
}
