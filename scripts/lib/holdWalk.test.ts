// Unit tests for the 30-day hold logic: `npx tsx --test scripts/lib/holdWalk.test.ts` (npm run test:scripts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { changesFromMeta, verdict, walkHold, walletsFromCsv, type HoldEvent } from "./holdWalk";

const U = 1_000_000n;
const ev = (sig: string, slot: number, t: number, ch: Record<string, [number, number]>, txIndex: number | null = 0): HoldEvent => ({
  sig, slot, txIndex, blockTime: t,
  changes: new Map(Object.entries(ch).map(([k, [a, b]]) => [k, { pre: BigInt(a) * U, post: BigInt(b) * U }])),
});
const fmt = (r: bigint) => (r / U).toString();
const iso = (t: number) => String(t);
const V = (r: ReturnType<typeof walkHold>, end = 1000, now = 2000) => verdict(r, 100_000n * U, end, now, fmt, iso);

test("no activity: today's balance held the whole window", () => {
  const r = walkHold([], new Map([["A", 150_000n * U]]), 100, 1000);
  assert.equal(r.startRaw, 150_000n * U);
  assert.equal(r.minRaw, 150_000n * U);
  assert.equal(V(r).qualified, true);
});

test("a dip below 100k for one tx disqualifies even if topped back up", () => {
  const r = walkHold([ev("s1", 10, 200, { A: [150_000, 90_000] }), ev("s2", 11, 300, { A: [90_000, 200_000] })], new Map([["A", 200_000n * U]]), 100, 1000);
  assert.equal(r.minRaw, 90_000n * U);
  assert.equal(r.gaps.length, 0);
  const v = V(r);
  assert.equal(v.qualified, false);
  assert.match(v.reason, /dipped to 90000 at 200 \(tx s1\)/);
});

test("adding more is fine; buying in after the snapshot fails", () => {
  assert.equal(V(walkHold([ev("s1", 10, 200, { A: [100_000, 500_000] })], new Map([["A", 500_000n * U]]), 100, 1000)).qualified, true);
  const late = V(walkHold([ev("s1", 10, 200, { A: [0, 500_000] })], new Map([["A", 500_000n * U]]), 100, 1000));
  assert.equal(late.qualified, false);
  assert.match(late.reason, /below 100000 at the snapshot/);
});

test("multiple token accounts are summed; moving between own accounts in one tx is not a dip", () => {
  const r = walkHold([ev("s1", 10, 200, { A: [120_000, 20_000], B: [0, 100_000] })], new Map([["A", 20_000n * U], ["B", 100_000n * U]]), 100, 1000);
  assert.equal(r.startRaw, 120_000n * U);
  assert.equal(r.minRaw, 120_000n * U);
  assert.equal(V(r).qualified, true);
});

test("split across two accounts: total counts, closed account (post 0, gone today) is fine", () => {
  const evs = [ev("s1", 10, 200, { A: [60_000, 0] }, 0), ev("s1b", 10, 200, { B: [60_000, 120_000] }, 1)];
  // A moved to B in two txs in the same slot: in-block order known → dip 60k between them is real
  const r = walkHold(evs, new Map([["B", 120_000n * U]]), 100, 1000);
  assert.equal(r.startRaw, 120_000n * U);
  assert.equal(r.minRaw, 60_000n * U);
  assert.equal(r.gaps.length, 0);
});

test("events after the window end don't count but anchor continuity", () => {
  const r = walkHold([ev("s1", 10, 1500, { A: [150_000, 0] })], new Map(), 100, 1000);
  assert.equal(r.minRaw, 150_000n * U);
  assert.equal(r.endRaw, 150_000n * U);
  assert.equal(V(r).qualified, true);
});

test("missing transaction → gap → manual review, never qualified", () => {
  const r = walkHold([ev("s1", 10, 200, { A: [150_000, 140_000] })], new Map([["A", 50_000n * U]]), 100, 1000);
  assert.equal(r.gaps.length, 1);
  assert.match(V(r).reason, /manual review/);
});

test("window still open → not qualified yet", () => {
  const r = walkHold([], new Map([["A", 150_000n * U]]), 100, 5000);
  assert.match(V(r, 5000, 2000).reason, /still open/);
});

test("changesFromMeta: owner + mint filter, created/closed accounts default to 0", () => {
  const keys = ["X", "A", "B", "C"];
  const m = changesFromMeta(keys,
    [{ accountIndex: 1, mint: "M", owner: "W", uiTokenAmount: { amount: "5" } }, { accountIndex: 2, mint: "M", owner: "Z", uiTokenAmount: { amount: "9" } }],
    [{ accountIndex: 3, mint: "M", owner: "W", uiTokenAmount: { amount: "7" } }, { accountIndex: 2, mint: "M", owner: "Z", uiTokenAmount: { amount: "1" } }],
    "W", "M");
  assert.deepEqual([...m.entries()], [["A", { pre: 5n, post: 0n }], ["C", { pre: 0n, post: 7n }]]);
});

test("walletsFromCsv: auto-detects the wallet column in a Gleam-style export", () => {
  const csv = 'Name,Email,"Solana wallet",X handle\r\nAl,"a@x, inc",13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfyj6,@al\nBo,b@x,4ux4b8uFSXBvuDLQrvqXM6SDPdrPmVAmmEfwr6rWMsoQ,@bo\n';
  const r = walletsFromCsv(csv);
  assert.equal(r.header, "Solana wallet");
  assert.deepEqual(r.wallets, ["13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfyj6", "4ux4b8uFSXBvuDLQrvqXM6SDPdrPmVAmmEfwr6rWMsoQ"]);
  assert.deepEqual(walletsFromCsv(csv, "solana wallet").wallets.length, 2);
});
