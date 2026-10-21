"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ALL_POOL_IDS, deriveAllTreasuryAddresses, GREENCAT_PROGRAM_ID, POOL_LABELS, PoolId } from "@greencat/sdk";
import { formatGc } from "@/lib/balances";
import { explorerUrl, shortKey } from "@/lib/explorer";
import { useProgram } from "@/context/ProgramContext";
import { btn, ErrorNotice, focusRing, Panel, Skeleton } from "@/components/ui";

type PoolRow = { poolId: PoolId; label: string; pda: string; vaultAta: string; balanceUi: number | null };

function Addr({ k }: { k: string }) {
  return (
    <a href={explorerUrl("address", k)} target="_blank" rel="noreferrer" className={`font-mono text-gc-lime underline decoration-gc-lime/30 underline-offset-2 ${focusRing}`} title={k}>
      {shortKey(k, 5)}
    </a>
  );
}

/** Treasury pools + vault balances. Cards on phones, a table from `sm` up. */
export function TreasuriesPanel() {
  const { connection } = useConnection();
  const p = useProgram();
  const addrs = useMemo(() => deriveAllTreasuryAddresses(GREENCAT_PROGRAM_ID), []);
  const [rows, setRows] = useState<PoolRow[] | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!p.gcMint) return;
    setErr(null);
    try {
      const pools = ALL_POOL_IDS.map((id) => addrs.pools.find((x) => x.poolId === id)!);
      const atas = pools.map((x) => getAssociatedTokenAddressSync(p.gcMint!, new PublicKey(x.pda), true, p.tokenProgram));
      const bals = await Promise.all(atas.map((a) => connection.getTokenAccountBalance(a, "confirmed").then((b) => Number(b.value.uiAmountString ?? 0)).catch(() => null)));
      setRows(pools.map((x, i) => ({ poolId: x.poolId, label: POOL_LABELS[x.poolId], pda: x.pda, vaultAta: atas[i].toBase58(), balanceUi: bals[i] })));
    } catch (e) {
      setErr(e);
    }
  }, [connection, addrs, p.gcMint, p.tokenProgram]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Panel
      title="Treasuries"
      subtitle={<>Program vaults on-chain. Balances are read live from each pool&apos;s token account.</>}
      actions={
        <button type="button" className={btn.small} onClick={() => void refresh()}>
          Refresh
        </button>
      }
    >
      {err ? <ErrorNotice error={err} onRetry={() => void refresh()} /> : null}
      {!rows ? (
        <div className="space-y-2" role="status">
          <span className="sr-only">Loading treasuries…</span>
          {ALL_POOL_IDS.map((id) => (
            <Skeleton key={id} className="h-10" />
          ))}
        </div>
      ) : (
        <>
          <ul className="space-y-2 sm:hidden">
            {rows.map((r) => (
              <li key={r.poolId} className="rounded-xl border border-gc-border bg-black/30 p-3 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-white">{r.label}</span>
                  <span className="font-bold tabular-nums text-gc-neon">{r.balanceUi === null ? "no vault" : `${formatGc(r.balanceUi, 0)} $GC`}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-gc-mute">
                  <span>
                    PDA <Addr k={r.pda} />
                  </span>
                  <span>
                    Vault <Addr k={r.vaultAta} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Treasury pools and balances</caption>
              <thead className="text-xs text-gc-mute">
                <tr className="border-b border-gc-border">
                  <th scope="col" className="py-2 pr-2">
                    Pool
                  </th>
                  <th scope="col" className="py-2 pr-2">
                    PDA
                  </th>
                  <th scope="col" className="py-2 pr-2">
                    Vault
                  </th>
                  <th scope="col" className="py-2 text-right">
                    Balance ($GC)
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.poolId} className="border-b border-gc-border/50">
                    <th scope="row" className="py-2 pr-2 font-medium text-white">
                      {r.label}
                    </th>
                    <td className="py-2 pr-2 text-xs">
                      <Addr k={r.pda} />
                    </td>
                    <td className="py-2 pr-2 text-xs">
                      <Addr k={r.vaultAta} />
                    </td>
                    <td className="py-2 text-right font-semibold tabular-nums text-gc-neon">{r.balanceUi === null ? "no vault" : formatGc(r.balanceUi, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}
