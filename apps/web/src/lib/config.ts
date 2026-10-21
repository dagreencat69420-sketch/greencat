import {
  DEFAULT_GC_DECIMALS,
  getDevnetGcMint,
  MAINNET_GC_MINT,
  parseCluster,
  getClusterRpc,
  type SolanaCluster,
} from "@greencat/sdk";

export const CLUSTER: SolanaCluster = parseCluster(
  process.env.NEXT_PUBLIC_SOLANA_NETWORK || "mainnet-beta"
);

export const RPC_URL = getClusterRpc(
  CLUSTER,
  process.env.NEXT_PUBLIC_RPC_URL
);

/** Active $GC mint — env override, else mainnet pump.fun CA, else generated devnet clone. */
export function getActiveGcMint(): string {
  const fromEnv = process.env.NEXT_PUBLIC_GC_MINT?.trim();
  if (fromEnv) return fromEnv;
  if (CLUSTER === "mainnet-beta") return MAINNET_GC_MINT;
  return getDevnetGcMint();
}

export const GC_DECIMALS = DEFAULT_GC_DECIMALS;

export const DEMO_URL = "https://greencat-holder-app.vercel.app";
export const MAINNET_CA = MAINNET_GC_MINT;

/**
 * NFT art image base: prefix placed directly before `{tokenId}.webp` (same as metadata `image`).
 * Default `/nft/images/` is served locally by `src/app/nft/images/[file]/route.ts` from the WebP render
 * (`art/out/images-webp`, override with ART_IMAGES_DIR). After the IPFS upload set
 * NEXT_PUBLIC_NFT_IMAGE_BASE=ipfs://<IMAGES_CID>/ (rewritten to NEXT_PUBLIC_IPFS_GATEWAY for browsers).
 */
export const NFT_IMAGE_BASE = process.env.NEXT_PUBLIC_NFT_IMAGE_BASE?.trim() || "/nft/images/";
export const IPFS_GATEWAY = process.env.NEXT_PUBLIC_IPFS_GATEWAY?.trim() || "https://ipfs.filebase.io/ipfs/";
