import { loadDotEnv } from "./env";
loadDotEnv();
import { loadConfig } from "./config";
import { migrate, openDb } from "./db";

const cfg = loadConfig();
const db = await openDb(cfg.databaseUrl);
const applied = await migrate(db);
console.log(`[migrate] ${db.kind}: applied ${applied.length ? applied.join(", ") : "nothing (up to date)"}`);
await db.close();
