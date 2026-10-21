#!/usr/bin/env node
/**
 * Stub: generate EXAMPLE Metaplex JSON for GreenCat catalog tokens.
 *
 * Usage:
 *   node scripts/generate-metadata.mjs --limit 3
 *   node scripts/generate-metadata.mjs --limit 10000 --out metadata/out
 *
 * Rarity matches packages/sdk (seed greencat-meme-collection-v1).
 * Traits / images are EXAMPLE placeholders until art is final.
 * See docs/METADATA-PIPELINE.md
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CATALOG_SEED = "greencat-meme-collection-v1";
const COLLECTION_SIZE = 10_000;
const RARITY_COUNTS = {
  legendary: 100,
  rare: 900,
  uncommon: 2_000,
  common: 7_000,
};
const RARITY_LABELS = {
  legendary: "Legendary",
  rare: "Rare",
  uncommon: "Uncommon",
  common: "Common",
};

const DEFAULT_BASE = "https://www.greencat69420.com/nft/";

function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getRarityTable() {
  const table = [];
  for (const [r, n] of Object.entries(RARITY_COUNTS)) {
    for (let i = 0; i < n; i++) table.push(r);
  }
  const rng = mulberry32(hashSeed(CATALOG_SEED));
  for (let i = table.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [table[i], table[j]] = [table[j], table[i]];
  }
  return table;
}

function parseArgs(argv) {
  let limit = 3;
  let out = path.join(ROOT, "metadata", "out");
  let base = process.env.METADATA_BASE_URI || DEFAULT_BASE;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
    else if (argv[i] === "--out" && argv[i + 1]) out = path.resolve(argv[++i]);
    else if (argv[i] === "--base" && argv[i + 1]) base = argv[++i];
    else if (argv[i] === "--help") {
      console.log(`Usage: node scripts/generate-metadata.mjs [--limit N] [--out DIR] [--base URI]
Env: METADATA_BASE_URI (default ${DEFAULT_BASE})`);
      process.exit(0);
    }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > COLLECTION_SIZE) {
    throw new Error(`--limit must be 1..${COLLECTION_SIZE}`);
  }
  if (!base.endsWith("/")) base += "/";
  return { limit, out, base };
}

function buildJson(tokenId, rarity, base) {
  const label = RARITY_LABELS[rarity];
  const image = `${base}placeholders/EXAMPLE-${tokenId}.png`;
  return {
    name: `GreenCat #${tokenId}`,
    symbol: "GCAT",
    description: `EXAMPLE ONLY — not production art. ${label} GreenCat meme · seed ${CATALOG_SEED}. See docs/METADATA-PIPELINE.md.`,
    image,
    external_url: "https://www.greencat69420.com",
    attributes: [
      { trait_type: "Rarity", value: label },
      { trait_type: "Background", value: "EXAMPLE — pending trait port" },
      { trait_type: "Fur", value: "EXAMPLE — pending trait port" },
      { trait_type: "Eyes", value: "EXAMPLE — pending trait port" },
      { trait_type: "Hat", value: "EXAMPLE — pending trait port" },
      { trait_type: "Accessory", value: "EXAMPLE — pending trait port" },
      { trait_type: "Catchphrase", value: "EXAMPLE — pending trait port" },
      { trait_type: "Catalog Seed", value: CATALOG_SEED },
      { trait_type: "Token ID", value: String(tokenId) },
      {
        trait_type: "Status",
        value: "EXAMPLE PLACEHOLDER — metadata not uploaded yet",
      },
    ],
    properties: {
      category: "image",
      files: [{ uri: image, type: "image/png" }],
    },
    _greencat: {
      example: true,
      rarity,
      catalogSeed: CATALOG_SEED,
      note: "Stub output. Port getTokenTraits from holder-app before mainnet.",
    },
  };
}

const { limit, out, base } = parseArgs(process.argv);
const table = getRarityTable();
fs.mkdirSync(out, { recursive: true });

for (let tokenId = 1; tokenId <= limit; tokenId++) {
  const rarity = table[tokenId - 1];
  const json = buildJson(tokenId, rarity, base);
  const dest = path.join(out, `${tokenId}.json`);
  fs.writeFileSync(dest, JSON.stringify(json, null, 2) + "\n");
}

console.log(
  `Wrote ${limit} EXAMPLE metadata files → ${out} (base=${base})\n` +
    `Mint URI shape: ${base}{token_id}.json\n` +
    `TODO: real art + full traits; upload to CDN/IPFS/Arweave; then initialize_collection.`
);
