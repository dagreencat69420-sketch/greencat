import { loadDotEnv } from "./env";
loadDotEnv();
import { serve } from "@hono/node-server";
import { Connection } from "@solana/web3.js";
import { createApp } from "./app";
import { loadConfig, redactUrl } from "./config";
import { migrate, openDb } from "./db";
import { startIndexer } from "./indexer/worker";
import { MarketPoints, startPointsSettler } from "./points/market";

const config = loadConfig();
const db = await openDb(config.databaseUrl);
const applied = await migrate(db);
if (applied.length) console.log(`[api] migrations applied: ${applied.join(", ")}`);
if (config.jwtSecretIsEphemeral) {
  console.warn("[api] JWT_SECRET not set — using an ephemeral dev secret (sessions reset on restart)");
}

const app = createApp({ db, config });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `[api] listening on :${info.port} db=${db.kind} rpc=${redactUrl(config.rpcUrl)} program=${config.programId} cors=${config.corsOrigins.join(",")}`
  );
});

let indexer: { stop: () => Promise<void> } | null = null;
if (config.runIndexer) {
  const connection = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: config.rpcWsUrl,
  });
  indexer = startIndexer({
    db,
    connection,
    programId: config.programId,
    mode: config.indexerMode,
    pollMs: config.pollMs,
    safetyPollMs: config.safetyPollMs,
    pageSize: config.indexerPageSize,
    backfillMax: config.indexerBackfillMax,
  });
  console.log(`[api] in-process indexer started (${config.indexerMode})`);
}

// Credits deferred listing points + wash-trade-limited sale points from indexed state.
const settler = startPointsSettler(new MarketPoints(db, config.marketPoints), config.pointsSettleMs);

const shutdown = async () => {
  await settler.stop();
  await indexer?.stop();
  server.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
