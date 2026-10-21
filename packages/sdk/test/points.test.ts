import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  applyDailyClaim,
  applyLofiHeartbeat,
  awardActivityPoints,
  buildLeaderboard,
  effectiveStreak,
  emptyPointsState,
  migratePointsFields,
  nextPointsResetDate,
  vancouverDateKey,
  vancouverMonthKey,
  POINTS_BONUS,
  type PointsWalletState,
} from "../src/points";
import { parseProgramLogs } from "../src/marketplaceLogs";
import { NFT_MINTED_EVENT_DISC } from "../src/instructions";
import { buildSignInMessage } from "../src/siws";

const W = "8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE";

function fresh(month = "2026-09"): PointsWalletState {
  return { ...emptyPointsState(W), pointsMonth: month };
}

describe("Vancouver day boundary", () => {
  it("PDT: 06:59:59Z is still the previous Vancouver day, 07:00Z is the next", () => {
    expect(vancouverDateKey(new Date("2026-09-27T06:59:59Z"))).toBe("2026-09-26");
    expect(vancouverDateKey(new Date("2026-09-27T07:00:00Z"))).toBe("2026-09-27");
  });
  it("PST (after DST ends): boundary moves to 08:00Z", () => {
    expect(vancouverDateKey(new Date("2026-12-01T07:59:59Z"))).toBe("2026-11-30");
    expect(vancouverDateKey(new Date("2026-12-01T08:00:00Z"))).toBe("2026-12-01");
  });
  it("month key + next reset follow Vancouver, not UTC", () => {
    // 2026-10-01T03:00Z is still Sept 30 in Vancouver
    expect(vancouverMonthKey(new Date("2026-10-01T03:00:00Z"))).toBe("2026-09");
    expect(nextPointsResetDate(new Date("2026-10-01T03:00:00Z"))).toBe("2026-10-01");
    expect(nextPointsResetDate(new Date("2026-12-15T12:00:00Z"))).toBe("2027-01-01");
  });
});

describe("daily claim + streaks", () => {
  it("once per day", () => {
    const a = applyDailyClaim(fresh(), 50, { today: "2026-09-10", month: "2026-09" });
    expect(a.gained).toBe(50);
    const b = applyDailyClaim(a.user, 99, { today: "2026-09-10", month: "2026-09" });
    expect(b.gained).toBe(0);
    expect(b.user.points).toBe(50);
  });

  it("consecutive days extend streak; a missed day resets to 1", () => {
    let u = fresh();
    u = applyDailyClaim(u, 1, { today: "2026-09-10", month: "2026-09" }).user;
    u = applyDailyClaim(u, 1, { today: "2026-09-11", month: "2026-09" }).user;
    expect(u.streak).toBe(2);
    expect(effectiveStreak(u, "2026-09-12")).toBe(2); // yesterday still counts
    expect(effectiveStreak(u, "2026-09-13")).toBe(0); // broken
    const r = applyDailyClaim(u, 1, { today: "2026-09-13", month: "2026-09" });
    expect(r.streak).toBe(1);
    expect(r.user.streakMilestonesAwarded).toEqual([]);
  });

  it("milestones 3/7/30 award +10/+25/+100 once per streak, and again after a break", () => {
    let u = fresh();
    const gains: number[] = [];
    const bonuses: number[] = [];
    for (let d = 1; d <= 30; d++) {
      const day = `2026-09-${String(d).padStart(2, "0")}`;
      const r = applyDailyClaim(u, 1, { today: day, month: "2026-09" });
      gains.push(r.gained);
      bonuses.push(r.milestoneBonus);
      u = r.user;
    }
    expect(bonuses[2]).toBe(10);
    expect(bonuses[6]).toBe(25);
    expect(bonuses[29]).toBe(100);
    expect(bonuses.reduce((a, b) => a + b, 0)).toBe(135);
    expect(u.points).toBe(30 + 135);
    // break then 3 more days → +10 again
    let v = u;
    for (const day of ["2026-10-05", "2026-10-06", "2026-10-07"]) {
      v = applyDailyClaim(v, 1, { today: day, month: "2026-10" }).user;
    }
    expect(v.streak).toBe(3);
    expect(v.points).toBe(3 + 10);
  });

  it("monthly reset zeroes points but keeps streak", () => {
    let u = fresh("2026-09");
    u = applyDailyClaim(u, 80, { today: "2026-09-29", month: "2026-09" }).user;
    u = applyDailyClaim(u, 80, { today: "2026-09-30", month: "2026-09" }).user;
    expect(u.points).toBe(160);
    const migrated = migratePointsFields(u, "2026-10");
    expect(migrated.points).toBe(0);
    expect(migrated.streak).toBe(2);
    const r = applyDailyClaim(migrated, 5, { today: "2026-10-01", month: "2026-10" });
    expect(r.streak).toBe(3);
    expect(r.milestoneBonus).toBe(10);
    expect(r.user.points).toBe(15);
  });
});

describe("activity bonuses + lo-fi", () => {
  it("amounts", () => {
    const u = fresh();
    expect(awardActivityPoints(u, "mint", { today: "2026-09-01", month: "2026-09" }).gained).toBe(15);
    expect(awardActivityPoints(u, "stake", { today: "2026-09-01", month: "2026-09" }).gained).toBe(10);
    expect(awardActivityPoints(u, "list", { today: "2026-09-01", month: "2026-09" }).gained).toBe(10);
    expect(awardActivityPoints(u, "wheel", { today: "2026-09-01", month: "2026-09" }).gained).toBe(5);
  });

  it("lo-fi heartbeat: ≤1 point per 60s, requires continuous session, cap 10/day, resets next day", () => {
    const t0 = Date.parse("2026-09-26T18:00:00Z");
    let u = fresh();
    let r = applyLofiHeartbeat(u, t0);
    expect(r.status).toBe("started");
    expect(r.gained).toBe(0);
    u = r.user;
    // spam heartbeats every second for 59s → nothing
    for (let s = 1; s < 60; s++) {
      r = applyLofiHeartbeat(u, t0 + s * 1000);
      expect(r.gained).toBe(0);
      u = r.user;
    }
    r = applyLofiHeartbeat(u, t0 + 60_000);
    expect(r.status).toBe("tick");
    expect(r.gained).toBe(1);
    u = r.user;
    // gap > 90s → session restarts, no point
    r = applyLofiHeartbeat(u, t0 + 60_000 + 200_000);
    expect(r.status).toBe("started");
    expect(r.gained).toBe(0);
    u = r.user;
    // listen long enough for many intervals, heartbeat every 15s
    let t = t0 + 260_000;
    let total = 1;
    for (let i = 0; i < 4 * 30; i++) {
      t += 15_000;
      r = applyLofiHeartbeat(u, t);
      total += r.gained;
      u = r.user;
    }
    expect(total).toBe(POINTS_BONUS.lofiDailyCap);
    expect(r.status).toBe("capped");
    expect(u.lofiPointsToday).toBe(10);
    // next Vancouver day: cap resets
    const tomorrow = Date.parse("2026-09-27T18:00:00Z");
    r = applyLofiHeartbeat(u, tomorrow);
    expect(r.status).toBe("started");
    r = applyLofiHeartbeat(r.user, tomorrow + 60_000);
    expect(r.gained).toBe(1);
    expect(r.lofiToday).toBe(1);
  });
});

describe("leaderboard", () => {
  it("ranks everyone; ties broken by wallet asc", () => {
    const rows = buildLeaderboard(
      [
        { wallet: "B", points: 10, pointsMonth: "2026-09" },
        { wallet: "A", points: 10, pointsMonth: "2026-09" },
        { wallet: "C", points: 30, pointsMonth: "2026-09" },
        { wallet: "D", points: 99, pointsMonth: "2026-08" }, // stale month → 0
      ],
      { month: "2026-09", today: "2026-09-26" }
    );
    expect(rows.map((r) => [r.wallet, r.rank, r.points])).toEqual([
      ["C", 1, 30],
      ["A", 2, 10],
      ["B", 3, 10],
      ["D", 4, 0],
    ]);
  });
});

describe("program log parsing", () => {
  const PID = "8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE";
  const EVIL = "Evi1111111111111111111111111111111111111111";
  it("parses marketplace msg! lines + NftMinted event from our program frame only", () => {
    const buyer = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const ev = Buffer.alloc(8 + 2 + 1 + 64);
    NFT_MINTED_EVENT_DISC.copy(ev, 0);
    ev.writeUInt16LE(42, 8);
    ev[10] = 3;
    buyer.toBuffer().copy(ev, 11);
    mint.toBuffer().copy(ev, 43);
    const logs = [
      `Program ${PID} invoke [1]`,
      `Program log: Instruction: MintNft`,
      `Program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s invoke [2]`,
      `Program log: list_nft: mint=${mint.toBase58()} seller=${buyer.toBase58()} price=1`, // CPI frame → ignored
      `Program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s success`,
      `Program data: ${ev.toString("base64")}`,
      `Program log: list_nft: mint=${mint.toBase58()} seller=${buyer.toBase58()} price=5000000`,
      `Program ${PID} success`,
      `Program ${EVIL} invoke [1]`,
      `Program log: buy_nft: mint=${mint.toBase58()} buyer=${buyer.toBase58()} price=1 fee=0 seller_net=1`,
      `Program ${EVIL} success`,
    ];
    const events = parseProgramLogs(logs, PID);
    expect(events).toEqual([
      { type: "nft_minted", tokenId: 42, rarity: 3, buyer: buyer.toBase58(), nftMint: mint.toBase58() },
      { type: "list_nft", nftMint: mint.toBase58(), seller: buyer.toBase58(), priceRaw: "5000000" },
    ]);
    expect(new PublicKey(buyer).toBase58()).toBe(buyer.toBase58());
  });
});

describe("SIWS message", () => {
  it("is deterministic", () => {
    const m = buildSignInMessage({
      domain: "localhost:3001",
      wallet: W,
      nonce: "abc",
      issuedAt: "2026-09-26T00:00:00.000Z",
      expirationTime: "2026-09-26T00:05:00.000Z",
      uri: "http://localhost:8787",
    });
    expect(m.split("\n")[0]).toBe("localhost:3001 wants you to sign in with your Solana account:");
    expect(m).toContain("Nonce: abc");
  });
});
