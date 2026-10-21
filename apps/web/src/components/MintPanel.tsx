"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  buildMintNftIx,
  COLLECTION_SIZE,
  fetchOraoTreasury,
  MINT_NFT_COMPUTE_UNITS,
  MINT_PRICE_GC,
  RARITY_COLORS,
  RARITY_LABELS,
  rarityFromU8,
  rawToUi,
  type DecodedNftRecord,
  type Rarity,
} from "@greencat/sdk";
import { useConnection } from "@solana/wallet-adapter-react";
import { CLUSTER, GC_DECIMALS } from "@/lib/config";
import { formatGc } from "@/lib/balances";
import { UserFacingError, friendlyError } from "@/lib/errors";
import { nftLabel, useMyNfts } from "@/lib/nfts";
import { shortKey } from "@/lib/explorer";
import { useInstantReveal, type RevealPhase } from "@/lib/instantReveal";
import { usePoints } from "@/context/PointsContext";
import { useProgram } from "@/context/ProgramContext";
import { useToast } from "@/components/Toaster";
import { NftImage, NftTraits } from "@/components/NftArt";
import { NftStatsCard } from "@/components/NftStats";
import { WalletNotice } from "@/components/WalletNotice";
import { btn, EmptyState, ErrorNotice, Notice, Panel, PanelSkeleton, Stat, TxLink, LaunchingSoon } from "@/components/ui";

type Minted = { mint: string; sig: string; phase: RevealPhase; record?: DecodedNftRecord; revealSig?: string | null };

function playRevealSfx(rarity: Rarity) {
  try {
    const audio = new Audio(`/sounds/reveal-${rarity}.wav`);
    audio.volume = 0.55;
    void audio.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

export function MintPanel() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const { awardBonus } = usePoints();
  const { toast } = useToast();
  const p = useProgram();
  const { collection, status } = p;
  const reveal = useInstantReveal(p.programId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [minted, setMinted] = useState<Minted | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // StrictMode mounts effects twice in dev; re-arm after the simulated unmount
    return () => void (alive.current = false);
  }, []);

  const soldOut = collection ? collection.mintedCount >= collection.collectionSize || collection.mintClosed : false;
  const priceUi = collection ? rawToUi(collection.mintPriceRaw, GC_DECIMALS) : MINT_PRICE_GC;
  const vrfExpiry = Number(p.config?.vrfExpirySecs ?? 86_400n);

  const onRevealed = useCallback(
    (rec: DecodedNftRecord, revealSig: string | null) => {
      setMinted((m) => (m ? { ...m, phase: { kind: "revealed", record: rec, sig: revealSig }, record: rec, revealSig } : m));
      playRevealSfx(rarityFromU8(rec.rarity));
      toast({ tone: "success", title: `It's GreenCat #${rec.tokenId}!`, sig: revealSig ?? undefined });
      void p.refresh();
    },
    [p, toast]
  );

  const onMint = async () => {
    if (!publicKey || !collection || soldOut || !p.gcMint) return;
    setBusy(true);
    setErr(null);
    setMinted(null);
    try {
      if (p.gc !== null && p.gc < priceUi) {
        throw new UserFacingError("insufficient_gc", `Minting costs ${formatGc(priceUi)} $GC; you have ${formatGc(p.gc)} $GC.`);
      }
      const nftMint = Keypair.generate();
      const ix = buildMintNftIx({
        buyer: publicKey,
        nftMint: nftMint.publicKey,
        gcMint: p.gcMint,
        buyerGcAta: getAssociatedTokenAddressSync(p.gcMint, publicKey, false, p.tokenProgram),
        buyerNftAta: getAssociatedTokenAddressSync(nftMint.publicKey, publicKey, false, TOKEN_PROGRAM_ID),
        vrfTreasury: await fetchOraoTreasury(connection),
        tokenProgramId: p.tokenProgram,
        programId: p.programId,
      });
      const { mintSig, wait } = await reveal.mintAndReveal(ix, nftMint, { cu: MINT_NFT_COMPUTE_UNITS, minSol: 0.04 });
      setMinted({ mint: nftMint.publicKey.toBase58(), sig: mintSig, phase: { kind: "waiting_oracle" } });
      setBusy(false);
      void awardBonus("mint", mintSig);
      void p.refresh();
      void p.refreshBalances();
      const end = await wait((ph) => alive.current && ph.kind !== "revealed" && setMinted((m) => (m ? { ...m, phase: ph } : m)));
      if (!alive.current) return;
      if (end.kind === "revealed") onRevealed(end.record, end.sig);
      // The oracle answered: ask for the reveal right away (one more normal approval; "Reveal my cat" stays as a retry).
      else void revealMint(nftMint.publicKey.toBase58());
    } catch (e) {
      console.error("mint failed:", e);
      setErr(e);
      const f = friendlyError(e);
      toast(f.kind === "rejected" ? { tone: "info", title: "Cancelled in your wallet", body: "Nothing was sent." } : { tone: "error", title: f.message, body: f.hint ?? f.detail });
    } finally {
      setBusy(false);
    }
  };

  const revealMint = async (mintStr: string) => {
    setErr(null);
    setMinted((m) => (m ? { ...m, phase: { kind: "settling" } } : m));
    try {
      const mint = new PublicKey(mintStr);
      for (let i = 0; i < 6; i++) {
        const before = await reveal.readRecord(mint);
        if (before?.revealed) return onRevealed(before, null);
        let sig: string | null = null;
        try {
          sig = await reveal.revealNow(mint, vrfExpiry);
        } catch (e) {
          // "oracle hasn't answered yet" / "earlier mints first": keep waiting; wallet or program errors surface
          if (!(e instanceof UserFacingError) || i === 5) throw e;
        }
        const rec = await reveal.readRecord(mint);
        if (rec?.revealed) return onRevealed(rec, sig);
        await new Promise((r) => setTimeout(r, 1500));
      }
      setMinted((m) => (m ? { ...m, phase: { kind: "needs_approval", reason: "Still waiting. Try again in a few seconds." } } : m));
    } catch (e) {
      console.error("reveal failed:", e);
      const f = friendlyError(e);
      if (f.kind === "rejected") {
        toast({ tone: "info", title: "Reveal not sent", body: "Your cat is minted. Press “Reveal my cat” whenever you're ready." });
      } else {
        setErr(e);
        toast({ tone: "error", title: f.message, body: f.hint ?? f.detail });
      }
      setMinted((m) => (m ? { ...m, phase: { kind: "needs_approval", reason: "Your cat is minted. The reveal wasn't sent yet." } } : m));
    }
  };
  const onRevealNow = () => minted && revealMint(minted.mint);

  if (status === "loading") {
    return (
      <Panel title="Mint">
        <PanelSkeleton label="Loading collection" />
      </Panel>
    );
  }
  if (status === "error") {
    return (
      <Panel title="Mint">
        <ErrorNotice error={p.error} onRetry={() => void p.refresh()} />
      </Panel>
    );
  }
  if (!collection) {
    return (
      <Panel title="Mint">
        <LaunchingSoon feature="Minting" icon="🎁">
          <p>
            The GreenCat collection opens once the program is live on {CLUSTER}. Every cat is minted with $GC and revealed seconds
            later by an on-chain random draw (ORAO VRF), so nobody can pick the rare ones.
          </p>
        </LaunchingSoon>
      </Panel>
    );
  }

  const mintedN = Number(collection.mintedCount);
  const size = Number(collection.collectionSize);
  const pct = size ? Math.min(100, (mintedN / size) * 100) : 0;

  return (
    <div className="space-y-5">
      <Panel
        title="Mint a GreenCat"
        subtitle={
          <>
            {formatGc(priceUi)} $GC each · {COLLECTION_SIZE.toLocaleString()} cats · your cat is revealed seconds after you
            mint (random remaining cat, ORAO VRF)
          </>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Minted" value={`${mintedN.toLocaleString()} / ${size.toLocaleString()}`} />
          <Stat label="Price" value={`${formatGc(priceUi)} $GC`} tone="lime" />
          <Stat label="Remaining" value={(size - mintedN).toLocaleString()} tone="white" />
          <Stat label="Royalty" value={`${(collection.royaltyBps / 100).toFixed(1)}%`} tone="white" />
        </div>
        <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-black/40"
          role="progressbar"
          aria-label="Collection minted"
          aria-valuemin={0}
          aria-valuemax={size}
          aria-valuenow={mintedN}
        >
          <div className="h-full rounded-full bg-gc-lime shadow-neonSm" style={{ width: `${pct}%` }} />
        </div>

        <div className="mt-4 space-y-3">
          <WalletNotice action="mint" needGc={soldOut ? undefined : priceUi} needSol={0.04} />
          {p.paused && <Notice tone="warn">Minting is paused right now.</Notice>}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              disabled={!connected || soldOut || busy || p.paused}
              onClick={() => void onMint()}
              className={`${btn.primary} w-full sm:w-auto`}
              aria-busy={busy}
            >
              {busy ? "Confirm in your wallet…" : soldOut ? (collection.mintClosed ? "Mint closed" : "Sold out") : `Mint · ${formatGc(priceUi)} $GC`}
            </button>
            {connected && p.gc !== null && !soldOut && (
              <span className="text-xs text-gc-mute">Balance {formatGc(p.gc)} $GC</span>
            )}
          </div>
          {err ? <ErrorNotice error={err} onRetry={() => void onMint()} onDismiss={() => setErr(null)} /> : null}
          {minted && <MintResult minted={minted} onRevealNow={() => void onRevealNow()} />}
        </div>
      </Panel>
      <PendingPanel />
    </div>
  );
}

function phaseText(ph: RevealPhase): string {
  switch (ph.kind) {
    case "waiting_oracle":
      return "Revealing… waiting for the randomness oracle (usually a few seconds).";
    case "queued":
      return ph.ahead > 0 ? `Revealing… ${ph.ahead} earlier mint${ph.ahead === 1 ? "" : "s"} first (cats are drawn in mint order).` : "Revealing…";
    case "settling":
      return "Revealing… approve the reveal in your wallet if it asks (it draws your cat on-chain).";
    case "needs_approval":
      return ph.reason;
    default:
      return "";
  }
}

function MintResult({ minted, onRevealNow }: { minted: Minted; onRevealNow: () => void }) {
  const rec = minted.record;
  if (minted.phase.kind === "revealed" && rec) {
    const rarity = rarityFromU8(rec.rarity);
    return (
      <div className="gc-unwrap rounded-2xl border p-4" style={{ borderColor: RARITY_COLORS[rarity] + "88" }} role="status" aria-live="polite">
        <p className="text-xs uppercase tracking-wider text-gc-mute">You minted</p>
        <div className="mt-1">
          <NftStatsCard tokenId={rec.tokenId} rarity={rarity} />
        </div>
        <p className="mt-2 font-mono text-[11px] text-gc-mute">NFT {shortKey(minted.mint, 6)}</p>
        <p className="mt-1 flex flex-wrap gap-3">
          <TxLink sig={minted.sig} label="Mint transaction" />
          {minted.revealSig && <TxLink sig={minted.revealSig} label="Reveal transaction" />}
        </p>
      </div>
    );
  }
  const needs = minted.phase.kind === "needs_approval";
  return (
    <div className="rounded-2xl border border-gc-lime/50 bg-black/30 p-4" role="status" aria-live="polite">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,160px)_1fr]">
        <NftImage tokenId={0} revealing={!needs} />
        <div>
          <p className="text-xs uppercase tracking-wider text-gc-mute">Minted · {needs ? "reveal pending" : "revealing…"}</p>
          <p className="mt-1 text-sm text-white">{phaseText(minted.phase)}</p>
          {needs && (
            <button type="button" className={`${btn.primary} mt-3`} onClick={onRevealNow}>
              Reveal my cat
            </button>
          )}
          <p className="mt-2 font-mono text-[11px] text-gc-mute">NFT {shortKey(minted.mint, 6)}</p>
          <p className="mt-1">
            <TxLink sig={minted.sig} label="Mint transaction" />
          </p>
        </div>
      </div>
    </div>
  );
}

/** The wallet's cats that are still waiting for their reveal (minted before the upgrade, or a stuck oracle). */
function PendingPanel() {
  const { connected } = useWallet();
  const { toast } = useToast();
  const p = useProgram();
  const reveal = useInstantReveal(p.programId);
  const { nfts, refresh } = useMyNfts();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<{ rec: DecodedNftRecord; sig: string | null } | null>(null);
  const collection = p.collection!;
  const pending = (nfts ?? []).filter((n) => !n.record.revealed);
  const vrfExpiry = Number(p.config?.vrfExpirySecs ?? 86_400n);
  const queued = Number(collection.mintedCount - collection.revealedCount);

  const revealOne = async (mint: string) => {
    setBusy(mint);
    setErr(null);
    try {
      const pk = new PublicKey(mint);
      let lastSig: string | null = null;
      for (let i = 0; i < 8; i++) {
        const rec = await reveal.readRecord(pk);
        if (rec?.revealed) {
          setDone({ rec, sig: lastSig });
          playRevealSfx(rarityFromU8(rec.rarity));
          break;
        }
        try {
          lastSig = await reveal.revealNow(pk, vrfExpiry);
        } catch (e) {
          if (!(e instanceof UserFacingError) || i === 7) throw e;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      await refresh();
      await p.refresh();
    } catch (e) {
      console.error("reveal failed:", e);
      setErr(e);
      const f = friendlyError(e);
      toast(
        f.kind === "rejected"
          ? { tone: "info", title: "Reveal not sent", body: "Nothing was sent. Try again whenever you're ready." }
          : { tone: "error", title: f.message, body: f.hint ?? f.detail }
      );
    } finally {
      setBusy(null);
    }
  };

  if (!connected || (!pending.length && !done && queued === 0)) return null;
  return (
    <Panel title="Waiting to be revealed" subtitle={`${queued.toLocaleString()} cat${queued === 1 ? "" : "s"} in the reveal queue · revealed in mint order`}>
      {pending.length === 0 ? (
        <EmptyState icon="✨" title="All your cats are revealed" />
      ) : (
        <ul className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:grid-cols-3">
          {pending.map((n) => (
            <li key={n.mint} className="flex items-center justify-between gap-2 rounded-xl border border-gc-border bg-black/30 p-3">
              <span className="min-w-0">
                <span className="block font-semibold text-white">{nftLabel(n)}</span>
                <span className="block truncate font-mono text-[10px] text-gc-mute">{shortKey(n.mint, 5)}</span>
              </span>
              <button type="button" className={btn.small} disabled={!!busy} onClick={() => void revealOne(n.mint)} aria-label={`Reveal ${nftLabel(n)}`}>
                {busy === n.mint ? "Revealing…" : "Reveal"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {err ? <div className="mt-3"><ErrorNotice error={err} onDismiss={() => setErr(null)} /></div> : null}
      {done && (
        <div className="gc-unwrap mt-3 rounded-2xl border p-4" style={{ borderColor: RARITY_COLORS[rarityFromU8(done.rec.rarity)] + "88" }} role="status">
          <p className="text-xs uppercase tracking-wider text-gc-mute">Revealed</p>
          <p className="mt-1 text-2xl font-black text-white">GreenCat #{done.rec.tokenId}</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,220px)_1fr]">
            <NftImage tokenId={done.rec.tokenId} rarity={rarityFromU8(done.rec.rarity)} />
            <NftTraits tokenId={done.rec.tokenId} />
          </div>
          {done.sig && <p className="mt-2"><TxLink sig={done.sig} /></p>}
        </div>
      )}
      <Notice>
        Each mint gets its own oracle randomness, and cats are drawn from the remaining pool strictly in mint order, so nobody can
        wait for a better draw. Anyone can push the queue forward; it only costs a transaction fee.
      </Notice>
    </Panel>
  );
}
