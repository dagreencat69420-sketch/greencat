"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { buildClaimAirdropIx, deriveAirdropClaimPda, deriveAirdropDistributionPda, merkleLeaf, rawToUi, verifyMerkleProof } from "@greencat/sdk";
import { GC_DECIMALS } from "@/lib/config";
import { formatGc } from "@/lib/balances";
import { useSendTx } from "@/lib/useSendTx";
import { UserFacingError } from "@/lib/errors";
import { useAirdropProofs } from "@/lib/airdrop";
import { useNow, useProgram } from "@/context/ProgramContext";
import { WalletNotice } from "@/components/WalletNotice";
import { btn, EmptyState, ErrorNotice, formatDuration, Notice, Panel, Skeleton, Stat, SuccessNotice } from "@/components/ui";

/**
 * Merkle airdrop (audit GC-22): the team snapshots holders off-chain, publishes the proofs file and
 * posts only the root on-chain. Each holder claims their own amount with a proof.
 * Holders only ever see the auto-loaded published file (public/airdrops/current.json); there is no
 * way to paste or link a proofs file here, so a scammer can't hand holders a fake one.
 */
export function AirdropPanel({ proofs }: { proofs: ReturnType<typeof useAirdropProofs> }) {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const p = useProgram();
  const send = useSendTx();
  const now = useNow(5000);
  const { file, dist, loading, error } = proofs;
  const [claimed, setClaimed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);

  const mine = useMemo(() => (file && publicKey ? file.claims.find((c) => c.claimant === publicKey.toBase58()) ?? null : null), [file, publicKey]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!file || !mine) return setClaimed(null);
      const [distPk] = deriveAirdropDistributionPda(BigInt(file.distributionId));
      const [claimPk] = deriveAirdropClaimPda(distPk, mine.index);
      const c = (await connection.getAccountInfo(claimPk, "confirmed")) !== null;
      if (alive) setClaimed(c);
    })();
    return () => {
      alive = false;
    };
  }, [connection, file, mine, ok]);

  const expiry = dist ? Number(dist.expiryTs) : file?.expiryTs ?? 0;
  const expired = expiry > 0 && now >= expiry;

  const onClaim = async () => {
    if (!file || !mine || !publicKey || !p.gcMint) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const [distPk] = deriveAirdropDistributionPda(BigInt(file.distributionId));
      const proof = mine.proof.map((h) => Buffer.from(h, "hex"));
      const leaf = merkleLeaf(distPk, mine.index, publicKey, BigInt(mine.amountRaw));
      if (!verifyMerkleProof(proof, Buffer.from(file.merkleRoot, "hex"), leaf)) {
        throw new UserFacingError("program", "Your proof doesn't verify against this airdrop. Refresh this page and try again.");
      }
      const sig = await send(
        [
          buildClaimAirdropIx({
            claimant: publicKey,
            gcMint: p.gcMint,
            distributionId: BigInt(file.distributionId),
            index: BigInt(mine.index),
            amountRaw: BigInt(mine.amountRaw),
            proof,
            tokenProgramId: p.tokenProgram,
          }),
        ],
        { minSol: 0.005, cu: 200_000 }
      );
      setOk(sig);
      void p.refreshBalances();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <Panel title="Airdrop claim" subtitle="Snapshot + Merkle proof. You claim your own allocation; nothing is sent automatically.">
        {!file &&
          (loading ? (
            <div role="status" className="space-y-2">
              <span className="sr-only">Loading the current airdrop…</span>
              <Skeleton className="h-16" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : !error ? (
            <EmptyState icon="🪂" title="No airdrop right now">
              Official airdrops are announced on GreenCat&apos;s channels and appear here automatically.
            </EmptyState>
          ) : null)}
        {error ? (
          <div className="mt-3">
            <ErrorNotice error={error} />
          </div>
        ) : null}

        {file && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Distribution" value={`#${file.distributionId}`} tone="white" />
              <Stat label="Wallets" value={file.claims.length.toLocaleString()} tone="white" />
              <Stat label="Total" value={`${formatGc(rawToUi(BigInt(file.totalAmountRaw), GC_DECIMALS), 0)} $GC`} />
              <Stat
                label="Window"
                value={!dist ? "not live" : dist.reclaimed ? "closed" : expired ? "ended" : `${formatDuration(expiry - now)} left`}
                tone={expired || !dist ? "white" : "lime"}
              />
            </div>
            {!dist && <Notice tone="warn">This airdrop isn&apos;t live on-chain yet. Claims open once the team posts it.</Notice>}
            {dist && expired && <Notice tone="warn">The claim window ended {new Date(expiry * 1000).toLocaleString()}.</Notice>}
            <WalletNotice action="check your allocation" />
            {connected &&
              (mine ? (
                <div className="rounded-xl border border-gc-lime/40 bg-gc-lime/10 p-4">
                  <p className="text-xs uppercase tracking-wide text-gc-mute">Your allocation</p>
                  <p className="mt-1 text-2xl font-black text-gc-neon">{formatGc(rawToUi(BigInt(mine.amountRaw), GC_DECIMALS))} $GC</p>
                  <button
                    type="button"
                    className={`${btn.primary} mt-3 w-full sm:w-auto`}
                    disabled={busy || claimed !== false || !dist || expired || p.paused}
                    onClick={() => void onClaim()}
                  >
                    {claimed ? "Claimed ✓" : busy ? "Confirm in your wallet…" : claimed === null ? "Checking…" : "Claim"}
                  </button>
                </div>
              ) : (
                <EmptyState icon="🙀" title="This wallet isn't in this snapshot">
                  Check that you connected the wallet that held $GC at snapshot time.
                </EmptyState>
              ))}
            {ok && <SuccessNotice title="Airdrop claimed!" sig={ok} />}
            {err ? <ErrorNotice error={err} onDismiss={() => setErr(null)} /> : null}
          </div>
        )}
        <p className="mt-4 text-xs font-semibold text-gc-lime">🔒 Never paste airdrop links or files from anyone: claims only happen here.</p>
        <p className="mt-2 text-[11px] leading-relaxed text-gc-mute">
          The program checks each proof, pays each leaf once, and reserves the total so the pool can&apos;t be withdrawn from under claimants.
          Unclaimed funds return to the pool only after the claim window (≥ 7 days) ends.
        </p>
      </Panel>
    </div>
  );
}
