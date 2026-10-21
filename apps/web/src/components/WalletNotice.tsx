"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletButton } from "@/components/WalletButton";
import { CLUSTER } from "@/lib/config";
import { WALLET_NETWORK_HINT } from "@/lib/errors";
import { formatGc } from "@/lib/balances";
import { useProgram } from "@/context/ProgramContext";
import { btn, Notice } from "@/components/ui";

type PhantomWindow = Window & { phantom?: { solana?: unknown }; solana?: { isPhantom?: boolean } };

/** Mobile browser without an injected wallet → offer Phantom's universal "browse" deep link. */
export function usePhantomDeepLink(): string | null {
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    const w = window as PhantomWindow;
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const injected = !!(w.phantom?.solana || w.solana?.isPhantom);
    if (mobile && !injected) {
      const url = encodeURIComponent(window.location.href);
      const ref = encodeURIComponent(window.location.origin);
      setLink(`https://phantom.app/ul/browse/${url}?ref=${ref}`);
    }
  }, []);
  return link;
}

export function networkHint(): string {
  return WALLET_NETWORK_HINT;
}

/**
 * Inline wallet gate for action panels: connect CTA (+ Phantom deep link on mobile), and low SOL / $GC
 * warnings when the connected wallet can't afford the action.
 */
export function WalletNotice({
  action = "continue",
  needGc,
  needSol = 0.003,
  compact = false,
}: {
  action?: string;
  needGc?: number;
  needSol?: number;
  /** Narrow containers (sidebar cards): always stack the text above the button. */
  compact?: boolean;
}) {
  const { connected, connecting, wallet } = useWallet();
  const phantomOnTestCluster = connected && CLUSTER !== "mainnet-beta" && /phantom/i.test(wallet?.adapter.name ?? "");
  const { sol, gc } = useProgram();
  const deepLink = usePhantomDeepLink();

  if (!connected) {
    return (
      <div
        className={`flex flex-col items-start gap-3 rounded-xl border border-gc-lime/30 bg-gc-lime/5 p-4 text-sm text-gc-mute ${
          compact ? "" : "sm:flex-row sm:items-center sm:justify-between"
        }`}
      >
        <p>
          <span aria-hidden>🔌 </span>
          {connecting ? "Connecting to your wallet…" : `Connect a wallet to ${action}.`}
          {!connecting && <span className="mt-0.5 block text-xs opacity-80">Phantom, MetaMask, Solflare, Backpack and more.</span>}
        </p>
        <div className="flex shrink-0 flex-wrap gap-2">
          {deepLink ? (
            <a href={deepLink} className={btn.primary}>
              Open in Phantom
            </a>
          ) : (
            <WalletButton />
          )}
        </div>
        {deepLink && (
          <p className="text-xs">
            On mobile, wallets work inside their in-app browser. The button reopens this page in Phantom.
          </p>
        )}
      </div>
    );
  }

  const lowSol = sol !== null && sol < needSol;
  const lowGc = needGc !== undefined && gc !== null && gc < needGc;
  if (!lowSol && !lowGc) {
    // Phantom previews (and would submit) on the network picked in Phantom, not the app's. Remind once per panel.
    return phantomOnTestCluster ? (
      <p className="text-xs text-gc-mute" data-testid="phantom-network-tip">
        <span aria-hidden>🧪 </span>Phantom user? This is a {CLUSTER} preview. {networkHint()}
      </p>
    ) : null;
  }
  return (
    <Notice tone="warn" title={lowSol ? "Low SOL balance" : "Not enough $GC"}>
      {lowSol && (
        <p>
          You have {sol?.toFixed(4)} SOL. Keep at least ~{needSol} SOL on {CLUSTER} for fees and rent.
        </p>
      )}
      {lowGc && (
        <p>
          You have {formatGc(gc)} $GC; this needs {formatGc(needGc ?? 0)} $GC.
        </p>
      )}
      <p className="mt-1 text-xs opacity-80">Wrong network? {networkHint()}</p>
    </Notice>
  );
}

/** Global banners: non-mainnet preview + launch status (one compact line), RPC/mint misconfiguration, paused program. */
export function ClusterBanner() {
  const { rpcMismatch, mintMismatch, paused, status } = useProgram();
  const notLive = status === "not_deployed" || status === "not_initialized";
  const items: { tone: "warn" | "error"; text: string }[] = [];
  if (rpcMismatch) items.push({ tone: "error", text: rpcMismatch });
  if (mintMismatch) items.push({ tone: "error", text: mintMismatch });
  if (paused) items.push({ tone: "warn", text: "GreenCat is paused for maintenance. Most new actions are blocked until it resumes; your funds stay safe." });
  const preview = CLUSTER !== "mainnet-beta";
  if (!preview && !notLive && items.length === 0) return null;
  const net = CLUSTER === "devnet" ? "Devnet" : CLUSTER;
  return (
    <div className="mx-auto mt-3 w-full max-w-5xl space-y-2 px-4">
      {(preview || notLive) && (
        <details className="group rounded-lg border border-gc-lime/25 bg-gc-lime/5 text-xs text-gc-mute">
          <summary className="flex min-h-[36px] cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gc-neon [&::-webkit-details-marker]:hidden">
            {preview && (
              <span className="inline-flex items-center gap-1 rounded-full bg-gc-lime px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-black">
                {net}
              </span>
            )}
            <span className="min-w-0 flex-1">
              {preview ? (
                <>
                  <span className="hidden sm:inline">Preview build: test funds only.</span>
                  <span className="sm:hidden">Test funds only.</span>
                </>
              ) : null}
              {notLive ? (
                <span className="text-gc-lime">
                  {" "}
                  <span aria-hidden>🚀 </span>
                  <span className="hidden sm:inline">On-chain features launch soon.</span>
                  <span className="sm:hidden">Launching soon.</span>
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-gc-lime underline decoration-gc-lime/40 underline-offset-2">
              <span className="group-open:hidden">Wallet setup</span>
              <span className="hidden group-open:inline">Hide</span>
            </span>
          </summary>
          <div className="space-y-1 border-t border-gc-lime/15 px-3 py-2 leading-relaxed">
            <p>{networkHint()}</p>
            <p>MetaMask (Solana), Solflare, Backpack and other Wallet Standard wallets are detected automatically; Phantom works too.</p>
            {notLive && <p>Browsing, Points and the lo-fi player work today. Minting, staking and the marketplace switch on when the GreenCat program goes live.</p>}
          </div>
        </details>
      )}
      {items.map((i) => (
        <p
          key={i.text}
          role={i.tone === "error" ? "alert" : "status"}
          className={`rounded-lg border px-3 py-1.5 text-xs ${
            i.tone === "error" ? "border-red-400/50 bg-red-500/10 text-red-100" : "border-amber-400/40 bg-amber-500/10 text-amber-100"
          }`}
        >
          {i.text}
        </p>
      ))}
    </div>
  );
}
