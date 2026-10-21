/**
 * Browser/Node fetch client for apps/api (global Points + marketplace browse).
 * Enabled in the web app when NEXT_PUBLIC_API_URL is set; otherwise the app falls back to
 * the localStorage PointsStore adapter (offline / demo mode).
 */

import type { Rarity } from "./nftCatalog";
import type { SiwsSignInInput } from "./siws";

export type ApiLeaderboardEntry = {
  rank: number;
  wallet: string;
  displayName: string;
  points: number;
  streak: number;
};

export type ApiLeaderboard = { month: string; total: number; top: ApiLeaderboardEntry[] };

export type ApiMe = {
  wallet: string;
  displayName: string;
  month: string;
  points: number;
  rank: number | null;
  totalRanked: number;
  streak: number;
  streakMilestones: number[];
  claimedToday: boolean;
  lastClaimDate: string | null;
  today: string;
  nextReset: string;
  lofiToday: number;
  lofiDailyCap: number;
};

export type ApiClaim = {
  baseGained: number;
  milestoneBonus: number;
  milestonesHit: number[];
  gained: number;
  streak: number;
  total: number;
  today: string;
  month: string;
};

export type ApiBonusKind = "mint" | "stake" | "list";

export type ApiBonus = {
  kind: ApiBonusKind;
  gained: number;
  total: number;
  toast: string | null;
  verified: { instruction: string; slot: number };
  /** kind "list": points are credited later, once the listing stayed active long enough. */
  pending?: boolean;
  creditAt?: string;
};

export type ApiLofi = {
  status: "started" | "tick" | "waiting" | "capped";
  gained: number;
  lofiToday: number;
  lofiDailyCap: number;
  nextInMs: number;
  total: number;
};

export type ApiListing = {
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

export type ApiListingsPage = { items: ApiListing[]; total: number; limit: number; offset: number };

export type ApiListingsQuery = {
  rarity?: Rarity[];
  /** UI units ($GC) */
  minPrice?: string;
  maxPrice?: string;
  seller?: string;
  sort?: "price_asc" | "price_desc" | "recent" | "token_id";
  limit?: number;
  offset?: number;
};

/** `input` = Wallet Standard SolanaSignInInput for the same fields (API ≥ Oct 2026; older APIs omit it). */
export type ApiNonce = { nonce: string; message: string; expiresAt: string; input?: SiwsSignInInput };

/** wallet-adapter `signIn` (Wallet Standard `solana:signIn`): the wallet formats + signs the SIWS text itself. */
export type WalletSignInFn = (input: SiwsSignInInput) => Promise<{
  account: { address: string };
  signedMessage: Uint8Array;
  signature: Uint8Array;
}>;
export type ApiSession = { token: string; expiresAt: string; wallet: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
    /** Full JSON error body (e.g. `until`, `retryAfterMs`). */
    public data: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export class GreenCatApiClient {
  private token: string | null = null;

  constructor(
    public readonly baseUrl: string,
    private fetchImpl: typeof fetch = (...a) => fetch(...a)
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  setToken(token: string | null) {
    this.token = token;
  }

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown, auth = false): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      if (!this.token) throw new ApiError(401, "unauthorized", "Sign in with your wallet first");
      headers.Authorization = `Bearer ${this.token}`;
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      throw new ApiError(
        res.status,
        String(json.error ?? "http_error"),
        String(json.message ?? `HTTP ${res.status}`),
        Boolean(json.retryable),
        json
      );
    }
    return json as T;
  }

  health() {
    return this.req<{ ok: boolean; db: string; programId: string }>("GET", "/health");
  }

  requestNonce(wallet: string) {
    return this.req<ApiNonce>("POST", "/auth/nonce", { wallet });
  }

  verifySignIn(wallet: string, nonce: string, signatureBase64: string, signedMessageBase64?: string) {
    return this.req<ApiSession>("POST", "/auth/verify", {
      wallet,
      nonce,
      signature: signatureBase64,
      ...(signedMessageBase64 ? { signedMessage: signedMessageBase64 } : {}),
    });
  }

  /**
   * Full SIWS flow → stores token.
   *  1. `walletSignIn` given (wallet supports Wallet Standard `solana:signIn`, e.g. Phantom) and the API sent a
   *     signIn input: the wallet builds + signs the SIWS text; we send {signature, signedMessage}.
   *  2. Otherwise `signMessage(message)` over the API's exact text.
   * If signIn fails for a reason other than the user cancelling, falls back to signMessage (same nonce).
   */
  async signIn(
    wallet: string,
    signMessage?: ((msg: Uint8Array) => Promise<Uint8Array>) | null,
    walletSignIn?: WalletSignInFn | null
  ): Promise<ApiSession> {
    const { nonce, message, input } = await this.requestNonce(wallet);
    let session: ApiSession | null = null;
    if (walletSignIn && input) {
      try {
        const out = await walletSignIn(input);
        if (out.account.address !== wallet) {
          throw new Error(`Your wallet signed in with ${out.account.address.slice(0, 4)}…, not the connected ${wallet.slice(0, 4)}…. Switch accounts and retry.`);
        }
        session = await this.verifySignIn(wallet, nonce, bytesToBase64(out.signature), bytesToBase64(out.signedMessage));
      } catch (e) {
        const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
        if (!signMessage || /reject|cancel|declin|4001|signed in with/i.test(text) || e instanceof ApiError) throw e;
        console.warn("signIn feature failed, falling back to signMessage:", e);
      }
    }
    if (!session) {
      if (!signMessage) throw new Error("This wallet can't sign messages");
      const sig = await signMessage(new TextEncoder().encode(message));
      session = await this.verifySignIn(wallet, nonce, bytesToBase64(sig));
    }
    this.token = session.token;
    return session;
  }

  leaderboard(month?: string) {
    return this.req<ApiLeaderboard>("GET", `/leaderboard${month ? `?month=${encodeURIComponent(month)}` : ""}`);
  }

  me() {
    return this.req<ApiMe>("GET", "/me", undefined, true);
  }

  claim() {
    return this.req<ApiClaim>("POST", "/claim", {}, true);
  }

  bonus(kind: ApiBonusKind, signature: string) {
    return this.req<ApiBonus>("POST", "/bonus", { kind, signature }, true);
  }

  /** Retries while the API's RPC hasn't seen the tx yet (404 retryable). */
  async bonusWithRetry(kind: ApiBonusKind, signature: string, attempts = 5, delayMs = 2000): Promise<ApiBonus> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.bonus(kind, signature);
      } catch (e) {
        last = e;
        if (!(e instanceof ApiError) || !(e.retryable || e.status === 502)) throw e;
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
    throw last;
  }

  lofiHeartbeat() {
    return this.req<ApiLofi>("POST", "/lofi/heartbeat", {}, true);
  }

  listings(q: ApiListingsQuery = {}) {
    const p = new URLSearchParams();
    if (q.rarity?.length) p.set("rarity", q.rarity.join(","));
    if (q.minPrice) p.set("minPrice", q.minPrice);
    if (q.maxPrice) p.set("maxPrice", q.maxPrice);
    if (q.seller) p.set("seller", q.seller);
    if (q.sort) p.set("sort", q.sort);
    if (q.limit) p.set("limit", String(q.limit));
    if (q.offset) p.set("offset", String(q.offset));
    const qs = p.toString();
    return this.req<ApiListingsPage>("GET", `/listings${qs ? `?${qs}` : ""}`);
  }

  nft(mint: string) {
    return this.req<Record<string, unknown>>("GET", `/nft/${encodeURIComponent(mint)}`);
  }
}

function bytesToBase64(b: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(b).toString("base64");
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
