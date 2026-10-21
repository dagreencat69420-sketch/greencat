import { describe, expect, it } from "vitest";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { Clock, PROGRAM_ID, fakeProgramTx, makeApp, signIn } from "./helpers";
import { ingestTransaction } from "../src/indexer/store";
import { MarketPoints } from "../src/points/market";

// 2026-09-26 10:00 PDT
const T0 = "2026-09-26T17:00:00Z";
const MIN = 60_000;
const HOUR = 60 * MIN;
const PRICE = 500_000_000n; // 500 GC (min for points = 100 GC)
const wrap = (lines: string[]) => [`Program ${PROGRAM_ID} invoke [1]`, ...lines, `Program ${PROGRAM_ID} success`];

async function setup(env?: Record<string, string>) {
  const clock = new Clock(Date.parse(T0));
  const ctx = await makeApp({ clock, env: { SESSION_TTL_SEC: String(30 * 86400), ...(env ?? {}) } });
  const market = new MarketPoints(ctx.db, ctx.config.marketPoints, clock.now);
  let slot = 10_000;
  const nowSec = () => Math.floor(clock.t / 1000);
  const ingest = (lines: string[], sig = Keypair.generate().publicKey.toBase58() + "x") =>
    ingestTransaction(ctx.db, PROGRAM_ID, { signature: sig, slot: slot++, blockTime: nowSec(), logMessages: wrap(lines) });

  /** Seller lists on-chain (indexed) and asks the API for the listing bonus. */
  const list = async (kp: Keypair, token: string, mint: PublicKey, price = PRICE) => {
    const logs = wrap([`Program log: list_nft: mint=${mint.toBase58()} seller=${kp.publicKey.toBase58()} price=${price}`]);
    const tx = fakeProgramTx({ signer: kp, ix: "list_nft", blockTime: nowSec(), amountRaw: price, logs, slot });
    ctx.txs.set(tx.signature, tx.response);
    await ingestTransaction(ctx.db, PROGRAM_ID, { signature: tx.signature, slot: slot++, blockTime: nowSec(), logMessages: logs });
    return ctx.call("POST", "/bonus", { kind: "list", signature: tx.signature }, token);
  };
  const cancel = (seller: PublicKey, mint: PublicKey) =>
    ingest([`Program log: cancel_listing: mint=${mint.toBase58()} seller=${seller.toBase58()}`]);
  const buy = (buyer: PublicKey, mint: PublicKey, price = PRICE) =>
    ingest([
      `Program log: buy_nft: mint=${mint.toBase58()} buyer=${buyer.toBase58()} price=${price} fee=${price / 100n} seller_net=${price - price / 100n}`,
    ]);
  const pointsOf = async (w: PublicKey) => {
    const { rows } = await ctx.db.query<{ points: number }>(
      "SELECT COALESCE(SUM(amount),0)::int AS points FROM points_events WHERE wallet = $1",
      [w.toBase58()]
    );
    return Number(rows[0].points);
  };
  const user = async () => {
    const kp = Keypair.generate();
    return { kp, pk: kp.publicKey, token: await signIn(ctx.call, kp) };
  };
  return { ...ctx, clock, market, list, cancel, buy, pointsOf, user, ingest };
}

describe("listing points: list/delist loop is closed", () => {
  it("list → delist → relist loop earns nothing; listing must stay active 10 min", async () => {
    const s = await setup();
    const a = await s.user();
    const nft = Keypair.generate().publicKey;

    const r1 = await s.list(a.kp, a.token, nft);
    expect(r1.status).toBe(202);
    expect(r1.json).toMatchObject({ kind: "list", gained: 0, pending: true, nftMint: nft.toBase58() });

    s.clock.advance(1 * MIN);
    await s.cancel(a.pk, nft); // cancelled after 1 minute
    s.clock.advance(1 * MIN);
    const r2 = await s.list(a.kp, a.token, nft); // relist the same NFT
    expect(r2.status).toBe(409);
    expect(r2.json.error).toBe("list_nft_window");

    // loop it a few more times — never anything
    for (let i = 0; i < 5; i++) {
      await s.cancel(a.pk, nft);
      s.clock.advance(30_000);
      expect((await s.list(a.kp, a.token, nft)).status).toBe(409);
    }
    s.clock.advance(20 * MIN);
    const settled = await s.market.settle();
    expect(settled).toMatchObject({ listAwarded: 0, listVoided: 1 });
    expect(await s.pointsOf(a.pk)).toBe(0);
    const { rows } = await s.db.query<{ reason: string }>("SELECT reason FROM listing_awards");
    // the relist replaced it on-chain before 10 min elapsed
    expect(rows.map((r) => r.reason)).toEqual(["replaced_before_min_active"]);
  });

  it("plain delist within 10 min voids the pending award", async () => {
    const s = await setup();
    const a = await s.user();
    const nft = Keypair.generate().publicKey;
    expect((await s.list(a.kp, a.token, nft)).status).toBe(202);
    s.clock.advance(9 * MIN);
    await s.cancel(a.pk, nft);
    s.clock.advance(5 * MIN);
    expect(await s.market.settle()).toMatchObject({ listAwarded: 0, listVoided: 1 });
    const { rows } = await s.db.query<{ reason: string }>("SELECT reason FROM listing_awards");
    expect(rows[0].reason).toBe("delisted_before_min_active");
    expect(await s.pointsOf(a.pk)).toBe(0);
  });

  it("credits once after ≥10 min active; delisting later does not deduct; relist only after 24h", async () => {
    const s = await setup();
    const a = await s.user();
    const nft = Keypair.generate().publicKey;
    expect((await s.list(a.kp, a.token, nft)).status).toBe(202);

    s.clock.advance(5 * MIN);
    expect(await s.market.settle()).toMatchObject({ listAwarded: 0, listVoided: 0 }); // still waiting
    s.clock.advance(5 * MIN);
    expect(await s.market.settle()).toMatchObject({ listAwarded: 1 });
    expect(await s.pointsOf(a.pk)).toBe(10);
    expect((await s.call("GET", "/me", undefined, a.token)).json.points).toBe(10);
    expect(await s.market.settle()).toMatchObject({ listAwarded: 0, listVoided: 0 }); // idempotent

    await s.cancel(a.pk, nft);
    expect(await s.pointsOf(a.pk)).toBe(10); // no deduction
    s.clock.advance(1 * HOUR);
    expect((await s.list(a.kp, a.token, nft)).json.error).toBe("list_nft_window");

    s.clock.advance(24 * HOUR);
    expect((await s.list(a.kp, a.token, nft)).status).toBe(202);
    s.clock.advance(11 * MIN);
    await s.market.settle();
    expect(await s.pointsOf(a.pk)).toBe(20);
  });

  it("a listing cancelled after ≥10 min (settler late) still counts; the window is per NFT across wallets", async () => {
    const s = await setup();
    const a = await s.user();
    const b = await s.user();
    const nft = Keypair.generate().publicKey;
    expect((await s.list(a.kp, a.token, nft)).status).toBe(202);
    s.clock.advance(12 * MIN);
    await s.cancel(a.pk, nft);
    s.clock.advance(30 * MIN);
    expect(await s.market.settle()).toMatchObject({ listAwarded: 1 });
    // NFT handed to a second wallet and relisted → still inside the NFT's 24h window
    const r = await s.list(b.kp, b.token, nft);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("list_nft_window");
    expect(await s.pointsOf(b.pk)).toBe(0);
  });

  it("per-wallet cap: listing points for at most N distinct NFTs per 24h (default 5, configurable)", async () => {
    const s = await setup();
    const a = await s.user();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await s.list(a.kp, a.token, Keypair.generate().publicKey)).status);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    s.clock.advance(11 * MIN);
    await s.market.settle();
    expect(await s.pointsOf(a.pk)).toBe(50);
    s.clock.advance(24 * HOUR);
    expect((await s.list(a.kp, a.token, Keypair.generate().publicKey)).status).toBe(202);

    const s2 = await setup({ LIST_POINTS_MAX_NFTS_PER_DAY: "2", LIST_POINTS_MIN_ACTIVE_SEC: "60" });
    const c = await s2.user();
    const st: number[] = [];
    for (let i = 0; i < 3; i++) st.push((await s2.list(c.kp, c.token, Keypair.generate().publicKey)).status);
    expect(st).toEqual([202, 202, 429]);
    s2.clock.advance(61_000);
    expect(await s2.market.settle()).toMatchObject({ listAwarded: 2 });
  });

  it("replayed signature and replaced listing are rejected / voided; dust price earns nothing", async () => {
    const s = await setup();
    const a = await s.user();
    const nft = Keypair.generate().publicKey;
    const logs = wrap([`Program log: list_nft: mint=${nft.toBase58()} seller=${a.pk.toBase58()} price=${PRICE}`]);
    const tx = fakeProgramTx({ signer: a.kp, ix: "list_nft", blockTime: Math.floor(s.clock.t / 1000), amountRaw: PRICE, logs });
    s.txs.set(tx.signature, tx.response);
    expect((await s.call("POST", "/bonus", { kind: "list", signature: tx.signature }, a.token)).status).toBe(202);
    expect((await s.call("POST", "/bonus", { kind: "list", signature: tx.signature }, a.token)).json.error).toBe("replay");
    // never indexed for >24h → void
    s.clock.advance(25 * HOUR);
    expect(await s.market.settle()).toMatchObject({ listVoided: 1 });
    expect((await s.list(a.kp, a.token, Keypair.generate().publicKey, 1n)).json.error).toBe("amount_too_small");
  });
});

describe("sale points: wash-trade limits", () => {
  it("seller+buyer earn on a real sale; self-trade, same-pair cooldown, NFT cooldown and old trades earn nothing", async () => {
    const s = await setup();
    const [a, b, c] = [await s.user(), await s.user(), await s.user()];
    const nft = Keypair.generate().publicKey;

    await s.list(a.kp, a.token, nft);
    s.clock.advance(2 * MIN);
    await s.buy(b.pk, nft); // sold within 10 min → no listing points, but sale points
    s.clock.advance(1 * MIN);
    const r = await s.market.settle();
    expect(r).toMatchObject({ listVoided: 1, salesDecided: 1, salePointsAwarded: 15 });
    expect(await s.pointsOf(a.pk)).toBe(10);
    expect(await s.pointsOf(b.pk)).toBe(5);
    expect(await s.market.settle()).toMatchObject({ salesDecided: 0 }); // decided exactly once

    // B sells it straight back to A → same pair within cooldown
    s.clock.advance(2 * HOUR);
    await s.ingest([`Program log: list_nft: mint=${nft.toBase58()} seller=${b.pk.toBase58()} price=${PRICE}`]);
    await s.buy(a.pk, nft);
    await s.market.settle();
    // A → C on the same NFT within 24h of the rewarded sale → NFT cooldown (ring A→B→A→C)
    s.clock.advance(1 * HOUR);
    await s.ingest([`Program log: list_nft: mint=${nft.toBase58()} seller=${a.pk.toBase58()} price=${PRICE}`]);
    await s.buy(c.pk, nft);
    await s.market.settle();
    const { rows } = await s.db.query<{ reason: string }>("SELECT reason FROM sale_awards ORDER BY trade_id");
    expect(rows.map((x) => x.reason)).toEqual(["awarded", "pair_cooldown", "nft_cooldown"]);
    expect(await s.pointsOf(a.pk)).toBe(10);
    expect(await s.pointsOf(b.pk)).toBe(5);
    expect(await s.pointsOf(c.pk)).toBe(0);

    // After the NFT cooldown, a fresh pair (C → B) earns again
    s.clock.advance(25 * HOUR);
    await s.ingest([`Program log: list_nft: mint=${nft.toBase58()} seller=${c.pk.toBase58()} price=${PRICE}`]);
    await s.buy(b.pk, nft);
    await s.market.settle();
    expect(await s.pointsOf(c.pk)).toBe(10);
    expect(await s.pointsOf(b.pk)).toBe(10);

    // self-trade + dust + old trades (direct rows; the program already forbids buyer == seller)
    const nowIso = new Date(s.clock.t).toISOString();
    const old = new Date(s.clock.t - 3 * 86_400_000).toISOString();
    const n2 = Keypair.generate().publicKey.toBase58();
    await s.db.query(
      `INSERT INTO trades (nft_mint, buyer, seller, price_raw, kind, sig, traded_at) VALUES
        ($1, $2, $2, 500000000, 'buy', 'selfsig', $3),
        ($1, $2, $4, 1, 'buy', 'dustsig', $3),
        ($5, $2, $4, 500000000, 'buy', 'oldsig', $6)`,
      [n2, a.pk.toBase58(), nowIso, b.pk.toBase58(), Keypair.generate().publicKey.toBase58(), old]
    );
    await s.market.settle();
    const { rows: r2 } = await s.db.query<{ reason: string }>(
      "SELECT reason FROM sale_awards ORDER BY trade_id DESC LIMIT 3"
    );
    expect(r2.map((x) => x.reason).sort()).toEqual(["below_min_price", "self_trade", "too_old"]);
  });

  it("per-wallet daily sale cap; concurrent settlers never double-award", async () => {
    const s = await setup({ SALE_POINTS_MAX_PER_DAY: "1" });
    const a = await s.user();
    const buyers = [await s.user(), await s.user()];
    for (const b of buyers) {
      const nft = Keypair.generate().publicKey;
      await s.ingest([`Program log: list_nft: mint=${nft.toBase58()} seller=${a.pk.toBase58()} price=${PRICE}`]);
      await s.buy(b.pk, nft);
    }
    await Promise.all([s.market.settle(), s.market.settle(), s.market.settle()]);
    expect(await s.pointsOf(a.pk)).toBe(10); // 2nd sale over the seller's cap
    expect(await s.pointsOf(buyers[0].pk)).toBe(5);
    expect(await s.pointsOf(buyers[1].pk)).toBe(5);
    const { rows } = await s.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM sale_awards");
    expect(Number(rows[0].n)).toBe(2);
  });
});
