"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  accrueDailyPending,
  buildAddDailyIx,
  buildClaimDailyIx,
  buildClaimLongIx,
  buildStakeDailyIx,
  buildStakeLongIx,
  buildUnstakeDailyIx,
  DAILY_ACCRUAL_RATE_PERCENT,
  decodeDailyStakeAccount,
  decodeLongStateAccount,
  decodeLongTrancheAccount,
  deriveDailyStakePda,
  deriveLongStatePda,
  deriveLongTranchePda,
  floorClaimableRaw,
  rawToUi,
  uiToRaw,
  type DecodedDailyStake,
  type DecodedLongTranche,
} from "@greencat/sdk";
import { GC_DECIMALS } from "@/lib/config";
import { formatGc } from "@/lib/balances";
import { useSendTx } from "@/lib/useSendTx";
import { UserFacingError } from "@/lib/errors";
import { usePoints } from "@/context/PointsContext";
import { useNow, useProgram } from "@/context/ProgramContext";
import { WalletNotice } from "@/components/WalletNotice";
import { btn, EmptyState, ErrorNotice, ExpiryBar, field, formatDuration, labelCls, Notice, Panel, PanelSkeleton, Stat, SuccessNotice, LaunchingSoon } from "@/components/ui";

const DAY = 86_400;
export const STAKING_LOCKED_MESSAGE = "🔒 Staking opens after the launch airdrop is complete";

export function StakePanel() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const { awardBonus } = usePoints();
  const p = useProgram();
  const send = useSendTx();
  const now = useNow(5000);
  const { config } = p;

  const [daily, setDaily] = useState<DecodedDailyStake | null>(null);
  const [tranches, setTranches] = useState<DecodedLongTranche[]>([]);
  const [nextTrancheId, setNextTrancheId] = useState(0n);
  const [userLoading, setUserLoading] = useState(false);
  const [userErr, setUserErr] = useState<unknown>(null);
  const [amountUi, setAmountUi] = useState("1000");
  const [mode, setMode] = useState<"daily" | "long">("daily");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState<{ title: string; sig: string } | null>(null);

  const loadUser = useCallback(async () => {
    if (!publicKey) {
      setDaily(null);
      setTranches([]);
      return;
    }
    setUserLoading(true);
    setUserErr(null);
    try {
      const [ds] = deriveDailyStakePda(publicKey, p.programId);
      const [ls] = deriveLongStatePda(publicKey, p.programId);
      const [dsInfo, lsInfo] = await connection.getMultipleAccountsInfo([ds, ls], "confirmed");
      setDaily(dsInfo ? decodeDailyStakeAccount(Buffer.from(dsInfo.data)) : null);
      const next = lsInfo ? decodeLongStateAccount(Buffer.from(lsInfo.data))?.nextTrancheId ?? 0n : 0n;
      setNextTrancheId(next);
      const ids = Array.from({ length: Math.min(Number(next), 100) }, (_, i) => BigInt(i));
      const infos = ids.length ? await connection.getMultipleAccountsInfo(ids.map((i) => deriveLongTranchePda(publicKey, i, p.programId)[0]), "confirmed") : [];
      setTranches(infos.map((i) => (i ? decodeLongTrancheAccount(Buffer.from(i.data)) : null)).filter((t): t is DecodedLongTranche => !!t && t.principal > 0n));
    } catch (e) {
      setUserErr(e);
    } finally {
      setUserLoading(false);
    }
  }, [connection, publicKey, p.programId]);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  const pending = useMemo(() => {
    if (!daily || daily.principal <= 0n) return 0n;
    return floorClaimableRaw(accrueDailyPending(daily.principal, daily.pendingScaled, daily.lastAccrualTs, BigInt(now)).pendingScaled);
  }, [daily, now]);
  const remainPayout = config && config.dailyPayoutAllowance > config.dailyLifetimePaid ? config.dailyPayoutAllowance - config.dailyLifetimePaid : 0n;
  const dailyLocked = remainPayout <= 0n;
  const amountRaw = (() => {
    try {
      return uiToRaw(amountUi || "0", GC_DECIMALS);
    } catch {
      return 0n;
    }
  })();
  const amount = Number(amountUi);
  const longFull = config ? config.longStaked + amountRaw > config.longStakeCapacity : true;
  const unlockDaily = daily ? Number(daily.startedAt) + DAY : 0;
  const hasDaily = !!daily && daily.principal > 0n;
  /** On-chain staking switch (Config.staking_enabled): when locked, new stakes are refused; unstake/claim still work. */
  const stakingLocked = config ? !config.stakingEnabled : false;

  const run = async (label: string, title: string, build: (a: { staker: PublicKey; gcMint: PublicKey; stakerAta: PublicKey; tokenProgramId: PublicKey }) => TransactionInstruction, bonus = false) => {
    if (!publicKey || !p.gcMint) return;
    setBusy(label);
    setErr(null);
    setOk(null);
    try {
      if (label.startsWith("stake") || label === "add") {
        if (amountRaw <= 0n) throw new UserFacingError("unknown", "Enter an amount greater than zero.");
        if (p.gc !== null && p.gc < amount) throw new UserFacingError("insufficient_gc", `You have ${formatGc(p.gc)} $GC; staking ${formatGc(amount)} needs more.`);
      }
      const sig = await send(
        [build({ staker: publicKey, gcMint: p.gcMint, stakerAta: getAssociatedTokenAddressSync(p.gcMint, publicKey, false, p.tokenProgram), tokenProgramId: p.tokenProgram })],
        { minSol: 0.005 }
      );
      if (bonus) void awardBonus("stake", sig);
      setOk({ title, sig });
      await Promise.all([loadUser(), p.refresh(), p.refreshBalances()]);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  if (p.status === "loading") {
    return (
      <Panel title="Stake">
        <PanelSkeleton label="Loading staking" />
      </Panel>
    );
  }
  if (p.status === "error") {
    return (
      <Panel title="Stake">
        <ErrorNotice error={p.error} onRetry={() => void p.refresh()} />
      </Panel>
    );
  }
  if (!config) {
    return (
      <Panel title="Stake">
        <LaunchingSoon feature="Staking" icon="🔒">
          <p>Stake $GC for daily accrual (24 h minimum lock) or 365-day tranches once the program is live. Your tokens stay in your wallet until then.</p>
        </LaunchingSoon>
      </Panel>
    );
  }

  return (
    <div className="space-y-5">
      <Panel
        title="Stake $GC"
        subtitle={
          <>
            Daily: ≈{Number(DAILY_ACCRUAL_RATE_PERCENT).toFixed(4)}% per day (~5% APR), 24 h minimum lock. 365-day tranches: promotional bonus up to 100% from
            the reward pool if funded, <strong className="text-amber-200">not guaranteed</strong>.
          </>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Your daily stake" value={connected ? (userLoading && !daily ? "…" : `${formatGc(rawToUi(daily?.principal ?? 0n, GC_DECIMALS))}`) : "—"} />
          <Stat label="Claimable" value={connected ? formatGc(rawToUi(pending, GC_DECIMALS), 4) : "—"} tone="lime" />
          <Stat label="Payout left (site)" value={formatGc(rawToUi(remainPayout, GC_DECIMALS), 0)} tone="white" />
          <Stat
            label="365d capacity"
            value={`${Math.round((Number(config.longStaked) / Math.max(1, Number(config.longStakeCapacity))) * 100)}% used`}
            tone="white"
          />
        </div>

        <div className="mt-4 space-y-3">
          <WalletNotice action="stake" needGc={amount > 0 ? amount : undefined} needSol={0.005} />
          {userErr ? <ErrorNotice error={userErr} onRetry={() => void loadUser()} /> : null}
          {stakingLocked && (
            <Notice title={STAKING_LOCKED_MESSAGE}>
              New stakes (daily and 365-day) are switched off on-chain until the admin opens them.{" "}
              {hasDaily || tranches.length > 0 ? "Your existing positions are safe: claim and unstake below still work." : "Your $GC stays in your wallet until then."}
            </Notice>
          )}
          {dailyLocked && <Notice tone="warn">Daily staking is closed until more rewards are allocated (lifetime payout allowance used up).</Notice>}

          <div role="tablist" aria-label="Stake type" className="grid grid-cols-2 gap-1 rounded-full border border-gc-border bg-black/30 p-1">
            {(["daily", "long"] as const).map((m) => (
              <button
                key={m}
                role="tab"
                type="button"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={`min-h-[40px] rounded-full text-sm font-semibold transition motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gc-neon ${
                  mode === m ? "bg-gc-lime text-black" : "text-gc-mute hover:text-gc-lime"
                }`}
              >
                {m === "daily" ? "Daily" : "365-day"}
              </button>
            ))}
          </div>

          <div>
            <label htmlFor="stake-amount" className={labelCls}>
              Amount ($GC)
            </label>
            <div className="mt-1 flex gap-2">
              <input id="stake-amount" className={field} value={amountUi} onChange={(e) => setAmountUi(e.target.value)} inputMode="decimal" />
              <button type="button" className={btn.small} disabled={p.gc === null} onClick={() => p.gc !== null && setAmountUi(String(Math.floor(p.gc)))}>
                Max
              </button>
            </div>
          </div>

          {mode === "daily" ? (
            <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
              <button
                type="button"
                className={btn.primary}
                disabled={!connected || !!busy || dailyLocked || amountRaw <= 0n || p.paused || stakingLocked}
                title={stakingLocked ? STAKING_LOCKED_MESSAGE : undefined}
                onClick={() =>
                  void run(hasDaily ? "add" : "stake-daily", hasDaily ? "Added to your daily stake" : "Staked", (a) =>
                    hasDaily ? buildAddDailyIx({ ...a, amountRaw }) : buildStakeDailyIx({ ...a, amountRaw }), true)
                }
              >
                {busy === "stake-daily" || busy === "add" ? "Confirm in your wallet…" : stakingLocked ? "🔒 Staking locked" : hasDaily ? "Add to daily stake" : "Stake daily"}
              </button>
              <button
                type="button"
                className={btn.secondary}
                disabled={!connected || !!busy || pending <= 0n}
                onClick={() => void run("claim", "Rewards claimed", (a) => buildClaimDailyIx(a))}
              >
                {busy === "claim" ? "Confirm in your wallet…" : pending > 0n ? `Claim ${formatGc(rawToUi(pending, GC_DECIMALS), 4)} $GC` : "Nothing to claim yet"}
              </button>
              {hasDaily && (
                <div className="min-[420px]:col-span-2">
                  {now < unlockDaily && <p className="mb-2 text-xs text-gc-mute">Unstake opens in {formatDuration(unlockDaily - now)} (24 h minimum lock).</p>}
                  <button
                    type="button"
                    className={`${btn.warn} w-full`}
                    disabled={!connected || !!busy || now < unlockDaily}
                    onClick={() => void run("unstake", "Unstaked. Principal and rewards are back in your wallet.", (a) => buildUnstakeDailyIx(a))}
                  >
                    {busy === "unstake" ? "Confirm in your wallet…" : "Unstake all"}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-gc-mute">
                Locks for 365 days. Capacity {formatGc(rawToUi(config.longStaked, GC_DECIMALS), 0)} / {formatGc(rawToUi(config.longStakeCapacity, GC_DECIMALS), 0)} $GC.
              </p>
              <button
                type="button"
                className={`${btn.primary} w-full`}
                disabled={!connected || !!busy || amountRaw <= 0n || longFull || p.paused || stakingLocked}
                title={stakingLocked ? STAKING_LOCKED_MESSAGE : undefined}
                onClick={() => void run("stake-long", "365-day tranche created", (a) => buildStakeLongIx({ ...a, amountRaw, trancheId: nextTrancheId }), true)}
              >
                {busy === "stake-long" ? "Confirm in your wallet…" : stakingLocked ? "🔒 Staking locked" : longFull ? "Capacity full" : `Lock for 365 days (tranche #${nextTrancheId.toString()})`}
              </button>
            </div>
          )}
          {ok && <SuccessNotice title={ok.title} sig={ok.sig} />}
          {err ? <ErrorNotice error={err} onDismiss={() => setErr(null)} /> : null}
        </div>
      </Panel>

      <Panel title="Your 365-day tranches">
        {!connected ? (
          <p className="text-sm text-gc-mute">Connect a wallet to see your tranches.</p>
        ) : userLoading && tranches.length === 0 ? (
          <PanelSkeleton rows={1} label="Loading tranches" />
        ) : tranches.length === 0 ? (
          <EmptyState icon="🗓️" title="No locked tranches">
            {stakingLocked ? "365-day staking opens after the launch airdrop is complete." : "Lock $GC for 365 days above to earn the promotional bonus."}
          </EmptyState>
        ) : (
          <ul className="space-y-2">
            {tranches.map((t) => {
              const unlocked = now >= Number(t.unlockAt);
              return (
                <li key={t.trancheId.toString()} className="rounded-xl border border-gc-border bg-black/30 p-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-semibold text-white">
                      Tranche #{t.trancheId.toString()} · {formatGc(rawToUi(t.principal, GC_DECIMALS))} $GC
                    </span>
                    <span className="text-xs text-gc-lime">bonus {formatGc(rawToUi(t.bonusOwed, GC_DECIMALS))} $GC</span>
                  </div>
                  <div className="mt-2 text-gc-mute">
                    <ExpiryBar now={now} start={Number(t.startedAt)} end={Number(t.unlockAt)} label="Unlocks in" doneLabel="Unlocked" doneValue="ready to claim" />
                  </div>
                  <button
                    type="button"
                    className={`${btn.secondary} mt-3 w-full min-[420px]:w-auto`}
                    disabled={!unlocked || !!busy}
                    onClick={() => void run(`long:${t.trancheId}`, "Tranche claimed", (a) => buildClaimLongIx({ ...a, trancheId: t.trancheId }))}
                  >
                    {busy === `long:${t.trancheId}` ? "Confirm in your wallet…" : unlocked ? "Claim principal + bonus" : "Locked"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
