import { loadDotEnv } from "./env";
loadDotEnv();
import { Connection } from "@solana/web3.js";
import { loadConfig, redactUrl } from "./config";
import { migrate, openDb } from "./db";
import { pollOnce, startIndexer } from "./indexer/worker";
import { MarketPoints, startPointsSettler } from "./points/market";

const config = loadConfig();
const db = await openDb(config.databaseUrl);
await migrate(db);
const connection = new Connection(config.rpcUrl, {
  commitment: "confirmed",
  wsEndpoint: config.rpcWsUrl,
});
const opts = {
  db,
  connection,
  programId: config.programId,
  pageSize: config.indexerPageSize,
  backfillMax: config.indexerBackfillMax,
};
console.log(`[worker] rpc=${redactUrl(config.rpcUrl)} program=${config.programId} db=${db.kind} mode=${config.indexerMode}`);

if (process.argv.includes("--once")) {
  const r = await pollOnce(opts);
  const s = await new MarketPoints(db, config.marketPoints).settle();
  console.log(`[worker] once: txs=${r.txs} events=${r.events} points=${JSON.stringify(s)}`);
  await db.close();
} else {
  const idx = startIndexer({ ...opts, mode: config.indexerMode, pollMs: config.pollMs, safetyPollMs: config.safetyPollMs });
  const settler = startPointsSettler(new MarketPoints(db, config.marketPoints), config.pointsSettleMs);
  const stop = async () => {
    await settler.stop();
    await idx.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}
