/**
 * Deterministic GreenCat meme NFT catalog (10,000 tokens).
 * Parity with greencat-holder-app/src/lib/nftCatalog.ts (seed greencat-meme-collection-v1).
 */

export const COLLECTION_SIZE = 10_000;
export const MINT_PRICE_GC = 10_000;
/** Raw mint price at 6 decimals: 10_000 * 10^6 */
export const MINT_PRICE_RAW = BigInt(10_000) * BigInt(1_000_000);
export const NFT_COLLECTION_VERSION = 2;
export const CATALOG_SEED = "greencat-meme-collection-v1";
export const DEFAULT_METADATA_BASE_URI = "https://www.greencat69420.com/nft/";

export type Rarity = "legendary" | "rare" | "uncommon" | "common";

export const RARITY_COUNTS: Record<Rarity, number> = {
  legendary: 100,
  rare: 900,
  uncommon: 2_000,
  common: 7_000,
};

export const RARITY_U8: Record<Rarity, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  legendary: 3,
};

export const RARITY_FROM_U8: Rarity[] = [
  "common",
  "uncommon",
  "rare",
  "legendary",
];

export const RARITY_COLORS: Record<Rarity, string> = {
  legendary: "#FBBF24",
  rare: "#A78BFA",
  uncommon: "#38BDF8",
  common: "#94A3B8",
};

export const RARITY_LABELS: Record<Rarity, string> = {
  legendary: "Legendary",
  rare: "Rare",
  uncommon: "Uncommon",
  common: "Common",
};

/** FNV-1a 32-bit (JS parity with demo). Exported for the art-v1 trait generator. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG (JS parity with demo). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rarityTable: Rarity[] | null = null;

/** Pre-set rarity for each token index 0..9999 via seeded Fisher–Yates. */
export function getRarityTable(): Rarity[] {
  if (rarityTable) return rarityTable;
  const table: Rarity[] = [];
  (Object.keys(RARITY_COUNTS) as Rarity[]).forEach((r) => {
    for (let i = 0; i < RARITY_COUNTS[r]; i++) table.push(r);
  });
  const rng = mulberry32(hashSeed(CATALOG_SEED));
  for (let i = table.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = table[i];
    table[i] = table[j];
    table[j] = tmp;
  }
  rarityTable = table;
  return table;
}

export function getTokenRarity(tokenId: number): Rarity {
  if (tokenId < 1 || tokenId > COLLECTION_SIZE) {
    throw new Error(`tokenId out of range: ${tokenId}`);
  }
  return getRarityTable()[tokenId - 1];
}

export function rarityToU8(r: Rarity): number {
  return RARITY_U8[r];
}

export function rarityFromU8(v: number): Rarity {
  return RARITY_FROM_U8[v] ?? "common";
}

export function metadataUriForToken(
  tokenId: number,
  base: string = DEFAULT_METADATA_BASE_URI
): string {
  return `${base}${tokenId}.json`;
}

export function nftDisplayName(tokenId: number): string {
  return `GreenCat #${tokenId}`;
}
