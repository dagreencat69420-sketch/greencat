"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { STREAK_MILESTONES } from "@greencat/sdk";
import { usePoints } from "@/context/PointsContext";
import { friendlyError } from "@/lib/errors";
import { btn, EmptyState, PanelSkeleton, PageHeader, Panel } from "@/components/ui";
import { WalletNotice } from "@/components/WalletNotice";

export default function PointsPage() {
  const { connected, publicKey } = useWallet();
  const {
    mode,
    signedIn,
    signingIn,
    canSignIn,
    signIn,
    signOut,
    apiError,
    ready,
    myPoints,
    claimedPointsToday,
    myLastClaimDate,
    myStreak,
    myStreakMilestones,
    nextPointsReset,
    myRankRow,
    totalRanked,
    claimDailyPoints,
  } = usePoints();
  const [pulse, setPulse] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  const onClaim = async () => {
    setErr(null);
    setClaiming(true);
    const result = await claimDailyPoints();
    setClaiming(false);
    if (!result.ok) {
      setErr(result.error);
      return;
    }
    // The points provider raises the shared "+N points" toast for the claim.
    setPulse(true);
    window.setTimeout(() => setPulse(false), 700);
  };

  const onSignIn = async () => {
    setErr(null);
    try {
      await signIn();
    } catch (e) {
      setErr(friendlyError(e).message);
    }
  };

  const needsSignIn = mode === "api" && !signedIn;


  if (!ready) {
    return (
      <div>
        <PageHeader title="Points & leaderboard" subtitle="Monthly engagement · display-only" />
        <Panel title="This month">
          <PanelSkeleton label="Loading points" />
        </Panel>
      </div>
    );
  }

  if (!connected || !publicKey) {
    return (
      <div>
        <PageHeader title="Points & leaderboard" subtitle="Monthly engagement · display-only" />
        <div className="space-y-6">
          <WalletNotice action="claim daily points, build streaks, and climb the board" />
          <Leaderboard me={null} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Points & leaderboard"
        subtitle={
          <>
            Monthly engagement · display-only ·{" "}
            <span className="text-gc-lime/80">{mode === "api" ? "global board" : "this browser only"}</span>
          </>
        }
      />

      {apiError && (
        <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
          <span aria-hidden>⚠️ </span>
          {apiError}
        </p>
      )}

      {needsSignIn && (
        <section className="space-y-3 rounded-2xl border border-gc-lime/40 bg-gc-lime/5 p-5 text-center shadow-neonSm">
          <p className="text-sm text-gc-mute">
            Sign in with your wallet to claim daily points and earn activity bonuses on the{" "}
            <strong className="text-gc-lime">global</strong> leaderboard. It&apos;s a free
            message signature: no transaction, no fees.
          </p>
          <button
            type="button"
            onClick={() => void onSignIn()}
            disabled={signingIn || !canSignIn}
            className={btn.primary}
          >
            {signingIn ? "Check your wallet…" : "Sign in with wallet"}
          </button>
          {!canSignIn && (
            <p className="text-xs text-amber-200">
              This wallet can&apos;t sign messages. Try Phantom or Solflare.
            </p>
          )}
        </section>
      )}

      <div className="rounded-xl border border-gc-lime/20 bg-gc-lime/5 px-4 py-3 text-sm text-gc-mute">
        Points are a fun engagement score —{" "}
        <strong className="text-gc-lime">not spendable</strong> and{" "}
        <strong className="text-gc-lime">not convertible to $GC</strong>. They
        never affect stake, mint, or market balances. Monthly totals
        reset on the 1st (America/Vancouver). Streaks survive the reset.
      </div>

      <section className="relative space-y-4 overflow-hidden rounded-2xl border border-gc-border bg-gc-panel/90 p-4 shadow-neonSm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs text-gc-mute">
              This month ·{" "}
              <span className="font-mono text-gc-lime">
                {publicKey.toBase58().slice(0, 4)}…
                {publicKey.toBase58().slice(-4)}
              </span>
            </p>
            <p
              className={`text-5xl font-black tabular-nums text-gc-neon transition-transform motion-reduce:transition-none ${
                pulse ? "scale-110" : "scale-100"
              }`}
            >
              {myPoints.toLocaleString()}
            </p>
            {myRankRow && (
              <p className="mt-1 text-sm text-gc-mute">
                Rank{" "}
                <span className="font-bold text-gc-lime">
                  #{myRankRow.rank}
                </span>{" "}
                of {totalRanked}
              </p>
            )}
            {!myRankRow && !needsSignIn && (
              <p className="mt-1 text-sm text-gc-mute">
                Not ranked yet this month · {totalRanked} ranked
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <div
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-bold ${
                myStreak > 0
                  ? "border-gc-lime/50 bg-gc-lime/15 text-gc-lime"
                  : "border-gc-border bg-black/40 text-gc-mute"
              }`}
              title="Consecutive daily claims (America/Vancouver). Miss a day and it resets."
            >
              <span aria-hidden>🔥</span>
              <span>
                {myStreak > 0 ? `${myStreak}-day streak` : "No streak yet"}
              </span>
            </div>
            <div className="flex flex-wrap justify-end gap-1">
              {STREAK_MILESTONES.map((m) => {
                const hit = myStreak >= m.days;
                const awarded = myStreakMilestones.includes(m.days);
                return (
                  <span
                    key={m.days}
                    className={`rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                      hit
                        ? "border-gc-lime/60 bg-gc-lime/10 text-gc-lime"
                        : "border-gc-border text-gc-mute"
                    }`}
                    title={
                      awarded
                        ? `Awarded +${m.bonus} once this streak`
                        : hit
                          ? `${m.label} reached`
                          : `Reach ${m.days} days for +${m.bonus}`
                    }
                  >
                    {m.days}d{awarded ? " ✓" : ""}
                  </span>
                );
              })}
            </div>
          </div>
        </div>

        <p className="text-sm text-gc-mute">
          Claim a daily bonus for a random{" "}
          <span className="text-gc-lime">1–100</span> points. Hit streak
          milestones for one-time bonuses (+10 / +25 / +100 at 3 / 7 / 30 days).
          Activity (mint, stake, list, lo-fi) also earns bonus points.
        </p>

        <p className="text-xs text-gc-mute">
          Next monthly reset:{" "}
          <span className="text-gc-lime/80">{nextPointsReset}</span>{" "}
          (America/Vancouver midnight)
        </p>

        <button
          type="button"
          className={`${btn.primary} w-full min-[420px]:w-auto min-[420px]:min-w-[12rem]`}
          onClick={() => void onClaim()}
          disabled={claimedPointsToday || claiming || needsSignIn}
        >
          {claimedPointsToday
            ? "Come back tomorrow"
            : needsSignIn
              ? "Sign in to claim"
              : claiming
                ? "Rolling…"
                : "Claim daily bonus"}
        </button>
        {mode === "api" && signedIn && (
          <button
            type="button"
            onClick={signOut}
            className="ml-3 min-h-[44px] text-xs text-gc-mute underline hover:text-gc-lime focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gc-neon"
          >
            Sign out
          </button>
        )}

        {claimedPointsToday && (
          <p className="text-sm text-gc-mute">
            Already claimed today
            {myLastClaimDate ? (
              <>
                {" "}
                (<span className="text-gc-lime/80">{myLastClaimDate}</span> PT)
              </>
            ) : null}
            . Next claim unlocks at midnight America/Vancouver.
          </p>
        )}
        {err && (
          <p role="alert" className="text-sm text-amber-300">
            {err}
          </p>
        )}

      </section>

      <Leaderboard me={publicKey.toBase58()} />
    </div>
  );
}

function Leaderboard({ me }: { me: string | null }) {
  const { mode, ready, top10, myRankRow, totalRanked } = usePoints();
  const inTop10 = !!myRankRow && top10.some((r) => r.wallet === myRankRow.wallet);
  if (!ready) {
    return (
      <Panel title="This month · Top 10">
        <PanelSkeleton rows={4} label="Loading leaderboard" />
      </Panel>
    );
  }
  return (
    <section className="space-y-4 rounded-2xl border border-gc-border bg-gc-panel/90 p-4 shadow-neonSm sm:p-6">
        <h2 className="text-lg font-bold text-gc-neon">This month · Top 10</h2>
        {mode === "api" ? (
          <p className="text-xs text-gc-mute">
            Global board: every wallet is ranked server-side ({totalRanked} this
            month). Top 10 shown; your place is always shown below even if outside
            the top 10. Daily rolls and bonuses are verified by the server.
          </p>
        ) : (
          <p className="text-xs text-gc-mute">
            All wallets that have used this browser are ranked (#1…N). UI shows
            top 10; your place is always shown below even if outside the top 10.
            Set <code className="text-gc-lime">NEXT_PUBLIC_API_URL</code> for the
            global board — see <code className="text-gc-lime">docs/POINTS.md</code>.
          </p>
        )}
        {top10.length === 0 ? (
          <EmptyState icon="🏆" title="The board is empty this month">
            No one has claimed yet. Claim your daily bonus to take #1.
          </EmptyState>
        ) : (
          <ol className="space-y-2">
            {top10.map((row) => {
              const mine = row.wallet === me;
              return (
                <li
                  key={row.wallet}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
                    mine
                      ? "border-gc-lime/50 bg-gc-lime/10"
                      : "border-gc-border bg-black/40"
                  }`}
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-black ${
                      row.rank === 1
                        ? "bg-gc-lime text-black"
                        : row.rank <= 3
                          ? "bg-gc-lime/30 text-gc-lime"
                          : "bg-gc-panel text-gc-mute"
                    }`}
                  >
                    {row.rank}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">
                      {row.displayName}
                      {mine && (
                        <span className="ml-2 text-xs font-normal text-gc-lime">
                          you
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-gc-mute">
                      {row.wallet.slice(0, 8)}…
                      {row.streak > 0 ? ` · 🔥 ${row.streak}d` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 font-bold tabular-nums text-gc-neon">
                    {row.points.toLocaleString()}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {me && myRankRow && !inTop10 && (
          <div className="rounded-xl border border-gc-lime/40 bg-gc-lime/10 px-3 py-3">
            <p className="text-xs uppercase tracking-wide text-gc-mute">
              Your place
            </p>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="font-bold text-gc-lime">
                #{myRankRow.rank} · {myRankRow.displayName}
                {myRankRow.streak > 0 ? ` · 🔥 ${myRankRow.streak}d` : ""}
              </span>
              <span className="font-black tabular-nums text-gc-neon">
                {myRankRow.points.toLocaleString()}
              </span>
            </div>
          </div>
        )}
      </section>
  );
}
