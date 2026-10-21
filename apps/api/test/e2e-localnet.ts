/**
 * Localnet end-to-end (audit round 2): solana-test-validator with greencat (upgradeable),
 * ORAO VRF + Token Metadata fixtures → init (upgrade authority) → stake_daily → API /bonus
 * verifies the stake tx via real RPC → replay / wrong kind / dust / foreign wallet rejected →
 * indexer polls program history. (The wheel flow was removed Oct 12, 2026 with the wheel.)
 *
 *   npm run test:e2e --workspace=@greencat/api
 *
 * Env: E2E_RPC_PORT (default 18899), SOLANA_BIN. Uses only localnet airdrops — no real SOL.
 */
import { serve } from "@hono/node-server";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  mintTo,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import {
  GreenCatApiClient,
  ApiError,
  PoolId,
  buildDepositTreasuryIx,
  buildStakeDailyIx,
} from "@greencat/sdk";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { migrate, openDb } from "../src/db";
import { pollOnce } from "../src/indexer/worker";
import { PID, airdrop, assert, initOrao, initProgram, sendIxs, startLocalnet } from "./localnet";

const UI = 1_000_000n;

async function main() {
  const ln = await startLocalnet({ port: Number(process.env.E2E_RPC_PORT || 18899), tag: "e2e" });
  const { conn, rpcUrl } = ln;
  let httpServer: ReturnType<typeof serve> | null = null;
  try {
    const admin = ln.upgradeAuthority;
    const player = Keypair.generate();
    await airdrop(conn, player.publicKey, 20);
    await initOrao(conn, admin);

    const gcMint = await createMint(conn, admin, admin.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
    const adminAta = await createAssociatedTokenAccountIdempotent(conn, admin, gcMint, admin.publicKey, {}, TOKEN_PROGRAM_ID);
    const playerAta = await createAssociatedTokenAccountIdempotent(conn, admin, gcMint, player.publicKey, {}, TOKEN_PROGRAM_ID);
    await mintTo(conn, admin, gcMint, adminAta, admin, Number(100_000n * UI), [], undefined, TOKEN_PROGRAM_ID);
    await mintTo(conn, admin, gcMint, playerAta, admin, Number(200_000n * UI), [], undefined, TOKEN_PROGRAM_ID);
    await initProgram(ln, gcMint, TOKEN_PROGRAM_ID, { collection: false });
    await sendIxs(conn, [admin], [
      buildDepositTreasuryIx({
        depositor: admin.publicKey,
        depositorAta: adminAta,
        gcMint,
        poolId: PoolId.DailyRewards,
        amountRaw: 50_000n * UI,
        tokenProgramId: TOKEN_PROGRAM_ID,
      }),
    ]);
    console.log("[e2e] treasuries initialized by the upgrade authority + daily rewards pool funded");

    const stakeSig = await sendIxs(conn, [player], [
      buildStakeDailyIx({ staker: player.publicKey, gcMint, stakerAta: playerAta, amountRaw: 1_000n * UI, tokenProgramId: TOKEN_PROGRAM_ID }),
    ]);
    console.log(`[e2e] stake_daily ${stakeSig.slice(0, 12)}…`);

    // ── API (real HTTP) against the same RPC ──
    const db = await openDb("pglite:memory");
    await migrate(db);
    const cfg = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret-00000",
      RPC_URL: rpcUrl,
      GREENCAT_PROGRAM_ID: PID.toBase58(),
    } as NodeJS.ProcessEnv);
    const app = createApp({ db, config: cfg });
    const port: number = await new Promise((resolve) => {
      httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
    });
    const client = new GreenCatApiClient(`http://127.0.0.1:${port}`);
    await client.signIn(player.publicKey.toBase58(), async (m) => nacl.sign.detached(m, player.secretKey));
    console.log("[e2e] SIWS sign-in OK");

    try {
      await client.bonus("mint", stakeSig);
      throw new Error("kind mismatch should fail");
    } catch (e) {
      assert(e instanceof ApiError && e.status === 422, `kind mismatch rejected (${String(e)})`);
    }
    const b2 = await client.bonusWithRetry("stake", stakeSig);
    assert(b2.gained === 10, "stake bonus");
    console.log(`[e2e] /bonus stake verified: +${b2.gained}; wrong-kind claim rejected (422)`);
    try {
      await client.bonus("stake", stakeSig);
      throw new Error("replay should have failed");
    } catch (e) {
      assert(e instanceof ApiError && e.status === 409 && e.code === "replay", `replay rejected (${String(e)})`);
    }
    console.log("[e2e] replay of same signature rejected (409)");

    // API-03: a dust stake (below the 1000 GC default minimum) earns nothing
    const dust = await sendIxs(conn, [player], [
      buildStakeDailyIx({ staker: player.publicKey, gcMint, stakerAta: playerAta, amountRaw: 1n * UI, tokenProgramId: TOKEN_PROGRAM_ID }),
    ]);
    try {
      await client.bonusWithRetry("stake", dust);
      throw new Error("dust stake should fail");
    } catch (e) {
      assert(e instanceof ApiError && e.status === 422 && e.code === "amount_too_small", `dust rejected (${String(e)})`);
    }
    console.log("[e2e] API-03: 1 GC add-stake rejected for bonus (amount_too_small)");

    const thief = Keypair.generate();
    const thiefClient = new GreenCatApiClient(`http://127.0.0.1:${port}`);
    await thiefClient.signIn(thief.publicKey.toBase58(), async (m) => nacl.sign.detached(m, thief.secretKey));
    const stake2 = await sendIxs(conn, [player], [
      buildStakeDailyIx({ staker: player.publicKey, gcMint, stakerAta: playerAta, amountRaw: 2_000n * UI, tokenProgramId: TOKEN_PROGRAM_ID }),
    ]);
    try {
      await thiefClient.bonus("stake", stake2);
      throw new Error("thief should fail");
    } catch (e) {
      assert(e instanceof ApiError && e.status === 422, `foreign wallet rejected (${String(e)})`);
    }
    console.log("[e2e] other wallet claiming player's tx rejected (422)");

    const me = await client.me();
    assert(me.points === 10 && me.rank === 1, `me ${JSON.stringify(me)}`);
    const lb = await client.leaderboard();
    assert(lb.total === 1 && lb.top[0].wallet === player.publicKey.toBase58(), "leaderboard");
    console.log(`[e2e] /me points=${me.points} rank=${me.rank}; /leaderboard total=${lb.total}`);

    const r = await pollOnce({ db, connection: conn, programId: PID.toBase58() });
    const { rows } = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM indexed_txs");
    assert(r.txs >= 4 && Number(rows[0].n) === r.txs, `indexer indexed ${r.txs}`);
    const again = await pollOnce({ db, connection: conn, programId: PID.toBase58() });
    assert(again.txs === 0, "cursor advanced");
    console.log(`[e2e] indexer poll: ${r.txs} program txs indexed; second poll no-op`);

    await db.close();
    void PublicKey;
    console.log("E2E PASS");
  } finally {
    (httpServer as { close?: () => void } | null)?.close?.();
    ln.stop();
  }
}

main()
  .then(() => process.exit(0)) // web3.js websocket reconnect timers would keep the process alive
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
