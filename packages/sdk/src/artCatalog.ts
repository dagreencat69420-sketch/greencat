/**
 * GreenCat art-v1 trait catalog — matches the rendered collection art
 * (greencat-app/art: catalog.py + render.py, approved 2026-09-30).
 *
 * - Rarity is NOT re-derived here: it comes from getTokenRarity() (seed greencat-meme-collection-v1,
 *   identical to the demo, on-chain rarity.rs and metadata pipeline).
 * - Visual traits are rarity-weighted draws from a separate RNG namespace
 *   `${CATALOG_SEED}:art-v1:${tokenId}` (+ `:reroll:k` on duplicate visual combos, ascending token order).
 * - Catchphrase is the demo's getTokenTraits catchphrase (exact port of its RNG sequence).
 * Parity with art/out/catalog-art-v1.json is enforced by test/artCatalog.test.ts (all 10,000 tokens).
 */
import {
  CATALOG_SEED,
  COLLECTION_SIZE,
  RARITY_LABELS,
  getTokenRarity,
  hashSeed,
  mulberry32,
  type Rarity,
} from "./nftCatalog";

export const ART_VERSION = "art-v1";

export const ART_LAYER_NAMES = [
  "Background",
  "Fur",
  "Eyes",
  "Eyewear",
  "Hat",
  "Accessory",
  "Aura",
] as const;
export type ArtLayer = (typeof ART_LAYER_NAMES)[number];

/** [value, [commonW, uncommonW, rareW, legendaryW]] in draw order. Weights are relative per tier. */
export type ArtPool = ReadonlyArray<readonly [string, readonly [number, number, number, number]]>;

export const ART_LAYERS: Record<ArtLayer, ArtPool> = {
  Background: [
    ["Concrete Grey", [9, 3, 0, 0]],
    ["Mint Flat", [9, 3, 0, 0]],
    ["Cream Flat", [8, 3, 0, 0]],
    ["Sky Flat", [8, 3, 0, 0]],
    ["Peach Flat", [8, 3, 0, 0]],
    ["Lavender Flat", [8, 3, 0, 0]],
    ["Sage Flat", [8, 3, 0, 0]],
    ["Butter Flat", [8, 3, 0, 0]],
    ["Coral Flat", [7, 3, 0, 0]],
    ["Seafoam Flat", [7, 3, 0, 0]],
    ["Slate Flat", [6, 3, 0, 0]],
    ["Deep Forest", [4, 14, 6, 0]],
    ["Vinyl Void", [3, 13, 6, 0]],
    ["Halftone Lime", [3, 12, 6, 0]],
    ["Pixel Meadow", [2, 12, 6, 0]],
    ["Neon Alley", [0, 5, 15, 5]],
    ["Sol Dusk", [0, 4, 15, 6]],
    ["Lime Nebula", [0, 4, 14, 6]],
    ["Chart Green", [0, 3, 14, 6]],
    ["Lo-fi Night", [0, 0, 12, 12]],
    ["Laser Loft", [0, 0, 0, 14]],
    ["Holo Foil", [0, 0, 0, 14]],
    ["Golden Vault", [0, 0, 0, 14]],
    ["Moonlit Rooftop", [0, 0, 0, 13]],
  ],
  Fur: [
    ["Lime Vinyl", [44, 26, 12, 4]],
    ["Mint Vinyl", [9, 10, 5, 0]],
    ["Forest Vinyl", [9, 10, 5, 0]],
    ["Chartreuse", [8, 10, 5, 0]],
    ["Olive Glow", [8, 9, 5, 0]],
    ["Neon Cream", [8, 9, 5, 0]],
    ["Sky Vinyl", [7, 8, 6, 0]],
    ["Bubblegum", [7, 8, 6, 0]],
    ["Midnight", [0, 6, 8, 4]],
    ["Sol Gradient", [0, 0, 12, 8]],
    ["Chrome", [0, 0, 12, 14]],
    ["Gold", [0, 0, 11, 16]],
    ["Holographic", [0, 0, 4, 18]],
    ["Glow-in-the-Dark", [0, 0, 4, 12]],
    ["Galaxy", [0, 0, 0, 12]],
  ],
  Eyes: [
    ["Grumpy", [36, 26, 18, 8]],
    ["Side-Eye", [15, 14, 10, 4]],
    ["Tiny Pupils", [12, 10, 8, 0]],
    ["Big Pupils", [12, 10, 8, 0]],
    ["Sleepy", [13, 10, 8, 0]],
    ["Wink", [12, 10, 8, 6]],
    ["Heart Eyes", [0, 8, 10, 8]],
    ["Dizzy", [0, 8, 10, 4]],
    ["Star Eyes", [0, 0, 8, 10]],
    ["Glow Eyes", [0, 0, 7, 12]],
    ["Laser Eyes", [0, 0, 5, 28]],
  ],
  Eyewear: [
    ["None", [66, 56, 45, 35]],
    ["Round Specs", [10, 9, 6, 0]],
    ["Cool Shades", [10, 10, 10, 6]],
    ["3D Glasses", [7, 8, 8, 0]],
    ["Monocle", [7, 7, 8, 6]],
    ["Pixel Shades", [0, 7, 10, 8]],
    ["Neon Visor", [0, 0, 10, 12]],
    ["Gold Aviators", [0, 0, 3, 20]],
  ],
  Hat: [
    ["None", [34, 24, 14, 0]],
    ["Beanie", [10, 9, 6, 0]],
    ["Backwards Cap", [10, 9, 6, 0]],
    ["Bandana", [9, 8, 5, 0]],
    ["Bucket Hat", [9, 8, 5, 0]],
    ["Headphones", [9, 10, 10, 8]],
    ["Party Hat", [8, 6, 5, 0]],
    ["Propeller Cap", [6, 7, 7, 0]],
    ["Cowboy Hat", [5, 6, 7, 6]],
    ["Wizard Hat", [0, 4, 8, 10]],
    ["Top Hat", [0, 3, 8, 10]],
    ["Crown", [0, 0, 8, 22]],
    ["Halo", [0, 0, 6, 16]],
  ],
  Accessory: [
    ["None", [34, 24, 12, 0]],
    ["Bow Tie", [10, 9, 6, 0]],
    ["Scarf", [10, 9, 6, 0]],
    ["Silver Chain", [10, 10, 8, 0]],
    ["Coffee Cup", [10, 9, 6, 0]],
    ["Balloon", [9, 8, 6, 0]],
    ["Cassette Tape", [9, 8, 7, 4]],
    ["Gold Chain", [5, 9, 10, 8]],
    ["$GC Pendant", [0, 6, 10, 10]],
    ["Vinyl Record", [0, 2, 6, 8]],
    ["Sol-Gradient Coin", [0, 2, 9, 10]],
    ["$GC Neon Sign", [0, 0, 9, 18]],
    ["Diamond Chain", [0, 0, 5, 22]],
  ],
  Aura: [
    ["None", [100, 100, 70, 0]],
    ["Sparkles", [0, 0, 15, 28]],
    ["Lime Glow", [0, 0, 15, 26]],
    ["Gold Aura", [0, 0, 0, 24]],
    ["Neon Aura", [0, 0, 0, 22]],
  ],};

const TIER_INDEX: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, legendary: 3 };
const OPAQUE_EYEWEAR = new Set(["Cool Shades", "Pixel Shades", "Neon Visor", "Gold Aviators"]);
const EYES_OK_UNDER_OPAQUE = new Set(["Grumpy", "Laser Eyes"]);
const MAX_REROLLS = 64;
/** Low-contrast fur/background pairs swap to a fixed background ("fur|background" -> background). */
const CLASH_PAIRS: Record<string, string> = {
  "Holographic|Holo Foil": "Moonlit Rooftop",
  "Gold|Golden Vault": "Laser Loft",
  "Chrome|Concrete Grey": "Slate Flat",
  "Chrome|Slate Flat": "Concrete Grey",
  "Glow-in-the-Dark|Mint Flat": "Vinyl Void",
  "Mint Vinyl|Mint Flat": "Seafoam Flat",
  "Mint Vinyl|Seafoam Flat": "Mint Flat",
  "Neon Cream|Cream Flat": "Sky Flat",
  "Neon Cream|Butter Flat": "Lavender Flat",
  "Sky Vinyl|Sky Flat": "Peach Flat",
  "Bubblegum|Coral Flat": "Mint Flat",
  "Bubblegum|Peach Flat": "Sky Flat",
  "Olive Glow|Sage Flat": "Lavender Flat",
};

// ---- exact port of demo getTokenTraits, used only for the Catchphrase ----
const D_BACKGROUNDS = ["deep forest", "neon alley", "vinyl void", "solana dusk", "laser loft", "cardboard castle",
  "lime nebula", "pixel meadow", "moonlit litter", "chart green"];
const D_HATS = ["none", "beanie", "cowboy", "crown", "propeller", "wizard", "bandana", "headphones", "top hat", "halo"];
const D_EYES = ["sleepy", "wide", "wink", "laser", "heart", "dizzy", "cool shades", "side-eye"];
const D_ACC = ["none", "gold chain", "scarf", "backpack", "skateboard", "coffee", "balloon", "yo-yo", "laptop", "laser pointer"];
export const CATCHPHRASES = ["ngmi? ngmi not", "to the litterbox", "wagmi paws", "meow or never", "pump the yarn",
  "hodl whiskers", "based feline", "send it, human", "vibes only", "green candle cat", "purrcentage gains", "floor is lava"];
const D_FUR = ["lime vinyl", "forest", "mint", "chartreuse", "olive glow", "neon cream"];

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** Demo catchphrase for a token (same RNG call sequence as holder-app getTokenTraits). */
export function getTokenCatchphrase(tokenId: number): string {
  const rarity = getTokenRarity(tokenId);
  const rng = mulberry32(hashSeed(`${CATALOG_SEED}:traits:${tokenId}`));
  let hat = pick(rng, D_HATS);
  let acc = pick(rng, D_ACC);
  if (rarity === "common") {
    if (rng() < 0.55) hat = "none";
    if (rng() < 0.6) acc = "none";
  } else if (rarity === "legendary") {
    if (hat === "none") hat = pick(rng, D_HATS.filter((h) => h !== "none"));
    if (acc === "none") acc = pick(rng, D_ACC.filter((a) => a !== "none"));
  }
  pick(rng, D_BACKGROUNDS);
  pick(rng, D_FUR);
  pick(rng, D_EYES);
  return pick(rng, CATCHPHRASES);
}

export type ArtTraits = Record<ArtLayer, string>;

export type TokenArt = {
  tokenId: number;
  rarity: Rarity;
  traits: ArtTraits;
  catchphrase: string;
  /** number of duplicate-combo re-rolls applied (0 for most tokens) */
  rerolls: number;
};

function weighted(rng: () => number, layer: ArtLayer, tier: Rarity): string {
  const ti = TIER_INDEX[tier];
  const items = ART_LAYERS[layer].filter(([, w]) => w[ti] > 0);
  let total = 0;
  for (const [, w] of items) total += w[ti];
  const x = rng() * total;
  let acc = 0;
  for (const [k, w] of items) {
    acc += w[ti];
    if (x < acc) return k;
  }
  return items[items.length - 1][0];
}

function rollArtTraits(tokenId: number, tier: Rarity, attempt: number): ArtTraits {
  const salt = `${CATALOG_SEED}:${ART_VERSION}:${tokenId}` + (attempt ? `:reroll:${attempt}` : "");
  const rng = mulberry32(hashSeed(salt));
  const t = {} as ArtTraits;
  for (const layer of ART_LAYER_NAMES) t[layer] = weighted(rng, layer, tier);
  if (OPAQUE_EYEWEAR.has(t.Eyewear) && !EYES_OK_UNDER_OPAQUE.has(t.Eyes)) t.Eyewear = "None";
  const clash = CLASH_PAIRS[`${t.Fur}|${t.Background}`];
  if (clash) t.Background = clash;
  return t;
}

let artCatalog: TokenArt[] | null = null;

/** Full deterministic art-v1 catalog (index = tokenId - 1). Built once (~10k entries, a few ms). */
export function getArtCatalog(): TokenArt[] {
  if (artCatalog) return artCatalog;
  const seen = new Set<string>();
  const out: TokenArt[] = [];
  for (let tokenId = 1; tokenId <= COLLECTION_SIZE; tokenId++) {
    const tier = getTokenRarity(tokenId);
    let traits: ArtTraits | null = null;
    let attempt = 0;
    for (; attempt < MAX_REROLLS; attempt++) {
      const t = rollArtTraits(tokenId, tier, attempt);
      const key = ART_LAYER_NAMES.map((l) => t[l]).join("\u0000");
      if (!seen.has(key)) {
        seen.add(key);
        traits = t;
        break;
      }
    }
    if (!traits) throw new Error(`art-v1: no unique combo for token ${tokenId}`);
    out.push({ tokenId, rarity: tier, traits, catchphrase: getTokenCatchphrase(tokenId), rerolls: attempt });
  }
  artCatalog = out;
  return out;
}

export function getTokenArt(tokenId: number): TokenArt {
  if (!Number.isInteger(tokenId) || tokenId < 1 || tokenId > COLLECTION_SIZE) {
    throw new Error(`tokenId out of range: ${tokenId}`);
  }
  return getArtCatalog()[tokenId - 1];
}

/** Placeholder for the images-directory root CID until the WebP folder is published to IPFS. */
export const IMAGES_CID_PLACEHOLDER = "__IMAGES_CID__";
/** Image base = prefix placed directly before `{tokenId}.webp` (same as art/catalog.py DEFAULT_BASE_URI). */
export const DEFAULT_IMAGE_BASE_URI = `ipfs://${IMAGES_CID_PLACEHOLDER}/`;
export const ART_IMAGE_EXT = "webp";
export const ART_IMAGE_MIME = "image/webp";
export const DEFAULT_IPFS_GATEWAY = "https://ipfs.filebase.io/ipfs/";

/** Final art image: `{imageBase}{tokenId}.webp` (matches art/out/metadata `image` + `properties.files[0].uri`). */
export function tokenImageUri(tokenId: number, imageBase: string = DEFAULT_IMAGE_BASE_URI): string {
  const b = imageBase.endsWith("/") ? imageBase : `${imageBase}/`;
  return `${b}${tokenId}.${ART_IMAGE_EXT}`;
}

/** Rewrite `ipfs://CID/path` to an HTTP gateway URL for browsers; other URIs are returned unchanged. */
export function ipfsToGatewayUrl(uri: string, gateway: string = DEFAULT_IPFS_GATEWAY): string {
  if (!uri.startsWith("ipfs://")) return uri;
  const g = gateway.endsWith("/") ? gateway : `${gateway}/`;
  return `${g}${uri.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
}

/** Metaplex `properties.files` entry for a token's image. */
export function tokenImageFile(tokenId: number, imageBase: string = DEFAULT_IMAGE_BASE_URI) {
  return { uri: tokenImageUri(tokenId, imageBase), type: ART_IMAGE_MIME };
}

export type MetaplexAttribute = { trait_type: string; value: string };

/** Attributes in the same order as art/out/metadata/{id}.json. */
export function tokenAttributes(tokenId: number): MetaplexAttribute[] {
  const a = getTokenArt(tokenId);
  return [
    { trait_type: "Rarity", value: RARITY_LABELS[a.rarity] },
    ...ART_LAYER_NAMES.map((l) => ({ trait_type: l, value: a.traits[l] })),
    { trait_type: "Catchphrase", value: a.catchphrase },
    { trait_type: "Catalog Seed", value: CATALOG_SEED },
    { trait_type: "Token ID", value: String(tokenId) },
  ];
}

/** Human description, identical to the metadata JSON `description`. */
export function tokenDescription(tokenId: number): string {
  const a = getTokenArt(tokenId);
  const t = a.traits;
  const bits = [`${RARITY_LABELS[a.rarity]} GreenCat`, t.Background, `${t.Fur} fur`, `${t.Eyes} eyes`];
  for (const k of ["Eyewear", "Hat", "Accessory", "Aura"] as const) if (t[k] !== "None") bits.push(t[k]);
  bits.push(`\u201c${a.catchphrase}\u201d`);
  return bits.join(" \u00b7 ");
}
