/**
 * Engagement points — display-only.
 * Never spendable, never convertible to $GC, never affects stake/wheel/mint/market balances.
 *
 * Pure helpers live here so web (localStorage today) or an indexer/on-chain backend later
 * can share the same rules. See docs/POINTS.md.
 */

export const POINTS_BONUS = {
  mint: 15,
  stake: 10,
  list: 10,
  /** Legacy (wheel removed Oct 12, 2026): kept so old history rows still label correctly. */
  wheel: 5,
  /** +1 point per ~60s of lo-fi listening */
  lofiPerInterval: 1,
  /** Max lo-fi points per Vancouver calendar day */
  lofiDailyCap: 10,
  /** Seconds of play required for one lo-fi tick */
  lofiIntervalSec: 60,
} as const;

/** One-time streak milestone bonuses (awarded once when first reaching each day count). */
export const STREAK_MILESTONES: ReadonlyArray<{
  days: number;
  bonus: number;
  label: string;
}> = [
  { days: 3, bonus: 10, label: "3-day streak" },
  { days: 7, bonus: 25, label: "7-day streak" },
  { days: 30, bonus: 100, label: "30-day streak" },
];

/** Calendar date key YYYY-MM-DD in America/Vancouver. */
export function vancouverDateKey(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Vancouver" });
}

/** Month key YYYY-MM in America/Vancouver (monthly points reset). */
export function vancouverMonthKey(d = new Date()): string {
  return vancouverDateKey(d).slice(0, 7);
}

/** Add/subtract whole calendar days from a YYYY-MM-DD key (timezone-agnostic date math). */
export function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** First day of next Vancouver month (YYYY-MM-DD) — when points reset. */
export function nextPointsResetDate(d = new Date()): string {
  const month = vancouverMonthKey(d);
  const [y, m] = month.split("-").map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/** Per-wallet engagement state (persisted client-side or by a future backend). */
export type PointsWalletState = {
  /** Base58 wallet pubkey (canonical key). */
  wallet: string;
  points: number;
  lastClaimDate?: string;
  /** YYYY-MM of the points balance (America/Vancouver). Mismatch → reset points to 0. */
  pointsMonth?: string;
  /** Consecutive daily-claim streak (survives monthly points reset). */
  streak?: number;
  /** Milestone day counts already awarded in the current streak. */
  streakMilestonesAwarded?: number[];
  /** YYYY-MM-DD of lo-fi points accrual (America/Vancouver). */
  lofiPointsDate?: string;
  /** Lo-fi points earned today (capped). */
  lofiPointsToday?: number;
  /** Server-side lo-fi session: ms epoch of the last heartbeat received. */
  lofiLastHeartbeatAt?: number;
  /** Server-side lo-fi session: ms epoch the current ~60s interval started. */
  lofiIntervalStartAt?: number;
  /** Optional display label (short pubkey by default). */
  displayName?: string;
  updatedAt?: number;
};

/**
 * Storage adapter — localStorage today; swap for indexer/API/on-chain later
 * without changing award/claim rules.
 */
export interface PointsStore {
  get(wallet: string): PointsWalletState | null;
  set(state: PointsWalletState): void;
  /** All wallets known to this store (browser-local until a global indexer exists). */
  listAll(): PointsWalletState[];
}

export function emptyPointsState(wallet: string): PointsWalletState {
  return {
    wallet,
    points: 0,
    pointsMonth: vancouverMonthKey(),
    streak: 0,
    streakMilestonesAwarded: [],
    lofiPointsToday: 0,
    displayName: shortWallet(wallet),
    updatedAt: Date.now(),
  };
}

export function shortWallet(wallet: string): string {
  if (wallet.length <= 10) return wallet;
  return `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

/**
 * Zero monthly points when Vancouver month ≠ stored `pointsMonth`.
 * Choice: **reset points only; keep streak** (and lastClaimDate / milestones).
 */
export function ensureMonthlyPoints(
  user: PointsWalletState,
  month = vancouverMonthKey()
): PointsWalletState {
  if (user.pointsMonth === month) {
    return {
      ...user,
      points:
        typeof user.points === "number" && Number.isFinite(user.points)
          ? Math.max(0, Math.floor(user.points))
          : 0,
    };
  }
  return {
    ...user,
    points: 0,
    pointsMonth: month,
  };
}

/** Streak is intact if last claim was today or yesterday (Vancouver); else 0. */
export function effectiveStreak(
  user: PointsWalletState,
  today = vancouverDateKey()
): number {
  const raw =
    typeof user.streak === "number" && user.streak > 0
      ? Math.floor(user.streak)
      : 0;
  if (!user.lastClaimDate || raw <= 0) return 0;
  const yesterday = shiftDateKey(today, -1);
  if (user.lastClaimDate === today || user.lastClaimDate === yesterday)
    return raw;
  return 0;
}

export function migratePointsFields(
  user: PointsWalletState,
  month = vancouverMonthKey()
): PointsWalletState {
  let next = ensureMonthlyPoints(user, month);
  const streak =
    typeof next.streak === "number" && Number.isFinite(next.streak)
      ? Math.max(0, Math.floor(next.streak))
      : 0;
  const milestones = Array.isArray(next.streakMilestonesAwarded)
    ? next.streakMilestonesAwarded.filter((n) => typeof n === "number")
    : [];
  const lofiToday =
    typeof next.lofiPointsToday === "number" &&
    Number.isFinite(next.lofiPointsToday)
      ? Math.max(0, Math.floor(next.lofiPointsToday))
      : 0;
  next = {
    ...next,
    wallet: next.wallet,
    streak,
    streakMilestonesAwarded: milestones,
    lofiPointsToday: lofiToday,
    lofiPointsDate:
      typeof next.lofiPointsDate === "string" && next.lofiPointsDate
        ? next.lofiPointsDate
        : undefined,
    displayName: next.displayName || shortWallet(next.wallet),
  };
  return next;
}

export type ActivityBonusKind = "mint" | "stake" | "list" | "wheel" | "lofi";

export function activityBonusAmount(kind: ActivityBonusKind): number {
  switch (kind) {
    case "mint":
      return POINTS_BONUS.mint;
    case "stake":
      return POINTS_BONUS.stake;
    case "list":
      return POINTS_BONUS.list;
    case "wheel":
      return POINTS_BONUS.wheel;
    case "lofi":
      return POINTS_BONUS.lofiPerInterval;
  }
}

export function activityBonusLabel(
  kind: ActivityBonusKind,
  amount: number
): string {
  switch (kind) {
    case "mint":
      return `+${amount} points for mint`;
    case "stake":
      return `+${amount} points for stake`;
    case "list":
      return `+${amount} points for listing`;
    case "wheel":
      return `+${amount} points for wheel spin`;
    case "lofi":
      return `+${amount} points for lo-fi`;
  }
}

/**
 * Add activity bonus points after monthly reset. Lo-fi respects daily cap.
 * Returns updated user + amount actually awarded (0 if capped / nothing).
 */
export function awardActivityPoints(
  user: PointsWalletState,
  kind: ActivityBonusKind,
  opts?: { today?: string; month?: string }
): { user: PointsWalletState; gained: number; toast: string | null } {
  const today = opts?.today ?? vancouverDateKey();
  const month = opts?.month ?? vancouverMonthKey();
  let next = ensureMonthlyPoints(user, month);
  let amount = activityBonusAmount(kind);

  if (kind === "lofi") {
    let earnedToday = next.lofiPointsToday ?? 0;
    if (next.lofiPointsDate !== today) {
      earnedToday = 0;
    }
    const room = Math.max(0, POINTS_BONUS.lofiDailyCap - earnedToday);
    amount = Math.min(amount, room);
    if (amount <= 0) {
      return {
        user: {
          ...next,
          lofiPointsDate: today,
          lofiPointsToday: earnedToday,
          updatedAt: Date.now(),
        },
        gained: 0,
        toast: null,
      };
    }
    next = {
      ...next,
      points: (next.points ?? 0) + amount,
      lofiPointsDate: today,
      lofiPointsToday: earnedToday + amount,
      updatedAt: Date.now(),
    };
    return {
      user: next,
      gained: amount,
      toast: activityBonusLabel(kind, amount),
    };
  }

  next = {
    ...next,
    points: (next.points ?? 0) + amount,
    updatedAt: Date.now(),
  };
  return {
    user: next,
    gained: amount,
    toast: activityBonusLabel(kind, amount),
  };
}

/** Max gap (ms) between heartbeats before a lo-fi session is considered stopped. */
export const LOFI_HEARTBEAT_MAX_GAP_MS = 90_000;
/** Recommended client heartbeat cadence (ms) while audio is playing. */
export const LOFI_HEARTBEAT_EVERY_MS = 15_000;

export type LofiHeartbeatResult = {
  user: PointsWalletState;
  gained: number;
  /** "started" = first beat of a session; "tick" = interval completed; "waiting" = interval still running; "capped" = daily cap reached */
  status: "started" | "tick" | "waiting" | "capped";
  /** ms until the next point could be earned (0 when capped or just awarded). */
  nextInMs: number;
  lofiToday: number;
};

/**
 * Server-authoritative lo-fi accrual. Clients send a heartbeat every ~15s while playing.
 * - First heartbeat (or after a gap > LOFI_HEARTBEAT_MAX_GAP_MS) only opens a session.
 * - A point is awarded when ≥ `lofiIntervalSec` has elapsed since the interval start
 *   (so at most 1 point per ~60s no matter how often the client pings).
 * - Daily cap (Vancouver day) enforced via awardActivityPoints("lofi").
 */
export function applyLofiHeartbeat(
  user: PointsWalletState,
  nowMs: number,
  opts?: { today?: string; month?: string; intervalMs?: number; maxGapMs?: number }
): LofiHeartbeatResult {
  const now = new Date(nowMs);
  const today = opts?.today ?? vancouverDateKey(now);
  const month = opts?.month ?? vancouverMonthKey(now);
  const intervalMs = opts?.intervalMs ?? POINTS_BONUS.lofiIntervalSec * 1000;
  const maxGapMs = opts?.maxGapMs ?? LOFI_HEARTBEAT_MAX_GAP_MS;
  let next = migratePointsFields(user, month);
  const lofiToday = next.lofiPointsDate === today ? next.lofiPointsToday ?? 0 : 0;

  if (lofiToday >= POINTS_BONUS.lofiDailyCap) {
    return {
      user: {
        ...next,
        lofiPointsDate: today,
        lofiPointsToday: lofiToday,
        lofiLastHeartbeatAt: nowMs,
      },
      gained: 0,
      status: "capped",
      nextInMs: 0,
      lofiToday,
    };
  }

  const last = next.lofiLastHeartbeatAt;
  const start = next.lofiIntervalStartAt;
  const sessionAlive =
    typeof last === "number" &&
    typeof start === "number" &&
    nowMs >= last &&
    nowMs - last <= maxGapMs;

  if (!sessionAlive) {
    next = {
      ...next,
      lofiPointsDate: today,
      lofiPointsToday: lofiToday,
      lofiLastHeartbeatAt: nowMs,
      lofiIntervalStartAt: nowMs,
    };
    return { user: next, gained: 0, status: "started", nextInMs: intervalMs, lofiToday };
  }

  const elapsed = nowMs - (start as number);
  if (elapsed < intervalMs) {
    next = { ...next, lofiLastHeartbeatAt: nowMs };
    return {
      user: next,
      gained: 0,
      status: "waiting",
      nextInMs: intervalMs - elapsed,
      lofiToday,
    };
  }

  const awarded = awardActivityPoints(next, "lofi", { today, month });
  const u = {
    ...awarded.user,
    lofiLastHeartbeatAt: nowMs,
    lofiIntervalStartAt: nowMs,
  };
  const nowToday = u.lofiPointsToday ?? 0;
  return {
    user: u,
    gained: awarded.gained,
    status: awarded.gained > 0 ? "tick" : "capped",
    nextInMs: nowToday >= POINTS_BONUS.lofiDailyCap ? 0 : intervalMs,
    lofiToday: nowToday,
  };
}

/** True when the wallet already claimed on the given Vancouver day. */
export function hasClaimedToday(
  user: PointsWalletState | null | undefined,
  today = vancouverDateKey()
): boolean {
  return !!user && user.lastClaimDate === today;
}

export type DailyClaimResult = {
  user: PointsWalletState;
  gained: number;
  milestoneBonus: number;
  milestonesHit: number[];
  streak: number;
  baseGained: number;
};

/**
 * Apply daily claim: streak continuity, random base already chosen by caller,
 * milestone bonuses for newly reached thresholds in this streak.
 */
export function applyDailyClaim(
  user: PointsWalletState,
  baseGained: number,
  opts?: { today?: string; month?: string }
): DailyClaimResult {
  const today = opts?.today ?? vancouverDateKey();
  const month = opts?.month ?? vancouverMonthKey();
  let next = ensureMonthlyPoints(user, month);

  if (next.lastClaimDate === today) {
    return {
      user: next,
      gained: 0,
      milestoneBonus: 0,
      milestonesHit: [],
      streak: effectiveStreak(next, today),
      baseGained: 0,
    };
  }

  const yesterday = shiftDateKey(today, -1);
  let streak: number;
  let milestones: number[];
  if (next.lastClaimDate === yesterday) {
    streak =
      (typeof next.streak === "number" && next.streak > 0
        ? Math.floor(next.streak)
        : 0) + 1;
    milestones = Array.isArray(next.streakMilestonesAwarded)
      ? [...next.streakMilestonesAwarded]
      : [];
  } else {
    streak = 1;
    milestones = [];
  }

  let milestoneBonus = 0;
  const milestonesHit: number[] = [];
  for (const m of STREAK_MILESTONES) {
    if (streak >= m.days && !milestones.includes(m.days)) {
      milestoneBonus += m.bonus;
      milestones.push(m.days);
      milestonesHit.push(m.days);
    }
  }

  const gained = baseGained + milestoneBonus;
  next = {
    ...next,
    points: (next.points ?? 0) + gained,
    lastClaimDate: today,
    streak,
    streakMilestonesAwarded: milestones,
    pointsMonth: month,
    updatedAt: Date.now(),
  };

  return {
    user: next,
    gained,
    milestoneBonus,
    milestonesHit,
    streak,
    baseGained,
  };
}

/** Cryptographically preferred random int in [0, maxExclusive). */
export function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}

/** Random daily base: 1–100 inclusive. */
export function randomDailyBase(): number {
  return secureRandomInt(100) + 1;
}

export type LeaderboardRow = {
  wallet: string;
  displayName: string;
  points: number;
  streak: number;
  /** 1-based place among all tracked wallets (ties broken by wallet asc). */
  rank: number;
};

/**
 * Rank **everyone** known to the store (full board).
 * UI should display only top N and always surface the current user's row/rank.
 */
export function buildLeaderboard(
  states: PointsWalletState[],
  opts?: { month?: string; today?: string }
): LeaderboardRow[] {
  const month = opts?.month ?? vancouverMonthKey();
  const today = opts?.today ?? vancouverDateKey();
  const rows = states
    .map((u) => {
      const m = migratePointsFields(u, month);
      return {
        wallet: m.wallet,
        displayName: m.displayName || shortWallet(m.wallet),
        points: m.points ?? 0,
        streak: effectiveStreak(m, today),
      };
    })
    .sort(
      (a, b) =>
        b.points - a.points || a.wallet.localeCompare(b.wallet)
    );
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

export function findRank(
  board: LeaderboardRow[],
  wallet: string | null | undefined
): LeaderboardRow | null {
  if (!wallet) return null;
  return board.find((r) => r.wallet === wallet) ?? null;
}
