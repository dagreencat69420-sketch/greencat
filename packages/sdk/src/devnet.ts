import {
  DEFAULT_GC_DECIMALS,
  MAINNET_GC_DECIMALS,
} from "./constants";
import generated from "./generated/devnet.json";

export type DevnetGcConfig = {
  mint: string;
  decimals: number;
  authorityPubkey: string;
  cluster?: string;
  tokenProgram?: string;
  note?: string;
};

let cached: DevnetGcConfig | null = null;

/**
 * Load generated devnet mint config written by scripts/create-devnet-gc-mint.mjs.
 * Falls back to env NEXT_PUBLIC_GC_MINT / process.env.GC_MINT.
 */
export function getDevnetGcConfig(): DevnetGcConfig {
  if (cached) return cached;

  const fromFile = generated as DevnetGcConfig;
  if (fromFile?.mint && !String(fromFile.mint).startsWith("REPLACE")) {
    cached = fromFile;
    // still allow empty mint placeholder — treat as missing
    if (cached.mint) return cached;
  }

  const mint =
    (typeof process !== "undefined" &&
      (process.env.NEXT_PUBLIC_GC_MINT || process.env.GC_MINT)) ||
    fromFile?.mint ||
    "";

  cached = {
    mint,
    decimals: fromFile?.decimals || MAINNET_GC_DECIMALS || DEFAULT_GC_DECIMALS,
    authorityPubkey: fromFile?.authorityPubkey || "",
    cluster: "devnet",
    tokenProgram: fromFile?.tokenProgram,
    note: fromFile?.note,
  };
  return cached;
}

/** Devnet clone mint address (empty string until script runs or env is set). */
export function getDevnetGcMint(): string {
  return getDevnetGcConfig().mint;
}

export const DEVNET_GC_DECIMALS = MAINNET_GC_DECIMALS;
