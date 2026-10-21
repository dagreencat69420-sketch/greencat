/**
 * Env-driven config for the GreenCat API + indexer worker. See apps/api/.env.example.
 */
import { randomBytes } from "node:crypto";
import { GREENCAT_PROGRAM_ID, SIWS_CHAIN_IDS, siwsChainIdFor, type SiwsChainId } from "@greencat/sdk";

export type ApiConfig = {
  port: number;
  /** postgres://… → node-postgres. Unset / "pglite" / "pglite:<dir>" / "memory" → embedded PGlite. */
  databaseUrl: string;
  rpcUrl: string;
  rpcWsUrl?: string;
  programId: string;
  jwtSecret: Uint8Array;
  jwtSecretIsEphemeral: boolean;
  sessionTtlSec: number;
  nonceTtlSec: number;
  /** Default SIWS domain/URI (used when the request's Origin isn't in siwsDomains, e.g. scripts). */
  siwsDomain: string;
  siwsUri: string;
  /**
   * Hosts allowed in the SIWS message (SIWS_DOMAINS, comma-separated, plus SIWS_DOMAIN). When the
   * request's Origin host matches one, the message names that host and URI = that Origin, so the
   * wallet popup matches the site the user is on (e.g. greencat-app.vercel.app and app.greencat69420.com).
   */
  siwsDomains: string[];
  /** SIWS Chain ID (SIWS_CHAIN_ID, else derived from RPC_URL: devnet/testnet/localnet/mainnet). */
  siwsChainId: SiwsChainId;
  corsOrigins: string[];
  trustProxy: boolean;
  /** Reject bonus txs older than this many seconds (0 = no limit). */
  bonusMaxTxAgeSec: number;
  bonusCommitment: "confirmed" | "finalized";
  /**
   * Per-kind daily caps for activity bonuses (audit API-03). Defaults to DEFAULT_BONUS_DAILY_CAPS;
   * set BONUS_DAILY_CAPS='{}' to disable explicitly.
   */
  bonusDailyCaps: Partial<Record<"mint" | "stake" | "list", number>>;
  /**
   * Minimum on-chain amount (raw GC base units) for a tx to earn a bonus (audit API-03).
   * Configured in whole GC via BONUS_MIN_AMOUNTS (JSON); '{}' disables.
   */
  bonusMinAmountsRaw: Partial<Record<"stake" | "list", bigint>>;
  /** Marketplace points anti-farming rules (see docs in src/points/market.ts). */
  marketPoints: MarketPointsConfig;
  /** How often the in-process settler credits deferred listing points / sale points (ms). 0 = off. */
  pointsSettleMs: number;
  gcDecimals: number;
  heliusWebhookSecret?: string;
  /** Run the indexer loop inside the API process (handy for single-dyno hosting). */
  runIndexer: boolean;
  indexerMode: "poll" | "ws";
  pollMs: number;
  /** ws mode: slow safety-net poll interval (logsSubscribe triggers the fast path). */
  safetyPollMs: number;
  indexerPageSize: number;
  indexerBackfillMax: number;
};


export type MarketPointsConfig = {
  /** Points for a listing that stayed active ≥ listMinActiveSec. */
  listPoints: number;
  /** A listing must stay active this long before it earns points (cancel sooner → nothing). */
  listMinActiveSec: number;
  /** At most one listing award per NFT mint per this rolling window (any wallet, any status). */
  listNftWindowSec: number;
  /** Per wallet: listing points for at most N distinct NFTs per rolling 24h. */
  listMaxNftsPerDay: number;
  /** Minimum list price (raw GC units) for a listing award. */
  listMinPriceRaw: bigint;
  salePointsSeller: number;
  salePointsBuyer: number;
  /** Minimum sale price (raw GC units) for sale points. */
  saleMinPriceRaw: bigint;
  /** No sale points when the same two wallets (either direction) traded this NFT within this window. */
  salePairCooldownSec: number;
  /** No sale points for an NFT that already earned sale points within this window (stops A→B→C→A rings). */
  saleNftCooldownSec: number;
  /** Per wallet per role: at most N sale awards per rolling 24h. */
  saleMaxPerDay: number;
  /** Trades older than this (vs. now) are never rewarded (backfill safety). */
  saleMaxAgeSec: number;
};

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
}

function list(v: string | undefined, d: string[]): string[] {
  const out = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return out.length ? out : d;
}

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === "") return d;
  return /^(1|true|yes|on)$/i.test(v);
}

/** Audit API-03 defaults: bounded farming even if the operator sets nothing. */
export const DEFAULT_BONUS_DAILY_CAPS = { mint: 10, stake: 3, list: 5 } as const;
/** Whole GC. stake/list stop dust-tx farming. */
export const DEFAULT_BONUS_MIN_AMOUNTS_GC = { stake: 1000, list: 100 } as const;

function parseJsonEnv<T>(name: string, v: string | undefined, d: T): T {
  if (v === undefined || v.trim() === "") return d;
  try {
    return JSON.parse(v) as T;
  } catch {
    throw new Error(`${name} must be JSON, e.g. {"list":5}`);
  }
}

/** Kinds that used to exist; silently dropped so old env values keep working (wheel removed Oct 12, 2026). */
const RETIRED_BONUS_KINDS = ["wheel"];

function validateCounts(name: string, o: Record<string, unknown>, allowed: readonly string[]) {
  for (const k of RETIRED_BONUS_KINDS) delete o[k];
  for (const [k, v] of Object.entries(o)) {
    if (!allowed.includes(k)) throw new Error(`${name}: unknown kind "${k}" (allowed: ${allowed.join(",")})`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${name}.${k} must be a number ≥ 0`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const isProd = env.NODE_ENV === "production";
  let jwtSecretIsEphemeral = false;
  let secret = env.JWT_SECRET?.trim();
  if (!secret) {
    if (isProd) {
      throw new Error("JWT_SECRET is required when NODE_ENV=production (≥32 random chars)");
    }
    secret = randomBytes(32).toString("hex");
    jwtSecretIsEphemeral = true;
  } else if (secret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters");
  }
  const port = num(env.PORT, 8787);
  const caps: ApiConfig["bonusDailyCaps"] = parseJsonEnv("BONUS_DAILY_CAPS", env.BONUS_DAILY_CAPS, {
    ...DEFAULT_BONUS_DAILY_CAPS,
  });
  validateCounts("BONUS_DAILY_CAPS", caps, ["mint", "stake", "list"]);
  const gcDecimals = num(env.GC_DECIMALS, 6);
  const minsGc = parseJsonEnv<Record<string, number>>("BONUS_MIN_AMOUNTS", env.BONUS_MIN_AMOUNTS, {
    ...DEFAULT_BONUS_MIN_AMOUNTS_GC,
  });
  validateCounts("BONUS_MIN_AMOUNTS", minsGc, ["stake", "list"]);
  const bonusMinAmountsRaw: ApiConfig["bonusMinAmountsRaw"] = {};
  for (const [k, v] of Object.entries(minsGc)) {
    bonusMinAmountsRaw[k as "stake" | "list"] =
      BigInt(Math.round(v * 1e6)) * 10n ** BigInt(gcDecimals) / 1_000_000n;
  }
  const gcRaw = (gc: number) => (BigInt(Math.round(gc * 1e6)) * 10n ** BigInt(gcDecimals)) / 1_000_000n;
  const listMinGc = num(env.LIST_POINTS_MIN_PRICE_GC, minsGc.list ?? 0);
  const marketPoints: MarketPointsConfig = {
    listPoints: num(env.LIST_POINTS, 10),
    listMinActiveSec: num(env.LIST_POINTS_MIN_ACTIVE_SEC, 600),
    listNftWindowSec: num(env.LIST_POINTS_NFT_WINDOW_SEC, 86_400),
    listMaxNftsPerDay: num(env.LIST_POINTS_MAX_NFTS_PER_DAY, 5),
    listMinPriceRaw: gcRaw(listMinGc),
    salePointsSeller: num(env.SALE_POINTS_SELLER, 10),
    salePointsBuyer: num(env.SALE_POINTS_BUYER, 5),
    saleMinPriceRaw: gcRaw(num(env.SALE_POINTS_MIN_PRICE_GC, listMinGc)),
    salePairCooldownSec: num(env.SALE_POINTS_PAIR_COOLDOWN_SEC, 7 * 86_400),
    saleNftCooldownSec: num(env.SALE_POINTS_NFT_COOLDOWN_SEC, 86_400),
    saleMaxPerDay: num(env.SALE_POINTS_MAX_PER_DAY, 5),
    saleMaxAgeSec: num(env.SALE_POINTS_MAX_AGE_SEC, 86_400),
  };
  return {
    port,
    databaseUrl: env.DATABASE_URL?.trim() || "pglite:./data/pglite",
    rpcUrl: env.RPC_URL?.trim() || "http://127.0.0.1:8899",
    rpcWsUrl: env.RPC_WS_URL?.trim() || undefined,
    programId: env.GREENCAT_PROGRAM_ID?.trim() || GREENCAT_PROGRAM_ID,
    jwtSecret: new TextEncoder().encode(secret),
    jwtSecretIsEphemeral,
    sessionTtlSec: num(env.SESSION_TTL_SEC, 3600),
    nonceTtlSec: num(env.NONCE_TTL_SEC, 300),
    siwsDomain: env.SIWS_DOMAIN?.trim() || "localhost:3001",
    siwsDomains: [
      ...new Set(
        [env.SIWS_DOMAIN?.trim() || "localhost:3001", ...(env.SIWS_DOMAINS || "").split(",")]
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      ),
    ],
    siwsChainId: (SIWS_CHAIN_IDS as readonly string[]).includes(env.SIWS_CHAIN_ID?.trim() ?? "")
      ? (env.SIWS_CHAIN_ID!.trim() as SiwsChainId)
      : siwsChainIdFor(env.SOLANA_NETWORK?.trim() || env.RPC_URL?.trim() || "http://127.0.0.1:8899"),
    siwsUri: env.SIWS_URI?.trim() || env.PUBLIC_API_URL?.trim() || `http://localhost:${port}`,
    corsOrigins: (env.CORS_ORIGINS || "http://localhost:3001")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: bool(env.TRUST_PROXY, false),
    bonusMaxTxAgeSec: num(env.BONUS_MAX_TX_AGE_SEC, 86_400),
    bonusCommitment: env.BONUS_COMMITMENT === "finalized" ? "finalized" : "confirmed",
    bonusDailyCaps: caps,
    bonusMinAmountsRaw,
    marketPoints,
    pointsSettleMs: num(env.POINTS_SETTLE_MS, 60_000),
    gcDecimals,
    heliusWebhookSecret: env.HELIUS_WEBHOOK_SECRET?.trim() || undefined,
    runIndexer: bool(env.RUN_INDEXER, false),
    indexerMode: env.INDEXER_MODE === "ws" ? "ws" : "poll",
    pollMs: num(env.POLL_MS, 5000),
    safetyPollMs: num(env.INDEXER_SAFETY_POLL_MS, 300_000),
    indexerPageSize: Math.min(1000, Math.max(1, num(env.INDEXER_PAGE_SIZE, 100))),
    indexerBackfillMax: num(env.INDEXER_BACKFILL_MAX, 5000),

  };
}

/** For logs: strips credentials from an RPC URL (query string such as `?api-key=…`, and user:pass). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    if (u.search) u.search = "?[redacted]";
    return u.toString();
  } catch {
    return "[unparseable url]";
  }
}
