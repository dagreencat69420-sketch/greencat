/**
 * Pure helpers (no npm deps, no network) for the $GC holder-milestone counter
 * (scripts/gc-holder-snapshot.mjs) and the airdrop exclude list. Plain .mjs so the GitHub Action can run it
 * with a sparse checkout and no `npm install`; types in milestone.d.mts; tests in milestone.test.ts.
 *
 * Airdrop milestone (owner decision, Oct 7, 2026 PT): the 7-day countdown to the snapshot starts when
 * 1,000 unique wallets EACH HOLD AT LEAST 100,000 $GC ("gte" below). The counter also reports the total
 * number of holders (balance > 0) for information only. Both counts are taken after removing non-person
 * accounts: off-curve owners (PDAs: bonding curve, AMM/LP pools, vaults, program treasuries) and the
 * wallets in the exclude file (burn, LP/pool, exchange, team, program).
 */

// ---------- ed25519 "is on curve" (same rule as @solana/web3.js PublicKey.isOnCurve, noble zip215) ----------
const P = 2n ** 255n - 19n;
const mod = (a) => { const r = a % P; return r >= 0n ? r : r + P; };
function pow(b, e) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
const D = mod(-121665n * pow(121666n, P - 2n));

/** true if the 32 bytes decode to a point on ed25519 (a normal keypair address); false = PDA / off-curve. */
export function isOnCurve(bytes) {
  if (!bytes || bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  const x = mod(u * v3 * pow(u * v7, (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  return vx2 === u || vx2 === mod(-u);
}

// ---------- base58 ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = "1" + s; }
  return s;
}
export function b58decode(str) {
  let n = 0n;
  for (const ch of str) { const i = B58.indexOf(ch); if (i < 0) throw new Error(`invalid base58: ${str}`); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of str) { if (ch !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
/** true for a valid 32-byte address that is on the curve (a wallet someone holds a key for). */
export function isWalletAddress(addr) {
  try { const b = b58decode(addr); return b.length === 32 && isOnCurve(b); } catch { return false; }
}

// ---------- exclude list ----------
/**
 * Exclude file (scripts/airdrop-exclude.json): { "<category>": ["address" | { "address": …, "note": … }, …] };
 * keys starting with "_" are comments. Returns Map address → category. Throws on a malformed address
 * (a typo must not silently let a wallet through).
 */
export function parseExcludeList(json) {
  const out = new Map();
  for (const [cat, list] of Object.entries(json ?? {})) {
    if (cat.startsWith("_")) continue;
    if (!Array.isArray(list)) throw new Error(`exclude list: "${cat}" must be an array`);
    for (const entry of list) {
      const addr = typeof entry === "string" ? entry : entry?.address;
      if (typeof addr !== "string") throw new Error(`exclude list: bad entry in "${cat}"`);
      let len = -1;
      try { len = b58decode(addr).length; } catch { /* invalid */ }
      if (len !== 32) throw new Error(`exclude list: "${addr}" in "${cat}" is not a valid address`);
      if (!out.has(addr)) out.set(addr, cat);
    }
  }
  return out;
}

// ---------- token-account rows → per-owner totals → counts ----------
/** rows: [{ owner, amount: bigint }] (one per token account) → Map owner → total raw. */
export function sumByOwner(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.owner, (m.get(r.owner) ?? 0n) + r.amount);
  return m;
}

/**
 * Count holders. `onCurve(owner)` decides PDAs (injectable for tests). Returns raw counts (every owner with
 * balance > 0), counted numbers (after exclusions) and what was excluded, per reason.
 */
export function countHolders(totals, minRaw, exclude = new Map(), onCurve = isWalletAddress) {
  const res = {
    raw: { total: 0, gte: 0 },
    counted: { total: 0, gte: 0 },
    excluded: { offCurve: { total: 0, gte: 0, balanceRaw: 0n }, list: {} },
    excludedOwners: [],
  };
  for (const [owner, bal] of totals) {
    if (bal <= 0n) continue;
    const big = bal >= minRaw;
    res.raw.total++; if (big) res.raw.gte++;
    const cat = exclude.get(owner);
    if (cat || !onCurve(owner)) {
      const reason = cat ?? "off-curve (program/PDA: pool, bonding curve, vault)";
      const e = cat ? (res.excluded.list[cat] ??= { total: 0, gte: 0, balanceRaw: 0n }) : res.excluded.offCurve;
      e.total++; if (big) e.gte++; e.balanceRaw += bal;
      res.excludedOwners.push({ owner, reason, balanceRaw: bal });
      continue;
    }
    res.counted.total++; if (big) res.counted.gte++;
  }
  res.excludedOwners.sort((a, b) => (b.balanceRaw > a.balanceRaw ? 1 : b.balanceRaw < a.balanceRaw ? -1 : 0));
  return res;
}

// ---------- milestone state ----------
export const WEEK_SECS = 7 * 86400;
/**
 * Record one observation and the FIRST time each count reached `milestone` (Terms: "first reaches").
 * Once set, firstReached never changes, even if the count drops later. Resolution = how often the counter
 * runs, so the time is "first observed at or above", not the exact block it happened.
 * The OFFICIAL milestone is `gte` (wallets ≥ 100,000 $GC); `total` is informational.
 * obs: { blockTime, slot, total, gte } (counted numbers). Returns a new state object.
 */
export function updateMilestone(state, obs, milestone = 1000) {
  const s = structuredClone(state ?? {});
  s.milestone ??= milestone;
  if (s.milestone !== milestone) throw new Error(`state file is for milestone ${s.milestone}, not ${milestone}`);
  s.runs ??= [];
  s.firstReached ??= { gte: null, total: null };
  const last = s.runs[s.runs.length - 1];
  if (last && obs.blockTime < last.blockTime) throw new Error("observation older than the last recorded run");
  s.runs.push({ at: new Date(obs.blockTime * 1000).toISOString(), blockTime: obs.blockTime, slot: obs.slot, total: obs.total, gte: obs.gte });
  for (const k of ["gte", "total"]) {
    if (!s.firstReached[k] && obs[k] >= milestone) {
      const snap = obs.blockTime + WEEK_SECS;
      s.firstReached[k] = {
        observedAt: new Date(obs.blockTime * 1000).toISOString(), blockTime: obs.blockTime, slot: obs.slot, count: obs[k],
        snapshotAt: new Date(snap * 1000).toISOString(), snapshotBlockTime: snap,
      };
    }
  }
  return s;
}
