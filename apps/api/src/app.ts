/**
 * HTTP API (Hono). Public: /health, /leaderboard, /listings, /nft/:mint, /auth/*.
 * Session-required: /me, /claim, /bonus, /lofi/heartbeat.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { Connection } from "@solana/web3.js";
import { uiToRaw, vancouverMonthKey, RARITY_FROM_U8, type Rarity } from "@greencat/sdk";
import type { ApiConfig } from "./config";
import type { Db } from "./db";
import { AuthService, decodeMessageBytes, decodeSignature, parseWallet } from "./auth";
import { PointsError, PointsService } from "./points/service";
import { MarketPoints } from "./points/market";
import { RateLimiter } from "./rateLimit";
import {
  BONUS_KINDS,
  isValidTxSignature,
  verifyActivityTx,
  type BonusKind,
  type TxFetcher,
} from "./verify/activityTx";
import { LISTING_SORTS, getNft, queryListings, type ListingSort } from "./indexer/queries";
import { ingestTransaction } from "./indexer/store";

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export type AppDeps = {
  db: Db;
  config: ApiConfig;
  /** Override for tests; default = Connection(rpcUrl).getTransaction */
  fetchTx?: TxFetcher;
  now?: () => Date;
  rollDaily?: () => number;
};

type Env = { Variables: { wallet: string } };

export function createApp(deps: AppDeps) {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  const auth = new AuthService(db, config, now);
  const points = new PointsService(db, {
    now,
    rollDaily: deps.rollDaily,
    bonusDailyCaps: config.bonusDailyCaps,
  });
  const market = new MarketPoints(db, config.marketPoints, now);
  const limiter = new RateLimiter(() => now().getTime());
  let connection: Connection | null = null;
  const fetchTx: TxFetcher =
    deps.fetchTx ??
    ((sig) => {
      connection ??= new Connection(config.rpcUrl, config.bonusCommitment);
      return connection.getTransaction(sig, {
        commitment: config.bonusCommitment,
        maxSupportedTransactionVersion: 0,
      });
    });

  const app = new Hono<Env>();
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: (origin) =>
        config.corsOrigins.includes("*") ? origin || "*" : config.corsOrigins.includes(origin) ? origin : null,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      maxAge: 600,
    })
  );

  // AUDIT(API-01): client-supplied proxy headers are only trusted behind a proxy
  // (TRUST_PROXY=1). Previously `x-real-ip` was always honoured, so any caller
  // could rotate it to bypass the per-IP nonce/verify rate limits.
  const ip = (c: Context) =>
    (config.trustProxy
      ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip")
      : undefined) || "local";

  const limited = (c: Context, key: string, limit: number, windowMs: number) => {
    const wait = limiter.take(key, limit, windowMs);
    if (!wait) return null;
    c.header("Retry-After", String(Math.ceil(wait / 1000)));
    return c.json({ error: "rate_limited", message: "Too many requests", retryAfterMs: wait }, 429);
  };

  const body = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const requireSession = async (c: Context<Env>, next: () => Promise<void>) => {
    const h = c.req.header("authorization") || "";
    const m = /^Bearer (.+)$/i.exec(h);
    const wallet = m ? await auth.walletFromToken(m[1]) : null;
    if (!wallet) return c.json({ error: "unauthorized", message: "Sign in with your wallet first" }, 401);
    c.set("wallet", wallet);
    await next();
  };

  app.onError((err, c) => {
    if (err instanceof PointsError) {
      return c.json({ error: err.code, message: err.message, ...(err.extra ?? {}) }, err.status);
    }
    console.error("[api] unhandled", err);
    return c.json({ error: "internal", message: "Internal error" }, 500);
  });

  // ─── Health ──────────────────────────────────────────────────────────────
  app.get("/health", async (c) => {
    await db.query("SELECT 1");
    const { rows } = await db.query<{ last_sig: string | null; last_slot: string | null; updated_at: string | null }>(
      "SELECT last_sig, last_slot::text AS last_slot, updated_at FROM indexer_cursor WHERE id = 1"
    );
    return c.json({
      ok: true,
      db: db.kind,
      programId: config.programId,
      indexer: rows[0] ?? null,
      time: now().toISOString(),
    });
  });

  // ─── Auth (SIWS) ─────────────────────────────────────────────────────────
  app.post("/auth/nonce", async (c) => {
    const r = limited(c, `nonce:${ip(c)}`, 30, 60_000);
    if (r) return r;
    const wallet = parseWallet((await body(c)).wallet);
    if (!wallet) return c.json({ error: "bad_wallet", message: "wallet must be a base58 pubkey" }, 400);
    return c.json(await auth.issueNonce(wallet, c.req.header("origin")));
  });

  app.post("/auth/verify", async (c) => {
    const r = limited(c, `verify:${ip(c)}`, 30, 60_000);
    if (r) return r;
    const b = await body(c);
    const wallet = parseWallet(b.wallet);
    const sig = decodeSignature(b.signature);
    if (!wallet || typeof b.nonce !== "string" || !sig) {
      return c.json({ error: "bad_request", message: "wallet, nonce and 64-byte signature required" }, 400);
    }
    let signedMessage: Uint8Array | undefined;
    if (b.signedMessage !== undefined) {
      signedMessage = decodeMessageBytes(b.signedMessage) ?? undefined;
      if (!signedMessage) return c.json({ error: "bad_request", message: "signedMessage must be base64 (max 2 KB)" }, 400);
    }
    const out = await auth.verify(wallet, b.nonce, sig, signedMessage);
    if (!out.ok) return c.json({ error: out.code, message: out.message }, 401);
    return c.json({ token: out.token, expiresAt: out.expiresAt, wallet });
  });

  // ─── Points ──────────────────────────────────────────────────────────────
  app.get("/leaderboard", async (c) => {
    const month = c.req.query("month") || vancouverMonthKey(now());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return c.json({ error: "bad_month", message: "month must be YYYY-MM" }, 400);
    }
    const lb = await points.leaderboard(month, 10);
    c.header("Cache-Control", "public, max-age=5");
    return c.json(lb);
  });

  app.get("/me", requireSession, async (c) => c.json(await points.me(c.get("wallet"))));

  app.post("/claim", requireSession, async (c) => {
    const wallet = c.get("wallet");
    const r = limited(c, `claim:${wallet}`, 10, 60_000);
    if (r) return r;
    return c.json(await points.claim(wallet));
  });

  app.post("/bonus", requireSession, async (c) => {
    const wallet = c.get("wallet");
    const r = limited(c, `bonus:${wallet}`, 30, 60_000);
    if (r) return r;
    const b = await body(c);
    const kind = b.kind as BonusKind;
    const signature = b.signature;
    if (!BONUS_KINDS.includes(kind)) {
      return c.json({ error: "bad_kind", message: `kind must be one of ${BONUS_KINDS.join(", ")}` }, 400);
    }
    if (!isValidTxSignature(signature)) {
      return c.json({ error: "bad_signature", message: "signature must be a base58 tx signature" }, 400);
    }
    if (await points.signatureUsed(signature)) {
      return c.json({ error: "replay", message: "This transaction signature was already used for a bonus" }, 409);
    }
    let tx;
    try {
      tx = await fetchTx(signature);
    } catch (e) {
      return c.json({ error: "rpc_error", message: `RPC error: ${(e as Error).message}`, retryable: true }, 502);
    }
    const v = verifyActivityTx(tx, {
      wallet,
      kind,
      programId: config.programId,
      nowSec: Math.floor(now().getTime() / 1000),
      maxAgeSec: config.bonusMaxTxAgeSec,
      minAmountRaw: kind === "mint" ? undefined : config.bonusMinAmountsRaw[kind],
    });
    if (!v.ok) {
      return c.json({ error: v.code, message: v.message, retryable: !!v.retryable }, v.retryable ? 404 : 422);
    }
    if (kind === "list") {
      // Listing points are deferred + capped (list/delist loop fix) — see points/market.ts.
      if (!v.listing) return c.json({ error: "missing_event", message: "list_nft event not found" }, 422);
      const pending = await market.registerListing(wallet, signature, v.listing.nftMint, v.blockTime);
      return c.json({ ...pending, verified: { instruction: v.instruction, slot: v.slot } }, 202);
    }
    const out = await points.awardVerifiedBonus(wallet, kind, signature, {
      instruction: v.instruction,
      slot: v.slot,
      blockTime: v.blockTime,
    });
    return c.json({ ...out, verified: { instruction: v.instruction, slot: v.slot } });
  });

  app.post("/lofi/heartbeat", requireSession, async (c) => {
    const wallet = c.get("wallet");
    const r = limited(c, `lofi:${wallet}`, 12, 60_000);
    if (r) return r;
    return c.json(await points.lofiHeartbeat(wallet));
  });

  // ─── Marketplace (indexer-backed) ────────────────────────────────────────
  app.get("/listings", async (c) => {
    const q = c.req.query();
    let rarity: Rarity[] | undefined;
    if (q.rarity) {
      rarity = q.rarity.split(",").map((s) => s.trim().toLowerCase()) as Rarity[];
      if (rarity.some((r) => !RARITY_FROM_U8.includes(r))) {
        return c.json({ error: "bad_rarity", message: `rarity ∈ ${RARITY_FROM_U8.join(",")}` }, 400);
      }
    }
    const sort = (q.sort || "price_asc") as ListingSort;
    if (!LISTING_SORTS.includes(sort)) {
      return c.json({ error: "bad_sort", message: `sort ∈ ${LISTING_SORTS.join(",")}` }, 400);
    }
    const price = (raw?: string, ui?: string): bigint | undefined => {
      if (raw && /^\d{1,20}$/.test(raw)) return BigInt(raw);
      if (ui && /^\d+(\.\d+)?$/.test(ui)) return uiToRaw(ui, config.gcDecimals);
      return undefined;
    };
    const seller = q.seller ? parseWallet(q.seller) : undefined;
    if (q.seller && !seller) return c.json({ error: "bad_seller" }, 400);
    const out = await queryListings(
      db,
      {
        rarity,
        minPriceRaw: price(q.minPriceRaw, q.minPrice),
        maxPriceRaw: price(q.maxPriceRaw, q.maxPrice),
        seller: seller ?? undefined,
        sort,
        limit: q.limit ? Number(q.limit) || 24 : 24,
        offset: q.offset ? Number(q.offset) || 0 : 0,
      },
      config.gcDecimals
    );
    c.header("Cache-Control", "public, max-age=3");
    return c.json(out);
  });

  app.get("/nft/:mint", async (c) => {
    const mint = parseWallet(c.req.param("mint"));
    if (!mint) return c.json({ error: "bad_mint" }, 400);
    const nft = await getNft(db, mint, config.gcDecimals);
    if (!nft) return c.json({ error: "not_found", message: "Mint not indexed" }, 404);
    return c.json(nft);
  });

  // ─── Optional Helius raw-webhook ingest ──────────────────────────────────
  app.post("/webhooks/helius", async (c) => {
    if (!config.heliusWebhookSecret) return c.json({ error: "disabled" }, 404);
    // AUDIT(API-02): constant-time comparison of the shared secret.
    if (!safeEqual(c.req.header("authorization") ?? "", config.heliusWebhookSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const payload = await c.req.json().catch(() => null);
    const items = Array.isArray(payload) ? payload : [];
    let events = 0;
    for (const it of items as Array<Record<string, any>>) {
      const sig = it?.transaction?.signatures?.[0] ?? it?.signature;
      if (typeof sig !== "string") continue;
      events += await ingestTransaction(db, config.programId, {
        signature: sig,
        slot: Number(it.slot ?? 0),
        blockTime: it.blockTime ?? null,
        err: it.meta?.err ?? null,
        logMessages: it.meta?.logMessages ?? [],
      });
    }
    return c.json({ ok: true, received: items.length, events });
  });

  return app;
}
