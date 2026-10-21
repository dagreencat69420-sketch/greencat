import { CLUSTER_RPC, type SolanaCluster } from "./constants";
import { getDevnetGcMint } from "./devnet";
import { MAINNET_GC_MINT } from "./constants";

/** Resolve RPC URL for a cluster (env override wins for app). */
export function getClusterRpc(
  cluster: SolanaCluster,
  override?: string
): string {
  if (override) return override;
  return CLUSTER_RPC[cluster];
}

/** $GC mint for the active cluster. Devnet uses generated clone. */
export function getGcMintForCluster(cluster: SolanaCluster): string {
  if (cluster === "mainnet-beta") return MAINNET_GC_MINT;
  if (cluster === "devnet") return getDevnetGcMint();
  return getDevnetGcMint() || MAINNET_GC_MINT;
}

export function parseCluster(
  value: string | undefined | null
): SolanaCluster {
  if (value === "mainnet-beta" || value === "mainnet") return "mainnet-beta";
  if (value === "localnet") return "localnet";
  return "devnet";
}
