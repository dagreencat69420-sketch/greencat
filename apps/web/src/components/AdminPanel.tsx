"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  airdropPostDeadline,
  airdropReclaimOpensAt,
  buildAcceptAuthorityIx,
  buildCloseMintIx,
  buildCreateAirdropIx,
  buildReclaimAirdropIx,
  buildSetPausedIx,
  rawToUi,
} from "@greencat/sdk";
import { GC_DECIMALS } from "@/lib/config";
import { formatGc } from "@/lib/balances";
import { useSendTx } from "@/lib/useSendTx";
import { UserFacingError } from "@/lib/errors";
import { useAirdropProofs } from "@/lib/airdrop";
import { shortKey } from "@/lib/explorer";
import { useNow, useProgram } from "@/context/ProgramContext";
import { WalletNotice } from "@/components/WalletNotice";
import { AirdropPoolPanel } from "@/components/AirdropPoolPanel";
import { VrfExpiryPanel } from "@/components/VrfExpiryPanel";
import { StakingSwitchPanel } from "@/components/StakingSwitchPanel";
import { btn, ErrorNotice, field, labelCls, LaunchingSoon, Notice, Panel, PanelSkeleton, Stat, SuccessNotice } from "@/components/ui";

const NONE = "11111111111111111111111111111111";

/** Button that needs a second press within 5 s for destructive actions. */
function ConfirmButton({ label, confirmLabel, onConfirm, disabled, className }: { label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; className: string }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      aria-live="polite"
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
          window.setTimeout(() => setArmed(false), 5000);
        }
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

export function AdminPanel() {
  const { publicKey, connected } = useWallet();
  const p = useProgram();
  const send = useSendTx();
  const now = useNow(5000);
  const proofs = useAirdropProofs();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState<{ title: string; sig: string } | null>(null);
  const [proofsText, setProofsText] = useState("");
  /** Which file (id + root) the admin ticked "I checked" for; Post root stays disabled until it matches the loaded file. */
  const [reviewedKey, setReviewedKey] = useState<string | null>(null);
  const { config, collection } = p;

  const run = async (label: string, title: string, f: () => Promise<string>) => {
    setBusy(label);
    setErr(null);
    setOk(null);
    try {
      const sig = await f();
      setOk({ title, sig });
      await p.refresh();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  if (p.status === "loading") {
    return (
      <Panel title="Admin">
        <PanelSkeleton label="Loading config" />
      </Panel>
    );
  }
  if (p.status === "error") {
    return (
      <Panel title="Admin">
        <ErrorNotice error={p.error} onRetry={() => void p.refresh()} />
      </Panel>
    );
  }
  if (!config) {
    return (
      <Panel title="Admin">
        <LaunchingSoon feature="Admin" icon="🛠️">
          <p>
            {p.status === "not_deployed" ? "The program isn't deployed on this cluster yet." : "The program is deployed but not initialized."} Operators: deploy,
            then run <code className="text-gc-lime">initialize_treasuries</code> (see docs/DEPLOY.md). Initialization is gated on the upgrade authority.
          </p>
        </LaunchingSoon>
      </Panel>
    );
  }

  const isPending = !!publicKey && config.pendingAuthority === publicKey.toBase58();
  const can = p.isAdmin && !busy;
  const dist = proofs.dist;
  const expired = dist ? now >= Number(dist.expiryTs) : false;
  const fmtWhen = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const postBy = proofs.file ? airdropPostDeadline(proofs.file.expiryTs) : 0;
  const tooLateToPost = !!proofs.file && !dist && now >= postBy;
  const deadline = dist ? Number(dist.expiryTs) : proofs.file?.expiryTs ?? 0;
  const reclaimAt = dist ? airdropReclaimOpensAt(Number(dist.expiryTs), Number(config.lastPauseChangeTs), config.paused) : null;
  const reclaimOpen = reclaimAt !== null && now >= reclaimAt;
  const fileKey = proofs.file ? `${proofs.file.distributionId}:${proofs.file.merkleRoot}` : null;
  const reviewed = !!fileKey && reviewedKey === fileKey;

  return (
    <div className="space-y-5">
      <Panel title="Program status">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="State" value={config.paused ? "Paused" : "Live"} tone={config.paused ? "white" : "neon"} />
          <Stat label="Staking" value={config.stakingEnabled ? "Open" : "Locked"} tone={config.stakingEnabled ? "neon" : "white"} />
          <Stat label="Authority" value={shortKey(config.authority)} tone="white" />
          <Stat label="VRF expiry" value={`${Number(config.vrfExpirySecs) / 60} min`} tone="white" />
          <Stat label="Long bonus owed" value={formatGc(rawToUi(config.longBonusOutstanding, GC_DECIMALS), 0)} tone="lime" />
          <Stat label="Airdrop reserved" value={formatGc(rawToUi(config.airdropReserved, GC_DECIMALS), 0)} tone="lime" />
          <Stat label="Minted" value={collection ? `${collection.mintedCount} / ${collection.collectionSize}` : "—"} tone="white" />
        </div>
        {config.pendingAuthority !== NONE && (
          <div className="mt-3">
            <Notice tone="warn" title="Authority handover pending">
              Proposed new authority {shortKey(config.pendingAuthority, 6)}. It takes effect when that wallet accepts.
            </Notice>
          </div>
        )}
      </Panel>

      <Panel title="Actions" subtitle="Only the program authority can run these. Withdrawals can never dip below the reserved floors above.">
        <div className="space-y-3">
          <WalletNotice action="manage the program" />
          {connected && !p.isAdmin && !isPending && <Notice>Read-only: this wallet isn&apos;t the program authority.</Notice>}
          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
            {config.paused ? (
              <button type="button" className={btn.primary} disabled={!can} onClick={() => void run("pause", "Program resumed", () => send([buildSetPausedIx({ authority: publicKey!, paused: false })]))}>
                {busy === "pause" ? "Confirm in your wallet…" : "Resume program"}
              </button>
            ) : (
              <ConfirmButton
                className={btn.warn}
                label="Pause program"
                confirmLabel="Press again to pause"
                disabled={!can}
                onConfirm={() => void run("pause", "Program paused", () => send([buildSetPausedIx({ authority: publicKey!, paused: true })]))}
              />
            )}
            {collection && !collection.mintClosed && (
              <ConfirmButton
                className={btn.warn}
                label="Close mint early"
                confirmLabel="Press again: closing is permanent"
                disabled={!can}
                onConfirm={() => void run("close", "Mint closed. No more cats can be minted.", () => send([buildCloseMintIx({ authority: publicKey! })]))}
              />
            )}
            {isPending && (
              <button
                type="button"
                className={btn.primary}
                disabled={!!busy}
                onClick={() => void run("accept", "You are now the program authority", () => send([buildAcceptAuthorityIx({ newAuthority: publicKey! })]))}
              >
                Accept authority
              </button>
            )}
          </div>
          {ok && <SuccessNotice title={ok.title} sig={ok.sig} />}
          {err ? <ErrorNotice error={err} onDismiss={() => setErr(null)} /> : null}
        </div>
      </Panel>

      <StakingSwitchPanel />

      <VrfExpiryPanel />

      <Panel title="Airdrop distributions" subtitle="Post a snapshot's Merkle root, or reclaim unclaimed funds after its window ends.">
        <div className="space-y-3">
          {proofs.loading && !proofs.file && <p className="text-xs text-gc-mute">Loading the published airdrop file…</p>}
          {proofs.error ? <ErrorNotice error={proofs.error} /> : null}
          {proofs.file && (
            <Notice title={`Distribution #${proofs.file.distributionId}`} tone={tooLateToPost ? "warn" : undefined}>
              <span className="block">
                {proofs.file.claims.length} wallets · {formatGc(rawToUi(BigInt(proofs.file.totalAmountRaw), GC_DECIMALS), 0)} $GC ·{" "}
                {dist ? (dist.reclaimed ? "reclaimed" : expired ? "window ended" : "live") : "not posted yet"}
              </span>
              <span className="block">Claim deadline: {fmtWhen(deadline)}</span>
              {!dist &&
                (tooLateToPost ? (
                  <span className="block font-semibold">
                    Too late to post this file: the program needs at least 7 days of claim window left. Ask for a fresh snapshot.
                  </span>
                ) : (
                  <span className="block">Press Post root before {fmtWhen(postBy)} (the program needs at least 7 days of claim window).</span>
                ))}
              {dist && !dist.reclaimed && (
                <span className="block">
                  {reclaimAt === null
                    ? "Reclaim is blocked while the program is paused."
                    : reclaimOpen
                      ? "Reclaim unclaimed is available now."
                      : `Reclaim unclaimed opens ${fmtWhen(reclaimAt)}.`}
                </span>
              )}
            </Notice>
          )}
          {proofs.file && (
            <div className="space-y-2 rounded-xl border border-gc-border/80 bg-black/20 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gc-mute">
                Loaded file · {proofs.source === "pasted" ? "pasted on this page (not the published file)" : "published file (/airdrops/current.json)"}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Recipients" value={proofs.file.claims.length.toLocaleString()} tone="white" />
                <Stat label="Total" value={`${formatGc(rawToUi(BigInt(proofs.file.totalAmountRaw), GC_DECIMALS))} $GC`} />
              </div>
              <div className="rounded-xl border border-gc-border/80 bg-black/30 p-3">
                <div className="text-[11px] uppercase tracking-wide text-gc-mute">Merkle root</div>
                <code className="mt-1 block break-all font-mono text-xs text-gc-lime">{proofs.file.merkleRoot}</code>
              </div>
              {!dist && (
                <label className="flex items-start gap-2 text-xs text-white">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={reviewed}
                    onChange={(e) => setReviewedKey(e.target.checked ? fileKey : null)}
                  />
                  <span>I checked the recipient count, total and Merkle root against the snapshot I made. (Required before Post root.)</span>
                </label>
              )}
            </div>
          )}
          <details className="rounded-xl border border-gc-border/70 bg-black/20 p-3">
            <summary className="cursor-pointer text-xs font-semibold text-gc-lime">Advanced: load a proofs file manually</summary>
            <div className="mt-2 space-y-2">
              <Notice tone="warn" title="Only load files you made yourself">
                Use only an airdrop-&lt;number&gt;-proofs.json you generated with scripts/airdrop.ts snapshot. Never load a proofs file someone sent you:
                posting its root locks pool funds for whoever is in it. Normally you don&apos;t need this; the published file loads automatically.
              </Notice>
              <p className="text-xs text-gc-mute">{proofs.file ? "Load a different proofs file:" : "No airdrop file published yet? Paste one here:"}</p>
              <label htmlFor="admin-proofs" className={`${labelCls} block`}>
                Proofs JSON (airdrop-&lt;number&gt;-proofs.json from scripts/airdrop.ts snapshot)
              </label>
              <textarea id="admin-proofs" rows={3} value={proofsText} onChange={(e) => setProofsText(e.target.value)} className={`${field} font-mono text-[11px]`} />
              <button type="button" className={btn.small} disabled={!proofsText.trim() || proofs.loading} onClick={() => void proofs.loadText(proofsText)}>
                Load
              </button>
            </div>
          </details>
          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
            {config.paused ? (
              <button type="button" className={btn.primary} disabled={!can} onClick={() => void run("pause", "Program resumed", () => send([buildSetPausedIx({ authority: publicKey!, paused: false })]))}>
                {busy === "pause" ? "Confirm in your wallet…" : "Resume program"}
              </button>
            ) : (
              <ConfirmButton
                className={btn.warn}
                label="Pause program"
                confirmLabel="Press again to pause"
                disabled={!can}
                onConfirm={() => void run("pause", "Program paused", () => send([buildSetPausedIx({ authority: publicKey!, paused: true })]))}
              />
            )}
            {collection && !collection.mintClosed && (
              <ConfirmButton
                className={btn.warn}
                label="Close mint early"
                confirmLabel="Press again: closing is permanent"
                disabled={!can}
                onConfirm={() => void run("close", "Mint closed. No more cats can be minted.", () => send([buildCloseMintIx({ authority: publicKey! })]))}
              />
            )}
            {isPending && (
              <button
                type="button"
                className={btn.primary}
                disabled={!!busy}
                onClick={() => void run("accept", "You are now the program authority", () => send([buildAcceptAuthorityIx({ newAuthority: publicKey! })]))}
              >
                Accept authority
              </button>
            )}
          </div>
          {ok && <SuccessNotice title={ok.title} sig={ok.sig} />}
          {err ? <ErrorNotice error={err} onDismiss={() => setErr(null)} /> : null}
        </div>
      </Panel>

      <StakingSwitchPanel />

      <VrfExpiryPanel />

      <Panel title="Airdrop distributions" subtitle="Post a snapshot's Merkle root, or reclaim unclaimed funds after its window ends.">
        <div className="space-y-3">
          {proofs.loading && !proofs.file && <p className="text-xs text-gc-mute">Loading the published airdrop file…</p>}
          {proofs.error ? <ErrorNotice error={proofs.error} /> : null}
          {proofs.file && (
            <Notice title={`Distribution #${proofs.file.distributionId}`} tone={tooLateToPost ? "warn" : undefined}>
              <span className="block">
                {proofs.file.claims.length} wallets · {formatGc(rawToUi(BigInt(proofs.file.totalAmountRaw), GC_DECIMALS), 0)} $GC ·{" "}
                {dist ? (dist.reclaimed ? "reclaimed" : expired ? "window ended" : "live") : "not posted yet"}
              </span>
              <span className="block">Claim deadline: {fmtWhen(deadline)}</span>
              {!dist &&
                (tooLateToPost ? (
                  <span className="block font-semibold">
                    Too late to post this file: the program needs at least 7 days of claim window left. Ask for a fresh snapshot.
                  </span>
                ) : (
                  <span className="block">Press Post root before {fmtWhen(postBy)} (the program needs at least 7 days of claim window).</span>
                ))}
              {dist && !dist.reclaimed && (
                <span className="block">
                  {reclaimAt === null
                    ? "Reclaim is blocked while the program is paused."
                    : reclaimOpen
                      ? "Reclaim unclaimed is available now."
                      : `Reclaim unclaimed opens ${fmtWhen(reclaimAt)}.`}
                </span>
              )}
            </Notice>
          )}
          <details className="rounded-xl border border-gc-border/70 bg-black/20 p-3" open={!proofs.file && !proofs.loading}>
            <summary className="cursor-pointer text-xs font-semibold text-gc-lime">
              {proofs.file ? "Load a different proofs file" : "No airdrop file published yet? Paste one here"}
            </summary>
            <label htmlFor="admin-proofs" className={`${labelCls} mt-2 block`}>
              Proofs JSON (airdrop-&lt;number&gt;-proofs.json from scripts/airdrop.ts snapshot)
            </label>
            <textarea id="admin-proofs" rows={3} value={proofsText} onChange={(e) => setProofsText(e.target.value)} className={`${field} font-mono text-[11px]`} />
            <button type="button" className={`${btn.small} mt-2`} disabled={!proofsText.trim()} onClick={() => void proofs.loadText(proofsText)}>
              Load
            </button>
          </details>
          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
            <button
              type="button"
              className={btn.secondary}
              disabled={!can || !proofs.file || !!dist || tooLateToPost || !reviewed}
              onClick={() =>
                void run("create", "Distribution posted", async () => {
                  const f = proofs.file!;
                  if (`${f.distributionId}:${f.merkleRoot}` !== reviewedKey) throw new UserFacingError("unknown", "Review the loaded file first.");
                  if (!p.gcMint) throw new UserFacingError("unknown", "No $GC mint configured.");
                  const sig = await send([
                    buildCreateAirdropIx({
                      authority: publicKey!,
                      gcMint: p.gcMint,
                      id: BigInt(f.distributionId),
                      merkleRoot: Buffer.from(f.merkleRoot, "hex"),
                      totalAmountRaw: BigInt(f.totalAmountRaw),
                      expiryTs: BigInt(f.expiryTs),
                      tokenProgramId: p.tokenProgram,
                    }),
                  ]);
                  await proofs.reload();
                  return sig;
                })
              }
            >
              Post root
            </button>
            <button
              type="button"
              className={btn.warn}
              disabled={!can || !dist || !reclaimOpen || dist.reclaimed}
              onClick={() =>
                void run("reclaim", "Unclaimed funds reclaimed", async () => {
                  const sig = await send([buildReclaimAirdropIx({ authority: publicKey!, distributionId: BigInt(proofs.file!.distributionId) })]);
                  await proofs.reload();
                  return sig;
                })
              }
            >
              Reclaim unclaimed
            </button>
          </div>
        </div>
      </Panel>

      <AirdropPoolPanel dist={dist} distributionId={proofs.file?.distributionId ?? null} onDone={proofs.reload} />
    </div>
  );
}
