import { CLUSTER, RPC_URL } from "@/lib/config";

/** Solana Explorer link for a tx / address on the active cluster (custom RPC for localnet). */
export function explorerUrl(kind: "tx" | "address", id: string): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  if (CLUSTER === "mainnet-beta") return base;
  if (CLUSTER === "localnet") return `${base}?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`;
  return `${base}?cluster=${CLUSTER}`;
}

export function shortKey(k: string, n = 4): string {
  return k.length > 2 * n + 1 ? `${k.slice(0, n)}…${k.slice(-n)}` : k;
}
