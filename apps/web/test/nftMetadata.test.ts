import { describe, expect, it, vi, beforeEach } from "vitest";
import { getTokenArt } from "@greencat/sdk";
import { __resetNftMetadataCache, fetchNftMetadata, formatPct, ipfsTo4everland, metadataUrl, tokenStats, PUBLISHED_METADATA_BASE } from "../src/lib/nftMetadata";

describe("NFT metadata URLs", () => {
  it("rewrites ipfs:// to the 4EVERLAND subdomain gateway", () => {
    expect(ipfsTo4everland("ipfs://bafyX/42.json")).toBe("https://bafyX.ipfs.4everland.io/42.json");
    expect(ipfsTo4everland("https://x.test/1.json")).toBe("https://x.test/1.json");
  });
  it("builds per-token URLs from the on-chain base, or the published base when missing", () => {
    expect(metadataUrl(7, "https://a.test/meta")).toBe("https://a.test/meta/7.json");
    expect(metadataUrl(7, "")).toBe(ipfsTo4everland(`${PUBLISHED_METADATA_BASE}7.json`));
  });
});

describe("fetchNftMetadata cache + errors", () => {
  beforeEach(() => __resetNftMetadataCache());
  it("fetches once and serves later calls from cache", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ name: "GreenCat #1", attributes: [] }), { status: 200 }));
    const a = await fetchNftMetadata("https://m.test/1.json", 1000, f as unknown as typeof fetch);
    const b = await fetchNftMetadata("https://m.test/1.json", 1000, f as unknown as typeof fetch);
    expect(a.name).toBe("GreenCat #1");
    expect(b).toBe(a);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("rejects on HTTP errors and bad JSON (caller falls back to the catalog)", async () => {
    const e404 = vi.fn(async () => new Response("no", { status: 404 }));
    await expect(fetchNftMetadata("https://m.test/2.json", 1000, e404 as unknown as typeof fetch)).rejects.toThrow(/404/);
    const bad = vi.fn(async () => new Response("{not json", { status: 200 }));
    await expect(fetchNftMetadata("https://m.test/3.json", 1000, bad as unknown as typeof fetch)).rejects.toThrow();
  });
});

describe("tokenStats", () => {
  it("returns tier, rank and per-trait shares that match the catalog", () => {
    const s = tokenStats(42)!;
    const art = getTokenArt(42);
    expect(s.rarity).toBe(art.rarity);
    expect(s.rank).toBeGreaterThanOrEqual(1);
    expect(s.rank).toBeLessThanOrEqual(10_000);
    expect(s.traits.map((t) => t.value)).toEqual(Object.values(art.traits));
    for (const t of s.traits) expect(t.pct).toBeGreaterThan(0);
    expect(s.tierPct).toBe(art.rarity === "rare" ? 9 : s.tierPct);
  });
  it("ranks are a permutation of 1..10000", () => {
    const seen = new Set<number>();
    for (let i = 1; i <= 10_000; i++) seen.add(tokenStats(i)!.rank);
    expect(seen.size).toBe(10_000);
  });
  it("formats percentages", () => {
    expect(formatPct(70)).toBe("70%");
    expect(formatPct(9)).toBe("9.0%");
    expect(formatPct(0.42)).toBe("0.42%");
  });
});

import { placeTooltip } from "../src/lib/tooltipPlacement";
describe("placeTooltip", () => {
  const a = (left: number, top: number) => ({ left, top, bottom: top + 100, width: 100 });
  it("clamps horizontally inside the viewport", () => {
    expect(placeTooltip(a(0, 10), 320, 200, 1000, 800).left).toBe(8);
    expect(placeTooltip(a(950, 10), 320, 200, 1000, 800).left).toBe(1000 - 320 - 8);
  });
  it("flips above when there is no room below", () => {
    expect(placeTooltip(a(300, 650), 320, 200, 1000, 800).top).toBe(650 - 8 - 200);
    expect(placeTooltip(a(300, 10), 320, 200, 1000, 800).top).toBe(118);
  });
});
