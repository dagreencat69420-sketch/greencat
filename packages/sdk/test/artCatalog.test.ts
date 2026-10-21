import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ART_LAYER_NAMES,
  getArtCatalog,
  getTokenArt,
  tokenAttributes,
  tokenDescription,
  tokenImageUri,
  tokenImageFile,
  ipfsToGatewayUrl,
  DEFAULT_IMAGE_BASE_URI,
} from "../src/artCatalog";
import { CATALOG_SEED, RARITY_COUNTS, getTokenRarity, hashSeed } from "../src/nftCatalog";

const FIX = path.join(__dirname, "fixtures");
type FixtureToken = { id: number; rarity: string; catchphrase: string } & Record<string, string | number>;
const fixture = JSON.parse(fs.readFileSync(path.join(FIX, "catalog-art-v1.json"), "utf8")) as {
  catalogSeed: string;
  artVersion: string;
  tokens: FixtureToken[];
};

describe("art-v1 catalog parity with rendered collection (art/out/catalog-art-v1.json)", () => {
  it("fixture header matches seed", () => {
    expect(fixture.catalogSeed).toBe(CATALOG_SEED);
    expect(fixture.artVersion).toBe("art-v1");
    expect(fixture.tokens).toHaveLength(10_000);
    expect(hashSeed(CATALOG_SEED)).toBe(3574348136);
  });

  it("all 10,000 tokens: rarity, every visual trait and catchphrase match", () => {
    const cat = getArtCatalog();
    let mismatches = 0;
    for (const f of fixture.tokens) {
      const a = cat[f.id - 1];
      if (a.tokenId !== f.id || a.rarity !== f.rarity || a.catchphrase !== f.catchphrase) mismatches++;
      else if (ART_LAYER_NAMES.some((l) => a.traits[l] !== f[l])) mismatches++;
      if (getTokenRarity(f.id) !== f.rarity) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it("exact tier counts and no duplicate visual combos", () => {
    const cat = getArtCatalog();
    const counts: Record<string, number> = {};
    const combos = new Set<string>();
    for (const a of cat) {
      counts[a.rarity] = (counts[a.rarity] ?? 0) + 1;
      combos.add(ART_LAYER_NAMES.map((l) => a.traits[l]).join("|"));
    }
    expect(counts).toEqual(RARITY_COUNTS);
    expect(combos.size).toBe(10_000);
  });

  it.each([1, 42, 100, 5000, 7320])("token %i attributes/description/name match metadata JSON", (id) => {
    const md = JSON.parse(fs.readFileSync(path.join(FIX, `metadata-${id}.json`), "utf8"));
    expect(md.name).toBe(`GreenCat #${id}`);
    expect(tokenAttributes(id)).toEqual(md.attributes);
    expect(tokenDescription(id)).toBe(md.description);
    expect(tokenImageUri(id)).toBe(md.image);
    expect(md.image).toBe(`${DEFAULT_IMAGE_BASE_URI}${id}.webp`);
    expect(md.properties.files).toEqual([tokenImageFile(id)]);
    expect(md.properties.files[0].type).toBe("image/webp");
  });

  it("range checks", () => {
    expect(() => getTokenArt(0)).toThrow();
    expect(() => getTokenArt(10_001)).toThrow();
    expect(tokenImageUri(7, "https://cdn.example/nft/images")).toBe("https://cdn.example/nft/images/7.webp");
    expect(tokenImageUri(7, "ipfs://bafyROOT/")).toBe("ipfs://bafyROOT/7.webp");
    expect(ipfsToGatewayUrl("ipfs://bafyROOT/7.webp")).toBe("https://ipfs.filebase.io/ipfs/bafyROOT/7.webp");
    expect(ipfsToGatewayUrl("ipfs://bafyROOT/7.webp", "https://gw.example/ipfs")).toBe("https://gw.example/ipfs/bafyROOT/7.webp");
    expect(ipfsToGatewayUrl("/nft/images/7.webp")).toBe("/nft/images/7.webp");
  });
});
