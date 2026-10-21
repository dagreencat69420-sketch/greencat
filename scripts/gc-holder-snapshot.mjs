#!/usr/bin/env node
/**
 * $GC holder snapshot + airdrop milestone counter. Read-only, no npm deps (runs in the GitHub Action
 * with a sparse checkout of this file, scripts/lib/milestone.mjs and scripts/airdrop-exclude.json).
 *
 *   RPC_URL=https://mainnet.helius-rpc.com/?api-key=… node scripts/gc-holder-snapshot.mjs \
 *     [--min-ui 100000] [--out snapshots] [--exclude-file scripts/airdrop-exclude.json] \
 *     [--milestone 1000] [--state <out>/milestone-state.json | --state none] [--json]
 *   (HELIUS_API_KEY works instead of RPC_URL)
 *
 * RPC cost: getAccountInfo + ONE getProgramAccounts (10 Helius credits; dataSlice = owner + amount only)
 * + getBlockTime ≈ 12 credits per run.
 *
 * Writes <out>/gc-holders-<UTC date>.json: every owner ≥ --min-ui (unfiltered backup record, used by
 * scripts/airdrop-hold-check.ts --snapshots as a second check) + counts + slot/block time + sha256.
 *
 * Milestone (Terms + owner decision Oct 7, 2026 PT): the snapshot is 7 days after 1,000 unique wallets
 * each hold ≥ 100,000 $GC. Printed counts (after excluding off-curve program/PDA owners such as the
 * pump.fun bonding curve and LP pools, and the exclude file: burn/LP/exchange/team):
 *   - holders ≥ 100,000 $GC  ← the milestone count
 *   - holders > 0            (information only)
 * The state file keeps every run and the FIRST run at which each count was ≥ --milestone, with S = M + 7 d.
 * Resolution = how often this runs (first OBSERVED crossing). Exit code 0 always (unless the RPC fails).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { b58encode, countHolders, parseExcludeList, sumByOwner, updateMilestone } from "./lib/milestone.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const MINT = flag("mint") ?? process.env.GC_MINT ?? "G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump";
const RPC = process.env.RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");
if (!RPC) { console.error("set RPC_URL or HELIUS_API_KEY"); process.exit(1); }
const minRaw = BigInt(Math.round(Number(flag("min-ui") ?? 100000))) * 1_000_000n;
const milestone = Number(flag("milestone") ?? 1000);
const outDir = path.resolve(flag("out") ?? "snapshots");
const here = path.dirname(fileURLToPath(import.meta.url));
const excludeFile = flag("exclude-file") ?? path.join(here, "airdrop-exclude.json");
const statePath = flag("state") === "none" ? null : path.resolve(flag("state") ?? path.join(outDir, "milestone-state.json"));
const fmt = (raw) => (raw / 1_000_000n).toLocaleString("en-US");

async function rpc(method, params) {
  for (let i = 0; ; i++) {
    let j;
    try {
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      j = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    } catch (e) { j = { error: { message: `network: ${e.message}` } }; } // never print the URL (has the key)
    if (!j.error) return j.result;
    if (i >= 4) throw new Error(`${method}: ${j.error.message}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
}

const exclude = fs.existsSync(excludeFile) ? parseExcludeList(JSON.parse(fs.readFileSync(excludeFile, "utf8"))) : new Map();
if (!fs.existsSync(excludeFile) && flag("exclude-file")) throw new Error(`exclude file not found: ${excludeFile}`);

const mint = await rpc("getAccountInfo", [MINT, { encoding: "base64", commitment: "finalized" }]);
const program = mint?.value?.owner;
if (!program) throw new Error("mint not found (mainnet RPC?)");
const res = await rpc("getProgramAccounts", [program, {
  encoding: "base64", commitment: "finalized", withContext: true,
  dataSlice: { offset: 32, length: 40 },
  filters: [...(program.startsWith("Tokenkeg") ? [{ dataSize: 165 }] : []), { memcmp: { offset: 0, bytes: MINT } }],
}]);
const slot = res.context.slot;
const blockTime = (await rpc("getBlockTime", [slot]).catch(() => null)) ?? Math.floor(Date.now() / 1000);
const totals = sumByOwner(res.value.map((a) => {
  const d = Buffer.from(a.account.data[0], "base64");
  return { owner: b58encode(d.subarray(0, 32)), amount: d.readBigUInt64LE(32) };
}));
const c = countHolders(totals, minRaw, exclude);

const holders = Object.fromEntries([...totals].filter(([, v]) => v >= minRaw).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).map(([k, v]) => [k, v.toString()]));
const date = new Date(blockTime * 1000).toISOString().slice(0, 10);
const counts = {
  milestoneRule: `snapshot 7 days after ${milestone} unique wallets each hold >= ${minRaw / 1_000_000n} GC`,
  holdersGteMin: c.counted.gte, holdersAny: c.counted.total,
  raw: c.raw,
  excluded: {
    offCurve: { ...c.excluded.offCurve, balanceRaw: c.excluded.offCurve.balanceRaw.toString() },
    list: Object.fromEntries(Object.entries(c.excluded.list).map(([k, v]) => [k, { ...v, balanceRaw: v.balanceRaw.toString() }])),
  },
  excludedOwners: c.excludedOwners.map((e) => ({ ...e, balanceRaw: e.balanceRaw.toString() })),
};
const body = { mint: MINT, tokenProgram: program, slot, blockTime, takenAt: new Date(blockTime * 1000).toISOString(), date, thresholdRaw: minRaw.toString(), tokenAccounts: res.value.length, owners: totals.size, holdersAtOrAbove: Object.keys(holders).length, counts, holders };
const json = JSON.stringify(body, null, 2);
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `gc-holders-${date}.json`);
fs.writeFileSync(file, json);

let state = null;
if (statePath) {
  const prev = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
  state = updateMilestone(prev, { blockTime, slot, total: c.counted.total, gte: c.counted.gte }, milestone);
  state.mint = MINT; state.minRaw = minRaw.toString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

const pt = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Vancouver", dateStyle: "medium", timeStyle: "short" }) + " PT";
const lines = [
  `$GC holders at slot ${slot} (${pt(body.takenAt)}):`,
  `  MILESTONE COUNT  wallets ≥ ${fmt(minRaw)} $GC: ${c.counted.gte} / ${milestone}   (raw ${c.raw.gte} before exclusions)`,
  `  info             holders > 0:          ${c.counted.total}   (raw ${c.raw.total}; ${res.value.length} token accounts)`,
  `  excluded: off-curve/program ${c.excluded.offCurve.total} (${c.excluded.offCurve.gte} ≥ min, ${fmt(c.excluded.offCurve.balanceRaw)} $GC)` +
    Object.entries(c.excluded.list).map(([k, v]) => `; ${k} ${v.total} (${v.gte} ≥ min, ${fmt(v.balanceRaw)} $GC)`).join(""),
];
if (state) {
  const g = state.firstReached.gte, t = state.firstReached.total;
  lines.push(g
    ? `  >>> MILESTONE REACHED: ${milestone} wallets ≥ ${fmt(minRaw)} first observed ${pt(g.observedAt)} → snapshot S = M + 7 d = ${pt(g.snapshotAt)} (announce the exact time)`
    : `  milestone not reached yet (${milestone - c.counted.gte} more wallets ≥ ${fmt(minRaw)} needed)`);
  lines.push(t ? `  (info) holders > 0 first observed ≥ ${milestone} at ${pt(t.observedAt)}` : `  (info) holders > 0 not yet ≥ ${milestone}`);
}
lines.push(`  file ${file} sha256 ${crypto.createHash("sha256").update(json).digest("hex")}${statePath ? `\n  state ${statePath}` : ""}`);
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + lines.join("\n") + "\n```\n");
if (process.env.GITHUB_ACTIONS && c.counted.gte >= milestone) console.log(`::warning title=$GC airdrop milestone::${c.counted.gte} wallets hold ≥ ${fmt(minRaw)} $GC (milestone ${milestone}). Check earlier runs for the first crossing; snapshot = first crossing + 7 days.`);
if (args.includes("--json")) console.log(JSON.stringify({ slot, blockTime, ...counts, excludedOwners: undefined }));
