import { beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  Clock,
  PROGRAM_ID,
  fakeProgramTx,
  makeApp,
  nftMintedData,
  nftRevealedData,
  signIn,
} from "./helpers";
import { ingestTransaction } from "../src/indexer/store";
import { loadConfig, DEFAULT_BONUS_DAILY_CAPS } from "../src/config";

// 2026-09-26 10:00 PDT
const T0 = "2026-09-26T17:00:00Z";

describe("auth (SIWS)", () => {
  it("nonce → ed25519 signMessage → session; nonce single-use; bad sig / wrong wallet / expiry rejected", async () => {
    const clock = new Clock(Date.parse(T0));
    const { call } = await makeApp({ clock });
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();

    expect((await call("GET", "/me")).status).toBe(401);
    expect((await call("POST", "/auth/nonce", { wallet: "nope" })).status).toBe(400);

    const n = await call("POST", "/auth/nonce", { wallet });
    expect(n.status).toBe(200);
    expect(n.json.message).toContain(wallet);
    expect(n.json.message).toContain(`Nonce: ${n.json.nonce}`);

    // signature by a different key
    const other = Keypair.generate();
    const badSig = nacl.sign.detached(new TextEncoder().encode(n.json.message), other.secretKey);
    const bad = await call("POST", "/auth/verify", {
      wallet,
      nonce: n.json.nonce,
      signature: Buffer.from(badSig).toString("base64"),
    });
    expect(bad.status).toBe(401);
    expect(bad.json.error).toBe("bad_signature");

    // nonce bound to wallet
    const sigOther = nacl.sign.detached(new TextEncoder().encode(n.json.message), other.secretKey);
    const wrongWallet = await call("POST", "/auth/verify", {
      wallet: other.publicKey.toBase58(),
      nonce: n.json.nonce,
      signature: Buffer.from(sigOther).toString("base64"),
    });
    expect(wrongWallet.status).toBe(401);

    const good = nacl.sign.detached(new TextEncoder().encode(n.json.message), kp.secretKey);
    const ok = await call("POST", "/auth/verify", {
      wallet,
      nonce: n.json.nonce,
      signature: Buffer.from(good).toString("base64"),
    });
    expect(ok.status).toBe(200);
    expect(typeof ok.json.token).toBe("string");
    const replay = await call("POST", "/auth/verify", {
      wallet,
      nonce: n.json.nonce,
      signature: Buffer.from(good).toString("base64"),
    });
    expect(replay.status).toBe(401);
    expect(replay.json.error).toBe("nonce_used");

    const me = await call("GET", "/me", undefined, ok.json.token);
    expect(me.status).toBe(200);
    expect(me.json.wallet).toBe(wallet);

    // expired nonce
    const n2 = await call("POST", "/auth/nonce", { wallet });
    clock.advance(301_000);
    const s2 = nacl.sign.detached(new TextEncoder().encode(n2.json.message), kp.secretKey);
    const exp = await call("POST", "/auth/verify", {
      wallet,
      nonce: n2.json.nonce,
      signature: Buffer.from(s2).toString("base64"),
    });
    expect(exp.json.error).toBe("nonce_expired");

    // session token expires after SESSION_TTL_SEC (1h)
    clock.advance(3600_000);
    expect((await call("GET", "/me", undefined, ok.json.token)).status).toBe(401);
    // forged token
    expect((await call("GET", "/me", undefined, ok.json.token.slice(0, -2) + "xx")).status).toBe(401);
  });
});

describe("points (server-authoritative)", () => {
  let clock: Clock;
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  const kp = Keypair.generate();
  let token: string;

  beforeEach(async () => {
    clock = new Clock(Date.parse(T0));
    ctx = await makeApp({ clock, rolls: [42, 7, 13, 100, 1, 1, 1, 1], env: { SESSION_TTL_SEC: "31536000" } });
    token = await signIn(ctx.call, kp);
  });

  it("claim once per Vancouver day; streak across midnight PT; milestone at 3; ignores client-supplied amounts", async () => {
    const { call } = ctx;
    const c1 = await call("POST", "/claim", { points: 999999, baseGained: 100 }, token);
    expect(c1.status).toBe(200);
    expect(c1.json.baseGained).toBe(42);
    expect(c1.json.total).toBe(42);
    expect(c1.json.streak).toBe(1);

    const again = await call("POST", "/claim", {}, token);
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("already_claimed");

    // 23:59:59 PDT same day → still blocked
    clock.set("2026-09-27T06:59:59Z");
    expect((await call("POST", "/claim", {}, token)).status).toBe(409);
    // 00:00 PDT next day → allowed, streak 2
    clock.set("2026-09-27T07:00:00Z");
    const c2 = await call("POST", "/claim", {}, token);
    expect(c2.status).toBe(200);
    expect(c2.json.streak).toBe(2);
    // day 3 → +10 milestone
    clock.set("2026-09-28T18:00:00Z");
    const c3 = await call("POST", "/claim", {}, token);
    expect(c3.json.streak).toBe(3);
    expect(c3.json.milestoneBonus).toBe(10);
    expect(c3.json.total).toBe(42 + 7 + 13 + 10);

    const me = await call("GET", "/me", undefined, token);
    expect(me.json).toMatchObject({ points: 72, streak: 3, claimedToday: true, rank: 1, totalRanked: 1 });
    expect(me.json.streakMilestones).toEqual([3]);

    // skip a day → streak breaks
    clock.set("2026-09-30T18:00:00Z");
    const me2 = await call("GET", "/me", undefined, token);
    expect(me2.json.streak).toBe(0);
    expect(me2.json.claimedToday).toBe(false);
    const c4 = await call("POST", "/claim", {}, token);
    expect(c4.json.streak).toBe(1);
  });

  it("monthly reset on the 1st (Vancouver) keeps streak; old month board preserved", async () => {
    const { call } = ctx;
    clock.set("2026-09-30T18:00:00Z");
    await call("POST", "/claim", {}, token); // 42
    // 2026-10-01T03:00Z is still Sept 30 PT → same month, already claimed
    clock.set("2026-10-01T03:00:00Z");
    expect((await call("GET", "/me", undefined, token)).json.month).toBe("2026-09");
    clock.set("2026-10-01T08:00:00Z"); // Oct 1, 01:00 PDT
    const me = await call("GET", "/me", undefined, token);
    expect(me.json).toMatchObject({ month: "2026-10", points: 0, streak: 1, rank: null });
    const c = await call("POST", "/claim", {}, token); // 7
    expect(c.json).toMatchObject({ streak: 2, total: 7 });
    const sep = await call("GET", "/leaderboard?month=2026-09");
    expect(sep.json.top[0]).toMatchObject({ wallet: kp.publicKey.toBase58(), points: 42 });
    const oct = await call("GET", "/leaderboard");
    expect(oct.json).toMatchObject({ month: "2026-10", total: 1 });
    expect(oct.json.top[0].points).toBe(7);
    expect((await call("GET", "/leaderboard?month=2026-13")).status).toBe(400);
  });

  it("concurrent claims: exactly one succeeds", async () => {
    const { call } = ctx;
    const results = await Promise.all(Array.from({ length: 6 }, () => call("POST", "/claim", {}, token)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const me = await call("GET", "/me", undefined, token);
    expect(me.json.points).toBe(42);
  });

  it("lo-fi heartbeat: server clock enforces ~60s/pt and 10/day cap", async () => {
    const { call } = ctx;
    let r = await call("POST", "/lofi/heartbeat", {}, token);
    expect(r.json.status).toBe("started");
    clock.advance(15_000);
    r = await call("POST", "/lofi/heartbeat", {}, token);
    expect(r.json).toMatchObject({ status: "waiting", gained: 0 });
    clock.advance(45_000);
    r = await call("POST", "/lofi/heartbeat", {}, token);
    expect(r.json).toMatchObject({ status: "tick", gained: 1, lofiToday: 1 });
    // burst of heartbeats is rate-limited (12/min) and can't earn more
    let limited = 0;
    for (let i = 0; i < 20; i++) {
      const x = await call("POST", "/lofi/heartbeat", {}, token);
      if (x.status === 429) limited++;
      else expect(x.json.gained).toBe(0);
    }
    expect(limited).toBeGreaterThan(0);
    // play for 30 minutes w/ 15s heartbeats
    let total = 1;
    for (let i = 0; i < 120; i++) {
      clock.advance(15_000);
      const x = await call("POST", "/lofi/heartbeat", {}, token);
      if (x.status === 200) total += x.json.gained;
    }
    expect(total).toBe(10);
    const me = await call("GET", "/me", undefined, token);
    expect(me.json.lofiToday).toBe(10);
    expect(me.json.points).toBe(10);
  });

  it("leaderboard returns top 10 + total; /me returns own rank outside top 10", async () => {
    const { call, db } = ctx;
    const month = "2026-09";
    for (let i = 0; i < 14; i++) {
      await db.query("INSERT INTO points_monthly (month, wallet, points) VALUES ($1, $2, $3)", [
        month,
        Keypair.generate().publicKey.toBase58(),
        1000 - i * 10,
      ]);
    }
    await call("POST", "/claim", {}, token); // 42 → last place
    const lb = await call("GET", "/leaderboard");
    expect(lb.json.total).toBe(15);
    expect(lb.json.top).toHaveLength(10);
    expect(lb.json.top.map((r: any) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(lb.json.top[0].points).toBe(1000);
    const me = await call("GET", "/me", undefined, token);
    expect(me.json).toMatchObject({ rank: 15, totalRanked: 15, points: 42 });
  });
});

describe("activity bonus verification", () => {
  it("awards only for a verified on-chain tx; dedupes by signature; rejects forged / failed / foreign / old txs", async () => {
    const clock = new Clock(Date.parse(T0));
    const nowSec = Math.floor(clock.t / 1000);
    const ctx = await makeApp({ clock });
    const { call, txs } = ctx;
    const kp = Keypair.generate();
    const token = await signIn(call, kp);

    const wheel = fakeProgramTx({
      signer: kp,
      ix: "stake_daily",
      amountRaw: 1_000_000_000n,
      slot: 3001,
      blockTime: nowSec - 30,
    });
    txs.set(wheel.signature, wheel.response);
    const ok = await call("POST", "/bonus", { kind: "stake", signature: wheel.signature }, token);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ kind: "stake", gained: 10, total: 10 });
    expect(ok.json.verified.instruction).toBe("stake_daily");

    const replay = await call("POST", "/bonus", { kind: "stake", signature: wheel.signature }, token);
    expect(replay.status).toBe(409);
    expect(replay.json.error).toBe("replay");

    // someone else tries to claim my tx
    const thief = Keypair.generate();
    const thiefToken = await signIn(call, thief);
    const wheel2 = fakeProgramTx({
      signer: kp,
      ix: "stake_daily",
      amountRaw: 1_000_000_000n,
      slot: 3002,
      blockTime: nowSec - 30,
    });
    txs.set(wheel2.signature, wheel2.response);
    const stolen = await call("POST", "/bonus", { kind: "stake", signature: wheel2.signature }, thiefToken);
    expect(stolen.status).toBe(422);
    expect(stolen.json.error).toBe("no_matching_instruction");

    // wrong kind for the instruction (stake tx claimed as mint)
    const asMint = await call("POST", "/bonus", { kind: "mint", signature: wheel2.signature }, token);
    expect(asMint.status).toBe(422);

    // failed tx
    const failed = fakeProgramTx({ signer: kp, ix: "stake_daily", err: { InstructionError: [0, "Custom"] }, blockTime: nowSec });
    txs.set(failed.signature, failed.response);
    expect((await call("POST", "/bonus", { kind: "stake", signature: failed.signature }, token)).json.error).toBe(
      "tx_failed"
    );

    // right discriminator but a different program id
    const other = fakeProgramTx({
      signer: kp,
      ix: "stake_daily",
      programId: Keypair.generate().publicKey.toBase58(),
      blockTime: nowSec,
    });
    txs.set(other.signature, other.response);
    expect((await call("POST", "/bonus", { kind: "stake", signature: other.signature }, token)).status).toBe(422);

    // our program, but actor account is not a signer (wallet only referenced)
    const payer = Keypair.generate();
    const notSigner = fakeProgramTx({ signer: payer, actor: kp.publicKey, ix: "stake_daily", blockTime: nowSec });
    txs.set(notSigner.signature, notSigner.response);
    const ns = await call("POST", "/bonus", { kind: "stake", signature: notSigner.signature }, token);
    expect(ns.status).toBe(422);
    expect(ns.json.error).toBe("wallet_not_signer");

    // too old
    const old = fakeProgramTx({ signer: kp, ix: "stake_daily", blockTime: nowSec - 3 * 86400 });
    txs.set(old.signature, old.response);
    expect((await call("POST", "/bonus", { kind: "stake", signature: old.signature }, token)).json.error).toBe(
      "tx_too_old"
    );

    // mint without the NftMinted event proof → rejected
    const mintNoEvent = fakeProgramTx({ signer: kp, ix: "mint_nft", blockTime: nowSec });
    txs.set(mintNoEvent.signature, mintNoEvent.response);
    expect((await call("POST", "/bonus", { kind: "mint", signature: mintNoEvent.signature }, token)).json.error).toBe(
      "missing_event"
    );

    // unknown sig → retryable 404
    const unknown = fakeProgramTx({ signer: kp, ix: "stake_daily", blockTime: nowSec });
    const nf = await call("POST", "/bonus", { kind: "stake", signature: unknown.signature }, token);
    expect(nf.status).toBe(404);
    expect(nf.json.retryable).toBe(true);

    // valid stake + mint
    const stake = fakeProgramTx({ signer: kp, ix: "add_daily", blockTime: nowSec });
    txs.set(stake.signature, stake.response);
    expect((await call("POST", "/bonus", { kind: "stake", signature: stake.signature }, token)).json.gained).toBe(10);
    const nftMint = Keypair.generate().publicKey;
    const mint = fakeProgramTx({
      signer: kp,
      ix: "mint_nft",
      blockTime: nowSec,
      logs: [`Program ${PROGRAM_ID} invoke [1]`, nftMintedData(7, 2, kp.publicKey, nftMint), `Program ${PROGRAM_ID} success`],
    });
    txs.set(mint.signature, mint.response);
    expect((await call("POST", "/bonus", { kind: "mint", signature: mint.signature }, token)).json.gained).toBe(15);

    // bad inputs
    expect((await call("POST", "/bonus", { kind: "lofi", signature: stake.signature }, token)).status).toBe(400);
    expect((await call("POST", "/bonus", { kind: "stake", signature: "abc" }, token)).status).toBe(400);
    expect((await call("POST", "/bonus", { kind: "stake", signature: stake.signature })).status).toBe(401);

    const me = await call("GET", "/me", undefined, token);
    expect(me.json.points).toBe(10 + 10 + 15);
  });

  it("optional per-kind daily cap", async () => {
    const clock = new Clock(Date.parse(T0));
    const nowSec = Math.floor(clock.t / 1000);
    const ctx = await makeApp({ clock, env: { BONUS_DAILY_CAPS: '{"stake":1}' } });
    const kp = Keypair.generate();
    const token = await signIn(ctx.call, kp);
    const a = fakeProgramTx({ signer: kp, ix: "stake_daily", blockTime: nowSec });
    const b = fakeProgramTx({ signer: kp, ix: "stake_long", blockTime: nowSec });
    ctx.txs.set(a.signature, a.response);
    ctx.txs.set(b.signature, b.response);
    expect((await ctx.call("POST", "/bonus", { kind: "stake", signature: a.signature }, token)).status).toBe(200);
    const capped = await ctx.call("POST", "/bonus", { kind: "stake", signature: b.signature }, token);
    expect(capped.status).toBe(429);
    expect(capped.json.error).toBe("bonus_daily_cap");
  });
});

describe("audit API-03: default bonus caps + minimum amounts", () => {
  it("defaults are non-empty; '{}' disables; bad JSON / unknown kinds rejected", () => {
    const base = { NODE_ENV: "test", JWT_SECRET: "x".repeat(32) } as NodeJS.ProcessEnv;
    const c = loadConfig(base);
    expect(c.bonusDailyCaps).toEqual(DEFAULT_BONUS_DAILY_CAPS);
    expect(c.bonusMinAmountsRaw).toEqual({ stake: 1_000_000_000n, list: 100_000_000n });
    // retired kind "wheel" in an old env value is ignored, not fatal
    expect(loadConfig({ ...base, BONUS_DAILY_CAPS: '{"mint":10,"wheel":10}' }).bonusDailyCaps).toEqual({ mint: 10 });
    expect(loadConfig({ ...base, BONUS_DAILY_CAPS: "{}", BONUS_MIN_AMOUNTS: "{}" }).bonusDailyCaps).toEqual({});
    expect(() => loadConfig({ ...base, BONUS_DAILY_CAPS: "nope" })).toThrow(/JSON/);
    expect(() => loadConfig({ ...base, BONUS_DAILY_CAPS: '{"spam":1}' })).toThrow(/unknown kind/);
    expect(() => loadConfig({ ...base, BONUS_MIN_AMOUNTS: '{"stake":-1}' })).toThrow(/≥ 0/);
  });

  it("dust stake / list txs earn nothing; default stake cap (3/day) applies", async () => {
    const clock = new Clock(Date.parse(T0));
    const nowSec = Math.floor(clock.t / 1000);
    const ctx = await makeApp({ clock });
    const kp = Keypair.generate();
    const token = await signIn(ctx.call, kp);
    const dust = fakeProgramTx({ signer: kp, ix: "stake_daily", blockTime: nowSec, amountRaw: 999_999_999n });
    ctx.txs.set(dust.signature, dust.response);
    const r = await ctx.call("POST", "/bonus", { kind: "stake", signature: dust.signature }, token);
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("amount_too_small");
    const dustList = fakeProgramTx({ signer: kp, ix: "list_nft", blockTime: nowSec, amountRaw: 1n });
    ctx.txs.set(dustList.signature, dustList.response);
    expect((await ctx.call("POST", "/bonus", { kind: "list", signature: dustList.signature }, token)).json.error).toBe(
      "amount_too_small"
    );
    // exactly the minimum passes; 4th stake bonus of the day hits the default cap
    const ok: number[] = [];
    for (let i = 0; i < 4; i++) {
      const t = fakeProgramTx({ signer: kp, ix: "stake_daily", blockTime: nowSec, amountRaw: 1_000_000_000n, slot: 2000 + i });
      ctx.txs.set(t.signature, t.response);
      ok.push((await ctx.call("POST", "/bonus", { kind: "stake", signature: t.signature }, token)).status);
    }
    expect(ok).toEqual([200, 200, 200, 429]);
  });
});

describe("marketplace indexer + browse API", () => {
  it("ingests mint/list/buy/offer logs and serves /listings filters, sort, pagination + /nft/:mint", async () => {
    const clock = new Clock(Date.parse(T0));
    const ctx = await makeApp({ clock });
    const { db, call } = ctx;
    const seller = Keypair.generate().publicKey;
    const buyer = Keypair.generate().publicKey;
    const mints = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
    const rarities = [0, 1, 2, 3, 2];
    let slot = 100;
    const sig = () => Keypair.generate().publicKey.toBase58() + "x";
    const wrap = (lines: string[]) => [`Program ${PROGRAM_ID} invoke [1]`, ...lines, `Program ${PROGRAM_ID} success`];

    for (let i = 0; i < 5; i++) {
      await ingestTransaction(db, PROGRAM_ID, {
        signature: sig(),
        slot: slot++,
        logMessages: wrap([nftMintedData(i + 1, rarities[i], seller, mints[i])]),
      });
      await ingestTransaction(db, PROGRAM_ID, {
        signature: sig(),
        slot: slot++,
        logMessages: wrap([
          `Program log: list_nft: mint=${mints[i].toBase58()} seller=${seller.toBase58()} price=${(i + 1) * 1_000_000_000}`,
        ]),
      });
    }
    // failed tx must not change state
    await ingestTransaction(db, PROGRAM_ID, {
      signature: sig(),
      slot: slot++,
      err: { InstructionError: [0, "x"] },
      logMessages: wrap([`Program log: cancel_listing: mint=${mints[0].toBase58()} seller=${seller.toBase58()}`]),
    });
    // sale of #2, cancel of #4, offer on #1
    const buySig = sig();
    await ingestTransaction(db, PROGRAM_ID, {
      signature: buySig,
      slot: slot++,
      logMessages: wrap([
        `Program log: buy_nft: mint=${mints[1].toBase58()} buyer=${buyer.toBase58()} price=2000000000 fee=20000000 seller_net=1980000000`,
      ]),
    });
    // replay of the same signature is ignored
    expect(
      await ingestTransaction(db, PROGRAM_ID, { signature: buySig, slot: slot, logMessages: wrap([]) })
    ).toBe(0);
    await ingestTransaction(db, PROGRAM_ID, {
      signature: sig(),
      slot: slot++,
      logMessages: wrap([`Program log: cancel_listing: mint=${mints[3].toBase58()} seller=${seller.toBase58()}`]),
    });
    await ingestTransaction(db, PROGRAM_ID, {
      signature: sig(),
      slot: slot++,
      logMessages: wrap([`Program log: make_offer: mint=${mints[0].toBase58()} bidder=${buyer.toBase58()} amount=500000000`]),
    });
    // stale (older-slot) webhook replay of a list must not reactivate the cancelled listing
    await ingestTransaction(db, PROGRAM_ID, {
      signature: sig(),
      slot: 101,
      logMessages: wrap([`Program log: list_nft: mint=${mints[3].toBase58()} seller=${seller.toBase58()} price=1`]),
    });

    const all = await call("GET", "/listings");
    expect(all.json.total).toBe(3); // #1, #3, #5 active
    expect(all.json.items.map((i: any) => i.tokenId)).toEqual([1, 3, 5]); // price_asc
    expect(all.json.items[0]).toMatchObject({ priceUi: 1000, rarity: "common" });

    const desc = await call("GET", "/listings?sort=price_desc");
    expect(desc.json.items.map((i: any) => i.tokenId)).toEqual([5, 3, 1]);
    const rare = await call("GET", "/listings?rarity=rare");
    expect(rare.json.items.map((i: any) => i.tokenId)).toEqual([3, 5]);
    const range = await call("GET", "/listings?minPrice=2000&maxPrice=4000");
    expect(range.json.items.map((i: any) => i.tokenId)).toEqual([3]);
    const page = await call("GET", "/listings?limit=2&offset=2");
    expect(page.json).toMatchObject({ total: 3, limit: 2, offset: 2 });
    expect(page.json.items.map((i: any) => i.tokenId)).toEqual([5]);
    expect((await call("GET", "/listings?rarity=mythic")).status).toBe(400);
    expect((await call("GET", "/listings?sort=nope")).status).toBe(400);

    const sold = await call("GET", `/nft/${mints[1].toBase58()}`);
    expect(sold.json).toMatchObject({ tokenId: 2, rarity: "uncommon", owner: buyer.toBase58() });
    expect(sold.json.listing.active).toBe(false);
    expect(sold.json.trades[0]).toMatchObject({ kind: "buy", buyer: buyer.toBase58(), seller: seller.toBase58(), priceUi: 2000 });
    const withOffer = await call("GET", `/nft/${mints[0].toBase58()}`);
    expect(withOffer.json.offers).toEqual([
      expect.objectContaining({ bidder: buyer.toBase58(), amountRaw: "500000000" }),
    ]);
    expect((await call("GET", `/nft/${Keypair.generate().publicKey.toBase58()}`)).status).toBe(404);

    // GC-17 reveal flow: unrevealed mint (token 0 / rarity 255) is stored as NULL, then revealed.
    const late = Keypair.generate().publicKey;
    await ingestTransaction(db, PROGRAM_ID, { signature: sig(), slot: slot++, logMessages: wrap([nftMintedData(0, 255, seller, late)]) });
    expect((await call("GET", `/nft/${late.toBase58()}`)).json).toMatchObject({ tokenId: null, rarity: null });
    await ingestTransaction(db, PROGRAM_ID, { signature: sig(), slot: slot++, logMessages: wrap([nftRevealedData(late, 5, 77, 3)]) });
    expect((await call("GET", `/nft/${late.toBase58()}`)).json).toMatchObject({ tokenId: 77, rarity: "legendary" });
    // a replayed/late NftMinted must not un-reveal it
    await ingestTransaction(db, PROGRAM_ID, { signature: sig(), slot: slot++, logMessages: wrap([nftMintedData(0, 255, seller, late)]) });
    expect((await call("GET", `/nft/${late.toBase58()}`)).json).toMatchObject({ tokenId: 77, rarity: "legendary" });
  });
});

describe("audit: rate-limit key + webhook auth", () => {
  it("API-01: spoofed x-real-ip does not bypass the per-IP nonce limit unless TRUST_PROXY=1", async () => {
    const clock = new Clock(Date.parse(T0));
    const { app } = await makeApp({ clock });
    const wallet = Keypair.generate().publicKey.toBase58();
    const hit = (ipHdr: string) =>
      app.request("/auth/nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-real-ip": ipHdr },
        body: JSON.stringify({ wallet }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await hit(`10.0.0.${i}`)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429); // rotating the header no longer resets the bucket

    const proxied = await makeApp({ clock, env: { TRUST_PROXY: "1" } });
    const hitP = (ipHdr: string) =>
      proxied.app.request("/auth/nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ipHdr },
        body: JSON.stringify({ wallet }),
      });
    for (let i = 0; i < 30; i++) await hitP("1.1.1.1");
    expect((await hitP("1.1.1.1")).status).toBe(429);
    expect((await hitP("2.2.2.2")).status).toBe(200); // distinct real clients behind a trusted proxy
  });

  it("API-02: helius webhook requires the exact shared secret", async () => {
    const clock = new Clock(Date.parse(T0));
    const secret = "whsec-0123456789abcdef0123456789abcdef";
    const { app } = await makeApp({ clock, env: { HELIUS_WEBHOOK_SECRET: secret } });
    const post = (auth?: string) =>
      app.request("/webhooks/helius", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth !== undefined ? { authorization: auth } : {}) },
        body: "[]",
      });
    expect((await post()).status).toBe(401);
    expect((await post(secret.slice(0, -1))).status).toBe(401);
    expect((await post(secret + "x")).status).toBe(401);
    expect((await post(secret)).status).toBe(200);
  });
});

describe("auth (SIWS) multi-domain", () => {
  it("names the allowlisted site from Origin (vercel.app and custom domain), falls back to SIWS_DOMAIN otherwise", async () => {
    const clock = new Clock(Date.parse(T0));
    const { app } = await makeApp({
      clock,
      env: {
        SIWS_DOMAIN: "greencat-app.vercel.app",
        SIWS_URI: "https://greencat-app.vercel.app",
        SIWS_DOMAINS: "app.greencat69420.com",
      },
    });
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const nonceFrom = async (origin?: string) => {
      const res = await app.request("/auth/nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ wallet }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { nonce: string; message: string };
    };

    for (const host of ["app.greencat69420.com", "greencat-app.vercel.app"]) {
      const n = await nonceFrom(`https://${host}`);
      expect(n.message.split("\n")[0]).toBe(`${host} wants you to sign in with your Solana account:`);
      expect(n.message).toContain(`URI: https://${host}\n`);
      // signing that message still yields a session
      const sig = nacl.sign.detached(new TextEncoder().encode(n.message), kp.secretKey);
      const v = await app.request("/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: `https://${host}` },
        body: JSON.stringify({ wallet, nonce: n.nonce, signature: Buffer.from(sig).toString("base64") }),
      });
      expect(v.status).toBe(200);
    }

    // unknown / missing / malformed Origin → default domain + URI (never echo an arbitrary host)
    for (const origin of ["https://evil.example", undefined, "not a url", "https://app.greencat69420.com.evil.example"]) {
      const n = await nonceFrom(origin);
      expect(n.message.split("\n")[0]).toBe("greencat-app.vercel.app wants you to sign in with your Solana account:");
      expect(n.message).toContain("URI: https://greencat-app.vercel.app\n");
    }
  });

  it("SIWS_DOMAINS parsing: SIWS_DOMAIN first, trimmed, lowercased, deduped", () => {
    const cfg = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-test-secret-test-secret-000",
      SIWS_DOMAIN: "greencat-app.vercel.app",
      SIWS_DOMAINS: " App.GreenCat69420.com , greencat-app.vercel.app,,",
    } as NodeJS.ProcessEnv);
    expect(cfg.siwsDomains).toEqual(["greencat-app.vercel.app", "app.greencat69420.com"]);
  });
});

describe("auth (SIWS) Phantom compatibility", () => {
  const env = {
    SIWS_DOMAIN: "greencat-app.vercel.app",
    SIWS_URI: "https://greencat-app.vercel.app",
    SIWS_DOMAINS: "app.greencat69420.com",
    RPC_URL: "https://api.devnet.solana.com",
  };
  const nonceFor = async (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, wallet: string) => {
    const res = await app.request("/auth/nonce", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.greencat69420.com" },
      body: JSON.stringify({ wallet }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { nonce: string; message: string; input: import("@solana/wallet-standard-features").SolanaSignInInput };
  };
  const verify = (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, body: unknown) =>
    app.request("/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.greencat69420.com" },
      body: JSON.stringify(body),
    });

  it("message passes Phantom's strict SIWS rules (chain id devnet, ASCII, field order) and parses with wallet-standard-util", async () => {
    const { phantomSiwsProblems } = await import("@greencat/sdk");
    const { parseSignInMessageText } = await import("@solana/wallet-standard-util");
    const clock = new Clock(Date.parse(T0));
    const { app } = await makeApp({ clock, env });
    const wallet = Keypair.generate().publicKey.toBase58();
    const n = await nonceFor(app, wallet);
    expect(phantomSiwsProblems(n.message)).toEqual([]);
    expect(n.message).toContain("\nChain ID: devnet\n");
    expect(n.message).not.toContain("Chain ID: solana");
    const p = parseSignInMessageText(n.message);
    expect(p).toMatchObject({
      domain: "app.greencat69420.com",
      address: wallet,
      uri: "https://app.greencat69420.com",
      version: "1",
      chainId: "devnet",
      nonce: n.nonce,
    });
    // the signIn input carries exactly the same fields
    expect(n.input).toMatchObject({ domain: p!.domain, address: wallet, statement: p!.statement, chainId: "devnet", nonce: n.nonce });
  });

  it("Wallet Standard signIn: wallet-built SIWS text + signature → session; tampered / foreign message rejected", async () => {
    const { createSignInMessageText, verifySignIn } = await import("@solana/wallet-standard-util");
    const clock = new Clock(Date.parse(T0));
    const { app } = await makeApp({ clock, env });
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();

    // what Phantom's signIn does: build the text from the input (reference impl), sign it
    const n = await nonceFor(app, wallet);
    const text = createSignInMessageText({ ...n.input, address: wallet, domain: n.input.domain! });
    expect(text).toBe(n.message); // byte-identical to what we'd ask signMessage to sign
    const signedMessage = new TextEncoder().encode(text);
    const signature = nacl.sign.detached(signedMessage, kp.secretKey);
    expect(
      verifySignIn(n.input, {
        account: { address: wallet, publicKey: kp.publicKey.toBytes(), chains: [], features: [] },
        signedMessage,
        signature,
      })
    ).toBe(true);
    const ok = await verify(app, {
      wallet,
      nonce: n.nonce,
      signature: Buffer.from(signature).toString("base64"),
      signedMessage: Buffer.from(signedMessage).toString("base64"),
    });
    expect(ok.status).toBe(200);

    // wallet appended a trailing newline (formatting only) → still fine
    const n2 = await nonceFor(app, wallet);
    const sm2 = new TextEncoder().encode(n2.message + "\n");
    const ok2 = await verify(app, {
      wallet,
      nonce: n2.nonce,
      signature: Buffer.from(nacl.sign.detached(sm2, kp.secretKey)).toString("base64"),
      signedMessage: Buffer.from(sm2).toString("base64"),
    });
    expect(ok2.status).toBe(200);

    // different domain in the signed text (phishing site relaying our nonce) → rejected even with a valid signature
    const n3 = await nonceFor(app, wallet);
    const evil = new TextEncoder().encode(n3.message.replace(/app\.greencat69420\.com/g, "evil.example"));
    const bad = await verify(app, {
      wallet,
      nonce: n3.nonce,
      signature: Buffer.from(nacl.sign.detached(evil, kp.secretKey)).toString("base64"),
      signedMessage: Buffer.from(evil).toString("base64"),
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: string }).error).toBe("bad_message");

    // signature over a different text than signedMessage → bad_signature
    const sigOfOther = nacl.sign.detached(new TextEncoder().encode("hello"), kp.secretKey);
    const bad2 = await verify(app, {
      wallet,
      nonce: n3.nonce,
      signature: Buffer.from(sigOfOther).toString("base64"),
      signedMessage: Buffer.from(new TextEncoder().encode(n3.message)).toString("base64"),
    });
    expect(bad2.status).toBe(401);
    expect(((await bad2.json()) as { error: string }).error).toBe("bad_signature");

    // garbage signedMessage → 400
    expect((await verify(app, { wallet, nonce: n3.nonce, signature: Buffer.from(sigOfOther).toString("base64"), signedMessage: "%%%" })).status).toBe(400);
  });

  it("chain id: SIWS_CHAIN_ID wins, else derived from SOLANA_NETWORK / RPC_URL", () => {
    const base = { NODE_ENV: "test", JWT_SECRET: "test-secret-test-secret-test-secret-000" };
    expect(loadConfig({ ...base, RPC_URL: "https://api.devnet.solana.com" } as NodeJS.ProcessEnv).siwsChainId).toBe("devnet");
    expect(loadConfig({ ...base, RPC_URL: "https://devnet.helius-rpc.com/?api-key=x" } as NodeJS.ProcessEnv).siwsChainId).toBe("devnet");
    expect(loadConfig({ ...base, RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x" } as NodeJS.ProcessEnv).siwsChainId).toBe("mainnet");
    expect(loadConfig({ ...base, RPC_URL: "https://x.example", SIWS_CHAIN_ID: "devnet" } as NodeJS.ProcessEnv).siwsChainId).toBe("devnet");
    expect(loadConfig({ ...base, RPC_URL: "https://x.example", SIWS_CHAIN_ID: "solana" } as NodeJS.ProcessEnv).siwsChainId).toBe("mainnet");
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).siwsChainId).toBe("localnet");
  });
});
