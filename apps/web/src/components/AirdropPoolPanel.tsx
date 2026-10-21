"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  airdropPoolWithdrawable,
  airdropUnclaimed,
  buildAirdropPoolDepositIxs,
  buildAirdropPoolWithdrawIxs,
  deriveTreasuryPda,
  deriveTreasuryVaultAta,
  GREENCAT_PROGRAM_ID,
  parseGcAmount,
  PoolId,
  rawToUi,
  type DecodedAirdropDistribution,
} from "@greencat/sdk";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { GC_DECIMALS } from "@/lib/config";
import { formatGc } from "@/lib/balances";
import { useSendTx } from "@/lib/useSendTx";
import { friendlyError, UserFacingError } from "@/lib/errors";
import { useToast } from "@/components/Toaster";
import { useNow, useProgram } from "@/context/ProgramContext";
import { btn, ErrorNotice, field, labelCls, Notice, Panel, Stat, SuccessNotice } from "@/components/ui";

/** Same rule as `can_reclaim` on-chain: after expiry, not paused, and ≥ 3 days since the last pause/unpause. */
const RECLAIM_GRACE_SECS = 3 * 86_400;

const fmt = (raw: bigint) => formatGc(rawToUi(raw, GC_DECIMALS), 6);
const toInput = (raw: bigint) => {
  const s = raw.toString().padStart(GC_DECIMALS + 1, "0");
  const whole = s.slice(0, -GC_DECIMALS);
  const frac = s.slice(-GC_DECIMALS).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};

/**
 * Admin: fund the airdrop pool (pool 5) from the connected wallet, and withdraw what isn't reserved
 * for open airdrop rounds back to it. Both go through the wallet's normal sign-and-send
 * (`useSendTx` → wallet-adapter `sendTransaction`), one prompt each, so MetaMask works too.
 */
export function AirdropPoolPanel({ dist, distributionId, onDone }: { dist: DecodedAirdropDistribution | null; distributionId: string | null; onDone: () => Promise<void> }) {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const p = useProgram();
  const send = useSendTx();
  const { toast } = useToast();
  const now = useNow(5000);
  const [vaultRaw, setVaultRaw] = useState<bigint | null>(null);
  const [walletRaw, setWalletRaw] = useState<bigint | null>(null);
  const [depositIn, setDepositIn] = useState("");
  const [withdrawIn, setWithdrawIn] = useState("");
  const [busy, setBusy] = useState<"deposit" | "withdraw" | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState<{ title: string; sig: string } | null>(null);
  const { config, gcMint, tokenProgram } = p;

  const refreshVault = useCallback(async () => {
    if (!gcMint) return;
    const [pool] = deriveTreasuryPda(PoolId.Airdrop, new PublicKey(GREENCAT_PROGRAM_ID));
    const vault = deriveTreasuryVaultAta(gcMint, pool, tokenProgram);
    const raw = (a: PublicKey) =>
      connection
        .getTokenAccountBalance(a, "confirmed")
        .then((b) => BigInt(b.value.amount))
        .catch(() => null);
    const [v, w] = await Promise.all([raw(vault), publicKey ? raw(getAssociatedTokenAddressSync(gcMint, publicKey, false, tokenProgram)) : Promise.resolve(null)]);
    setVaultRaw(v);
    setWalletRaw(publicKey ? w ?? 0n : null);
  }, [connection, gcMint, tokenProgram, publicKey]);

  useEffect(() => {
    void refreshVault();
  }, [refreshVault]);

  if (!config) return null;
  const reserved = config.airdropReserved;
  // A loaded round that has ended but still holds a reservation: release it in the same withdraw tx.
  const ended = !!dist && !dist.reclaimed && now >= Number(dist.expiryTs);
  const graceOk = !config.paused && now >= Number(config.lastPauseChangeTs) + RECLAIM_GRACE_SECS;
  const bundleReclaim = ended && graceOk && distributionId !== null;
  const releasable = bundleReclaim && dist ? airdropUnclaimed(dist) : 0n;
  const withdrawable = vaultRaw === null ? null : airdropPoolWithdrawable(vaultRaw, reserved, releasable);
  const can = p.isAdmin && !busy && !!gcMint;

  type Send = typeof send;
  const run = async (kind: "deposit" | "withdraw", f: (sendTx: Send) => Promise<{ title: string; sig: string }>) => {
    setBusy(kind);
    setErr(null);
    setOk(null);
    let sent = false; // once the tx reaches useSendTx, it shows the success / error toast itself
    const sendTx: Send = (ixs, opts) => {
      sent = true;
      return send(ixs, opts);
    };
    try {
      setOk(await f(sendTx));
      if (kind === "deposit") setDepositIn("");
      else setWithdrawIn("");
    } catch (e) {
      const fe = friendlyError(e);
      if (!sent) toast({ tone: "error", title: fe.message, body: fe.hint ?? fe.detail });
      if (fe.kind !== "rejected") setErr(e);
    } finally {
      setBusy(null);
      await Promise.all([refreshVault(), p.refresh(), p.refreshBalances(), onDone().catch(() => undefined)]);
    }
  };

  const onDeposit = () =>
    void run("deposit", async (sendTx) => {
      const amount = parseGcAmount(depositIn, GC_DECIMALS);
      if (!amount) throw new UserFacingError("unknown", "Enter how much $GC to deposit (a number above 0).");
      if (walletRaw !== null && amount > walletRaw) throw new UserFacingError("insufficient_gc", `Your wallet only has ${fmt(walletRaw)} $GC.`, "Lower the amount.");
      const title = `Deposited ${fmt(amount)} $GC into the airdrop pool`;
      const sig = await sendTx(buildAirdropPoolDepositIxs({ depositor: publicKey!, gcMint: gcMint!, amountRaw: amount, tokenProgramId: tokenProgram }), {
        preflight: true,
        toast: title,
      });
      return { title, sig };
    });

  const onWithdraw = () =>
    void run("withdraw", async (sendTx) => {
      const amount = parseGcAmount(withdrawIn, GC_DECIMALS);
      if (!amount) throw new UserFacingError("unknown", "Enter how much $GC to withdraw (a number above 0).");
      if (withdrawable !== null && amount > withdrawable) {
        throw new UserFacingError(
          "program",
          `Only ${fmt(withdrawable)} $GC can be withdrawn right now.`,
          reserved > 0n ? "The rest is reserved for holders who can still claim an open airdrop round." : undefined
        );
      }
      const title = `Withdrew ${fmt(amount)} $GC from the airdrop pool to your wallet`;
      const sig = await sendTx(
        buildAirdropPoolWithdrawIxs({
          authority: publicKey!,
          gcMint: gcMint!,
          amountRaw: amount,
          tokenProgramId: tokenProgram,
          reclaimDistributionId: bundleReclaim ? BigInt(distributionId!) : undefined,
        }),
        { preflight: true, minSol: 0.003, toast: bundleReclaim ? `Round #${distributionId} reclaimed. ${title}` : title }
      );
      return { title: bundleReclaim ? `Round #${distributionId} reclaimed. ${title}` : title, sig };
    });

  return (
    <Panel title="Airdrop pool funds" subtitle="Move $GC between your admin wallet and the airdrop pool (pool 5). Each button is one wallet approval.">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="In the pool" value={vaultRaw === null ? "—" : formatGc(rawToUi(vaultRaw, GC_DECIMALS), 0)} tone="neon" />
          <Stat label="Reserved for claims" value={formatGc(rawToUi(reserved, GC_DECIMALS), 0)} tone="lime" />
          <Stat label="Withdrawable now" value={withdrawable === null ? "—" : formatGc(rawToUi(withdrawable, GC_DECIMALS), 0)} tone="white" />
          <Stat label="Your wallet" value={walletRaw === null ? "—" : formatGc(rawToUi(walletRaw, GC_DECIMALS), 0)} tone="white" />
        </div>

        {connected && !p.isAdmin && <Notice>Read-only: this wallet isn&apos;t the program authority.</Notice>}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="pool-deposit" className={labelCls}>
              Deposit $GC into the airdrop pool
            </label>
            <div className="flex gap-2">
              <input id="pool-deposit" inputMode="decimal" placeholder="e.g. 1000000" value={depositIn} onChange={(e) => setDepositIn(e.target.value)} className={field} />
              <button type="button" className={btn.small} disabled={walletRaw === null || walletRaw === 0n} onClick={() => walletRaw !== null && setDepositIn(toInput(walletRaw))}>
                Max
              </button>
            </div>
            <button type="button" className={btn.primary} disabled={!can || config.paused || !depositIn.trim()} onClick={onDeposit}>
              {busy === "deposit" ? "Confirm in your wallet…" : "Deposit to airdrop pool"}
            </button>
            <p className="text-xs text-gc-mute">
              Sends from your connected wallet&apos;s $GC account. {config.paused ? "Deposits are blocked while the program is paused." : "Send a small test amount first."}
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="pool-withdraw" className={labelCls}>
              Withdraw unreserved $GC to your wallet
            </label>
            <div className="flex gap-2">
              <input id="pool-withdraw" inputMode="decimal" placeholder="e.g. 500000" value={withdrawIn} onChange={(e) => setWithdrawIn(e.target.value)} className={field} />
              <button type="button" className={btn.small} disabled={!withdrawable} onClick={() => withdrawable && setWithdrawIn(toInput(withdrawable))}>
                Max
              </button>
            </div>
            <button type="button" className={btn.warn} disabled={!can || !withdrawIn.trim() || withdrawable === 0n} onClick={onWithdraw}>
              {busy === "withdraw" ? "Confirm in your wallet…" : bundleReclaim ? `Reclaim round #${distributionId} + withdraw` : "Withdraw to my wallet"}
            </button>
            <p className="text-xs text-gc-mute">
              {bundleReclaim
                ? `Round #${distributionId} has ended: this also reclaims its ${fmt(releasable)} unclaimed $GC in the same transaction, so it can be withdrawn.`
                : ended && !graceOk
                  ? "The loaded round has ended, but reclaiming is blocked while paused and for 3 days after an unpause. Only unreserved $GC can be withdrawn now."
                  : "Only $GC not reserved for an open airdrop round can be withdrawn. The program enforces this."}
            </p>
          </div>
        </div>

        {ok && <SuccessNotice title={ok.title} sig={ok.sig} />}
        {err ? <ErrorNotice error={err} onDismiss={() => setErr(null)} /> : null}
      </div>
    </Panel>
  );
}
