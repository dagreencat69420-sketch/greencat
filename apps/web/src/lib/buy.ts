import { MAINNET_CA } from "@/lib/config";

/** Wrapped SOL mint (Jupiter's "SOL"). */
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * "Buy $GC" target: Jupiter swap with SOL → mainnet $GC pre-selected. Always the real mainnet mint, whatever cluster
 * this app runs on. Verified 2026-10-07 PT in headless Chrome: Sell = SOL, Buy = GreenCat (G2b4…pump).
 * Note: the old path form `jup.ag/swap/SOL-<mint>` no longer works (it redirects to SOL → USDC), so use the query form.
 */
export const JUPITER_BUY_GC_URL = `https://jup.ag/swap?sell=${SOL_MINT}&buy=${MAINNET_CA}`;

/** Short form of the mainnet mint for UI copy, e.g. "G2b4…pump". */
export const MAINNET_CA_SHORT = `${MAINNET_CA.slice(0, 4)}…${MAINNET_CA.slice(-4)}`;

/**
 * "No crypto yet?" help links (official wallet docs, verified 2026-10-07 PT). Jupiter's own card page
 * (jup.ag/deposit/onramp) showed "Invalid Link" when checked, so we point to the wallets' built-in buy flows instead.
 */
export const BUY_SOL_HELP = {
  phantomExtension: "https://help.phantom.com/articles/buy-sol-eth-and-other-tokens-in-the-phantom-browser-extension-52630526574227",
  phantomMobile: "https://help.phantom.com/articles/buy-sol-eth-btc-and-other-native-tokens-in-phantom-on-mobile-55468554125075",
  solflare: "https://www.solflare.com/prices/solana/So11111111111111111111111111111111111111112/how-to-buy/",
} as const;
