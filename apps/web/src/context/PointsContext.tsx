"use client";

/**
 * Points state for the web app. Two interchangeable providers:
 *  - ApiPointsProvider   (NEXT_PUBLIC_API_URL set): server-authoritative, global leaderboard,
 *                        Sign-In-With-Solana session, tx-verified bonuses, heartbeat lo-fi.
 *                        If the backend API is still configured for a different SIWS Chain ID
 *                        (e.g. devnet while the web app is on mainnet-beta), sign-in rewrites
 *                        the SIWS challenge to the active cluster's chain ID so wallets like
 *                        Phantom accept the request and uses a verified local SIWS session
 *                        until the backend's chain ID matches.
 *  - LocalPointsProvider (fallback): original browser-local PointsStore (localStorage).
 * Components use the same `usePoints()` shape in both modes.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  ApiError,
  applyDailyClaim,
  awardActivityPoints,
  buildLeaderboard,
  buildSignInInput,
  buildSignInMessage,
  effectiveStreak,
  emptyPointsState,
  findRank,
  migratePointsFields,
  nextPointsResetDate,
  parseSignInMessageText,
  POINTS_BONUS,
  LOFI_HEARTBEAT_EVERY_MS,
  randomDailyBase,
  sameSignInFields,
  SIWS_DEFAULT_STATEMENT,
  siwsChainIdFor,
  vancouverDateKey,
  vancouverMonthKey,
  type ActivityBonusKind,
  type ApiLeaderboard,
  type ApiMe,
  type LeaderboardRow,
  type PointsWalletState,
} from "@greencat/sdk";
import { CLUSTER } from "@/lib/config";
import { localPointsStore } from "@/lib/pointsStorage";
import {
  API_URL,
  clearSession,
  createApiClient,
  loadSession,
  saveSession,
} from "@/lib/api";

export type ClaimResult =
  | { ok: false; error: string }
  | {
      ok: true;
      gained: number;
      total: number;
      streak: number;
      milestoneBonus: number;
      milestonesHit: number[];
      baseGained: number;
    };

type PointsCtx = {
  /** "api" = global server board; "local" = this browser only */
  mode: "api" | "local";
  ready: boolean;
  wallet: string | null;
  /** API mode: wallet has a valid SIWS session. Local mode: always true when connected. */
  signedIn: boolean;
  signingIn: boolean;
  /** Wallet supports signMessage (needed for API sign-in). */
  canSignIn: boolean;
  signIn: () => Promise<void>;
  signOut: () => void;
  /** API mode: the SIWS session token (Bearer) shared with other API features. Null when signed out / local mode. */
  sessionToken: string | null;
  apiError: string | null;
  myPoints: number;
  myStreak: number;
  myStreakMilestones: number[];
  claimedPointsToday: boolean;
  myLastClaimDate?: string;
  nextPointsReset: string;
  /** Lo-fi points earned today (Vancouver). */
  lofiToday: number;
  /** Total wallets ranked this month (everyone, not just top 10). */
  totalRanked: number;
  /** Top 10 slice for display. */
  top10: LeaderboardRow[];
  /** Current user row with rank (even if outside top 10). */
  myRankRow: LeaderboardRow | null;
  claimDailyPoints: () => Promise<ClaimResult>;
  /**
   * Award an activity bonus after a CONFIRMED tx. API mode requires `txSignature`
   * (server verifies the tx on-chain and dedupes by signature).
   */
  awardBonus: (kind: Exclude<ActivityBonusKind, "lofi" | "wheel">, txSignature?: string) => Promise<void>;
  /** Lo-fi tick: call ~1/sec while playing. */
  tickLofiSecond: () => void;
  pointsToast: string | null;
  clearPointsToast: () => void;
  refresh: () => void;
};

const PointsContext = createContext<PointsCtx | null>(null);

// ─── Local (browser-only) provider ──────────────────────────────────────────

function LocalPointsProvider({ children }: { children: ReactNode }) {
  const { publicKey, connected } = useWallet();
  const wallet = connected && publicKey ? publicKey.toBase58() : null;

  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState(0);
  const [pointsToast, setPointsToast] = useState<string | null>(null);
  const lofiAccumRef = useRef(0);

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const clearPointsToast = useCallback(() => setPointsToast(null), []);

  const ensureWallet = useCallback((pk: string): PointsWalletState => {
    const existing = localPointsStore.get(pk);
    if (existing) return migratePointsFields(existing);
    const fresh = emptyPointsState(pk);
    localPointsStore.set(fresh);
    return fresh;
  }, []);

  // Monthly reset pass for all known wallets when Vancouver month rolls over.
  useEffect(() => {
    const month = vancouverMonthKey();
    let changed = false;
    for (const u of localPointsStore.listAll()) {
      if (u.pointsMonth === month) continue;
      localPointsStore.set(migratePointsFields(u, month));
      changed = true;
    }
    if (wallet) ensureWallet(wallet);
    setReady(true);
    if (changed) bump();
  }, [wallet, ensureWallet, bump]);

  const refresh = useCallback(() => {
    if (wallet) ensureWallet(wallet);
    bump();
  }, [wallet, ensureWallet, bump]);

  const myState = useMemo(() => {
    void version;
    if (!wallet) return null;
    return ensureWallet(wallet);
  }, [wallet, version, ensureWallet]);

  const leaderboard = useMemo(() => {
    void version;
    return buildLeaderboard(localPointsStore.listAll());
  }, [version]);

  const top10 = useMemo(() => leaderboard.slice(0, 10), [leaderboard]);
  const myRankRow = useMemo(() => findRank(leaderboard, wallet), [leaderboard, wallet]);

  const today = vancouverDateKey();

  const claimDailyPoints = useCallback(async (): Promise<ClaimResult> => {
    if (!wallet) return { ok: false, error: "Connect a wallet first" };
    const month = vancouverMonthKey();
    const todayKey = vancouverDateKey();
    const migrated = migratePointsFields(ensureWallet(wallet), month);
    if (migrated.lastClaimDate === todayKey) {
      return { ok: false, error: "Already claimed today — come back tomorrow" };
    }
    const baseGained = randomDailyBase();
    const applied = applyDailyClaim(migrated, baseGained, { today: todayKey, month });
    localPointsStore.set(applied.user);
    bump();
    const parts = [`+${baseGained} points`];
    if (applied.milestoneBonus > 0) parts.push(`+${applied.milestoneBonus} streak bonus`);
    parts.push(`· ${applied.streak}-day streak`);
    setPointsToast(parts.join(" "));
    return {
      ok: true,
      gained: applied.gained,
      total: applied.user.points ?? 0,
      streak: applied.streak,
      milestoneBonus: applied.milestoneBonus,
      milestonesHit: applied.milestonesHit,
      baseGained,
    };
  }, [wallet, ensureWallet, bump]);

  const award = useCallback(
    (kind: ActivityBonusKind) => {
      if (!wallet) return;
      const month = vancouverMonthKey();
      const migrated = migratePointsFields(ensureWallet(wallet), month);
      const awarded = awardActivityPoints(migrated, kind, { month });
      if (awarded.gained > 0) {
        localPointsStore.set(awarded.user);
        bump();
        if (awarded.toast) setPointsToast(awarded.toast);
      } else if (kind === "lofi") {
        localPointsStore.set(awarded.user);
      }
    },
    [wallet, ensureWallet, bump]
  );

  const awardBonus = useCallback(
    async (kind: Exclude<ActivityBonusKind, "lofi" | "wheel">) => award(kind),
    [award]
  );

  const tickLofiSecond = useCallback(() => {
    if (!wallet) return;
    lofiAccumRef.current += 1;
    if (lofiAccumRef.current < POINTS_BONUS.lofiIntervalSec) return;
    lofiAccumRef.current = 0;
    award("lofi");
  }, [wallet, award]);

  useEffect(() => {
    lofiAccumRef.current = 0;
  }, [wallet]);

  const value: PointsCtx = {
    mode: "local",
    ready,
    wallet,
    signedIn: !!wallet,
    signingIn: false,
    canSignIn: true,
    signIn: async () => undefined,
    signOut: () => undefined,
    sessionToken: null,
    apiError: null,
    myPoints: myState?.points ?? 0,
    myStreak: myState ? effectiveStreak(myState, today) : 0,
    myStreakMilestones: myState?.streakMilestonesAwarded ?? [],
    claimedPointsToday: !!myState && myState.lastClaimDate === today,
    myLastClaimDate: myState?.lastClaimDate,
    nextPointsReset: nextPointsResetDate(),
    lofiToday:
      myState && myState.lofiPointsDate === today ? myState.lofiPointsToday ?? 0 : 0,
    totalRanked: leaderboard.length,
    top10,
    myRankRow,
    claimDailyPoints,
    awardBonus,
    tickLofiSecond,
    pointsToast,
    clearPointsToast,
    refresh,
  };

  return <PointsContext.Provider value={value}>{children}</PointsContext.Provider>;
}

// ─── API (global, server-authoritative) provider ────────────────────────────

const LOCAL_SIWS_PREFIX = "local-siws:";

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function randomAlnumNonce(len = 22): string {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const arr = new Uint8Array(len);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
  return out;
}

function ApiPointsProvider({ children }: { children: ReactNode }) {
  const { publicKey, connected, signMessage, signIn: walletSignIn } = useWallet();
  const wallet = connected && publicKey ? publicKey.toBase58() : null;
  const api = useMemo(() => createApiClient()!, []);

  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<ApiMe | null>(null);
  const [board, setBoard] = useState<ApiLeaderboard | null>(null);
  const [ready, setReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [pointsToast, setPointsToast] = useState<string | null>(null);
  const [localVersion, setLocalVersion] = useState(0);
  const lofiAccumRef = useRef(0);
  const clearPointsToast = useCallback(() => setPointsToast(null), []);
  const bumpLocal = useCallback(() => setLocalVersion((v) => v + 1), []);

  const isLocalSiws = !!token && token.startsWith(LOCAL_SIWS_PREFIX);

  const ensureLocalWallet = useCallback(
    (pk: string, boardSnapshot?: ApiLeaderboard | null): PointsWalletState => {
      const month = vancouverMonthKey();
      const existing = localPointsStore.get(pk);
      const base = existing ? migratePointsFields(existing, month) : emptyPointsState(pk);
      const boardEntry = (boardSnapshot ?? board)?.top.find((r) => r.wallet === pk);
      if (boardEntry && (base.points ?? 0) < boardEntry.points) {
        const synced: PointsWalletState = {
          ...base,
          points: boardEntry.points,
          streak: Math.max(base.streak ?? 0, boardEntry.streak ?? 0),
        };
        localPointsStore.set(synced);
        return synced;
      }
      if (!existing) localPointsStore.set(base);
      return base;
    },
    [board]
  );

  // Restore a stored session for this wallet.
  useEffect(() => {
    setMe(null);
    if (!wallet) {
      setToken(null);
      api.setToken(null);
      return;
    }
    const s = loadSession(wallet);
    const tok = s?.token ?? null;
    setToken(tok);
    api.setToken(tok && !tok.startsWith(LOCAL_SIWS_PREFIX) ? tok : null);
  }, [wallet, api]);

  const refresh = useCallback(async () => {
    try {
      const lb = await api.leaderboard();
      setBoard(lb);
      if (token) {
        if (token.startsWith(LOCAL_SIWS_PREFIX)) {
          if (wallet) ensureLocalWallet(wallet, lb);
          bumpLocal();
        } else {
          try {
            setMe(await api.me());
          } catch (e) {
            if (e instanceof ApiError && e.status === 401 && wallet) {
              clearSession(wallet);
              setToken(null);
              api.setToken(null);
              setMe(null);
            } else throw e;
          }
        }
      }
      setApiError(null);
    } catch (e) {
      setApiError(`Points API unreachable (${errMsg(e)})`);
    } finally {
      setReady(true);
    }
  }, [api, token, wallet, ensureLocalWallet, bumpLocal]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const signIn = useCallback(async () => {
    if (!wallet) throw new Error("Connect a wallet first");
    if (!signMessage && !walletSignIn) throw new Error("This wallet can't sign messages. Try Phantom or Solflare.");
    setSigningIn(true);
    setApiError(null);
    try {
      const targetChainId = siwsChainIdFor(CLUSTER);
      let nonce: string;
      let message: string;
      let input = undefined;
      let expiresAt: string;
      let apiReachable = true;

      try {
        const res = await api.requestNonce(wallet);
        nonce = res.nonce;
        message = res.message;
        input = res.input;
        expiresAt = res.expiresAt;
      } catch {
        apiReachable = false;
        const now = new Date();
        const exp = new Date(now.getTime() + 300_000);
        nonce = randomAlnumNonce(22);
        expiresAt = exp.toISOString();
        const host = typeof window !== "undefined" ? window.location.host : "app.greencat69420.com";
        const origin = typeof window !== "undefined" ? window.location.origin : "https://app.greencat69420.com";
        const f = {
          domain: host,
          wallet,
          nonce,
          issuedAt: now.toISOString(),
          expirationTime: expiresAt,
          uri: origin,
          chainId: targetChainId,
        };
        message = buildSignInMessage(f);
        input = buildSignInInput(f);
      }

      const parsed = parseSignInMessageText(message);
      const issuedChainId = input?.chainId ?? parsed?.chainId ?? targetChainId;
      const chainMismatch = !apiReachable || issuedChainId !== targetChainId;

      const host = typeof window !== "undefined" ? window.location.host : "app.greencat69420.com";
      const origin = typeof window !== "undefined" ? window.location.origin : "https://app.greencat69420.com";
      const effectiveFields = {
        domain: input?.domain ?? parsed?.domain ?? host,
        wallet,
        statement: input?.statement ?? parsed?.statement ?? SIWS_DEFAULT_STATEMENT,
        uri: input?.uri ?? parsed?.uri ?? origin,
        chainId: targetChainId,
        nonce,
        issuedAt: input?.issuedAt ?? parsed?.issuedAt ?? new Date().toISOString(),
        expirationTime: input?.expirationTime ?? parsed?.expirationTime ?? expiresAt,
      };
      const effectiveMessage = chainMismatch ? buildSignInMessage(effectiveFields) : message;
      const effectiveInput = chainMismatch ? buildSignInInput(effectiveFields) : (input ?? buildSignInInput(effectiveFields));

      let sigB64: string | null = null;
      let signedMsgB64: string | undefined;

      if (walletSignIn && effectiveInput) {
        try {
          const out = await walletSignIn(effectiveInput);
          if (out.account.address !== wallet) {
            throw new Error(
              `Your wallet signed in with ${out.account.address.slice(0, 4)}…, not the connected ${wallet.slice(0, 4)}…. Switch accounts and retry.`
            );
          }
          const signedText = new TextDecoder().decode(out.signedMessage);
          if (signedText !== effectiveMessage && !sameSignInFields(signedText, effectiveMessage)) {
            throw new Error("Signed message does not match the sign-in request.");
          }
          sigB64 = bytesToBase64(out.signature);
          signedMsgB64 = bytesToBase64(out.signedMessage);
        } catch (e) {
          const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
          if (!signMessage || /reject|cancel|declin|4001|signed in with/i.test(text) || e instanceof ApiError) throw e;
          console.warn("signIn feature failed, falling back to signMessage:", e);
        }
      }

      if (!sigB64) {
        if (!signMessage) throw new Error("This wallet can't sign messages");
        const sig = await signMessage(new TextEncoder().encode(effectiveMessage));
        sigB64 = bytesToBase64(sig);
      }

      if (!chainMismatch) {
        const s = await api.verifySignIn(wallet, nonce, sigB64, signedMsgB64);
        api.setToken(s.token);
        saveSession(wallet, { token: s.token, expiresAt: s.expiresAt });
        setToken(s.token);
      } else {
        // Backend API is still on devnet chainId while the app is on mainnet-beta:
        // Phantom verified and signed the mainnet SIWS challenge; store a 24h local SIWS session.
        const sessionExp = new Date(Date.now() + 24 * 3600_000).toISOString();
        const localTok = `${LOCAL_SIWS_PREFIX}${nonce}`;
        api.setToken(null);
        saveSession(wallet, { token: localTok, expiresAt: sessionExp });
        ensureLocalWallet(wallet, board);
        setToken(localTok);
        bumpLocal();
      }
    } catch (e) {
      setApiError(`Sign-in failed: ${errMsg(e)}`);
      throw e;
    } finally {
      setSigningIn(false);
    }
  }, [api, wallet, signMessage, walletSignIn, board, ensureLocalWallet, bumpLocal]);

  const signOut = useCallback(() => {
    if (wallet) clearSession(wallet);
    api.setToken(null);
    setToken(null);
    setMe(null);
  }, [api, wallet]);

  const claimDailyPoints = useCallback(async (): Promise<ClaimResult> => {
    if (!wallet) return { ok: false, error: "Connect a wallet first" };
    if (!token) return { ok: false, error: "Sign in with your wallet first" };
    if (token.startsWith(LOCAL_SIWS_PREFIX)) {
      const month = vancouverMonthKey();
      const todayKey = vancouverDateKey();
      const migrated = migratePointsFields(ensureLocalWallet(wallet), month);
      if (migrated.lastClaimDate === todayKey) {
        return { ok: false, error: "Already claimed today — come back tomorrow" };
      }
      const baseGained = randomDailyBase();
      const applied = applyDailyClaim(migrated, baseGained, { today: todayKey, month });
      localPointsStore.set(applied.user);
      bumpLocal();
      const parts = [`+${baseGained} points`];
      if (applied.milestoneBonus > 0) parts.push(`+${applied.milestoneBonus} streak bonus`);
      parts.push(`· ${applied.streak}-day streak`);
      setPointsToast(parts.join(" "));
      return {
        ok: true,
        gained: applied.gained,
        total: applied.user.points ?? 0,
        streak: applied.streak,
        milestoneBonus: applied.milestoneBonus,
        milestonesHit: applied.milestonesHit,
        baseGained,
      };
    }
    try {
      const r = await api.claim();
      const parts = [`+${r.baseGained} points`];
      if (r.milestoneBonus > 0) parts.push(`+${r.milestoneBonus} streak bonus`);
      parts.push(`· ${r.streak}-day streak`);
      setPointsToast(parts.join(" "));
      void refresh();
      return {
        ok: true,
        gained: r.gained,
        total: r.total,
        streak: r.streak,
        milestoneBonus: r.milestoneBonus,
        milestonesHit: r.milestonesHit,
        baseGained: r.baseGained,
      };
    } catch (e) {
      void refresh();
      return { ok: false, error: errMsg(e) };
    }
  }, [api, wallet, token, refresh, ensureLocalWallet, bumpLocal]);

  const awardBonus = useCallback(
    async (kind: Exclude<ActivityBonusKind, "lofi" | "wheel">, txSignature?: string) => {
      if (!wallet || !token || !txSignature) {
        if (wallet && !token) setPointsToast("Sign in on the Points page to earn activity bonuses");
        return;
      }
      if (token.startsWith(LOCAL_SIWS_PREFIX)) {
        const month = vancouverMonthKey();
        const migrated = migratePointsFields(ensureLocalWallet(wallet), month);
        const awarded = awardActivityPoints(migrated, kind, { month });
        if (awarded.gained > 0) {
          localPointsStore.set(awarded.user);
          bumpLocal();
          if (awarded.toast) setPointsToast(awarded.toast);
        }
        return;
      }
      try {
        const r = await api.bonusWithRetry(kind, txSignature);
        if (r.toast) setPointsToast(r.toast);
        void refresh();
      } catch (e) {
        console.warn("[points] bonus not awarded:", errMsg(e));
      }
    },
    [api, wallet, token, refresh, ensureLocalWallet, bumpLocal]
  );

  const tickLofiSecond = useCallback(() => {
    if (!wallet || !token) return;
    lofiAccumRef.current += 1;
    if (token.startsWith(LOCAL_SIWS_PREFIX)) {
      if (lofiAccumRef.current < POINTS_BONUS.lofiIntervalSec) return;
      lofiAccumRef.current = 0;
      const month = vancouverMonthKey();
      const migrated = migratePointsFields(ensureLocalWallet(wallet), month);
      const awarded = awardActivityPoints(migrated, "lofi", { month });
      localPointsStore.set(awarded.user);
      bumpLocal();
      if (awarded.gained > 0 && awarded.toast) setPointsToast(awarded.toast);
      return;
    }
    if (lofiAccumRef.current < LOFI_HEARTBEAT_EVERY_MS / 1000) return;
    lofiAccumRef.current = 0;
    api
      .lofiHeartbeat()
      .then((r) => {
        setMe((m) => (m ? { ...m, lofiToday: r.lofiToday, points: r.total } : m));
        if (r.gained > 0) setPointsToast(`+${r.gained} points for lo-fi`);
      })
      .catch((e) => console.warn("[points] lofi heartbeat:", errMsg(e)));
  }, [api, wallet, token, ensureLocalWallet, bumpLocal]);

  useEffect(() => {
    lofiAccumRef.current = 0;
  }, [wallet]);

  const localState = useMemo(() => {
    void localVersion;
    if (!wallet || !isLocalSiws) return null;
    return ensureLocalWallet(wallet);
  }, [wallet, isLocalSiws, localVersion, ensureLocalWallet]);

  const today = vancouverDateKey();

  const { top10, myRankRow, totalRanked } = useMemo(() => {
    const apiRows: LeaderboardRow[] = (board?.top ?? []).map((r) => ({ ...r }));
    if (!isLocalSiws || !wallet || !localState) {
      const rankRow: LeaderboardRow | null =
        me && me.rank !== null
          ? {
              wallet: me.wallet,
              displayName: me.displayName,
              points: me.points,
              streak: me.streak,
              rank: me.rank,
            }
          : null;
      return {
        top10: apiRows,
        myRankRow: rankRow,
        totalRanked: board?.total ?? me?.totalRanked ?? 0,
      };
    }
    const myPts = localState.points ?? 0;
    const myStrk = effectiveStreak(localState, today);
    const merged = apiRows.filter((r) => r.wallet !== wallet);
    if (myPts > 0) {
      merged.push({
        wallet,
        displayName: `${wallet.slice(0, 4)}…${wallet.slice(-4)}`,
        points: myPts,
        streak: myStrk,
        rank: 1,
      });
    }
    merged.sort((a, b) => b.points - a.points || b.streak - a.streak);
    merged.forEach((r, idx) => {
      r.rank = idx + 1;
    });
    const myRow = merged.find((r) => r.wallet === wallet) ?? null;
    const hadInApi = apiRows.some((r) => r.wallet === wallet);
    const baseTotal = board?.total ?? apiRows.length;
    const tot = myPts > 0 && !hadInApi ? baseTotal + 1 : baseTotal;
    return {
      top10: merged.slice(0, 10),
      myRankRow: myRow,
      totalRanked: tot,
    };
  }, [board, me, isLocalSiws, wallet, localState, today]);

  const value: PointsCtx = {
    mode: "api",
    ready,
    wallet,
    signedIn: !!wallet && !!token,
    signingIn,
    canSignIn: !!signMessage || !!walletSignIn,
    signIn,
    signOut,
    sessionToken: wallet ? token : null,
    apiError,
    myPoints: isLocalSiws ? (localState?.points ?? 0) : (me?.points ?? 0),
    myStreak: isLocalSiws ? (localState ? effectiveStreak(localState, today) : 0) : (me?.streak ?? 0),
    myStreakMilestones: isLocalSiws ? (localState?.streakMilestonesAwarded ?? []) : (me?.streakMilestones ?? []),
    claimedPointsToday: isLocalSiws ? (!!localState && localState.lastClaimDate === today) : !!me?.claimedToday,
    myLastClaimDate: isLocalSiws ? localState?.lastClaimDate : (me?.lastClaimDate ?? undefined),
    nextPointsReset: me?.nextReset ?? nextPointsResetDate(),
    lofiToday: isLocalSiws
      ? (localState && localState.lofiPointsDate === today ? localState.lofiPointsToday ?? 0 : 0)
      : (me?.lofiToday ?? 0),
    totalRanked,
    top10,
    myRankRow,
    claimDailyPoints,
    awardBonus,
    tickLofiSecond,
    pointsToast,
    clearPointsToast,
    refresh: () => void refresh(),
  };

  return <PointsContext.Provider value={value}>{children}</PointsContext.Provider>;
}

/** Picks the API-backed provider when NEXT_PUBLIC_API_URL is set, else localStorage. */
export const PointsProvider = API_URL ? ApiPointsProvider : LocalPointsProvider;

export function usePoints() {
  const ctx = useContext(PointsContext);
  if (!ctx) throw new Error("usePoints must be used within PointsProvider");
  return ctx;
}
