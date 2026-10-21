// Unit tests for the holder-milestone counter helpers: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { b58decode, b58encode, countHolders, isOnCurve, isWalletAddress, parseExcludeList, sumByOwner, updateMilestone, WEEK_SECS } from "./milestone.mjs";

const U = 1_000_000n;

test("isOnCurve matches @solana/web3.js PublicKey.isOnCurve (random bytes, keypairs, PDAs)", () => {
  for (let i = 0; i < 1500; i++) {
    const b = crypto.randomBytes(32);
    assert.equal(isOnCurve(b), PublicKey.isOnCurve(b), Buffer.from(b).toString("hex"));
  }
  for (let i = 0; i < 50; i++) assert.equal(isOnCurve(Keypair.generate().publicKey.toBytes()), true);
  const prog = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"); // pump.fun program
  const mint = new PublicKey("G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump");
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], prog);
  assert.equal(isOnCurve(curve.toBytes()), false);
  assert.equal(isWalletAddress(curve.toBase58()), false);
});

test("base58 round-trips and matches web3.js", () => {
  for (let i = 0; i < 200; i++) {
    const pk = Keypair.generate().publicKey;
    assert.equal(b58encode(pk.toBytes()), pk.toBase58());
    assert.deepEqual(Buffer.from(b58decode(pk.toBase58())), Buffer.from(pk.toBytes()));
  }
  assert.equal(b58encode(new Uint8Array(32)), "11111111111111111111111111111111");
});

test("countHolders: total > 0 vs ≥100k, exclusions by list and off-curve", () => {
  const rows = [
    { owner: "A", amount: 150_000n * U }, { owner: "A", amount: 0n },
    { owner: "B", amount: 60_000n * U }, { owner: "B", amount: 40_000n * U }, // two accounts sum to exactly 100k
    { owner: "C", amount: 99_999n * U },
    { owner: "D", amount: 0n },                                               // empty account: not a holder
    { owner: "POOL", amount: 900_000_000n * U },                              // off-curve
    { owner: "TEAM", amount: 17_000_000n * U },                               // listed
    { owner: "BURN", amount: 5n * U },
  ];
  const totals = sumByOwner(rows);
  const ex = new Map([["TEAM", "team"], ["BURN", "burn"]]);
  const c = countHolders(totals, 100_000n * U, ex, (o) => o !== "POOL");
  assert.deepEqual(c.raw, { total: 6, gte: 4 });
  assert.deepEqual(c.counted, { total: 3, gte: 2 });
  assert.equal(c.excluded.offCurve.gte, 1);
  assert.equal(c.excluded.list.team.gte, 1);
  assert.equal(c.excluded.list.burn.total, 1);
  assert.equal(c.excludedOwners[0].owner, "POOL");
});

test("parseExcludeList: comments skipped, objects allowed, bad addresses throw", () => {
  const m = parseExcludeList({ _about: "x", burn: [{ address: "1nc1nerator11111111111111111111111111111111" }], team: ["13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfyj6"] });
  assert.equal(m.get("1nc1nerator11111111111111111111111111111111"), "burn");
  assert.equal(m.size, 2);
  assert.throws(() => parseExcludeList({ team: ["not-an-address"] }), /not a valid address/);
  assert.throws(() => parseExcludeList({ team: ["13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfy"] }), /not a valid address/);
});

test("updateMilestone: first crossing is kept forever, S = M + 7 days", () => {
  let s = updateMilestone(null, { blockTime: 1000, slot: 1, total: 900, gte: 40 });
  assert.equal(s.firstReached.gte, null);
  s = updateMilestone(s, { blockTime: 2000, slot: 2, total: 1001, gte: 400 });
  assert.equal(s.firstReached.total?.count, 1001);
  assert.equal(s.firstReached.gte, null);
  s = updateMilestone(s, { blockTime: 3000, slot: 3, total: 3000, gte: 1000 });
  assert.equal(s.firstReached.gte?.blockTime, 3000);
  assert.equal(s.firstReached.gte?.snapshotBlockTime, 3000 + WEEK_SECS);
  s = updateMilestone(s, { blockTime: 4000, slot: 4, total: 2000, gte: 990 }); // dips back below: unchanged
  s = updateMilestone(s, { blockTime: 5000, slot: 5, total: 4000, gte: 1200 });
  assert.equal(s.firstReached.gte?.blockTime, 3000);
  assert.equal(s.runs.length, 5);
  assert.throws(() => updateMilestone(s, { blockTime: 10, slot: 6, total: 1, gte: 1 }), /older/);
  assert.throws(() => updateMilestone(s, { blockTime: 6000, slot: 6, total: 1, gte: 1 }, 500), /milestone 1000/);
});
