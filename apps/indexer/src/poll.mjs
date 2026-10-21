#!/usr/bin/env node
/**
 * Local RPC poller for greencat marketplace logs.
 * No Helius key required. See docs/INDEXER.md and .env.example.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  parseMarketplaceLogs,
  applyEvents,
  activeListingsSorted,
} from "./parseLogs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
const PROGRAM_ID =
  process.env.GREENCAT_PROGRAM_ID ||
  "8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE";
const DB_PATH =
  process.env.INDEXER_DB_PATH || path.join(ROOT, "data", "listings.json");
const POLL_MS = Number(process.env.POLL_MS || 2000);
const ONCE = process.argv.includes("--once");

if (process.env.HELIUS_API_KEY) {
  console.log(
    "[indexer] HELIUS_API_KEY is set but this stub uses plain RPC polling only. See docs/INDEXER.md for webhook wiring."
  );
}

function loadStore() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    }
  } catch (e) {
    console.warn("[indexer] could not load store:", e.message);
  }
  return {
    listings: {},
    offers: {},
    trades: [],
    cursor: { lastSig: null },
    updatedAt: null,
  };
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2) + "\n");
}

async function pollOnce(connection, programId, store) {
  const until = store.cursor?.lastSig || undefined;
  const sigs = await connection.getSignaturesForAddress(programId, {
    limit: 25,
    ...(until ? { until } : {}),
  });
  const ordered = [...sigs].reverse();
  let applied = 0;
  for (const s of ordered) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const events = parseMarketplaceLogs(tx?.meta?.logMessages);
    if (events.length) {
      applyEvents(store, events, { sig: s.signature, slot: s.slot });
      applied += events.length;
    }
  }
  if (sigs.length) {
    store.cursor = { lastSig: sigs[0].signature };
  }
  return applied;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const programId = new PublicKey(PROGRAM_ID);
  const store = loadStore();

  console.log(
    `[indexer] RPC=${RPC_URL} program=${PROGRAM_ID} db=${DB_PATH} pollMs=${POLL_MS}`
  );

  const run = async () => {
    try {
      const n = await pollOnce(connection, programId, store);
      saveStore(store);
      const active = activeListingsSorted(store);
      if (n > 0 || ONCE) {
        console.log(
          `[indexer] events+=${n} activeListings=${active.length} trades=${store.trades.length}`
        );
        if (ONCE && active.length) {
          console.log(JSON.stringify(active.slice(0, 5), null, 2));
        }
      }
    } catch (e) {
      console.error("[indexer] poll error:", e.message || e);
    }
  };

  await run();
  if (ONCE) return;
  setInterval(run, POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
