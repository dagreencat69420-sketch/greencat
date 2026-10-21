"use client";

import { useEffect, useState } from "react";
import { ART_LAYER_NAMES, COLLECTION_SIZE, getArtCatalog, getTokenArt, type Rarity } from "@greencat/sdk";

/** Published metadata folder (v2, pinned on 4EVERLAND). Used when the on-chain base URI is missing. */
export const PUBLISHED_METADATA_BASE = "ipfs://bafybeihq3n4h2756mmonwi5ckia3vztc47zuzcglx5dqxmt6dfk2zmzap4/";

export type NftAttribute = { trait_type: string; value: string };
export type NftMetadata = { name?: string; description?: string; image?: string; attributes?: NftAttribute[] };

/** ipfs://CID/path → https://CID.ipfs.4everland.io/path (4EVERLAND subdomain gateway, CORS *). */
export function ipfsTo4everland(uri: string): string {
  const m = /^ipfs:\/\/([^/]+)\/?(.*)$/.exec(uri.trim());
  return m ? `https://${m[1]}.ipfs.4everland.io/${m[2]}` : uri;
}

export function metadataUrl(tokenId: number, base?: string | null): string {
  let b = (base ?? "").trim() || PUBLISHED_METADATA_BASE;
  if (!b.endsWith("/")) b += "/";
  return ipfsTo4everland(`${b}${tokenId}.json`);
}

const mem = new Map<string, NftMetadata>();
const inflight = new Map<string, Promise<NftMetadata>>();
const SS_KEY = "gc:nftmeta:";

/** Fetch + cache (memory, then sessionStorage). Rejects on network/HTTP/JSON errors or after `timeoutMs`. */
export function fetchNftMetadata(url: string, timeoutMs = 8000, fetchImpl: typeof fetch = fetch): Promise<NftMetadata> {
  const hit = mem.get(url);
  if (hit) return Promise.resolve(hit);
  try {
    const s = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(SS_KEY + url) : null;
    if (s) {
      const v = JSON.parse(s) as NftMetadata;
      mem.set(url, v);
      return Promise.resolve(v);
    }
  } catch {
    /* storage unavailable */
  }
  const running = inflight.get(url);
  if (running) return running;
  const p = (async () => {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = setTimeout(() => ctl?.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { signal: ctl?.signal });
      if (!r.ok) throw new Error(`metadata HTTP ${r.status}`);
      const j = (await r.json()) as NftMetadata;
      if (!j || typeof j !== "object" || (j.attributes && !Array.isArray(j.attributes))) throw new Error("bad metadata JSON");
      mem.set(url, j);
      try {
        sessionStorage.setItem(SS_KEY + url, JSON.stringify(j));
      } catch {
        /* quota / unavailable */
      }
      return j;
    } finally {
      clearTimeout(t);
      inflight.delete(url);
    }
  })();
  inflight.set(url, p);
  return p;
}

export type TraitStat = { trait: string; value: string; count: number; pct: number };
export type TokenStats = {
  tokenId: number;
  rarity: Rarity;
  tierCount: number;
  tierPct: number;
  /** 1 = rarest by statistical rarity (product of trait frequencies) */
  rank: number;
  traits: TraitStat[];
  catchphrase: string;
};

let freq: Record<string, Record<string, number>> | null = null;
let tierCounts: Record<string, number> | null = null;
let ranks: number[] | null = null;

function buildIndex() {
  if (freq && tierCounts && ranks) return;
  const cat = getArtCatalog();
  const f: Record<string, Record<string, number>> = {};
  const tc: Record<string, number> = {};
  for (const l of ART_LAYER_NAMES) f[l] = {};
  for (const a of cat) {
    tc[a.rarity] = (tc[a.rarity] ?? 0) + 1;
    for (const l of ART_LAYER_NAMES) f[l][a.traits[l]] = (f[l][a.traits[l]] ?? 0) + 1;
  }
  const score = cat.map((a) => ART_LAYER_NAMES.reduce((s, l) => s + Math.log(f[l][a.traits[l]] / cat.length), 0));
  const order = score.map((s, i) => [s, i] as const).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const r = new Array<number>(cat.length);
  order.forEach(([, i], pos) => (r[i] = pos + 1));
  freq = f;
  tierCounts = tc;
  ranks = r;
}

/** Trait frequencies + rank from the deterministic 10,000-token catalog (built once, cached). */
export function tokenStats(tokenId: number, attributes?: NftAttribute[]): TokenStats | null {
  let art;
  try {
    art = getTokenArt(tokenId);
  } catch {
    return null;
  }
  buildIndex();
  const total = COLLECTION_SIZE;
  const fromMeta = new Map((attributes ?? []).map((a) => [a.trait_type, String(a.value)]));
  const traits = ART_LAYER_NAMES.map((l) => {
    const value = fromMeta.get(l) ?? art.traits[l];
    const count = freq![l][value] ?? 0;
    return { trait: l, value, count, pct: (count / total) * 100 };
  });
  const tierCount = tierCounts![art.rarity] ?? 0;
  return {
    tokenId,
    rarity: art.rarity,
    tierCount,
    tierPct: (tierCount / total) * 100,
    rank: ranks![tokenId - 1],
    traits,
    catchphrase: fromMeta.get("Catchphrase") ?? art.catchphrase,
  };
}

export function formatPct(p: number): string {
  return p >= 10 ? `${p.toFixed(0)}%` : p >= 1 ? `${p.toFixed(1)}%` : `${p.toFixed(2)}%`;
}

export type MetaState = { status: "idle" | "loading" | "ok" | "error"; meta?: NftMetadata };

/** Load metadata for a token when `enabled`; falls back to the bundled catalog on error. */
export function useNftMetadata(tokenId: number, base: string | null | undefined, enabled: boolean): MetaState {
  const [st, setSt] = useState<MetaState>({ status: "idle" });
  useEffect(() => {
    if (!enabled || !tokenId) return;
    let alive = true;
    const url = metadataUrl(tokenId, base);
    const cached = mem.get(url);
    if (cached) {
      setSt({ status: "ok", meta: cached });
      return;
    }
    setSt({ status: "loading" });
    fetchNftMetadata(url)
      .then((m) => alive && setSt({ status: "ok", meta: m }))
      .catch(() => alive && setSt({ status: "error" }));
    return () => {
      alive = false;
    };
  }, [tokenId, base, enabled]);
  return st;
}

/** Test hook: clear caches. */
export function __resetNftMetadataCache() {
  mem.clear();
  inflight.clear();
}
