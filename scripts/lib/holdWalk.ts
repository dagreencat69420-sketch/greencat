/**
 * Pure logic for the 30-day continuous-hold check (no network). Used by scripts/airdrop-hold-check.ts
 * and unit-tested in scripts/lib/holdWalk.test.ts.
 *
 * Model: every successful transaction that changed one of the owner's $GC token accounts is an
 * "event" carrying that account's pre/post raw balance (from meta.pre/postTokenBalances, which are
 * absolute balances, so no amount parsing is needed). A missing pre = account created in that tx (0);
 * a missing post = account closed in that tx (0). The owner's total = sum over all its $GC accounts.
 */

export type AccountChange = { pre: bigint; post: bigint };
export type HoldEvent = {
  sig: string;
  slot: number;
  /** position inside the block (Helius getTransactionsForAddress); null when unknown (plain RPC). */
  txIndex: number | null;
  blockTime: number;
  /** token account → change */
  changes: Map<string, AccountChange>;
};

export type TokenBalanceLike = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
};

/** Extract the owner's $GC account changes from one transaction's meta. */
export function changesFromMeta(
  accountKeys: string[],
  pre: TokenBalanceLike[] | null | undefined,
  post: TokenBalanceLike[] | null | undefined,
  owner: string,
  mint: string,
  knownAccounts: Set<string> = new Set()
): Map<string, AccountChange> {
  const out = new Map<string, AccountChange>();
  const take = (list: TokenBalanceLike[] | null | undefined, key: "pre" | "post") => {
    for (const b of list ?? []) {
      if (b.mint !== mint) continue;
      const acct = accountKeys[b.accountIndex];
      if (!acct) continue;
      if (b.owner !== owner && !knownAccounts.has(acct)) continue;
      const c = out.get(acct) ?? { pre: 0n, post: 0n };
      c[key] = BigInt(b.uiTokenAmount.amount);
      out.set(acct, c);
    }
  };
  take(pre, "pre");
  take(post, "post");
  for (const [k, c] of out) if (c.pre === c.post) out.delete(k); // no balance change → not an event
  return out;
}

export function sortEvents(events: HoldEvent[]): HoldEvent[] {
  // stable sort: slot, then in-block index when known; otherwise keep input order
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.slot - b.e.slot || (a.e.txIndex ?? a.i) - (b.e.txIndex ?? b.i) || a.i - b.i)
    .map((x) => x.e);
}

export type HoldResult = {
  startRaw: bigint;
  minRaw: bigint;
  minAt: { blockTime: number; sig: string } | null;
  endRaw: bigint;
  eventsInWindow: number;
  /** continuity problems: a missed transaction somewhere (pre ≠ previous post, or last post ≠ current). */
  gaps: string[];
  /** same-slot events with unknown in-block order touching different accounts */
  ambiguousOrder: boolean;
};

/**
 * Walk events (all successful txs from window start until "now") and compute the owner's total at
 * window start, the running minimum inside [start, end] and the total at end.
 * `current` = token accounts open right now → raw balance (anchor for the continuity check).
 */
export function walkHold(eventsIn: HoldEvent[], current: Map<string, bigint>, startTs: number, endTs: number): HoldResult {
  const events = sortEvents(eventsIn.filter((e) => e.blockTime >= startTs));
  const gaps: string[] = [];
  const bal = new Map<string, bigint>();
  // balance at window start: pre of the first event for that account, else today's balance
  const seen = new Set<string>();
  for (const e of events)
    for (const [acct, c] of e.changes)
      if (!seen.has(acct)) {
        seen.add(acct);
        bal.set(acct, c.pre);
      }
  for (const [acct, amt] of current) if (!seen.has(acct)) bal.set(acct, amt);

  // continuity: each pre must equal the previous post for that account; last post must equal today's balance
  const last = new Map<string, { post: bigint; sig: string }>();
  for (const e of events)
    for (const [acct, c] of e.changes) {
      const p = last.get(acct);
      if (p && p.post !== c.pre) gaps.push(`${acct}: ${p.sig} post ${p.post} ≠ ${e.sig} pre ${c.pre}`);
      last.set(acct, { post: c.post, sig: e.sig });
    }
  for (const [acct, p] of last) {
    const now = current.get(acct) ?? 0n;
    if (p.post !== now) gaps.push(`${acct}: last post ${p.post} ≠ current ${now}`);
  }

  let ambiguousOrder = false;
  for (let i = 1; i < events.length; i++) {
    const a = events[i - 1], b = events[i];
    if (a.slot === b.slot && (a.txIndex == null || b.txIndex == null)) {
      const ak = [...a.changes.keys()], bk = new Set(b.changes.keys());
      if (ak.some((k) => !bk.has(k)) || [...bk].some((k) => !a.changes.has(k))) ambiguousOrder = true;
    }
  }

  const total = () => [...bal.values()].reduce((s, v) => s + v, 0n);
  const startRaw = total();
  let minRaw = startRaw;
  let minAt: HoldResult["minAt"] = null;
  let n = 0;
  for (const e of events) {
    if (e.blockTime > endTs) break;
    n++;
    for (const [acct, c] of e.changes) bal.set(acct, c.post);
    const t = total();
    if (t < minRaw) {
      minRaw = t;
      minAt = { blockTime: e.blockTime, sig: e.sig };
    }
  }
  return { startRaw, minRaw, minAt, endRaw: total(), eventsInWindow: n, gaps, ambiguousOrder };
}

export type Verdict = { qualified: boolean; reason: string };

export function verdict(r: HoldResult, thresholdRaw: bigint, endTs: number, nowTs: number, fmt: (raw: bigint) => string, iso: (ts: number) => string): Verdict {
  if (r.gaps.length) return { qualified: false, reason: `history incomplete (${r.gaps.length} gap(s)); manual review` };
  if (r.startRaw === 0n && r.minRaw === 0n && r.endRaw === 0n) return { qualified: false, reason: "held no $GC at the snapshot / window start" };
  if (r.startRaw < thresholdRaw) return { qualified: false, reason: `below ${fmt(thresholdRaw)} at the snapshot / window start (${fmt(r.startRaw)})` };
  if (r.minRaw < thresholdRaw)
    return { qualified: false, reason: `dipped to ${fmt(r.minRaw)} at ${iso(r.minAt!.blockTime)} (tx ${r.minAt!.sig})` };
  if (endTs > nowTs) return { qualified: false, reason: `window still open; on track so far (held ≥${fmt(thresholdRaw)} through now)` };
  const amb = r.ambiguousOrder ? " (note: same-slot order inferred)" : "";
  return { qualified: true, reason: `held ≥${fmt(thresholdRaw)} for the whole window (${r.eventsInWindow} balance change(s))${amb}` };
}

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/**
 * Pick the wallet column of a Gleam export: `column` by header name if given, else the column where
 * most cells look like base58 Solana addresses. Returns raw cell values (trimmed), header excluded.
 */
export function walletsFromCsv(text: string, column?: string): { header: string; wallets: string[] } {
  const rows = parseCsv(text);
  if (!rows.length) return { header: "", wallets: [] };
  const header = rows[0].map((h) => h.trim());
  let col = -1;
  if (column) {
    col = header.findIndex((h) => h.toLowerCase() === column.toLowerCase());
    if (col < 0) throw new Error(`column "${column}" not found; headers: ${header.join(" | ")}`);
  } else {
    let best = 0;
    for (let c = 0; c < header.length; c++) {
      const hits = rows.slice(1).filter((r) => B58.test((r[c] ?? "").trim())).length;
      if (hits > best) { best = hits; col = c; }
    }
    if (col < 0) {
      // headerless single-column list
      if (rows.every((r) => B58.test((r[0] ?? "").trim()))) return { header: "(none)", wallets: rows.map((r) => r[0].trim()) };
      throw new Error("no column of Solana addresses found; pass --column <header>");
    }
  }
  const body = B58.test((rows[0][col] ?? "").trim()) ? rows : rows.slice(1);
  return { header: header[col] ?? "", wallets: body.map((r) => (r[col] ?? "").trim()).filter(Boolean) };
}
