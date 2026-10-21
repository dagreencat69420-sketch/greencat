"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { CLUSTER } from "@/lib/config";
import { formatGc } from "@/lib/balances";
import { explorerUrl, shortKey } from "@/lib/explorer";
import { useProgram } from "@/context/ProgramContext";
import { WalletNotice } from "@/components/WalletNotice";
import { btn, focusRing, Panel, Skeleton, Stat } from "@/components/ui";

export function WalletPanel() {
  const { publicKey, connected } = useWallet();
  const { sol, gc, balancesLoading, refreshBalances } = useProgram();

  return (
    <Panel
      title="Wallet"
      subtitle={<>Network: <span className="text-gc-lime">{CLUSTER}</span></>}
      actions={
        connected && (
          <button type="button" className={btn.small} onClick={() => void refreshBalances()} aria-label="Refresh balances">
            Refresh
          </button>
        )
      }
    >
      {!connected || !publicKey ? (
        <WalletNotice compact action="see your SOL and $GC balances" />
      ) : (
        <div className="space-y-3">
          <a
            href={explorerUrl("address", publicKey.toBase58())}
            target="_blank"
            rel="noreferrer"
            className={`inline-block rounded-lg font-mono text-sm text-gc-lime underline decoration-gc-lime/30 underline-offset-2 ${focusRing}`}
          >
            {shortKey(publicKey.toBase58(), 6)} <span aria-hidden>↗</span>
          </a>
          <div className="grid grid-cols-2 gap-2">
            {balancesLoading && sol === null ? (
              <>
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </>
            ) : (
              <>
                <Stat label="SOL" value={sol === null ? "—" : sol.toFixed(4)} tone="white" />
                <Stat label="$GC" value={formatGc(gc)} />
              </>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
