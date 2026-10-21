/**
 * Marketplace indexer loop.
 *  - poll mode: getSignaturesForAddress(programId, {until: cursor}) paginated → getTransaction → ingest
 *  - ws mode:   logsSubscribe(programId) (standard / Helius-compatible websocket) triggers an
 *               immediate poll; a slower poll timer remains as a safety net.
 * Also fills missing rarity/token id for listed NFTs from the on-chain NftRecord PDA.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeNftRecordAccount, deriveNftRecordPda } from "@greencat/sdk";
import type { Db } from "../db";
import { ingestTransaction } from "./store";

export type IndexerOptions = {
  db: Db;
  connection: Connection;
  programId: string;
  pageSize?: number;
  backfillMax?: number;
  log?: (msg: string) => void;
};

export async function getCursor(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ last_sig: string | null }>("SELECT last_sig FROM indexer_cursor WHERE id = 1");
  return rows[0]?.last_sig ?? null;
}

async function setCursor(db: Db, sig: string, slot: number) {
  await db.query(
    `INSERT INTO indexer_cursor (id, last_sig, last_slot, updated_at) VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET last_sig = EXCLUDED.last_sig, last_slot = EXCLUDED.last_slot, updated_at = now()`,
    [sig, slot]
  );
}

/** One poll pass. Returns counts. Safe to call concurrently-guarded by caller. */
export async function pollOnce(opts: IndexerOptions): Promise<{ txs: number; events: number }> {
  const { db, connection } = opts;
  const programPk = new PublicKey(opts.programId);
  const pageSize = opts.pageSize ?? 100;
  const max = opts.backfillMax ?? 5000;
  const until = (await getCursor(db)) ?? undefined;

  // Walk backwards from newest until we hit the cursor (or backfill limit).
  const collected: { signature: string; slot: number; err: unknown; blockTime?: number | null }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await connection.getSignaturesForAddress(
      programPk,
      { limit: pageSize, before, until },
      "confirmed"
    );
    collected.push(...page);
    if (page.length < pageSize || collected.length >= max) break;
    before = page[page.length - 1].signature;
  }
  collected.reverse(); // oldest → newest

  let txs = 0;
  let events = 0;
  const listedMints = new Set<string>();
  for (const s of collected) {
    let logs: string[] | null | undefined = null;
    if (!s.err) {
      const tx = await connection.getTransaction(s.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) break; // not yet available — stop; retry next pass without advancing the cursor
      logs = tx.meta?.logMessages;
      for (const l of logs ?? []) {
        const m = /list_nft: mint=(\w+)/.exec(l);
        if (m) listedMints.add(m[1]);
      }
    }
    events += await ingestTransaction(db, opts.programId, {
      signature: s.signature,
      slot: s.slot,
      blockTime: s.blockTime,
      err: s.err,
      logMessages: logs,
    });
    await setCursor(db, s.signature, s.slot);
    txs += 1;
  }
  if (listedMints.size) await fillNftRecords(opts, [...listedMints]);
  return { txs, events };
}

/** For listings whose mint event we never saw, read NftRecord PDA for token id + rarity. */
export async function fillNftRecords(opts: IndexerOptions, mints: string[]) {
  const { db, connection } = opts;
  const programPk = new PublicKey(opts.programId);
  const { rows } = await db.query<{ mint: string }>(
    "SELECT mint FROM nfts WHERE mint = ANY($1::text[]) AND token_id IS NOT NULL",
    [mints]
  );
  const known = new Set(rows.map((r) => r.mint));
  for (const mint of mints) {
    if (known.has(mint)) continue;
    try {
      const [pda] = deriveNftRecordPda(new PublicKey(mint), programPk);
      const info = await connection.getAccountInfo(pda, "confirmed");
      if (!info || !info.owner.equals(programPk)) continue;
      const rec = decodeNftRecordAccount(Buffer.from(info.data));
      if (!rec || rec.mint !== mint) continue;
      await db.query(
        `INSERT INTO nfts (mint, token_id, rarity, minter) VALUES ($1, $2, $3, $4)
         ON CONFLICT (mint) DO UPDATE SET token_id = EXCLUDED.token_id, rarity = EXCLUDED.rarity,
           minter = COALESCE(nfts.minter, EXCLUDED.minter), updated_at = now()`,
        [mint, rec.tokenId, rec.rarity, rec.buyer]
      );
    } catch (e) {
      opts.log?.(`[indexer] nft_record ${mint}: ${(e as Error).message}`);
    }
  }
}

export function startIndexer(
  opts: IndexerOptions & { mode: "poll" | "ws"; pollMs: number; safetyPollMs?: number }
): { stop: () => Promise<void>; kick: () => void } {
  const log = opts.log ?? ((m: string) => console.log(m));
  let running = false;
  let again = false;
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const r = await pollOnce(opts);
        if (r.txs) log(`[indexer] txs+=${r.txs} events+=${r.events}`);
      } while (again && !stopped);
    } catch (e) {
      log(`[indexer] poll error: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  let subId: number | null = null;
  if (opts.mode === "ws") {
    subId = opts.connection.onLogs(new PublicKey(opts.programId), () => void run(), "confirmed");
    log("[indexer] ws logsSubscribe active");
  }
  const interval = opts.mode === "ws" ? opts.safetyPollMs ?? 300_000 : opts.pollMs;
  const timer = setInterval(() => void run(), interval);
  void run();
  return {
    kick: () => void run(),
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (subId !== null) await opts.connection.removeOnLogsListener(subId).catch(() => undefined);
    },
  };
}
