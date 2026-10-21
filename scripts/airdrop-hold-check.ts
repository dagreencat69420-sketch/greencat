#!/usr/bin/env -S npx tsx
/**
 * 30-day continuous-hold checker for the $GC launch airdrop (read-only: RPC reads only, sends nothing).
 *
 *   RPC_URL=https://mainnet.helius-rpc.com/?api-key=… npx tsx scripts/airdrop-hold-check.ts \
 *     --csv entries-clean.csv [--column "Solana wallet"] \
 *     --snapshot <S, e.g. 2026-11-30T10:00:00-08:00> \  (S = the announced snapshot time; window = S → S + 30 days)
 *     [--days 30 | --end <iso>] \                    (run before S + 30 d = "on track so far" preview)
 *     [--min-ui 100000] [--exclude k1,k2] [--exclude-file <file>, default scripts/airdrop-exclude.json | --no-exclude-file] [--top 1000]
 *     [--snapshots snapshots/] [--method gtfa|rpc] [--rps 8] [--out airdrops/hold]
 *   (or --wallets a,b,c instead of --csv; HELIUS_API_KEY works instead of RPC_URL; --start = alias of --snapshot)
 *
 * Timeline (Terms, docs/airdrop/TERMS.md; owner Oct 7, 2026): milestone M = 1,000 wallets each holding
 * ≥100,000 $GC → snapshot S = M + 7 days (exact time announced on official channels) → hold period S → S + 30 d
 * (must stay ≥100k the whole time; adding more is fine, any dip below disqualifies) → verification →
 * Merkle root → claim. So the checked window is [S, S + 30 d]. (The old --announce day-30/day-60 mode is gone.)
 *
 * For each wallet: total $GC across ALL its token accounts (open, closed, ATA or not, Token-2022 or
 * classic) must be ≥ --min-ui at S and after every transaction until S + 30 d.
 *  - method gtfa (default, Helius): getTransactionsForAddress(owner, tokenAccounts=balanceChanged,
 *    tokenTransfer.mint=$GC, blockTime ≥ start, succeeded, full) → pre/post token balances with
 *    in-block order. Finds closed and non-ATA accounts too (Helius indexes token-account owners).
 *  - method rpc (any RPC): ATA + open accounts → getSignaturesForAddress → getTransaction each.
 *    Can miss a non-ATA account that was closed before today (that only ever under-counts → fails safe).
 *  - history is read from S until NOW and checked for continuity (each pre = previous post,
 *    last post = today's balance). A gap → re-scan without the mint filter → still a gap = manual review.
 *  - --snapshots: daily holder snapshots (scripts/gc-holder-snapshot.mjs) inside the window are a second
 *    check: a wallet missing from any of them is marked not qualified.
 * Outputs (in --out): hold-check-<ts>.csv (wallet,snapshot,min,end,qualified,reason,…),
 *   hold-qualified.json (wallet → balance AT THE SNAPSHOT, raw; the ranking key for the top-1,000 rule;
 *   feed to `airdrop.ts snapshot --balances … --top 1000`), hold-qualified.txt.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { changesFromMeta, verdict, walkHold, walletsFromCsv, type HoldEvent } from "./lib/holdWalk";
import { equalSplit, selectTopN } from "./lib/allocation";
import { parseExcludeList } from "./lib/milestone.mjs";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const die = (m: string): never => { console.error(m); process.exit(1); };

const MINT = flag("mint") ?? process.env.GC_MINT ?? "G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump";
const RPC = process.env.RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");
if (!RPC) die("set RPC_URL (Helius mainnet URL) or HELIUS_API_KEY");
const METHOD = (flag("method") ?? "gtfa") as "gtfa" | "rpc";
const RPS = Number(flag("rps") ?? 8);
const CONC = Number(flag("concurrency") ?? 4);

// ---------- rate-limited JSON-RPC with credit accounting (never logs the URL: it contains the key) ----------
const credits: Record<string, { calls: number; credits: number }> = {};
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1000 / RPS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}
function meter(method: string, result: any) {
  let c = 1;
  if (method === "getProgramAccounts") c = 10;
  if (method === "getTransactionsForAddress") c = Array.isArray(result?.data) && result.data[0]?.meta !== undefined ? Math.max(10, Math.ceil(result.data.length / 100) * 10) : 10;
  const m = (credits[method] ??= { calls: 0, credits: 0 });
  m.calls++; m.credits += c;
}
async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    } catch (e) {
      if (attempt < 5) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
      throw new Error(`${method}: network error ${(e as Error).message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 6) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
    const j: any = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    if (j.error) {
      if (attempt < 3 && /rate|limit|timeout|busy/i.test(j.error.message ?? "")) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    }
    meter(method, j.result);
    return j.result as T;
  }
}

// ---------- chain reads ----------
let tokenProgram = "";
async function currentAccounts(owner: string): Promise<Map<string, bigint>> {
  const r = await rpc<any>("getTokenAccountsByOwner", [owner, { mint: MINT }, { encoding: "jsonParsed", commitment: "finalized" }]);
  const m = new Map<string, bigint>();
  for (const a of r.value) m.set(a.pubkey, BigInt(a.account.data.parsed.info.tokenAmount.amount));
  return m;
}
function txToEvent(tx: any, owner: string, known: Set<string>, txIndex: number | null): HoldEvent | null {
  if (!tx?.meta || tx.meta.err) return null;
  const msg = tx.transaction.message;
  const keys: string[] = [
    ...msg.accountKeys.map((k: any) => (typeof k === "string" ? k : k.pubkey)),
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const changes = changesFromMeta(keys, tx.meta.preTokenBalances, tx.meta.postTokenBalances, owner, MINT, known);
  if (!changes.size) return null;
  return { sig: tx.transaction.signatures[0], slot: tx.slot, txIndex: tx.transactionIndex ?? txIndex, blockTime: tx.blockTime ?? 0, changes };
}

async function eventsGtfa(owner: string, startTs: number, mintFilter: boolean, known: Set<string>): Promise<HoldEvent[]> {
  const out: HoldEvent[] = [];
  let token: string | undefined;
  do {
    const r = await rpc<any>("getTransactionsForAddress", [owner, {
      transactionDetails: "full", encoding: "json", maxSupportedTransactionVersion: 1, sortOrder: "asc", limit: 1000,
      commitment: "finalized",
      filters: { blockTime: { gte: startTs }, status: "succeeded", tokenAccounts: "balanceChanged", ...(mintFilter ? { tokenTransfer: { mint: MINT } } : {}) },
      ...(token ? { paginationToken: token } : {}),
    }]);
    for (const tx of r.data ?? []) { const e = txToEvent(tx, owner, known, null); if (e) out.push(e); }
    token = r.paginationToken ?? undefined;
  } while (token);
  return out;
}

async function eventsRpc(owner: string, startTs: number, current: Map<string, bigint>): Promise<HoldEvent[]> {
  const ata = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(owner), true, new PublicKey(tokenProgram), ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();
  const accounts = new Set([ata, ...current.keys()]);
  const order: { sig: string; slot: number }[] = [];
  const seen = new Set<string>();
  for (const acct of accounts) {
    let before: string | undefined;
    for (;;) {
      const sigs = await rpc<any[]>("getSignaturesForAddress", [acct, { limit: 1000, commitment: "finalized", ...(before ? { before } : {}) }]);
      let done = sigs.length < 1000;
      for (const s of sigs) {
        if (s.blockTime != null && s.blockTime < startTs) { done = true; break; }
        if (!s.err && !seen.has(s.signature)) { seen.add(s.signature); order.push({ sig: s.signature, slot: s.slot }); }
      }
      if (done || !sigs.length) break;
      before = sigs[sigs.length - 1].signature;
    }
  }
  order.reverse(); // getSignaturesForAddress is newest-first
  const out: HoldEvent[] = [];
  for (const o of order) {
    const tx = await rpc<any>("getTransaction", [o.sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
    const e = txToEvent(tx, owner, accounts, null);
    if (e) out.push(e);
  }
  return out;
}

// ---------- main ----------
const fmtUi = (raw: bigint) => { const s = (raw / 1_000_000n).toLocaleString("en-US"); const f = raw % 1_000_000n; return f ? `${s}.${f.toString().padStart(6, "0").replace(/0+$/, "")}` : s; };
const uiStr = (raw: bigint) => { const f = raw % 1_000_000n; return `${raw / 1_000_000n}${f ? "." + f.toString().padStart(6, "0").replace(/0+$/, "") : ""}`; };
const iso = (ts: number) => new Date(ts * 1000).toISOString();
const parseTime = (s: string) => (/^\d+$/.test(s) ? Number(s) : Math.floor(new Date(s).getTime() / 1000));
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

async function main() {
  if (flag("announce")) die("--announce (old day-30/day-60 timeline) was removed: pass --snapshot <S> (announced snapshot time); window = S → S + 30 days");
  const snapArg = flag("snapshot") ?? flag("start") ?? die("--snapshot <iso> required (the announced snapshot time S)");
  const startTs = parseTime(snapArg);
  const endTs = flag("end") ? parseTime(flag("end")!) : startTs + Math.round(Number(flag("days") ?? 30) * 86400);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) die("bad --snapshot/--end");
  const thresholdRaw = BigInt(Math.round(Number(flag("min-ui") ?? 100000))) * 1_000_000n;
  const topN = Number(flag("top") ?? 1000);
  const exclude = new Set((flag("exclude") ?? "").split(",").filter(Boolean));
  // BUGSWEEP-2026-10-07: scripts/airdrop-exclude.json applies by default (opt out with --no-exclude-file).
  const excludeFile = args.includes("--no-exclude-file") ? null : (flag("exclude-file") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "airdrop-exclude.json"));
  if (excludeFile) for (const w of parseExcludeList(JSON.parse(fs.readFileSync(excludeFile, "utf8"))).keys()) exclude.add(w);
  console.error(`exclude list: ${excludeFile ? `${exclude.size} wallet(s) (${path.basename(excludeFile)})` : "NONE (--no-exclude-file)"}`);
  const outDir = path.resolve(flag("out") ?? "airdrops/hold");
  fs.mkdirSync(outDir, { recursive: true });

  let raw: string[];
  if (flag("wallets")) raw = flag("wallets")!.split(",").map((s) => s.trim()).filter(Boolean);
  else {
    const { header, wallets } = walletsFromCsv(fs.readFileSync(flag("csv") ?? die("--csv or --wallets required"), "utf8"), flag("column"));
    console.error(`wallet column: "${header}" (${wallets.length} rows)`);
    raw = wallets;
  }

  const mintInfo = await rpc<any>("getAccountInfo", [MINT, { encoding: "base64" }]);
  tokenProgram = mintInfo?.value?.owner ?? die("mint not found on this RPC (mainnet?)");
  const nowTs = Math.floor(Date.now() / 1000);
  console.error(`mint ${MINT} (${tokenProgram.startsWith("Tokenz") ? "Token-2022" : "SPL Token"}), window ${iso(startTs)} → ${iso(endTs)}, min ${fmtUi(thresholdRaw)}, method ${METHOD}, ${RPS} rps`);

  // daily snapshots inside the window (optional second check)
  const snaps: { date: string; holders: Record<string, string> }[] = [];
  if (flag("snapshots")) {
    for (const f of fs.readdirSync(flag("snapshots")!).filter((f) => f.endsWith(".json"))) {
      const s = JSON.parse(fs.readFileSync(path.join(flag("snapshots")!, f), "utf8"));
      if (s.mint === MINT && s.blockTime >= startTs && s.blockTime <= endTs && BigInt(s.thresholdRaw) <= thresholdRaw) snaps.push({ date: s.date ?? f, holders: s.holders });
    }
    console.error(`daily snapshots in window: ${snaps.length}`);
  }

  type Row = { wallet: string; start: string; min: string; end: string; minRaw: bigint; startRaw: bigint; qualified: boolean; reason: string; events: number; minAt: string };
  const rows: Row[] = [];
  const seenW = new Set<string>();
  const todo: string[] = [];
  for (const w of raw) {
    const bad = (reason: string) => rows.push({ wallet: w, start: "", min: "", end: "", minRaw: 0n, startRaw: 0n, qualified: false, reason, events: 0, minAt: "" });
    let pk: PublicKey;
    try { pk = new PublicKey(w); } catch { bad("invalid Solana address"); continue; }
    if (pk.toBase58() !== w) { bad("invalid Solana address"); continue; }
    if (seenW.has(w)) { bad("duplicate entry (wallet already listed)"); continue; }
    seenW.add(w);
    if (exclude.has(w)) { bad("excluded (team/exchange/market-maker)"); continue; }
    if (!PublicKey.isOnCurve(pk.toBytes())) { bad("program/PDA address, not a self-custody wallet"); continue; }
    todo.push(w);
  }

  const t0 = Date.now();
  let done = 0;
  const worker = async () => {
    for (let w = todo.shift(); w; w = todo.shift()) {
      try {
        const cur = await currentAccounts(w);
        const known = new Set(cur.keys());
        let ev = METHOD === "gtfa" ? await eventsGtfa(w, startTs, true, known) : await eventsRpc(w, startTs, cur);
        let r = walkHold(ev, cur, startTs, endTs);
        if (r.gaps.length && METHOD === "gtfa") { // re-scan without the mint filter (catches burns / odd instructions)
          ev = await eventsGtfa(w, startTs, false, known);
          r = walkHold(ev, cur, startTs, endTs);
        }
        let v = verdict(r, thresholdRaw, endTs, nowTs, fmtUi, iso);
        if (v.qualified && snaps.length) {
          const miss = snaps.find((s) => BigInt(s.holders[w] ?? "0") < thresholdRaw);
          if (miss) v = { qualified: false, reason: `daily snapshot ${miss.date} shows below ${fmtUi(thresholdRaw)}; manual review` };
        }
        rows.push({ wallet: w, start: uiStr(r.startRaw), min: uiStr(r.minRaw), end: uiStr(r.endRaw), minRaw: r.minRaw, startRaw: r.startRaw, qualified: v.qualified, reason: v.reason, events: r.eventsInWindow, minAt: r.minAt ? iso(r.minAt.blockTime) : "" });
      } catch (e) {
        rows.push({ wallet: w, start: "", min: "", end: "", minRaw: 0n, startRaw: 0n, qualified: false, reason: `error: ${(e as Error).message.slice(0, 160)}; re-run`, events: 0, minAt: "" });
      }
      if (++done % 50 === 0) console.error(`  ${done} wallets checked (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));

  const order = new Map(raw.map((w, i) => [w, i]));
  rows.sort((a, b) => (order.get(a.wallet) ?? 0) - (order.get(b.wallet) ?? 0));
  const ts = Date.now();
  const csv = ["wallet,snapshot_balance,min_balance,end_balance,qualified,reason,balance_changes_in_window,min_at_utc",
    ...rows.map((r) => [r.wallet, r.start, r.min, r.end, r.qualified ? "y" : "n", r.reason, String(r.events), r.minAt].map(csvCell).join(","))].join("\n") + "\n";
  const csvPath = path.join(outDir, `hold-check-${ts}.csv`);
  fs.writeFileSync(csvPath, csv);
  const q = rows.filter((r) => r.qualified);
  // ranking key = balance at the snapshot (Terms: "top 1,000 holders by GreenCat balance at the snapshot")
  fs.writeFileSync(path.join(outDir, "hold-qualified.json"), JSON.stringify(Object.fromEntries(q.map((r) => [r.wallet, r.startRaw.toString()])), null, 2));
  fs.writeFileSync(path.join(outDir, "hold-qualified.txt"), q.map((r) => r.wallet).join("\n") + (q.length ? "\n" : ""));

  const totalCredits = Object.values(credits).reduce((s, c) => s + c.credits, 0);
  const secs = (Date.now() - t0) / 1000;
  console.log(`checked ${rows.length} entries in ${secs.toFixed(1)}s → qualified ${q.length}, not qualified ${rows.length - q.length}`);
  if (q.length) {
    // preview only: social-task verification must already be reflected in the input list
    const sel = selectTopN(q.map((r) => ({ wallet: r.wallet, balanceRaw: r.startRaw })), topN, "include");
    const sp = equalSplit(100_000_000n * 1_000_000n, sel.selected.length);
    console.log(`top-${topN} preview: ${sel.note}; equal share ${fmtUi(sp.shareRaw)} $GC each (100M / ${sel.selected.length}), dust ${sp.dustRaw} raw`);
  }
  console.log(`RPC: ${Object.entries(credits).map(([m, c]) => `${m} ${c.calls} calls/${c.credits} cr`).join(", ")} → ~${totalCredits} credits`);
  console.log(`csv: ${csvPath}\nqualified balances (for airdrop.ts --balances): ${path.join(outDir, "hold-qualified.json")}`);
}
main().catch((e) => die(String(e?.stack ?? e)));
