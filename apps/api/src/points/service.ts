/**
 * Server-authoritative points. All award math reuses the pure rules in @greencat/sdk
 * (packages/sdk/src/points.ts) so web-local and server behave identically.
 */
import { randomInt } from "node:crypto";
import {
  applyDailyClaim,
  applyLofiHeartbeat,
  awardActivityPoints,
  effectiveStreak,
  emptyPointsState,
  migratePointsFields,
  nextPointsResetDate,
  shortWallet,
  vancouverDateKey,
  vancouverMonthKey,
  POINTS_BONUS,
  type PointsWalletState,
} from "@greencat/sdk";
import type { Db, Queryable } from "../db";
import type { BonusKind } from "../verify/activityTx";

type WalletRow = {
  wallet: string;
  display_name: string | null;
  points_month: string;
  points: number;
  streak: number;
  last_claim_date: string | null;
  streak_milestones: number[] | string;
  lofi_date: string | null;
  lofi_today: number;
  lofi_last_heartbeat_at: number | null;
  lofi_interval_start_at: number | null;
};

function rowToState(r: WalletRow): PointsWalletState {
  const ms =
    typeof r.streak_milestones === "string"
      ? (JSON.parse(r.streak_milestones) as number[])
      : r.streak_milestones ?? [];
  return {
    wallet: r.wallet,
    displayName: r.display_name ?? shortWallet(r.wallet),
    points: Number(r.points) || 0,
    pointsMonth: r.points_month,
    streak: Number(r.streak) || 0,
    lastClaimDate: r.last_claim_date ?? undefined,
    streakMilestonesAwarded: ms,
    lofiPointsDate: r.lofi_date ?? undefined,
    lofiPointsToday: Number(r.lofi_today) || 0,
    lofiLastHeartbeatAt: r.lofi_last_heartbeat_at ?? undefined,
    lofiIntervalStartAt: r.lofi_interval_start_at ?? undefined,
  };
}

export async function lockWallet(q: Queryable, wallet: string, month: string): Promise<PointsWalletState> {
  await q.query(
    `INSERT INTO points_wallets (wallet, display_name, points_month)
     VALUES ($1, $2, $3) ON CONFLICT (wallet) DO NOTHING`,
    [wallet, shortWallet(wallet), month]
  );
  const { rows } = await q.query<WalletRow>(
    "SELECT * FROM points_wallets WHERE wallet = $1 FOR UPDATE",
    [wallet]
  );
  return migratePointsFields(rowToState(rows[0]), month);
}

export async function saveWallet(q: Queryable, s: PointsWalletState): Promise<void> {
  await q.query(
    `UPDATE points_wallets SET
       points_month = $2, points = $3, streak = $4, last_claim_date = $5,
       streak_milestones = $6::jsonb, lofi_date = $7, lofi_today = $8,
       lofi_last_heartbeat_at = $9, lofi_interval_start_at = $10, updated_at = now()
     WHERE wallet = $1`,
    [
      s.wallet,
      s.pointsMonth,
      s.points ?? 0,
      s.streak ?? 0,
      s.lastClaimDate ?? null,
      JSON.stringify(s.streakMilestonesAwarded ?? []),
      s.lofiPointsDate ?? null,
      s.lofiPointsToday ?? 0,
      s.lofiLastHeartbeatAt ?? null,
      s.lofiIntervalStartAt ?? null,
    ]
  );
}

export async function addMonthly(q: Queryable, month: string, wallet: string, amount: number) {
  if (amount <= 0) return;
  await q.query(
    `INSERT INTO points_monthly (month, wallet, points) VALUES ($1, $2, $3)
     ON CONFLICT (month, wallet) DO UPDATE
       SET points = points_monthly.points + EXCLUDED.points, updated_at = now()`,
    [month, wallet, amount]
  );
}

export async function insertEvent(
  q: Queryable,
  e: {
    wallet: string;
    kind: string;
    amount: number;
    month: string;
    day: string;
    txSig?: string | null;
    meta?: unknown;
  }
): Promise<boolean> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO points_events (wallet, kind, amount, month, day, tx_sig, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT DO NOTHING RETURNING id`,
    [e.wallet, e.kind, e.amount, e.month, e.day, e.txSig ?? null, e.meta ? JSON.stringify(e.meta) : null]
  );
  return rows.length > 0;
}

export class PointsError extends Error {
  constructor(
    public status: 400 | 401 | 404 | 409 | 422 | 429,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message);
  }
}

export type MeResponse = {
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

export type LeaderboardEntry = {
  rank: number;
  wallet: string;
  displayName: string;
  points: number;
  streak: number;
};

export class PointsService {
  constructor(
    private db: Db,
    private opts: {
      now?: () => Date;
      /** injectable for tests; default crypto.randomInt(1, 101) */
      rollDaily?: () => number;
      bonusDailyCaps?: Partial<Record<BonusKind, number>>;
    } = {}
  ) {}

  private now() {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private roll() {
    const n = this.opts.rollDaily ? this.opts.rollDaily() : randomInt(1, 101);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("daily roll out of range");
    return n;
  }

  async leaderboard(month: string, limit = 10): Promise<{ month: string; total: number; top: LeaderboardEntry[] }> {
    const now = this.now();
    const today = vancouverDateKey(now);
    const { rows } = await this.db.query<{
      wallet: string;
      points: number;
      rank: string | number;
      display_name: string | null;
      streak: number | null;
      last_claim_date: string | null;
    }>(
      `SELECT r.wallet, r.points, r.rank, w.display_name, w.streak, w.last_claim_date
         FROM (
           SELECT wallet, points,
                  ROW_NUMBER() OVER (ORDER BY points DESC, wallet ASC) AS rank
             FROM points_monthly WHERE month = $1
         ) r
         LEFT JOIN points_wallets w ON w.wallet = r.wallet
        WHERE r.rank <= $2
        ORDER BY r.rank`,
      [month, limit]
    );
    const { rows: cnt } = await this.db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM points_monthly WHERE month = $1",
      [month]
    );
    const isCurrent = month === vancouverMonthKey(now);
    return {
      month,
      total: Number(cnt[0]?.n ?? 0),
      top: rows.map((r) => ({
        rank: Number(r.rank),
        wallet: r.wallet,
        displayName: r.display_name ?? shortWallet(r.wallet),
        points: Number(r.points),
        streak: isCurrent
          ? effectiveStreak(
              {
                wallet: r.wallet,
                points: 0,
                streak: r.streak ?? 0,
                lastClaimDate: r.last_claim_date ?? undefined,
              },
              today
            )
          : 0,
      })),
    };
  }

  async rankOf(month: string, wallet: string): Promise<{ rank: number | null; total: number; points: number }> {
    const { rows } = await this.db.query<{ rank: string | number; total: string | number; points: number }>(
      `SELECT rank, total, points FROM (
         SELECT wallet, points,
                ROW_NUMBER() OVER (ORDER BY points DESC, wallet ASC) AS rank,
                COUNT(*) OVER () AS total
           FROM points_monthly WHERE month = $1
       ) r WHERE wallet = $2`,
      [month, wallet]
    );
    if (rows.length) {
      return { rank: Number(rows[0].rank), total: Number(rows[0].total), points: Number(rows[0].points) };
    }
    const { rows: cnt } = await this.db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM points_monthly WHERE month = $1",
      [month]
    );
    return { rank: null, total: Number(cnt[0]?.n ?? 0), points: 0 };
  }

  async me(wallet: string): Promise<MeResponse> {
    const now = this.now();
    const month = vancouverMonthKey(now);
    const today = vancouverDateKey(now);
    const { rows } = await this.db.query<WalletRow>("SELECT * FROM points_wallets WHERE wallet = $1", [wallet]);
    const state = rows.length
      ? migratePointsFields(rowToState(rows[0]), month)
      : emptyPointsState(wallet);
    const r = await this.rankOf(month, wallet);
    return {
      wallet,
      displayName: state.displayName ?? shortWallet(wallet),
      month,
      points: r.points,
      rank: r.rank,
      totalRanked: r.total,
      streak: effectiveStreak(state, today),
      streakMilestones: state.streakMilestonesAwarded ?? [],
      claimedToday: state.lastClaimDate === today,
      lastClaimDate: state.lastClaimDate ?? null,
      today,
      nextReset: nextPointsResetDate(now),
      lofiToday: state.lofiPointsDate === today ? state.lofiPointsToday ?? 0 : 0,
      lofiDailyCap: POINTS_BONUS.lofiDailyCap,
    };
  }

  async claim(wallet: string) {
    const now = this.now();
    const month = vancouverMonthKey(now);
    const today = vancouverDateKey(now);
    const result = await this.db.tx(async (q) => {
      const state = await lockWallet(q, wallet, month);
      if (state.lastClaimDate === today) {
        throw new PointsError(409, "already_claimed", "Already claimed today — come back after midnight America/Vancouver", {
          today,
        });
      }
      const base = this.roll();
      const applied = applyDailyClaim(state, base, { today, month });
      const inserted = await insertEvent(q, {
        wallet,
        kind: "claim",
        amount: base,
        month,
        day: today,
        meta: { streak: applied.streak },
      });
      if (!inserted) {
        throw new PointsError(409, "already_claimed", "Already claimed today", { today });
      }
      if (applied.milestoneBonus > 0) {
        await insertEvent(q, {
          wallet,
          kind: "milestone",
          amount: applied.milestoneBonus,
          month,
          day: today,
          meta: { milestones: applied.milestonesHit, streak: applied.streak },
        });
      }
      await saveWallet(q, applied.user);
      await addMonthly(q, month, wallet, applied.gained);
      return applied;
    });
    return {
      baseGained: result.baseGained,
      milestoneBonus: result.milestoneBonus,
      milestonesHit: result.milestonesHit,
      gained: result.gained,
      streak: result.streak,
      total: result.user.points ?? 0,
      today,
      month,
    };
  }

  /** Has this tx signature already been used for any award (incl. a pending/void listing award)? */
  async signatureUsed(sig: string): Promise<boolean> {
    const { rows } = await this.db.query(
      "SELECT 1 FROM points_events WHERE tx_sig = $1 UNION ALL SELECT 1 FROM listing_awards WHERE tx_sig = $1",
      [sig]
    );
    return rows.length > 0;
  }

  /** Award a VERIFIED activity bonus. Caller must have verified the tx on-chain first. */
  async awardVerifiedBonus(
    wallet: string,
    kind: BonusKind,
    txSig: string,
    meta: Record<string, unknown>
  ) {
    const now = this.now();
    const month = vancouverMonthKey(now);
    const today = vancouverDateKey(now);
    return this.db.tx(async (q) => {
      const state = await lockWallet(q, wallet, month);
      const cap = this.opts.bonusDailyCaps?.[kind];
      if (cap !== undefined) {
        const { rows } = await q.query<{ n: number }>(
          "SELECT COUNT(*)::int AS n FROM points_events WHERE wallet = $1 AND day = $2 AND kind = $3",
          [wallet, today, kind]
        );
        if (Number(rows[0]?.n ?? 0) >= cap) {
          throw new PointsError(429, "bonus_daily_cap", `Daily ${kind} bonus cap (${cap}) reached`);
        }
      }
      const awarded = awardActivityPoints(state, kind, { today, month });
      const inserted = await insertEvent(q, {
        wallet,
        kind,
        amount: awarded.gained,
        month,
        day: today,
        txSig,
        meta,
      });
      if (!inserted) {
        throw new PointsError(409, "replay", "This transaction signature was already used for a bonus");
      }
      await saveWallet(q, awarded.user);
      await addMonthly(q, month, wallet, awarded.gained);
      return { kind, gained: awarded.gained, total: awarded.user.points ?? 0, toast: awarded.toast };
    });
  }

  async lofiHeartbeat(wallet: string) {
    const now = this.now();
    const month = vancouverMonthKey(now);
    const today = vancouverDateKey(now);
    return this.db.tx(async (q) => {
      const state = await lockWallet(q, wallet, month);
      const r = applyLofiHeartbeat(state, now.getTime(), { today, month });
      if (r.gained > 0) {
        await insertEvent(q, { wallet, kind: "lofi", amount: r.gained, month, day: today });
        await addMonthly(q, month, wallet, r.gained);
      }
      await saveWallet(q, r.user);
      return {
        status: r.status,
        gained: r.gained,
        lofiToday: r.lofiToday,
        lofiDailyCap: POINTS_BONUS.lofiDailyCap,
        nextInMs: r.nextInMs,
        total: r.user.points ?? 0,
      };
    });
  }
}

/**
 * Credit `amount` points inside an existing transaction (wallet row locked FOR UPDATE).
 * Returns false (and changes nothing) if the event's tx_sig was already used.
 */
export async function awardInTx(
  q: Queryable,
  wallet: string,
  kind: string,
  amount: number,
  ctx: { month: string; today: string; txSig?: string | null; meta?: unknown }
): Promise<{ awarded: boolean; total: number }> {
  const state = await lockWallet(q, wallet, ctx.month);
  if (amount <= 0) return { awarded: false, total: state.points ?? 0 };
  const inserted = await insertEvent(q, {
    wallet,
    kind,
    amount,
    month: ctx.month,
    day: ctx.today,
    txSig: ctx.txSig ?? null,
    meta: ctx.meta,
  });
  if (!inserted) return { awarded: false, total: state.points ?? 0 };
  const next = { ...state, points: (state.points ?? 0) + amount, updatedAt: Date.now() };
  await saveWallet(q, next);
  await addMonthly(q, ctx.month, wallet, amount);
  return { awarded: true, total: next.points };
}
