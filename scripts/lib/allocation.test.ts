// Unit tests for the top-N equal-split rule: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { equalSplit, selectTopN, type Ranked } from "./allocation";

const U = 1_000_000n;
const TOTAL = 100_000_000n * U;
const w = (i: number, ui: number | bigint): Ranked => ({ wallet: `W${String(i).padStart(5, "0")}`, balanceRaw: BigInt(ui) * U });

test("1,000 or fewer qualified: everyone selected, 100M split evenly", () => {
  const q = Array.from({ length: 640 }, (_, i) => w(i, 100_000 + i));
  const s = selectTopN(q, 1000);
  assert.equal(s.selected.length, 640);
  const sp = equalSplit(TOTAL, s.selected.length);
  assert.equal(sp.shareRaw, 156_250n * U); // 100M / 640 = 156,250 exactly
  assert.equal(sp.dustRaw, 0n);
});

test("more than 1,000 qualified: top 1,000 by snapshot balance, 100k each, 0 dust", () => {
  const q = Array.from({ length: 1500 }, (_, i) => w(i, 100_000 + i * 10)); // unique balances
  const s = selectTopN(q, 1000);
  assert.equal(s.selected.length, 1000);
  assert.equal(s.selected[0].balanceRaw, BigInt(100_000 + 1499 * 10) * U);
  assert.equal(s.cutoffBalanceRaw, BigInt(100_000 + 500 * 10) * U);
  assert.ok(!s.selected.some((r) => r.balanceRaw < s.cutoffBalanceRaw!));
  const sp = equalSplit(TOTAL, 1000);
  assert.equal(sp.shareRaw, 100_000n * U);
  assert.equal(sp.dustRaw, 0n);
});

test("exact integer math: dust < N raw units and share × N + dust = total", () => {
  for (const n of [1, 3, 7, 333, 999, 1000]) {
    const sp = equalSplit(TOTAL, n);
    assert.equal(sp.shareRaw * BigInt(n) + sp.dustRaw, TOTAL);
    assert.ok(sp.dustRaw < BigInt(n));
    assert.equal(sp.allocatedRaw, sp.shareRaw * BigInt(n));
  }
  assert.equal(equalSplit(TOTAL, 3).dustRaw, 1n); // 100,000,000,000,000 raw / 3 → 1 raw left in the pool
  assert.throws(() => equalSplit(TOTAL, 0));
});

test("tie straddling rank N: error by default; include / exclude / address policies", () => {
  const q = [w(1, 500_000), w(2, 400_000), w(3, 100_000), w(4, 100_000), w(5, 100_000)];
  assert.throws(() => selectTopN(q, 3), /tie at rank 3/);
  assert.equal(selectTopN(q, 3, "include").selected.length, 5);
  assert.deepEqual(selectTopN(q, 3, "exclude").selected.map((r) => r.wallet), ["W00001", "W00002"]);
  assert.deepEqual(selectTopN(q, 3, "address").selected.map((r) => r.wallet), ["W00001", "W00002", "W00003"]);
  // tie entirely inside the top N is fine
  assert.equal(selectTopN(q, 5).selected.length, 5);
  // tie just below the cutoff is fine
  assert.equal(selectTopN([w(1, 300_000), w(2, 200_000), w(3, 100_000), w(4, 100_000)], 2).selected.length, 2);
});

test("duplicates and empty balances are rejected", () => {
  assert.throws(() => selectTopN([w(1, 200_000), w(1, 300_000)], 10), /duplicate/);
  assert.throws(() => selectTopN([w(1, 0)], 10), /no balance/);
  assert.throws(() => selectTopN([w(1, 1)], 0), /positive integer/);
});
