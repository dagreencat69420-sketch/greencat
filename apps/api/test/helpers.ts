import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { IX_DISCRIMINATORS, NFT_MINTED_EVENT_DISC, NFT_REVEALED_EVENT_DISC } from "@greencat/sdk";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { migrate, openDb, type Db } from "../src/db";

export const PROGRAM_ID = "8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE";

export class Clock {
  constructor(public t: number) {}
  now = () => new Date(this.t);
  set(iso: string) {
    this.t = Date.parse(iso);
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export async function makeApp(opts: {
  clock: Clock;
  txs?: Map<string, VersionedTransactionResponse>;
  rolls?: number[];
  env?: Record<string, string>;
}) {
  // Default: in-memory PGlite. Set TEST_DATABASE_URL=postgres://… to run against real Postgres
  // (tables are truncated per app instance; don't point this at a database you care about).
  const url = process.env.TEST_DATABASE_URL || "pglite:memory";
  const db: Db = await openDb(url);
  await migrate(db);
  if (db.kind === "postgres") {
    await db.exec(
      "TRUNCATE points_wallets, points_monthly, points_events, auth_nonces, nfts, listings, offers, trades, indexed_txs, indexer_cursor, listing_awards, sale_awards, chat_messages, chat_profiles, chat_sanctions, chat_mod_log, chat_settings RESTART IDENTITY"
    );
  }
  const config = loadConfig({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret-test-secret-test-secret-000",
    GREENCAT_PROGRAM_ID: PROGRAM_ID,
    BONUS_MAX_TX_AGE_SEC: "86400",
    ...(opts.env ?? {}),
  } as NodeJS.ProcessEnv);
  const txs = opts.txs ?? new Map();
  const rolls = opts.rolls ?? [];
  const app = createApp({
    db,
    config,
    now: opts.clock.now,
    fetchTx: async (sig) => txs.get(sig) ?? null,
    rollDaily: () => rolls.shift() ?? 50,
  });
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await app.request(path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    return { status: res.status, json };
  };
  return { app, db, config, txs, call };
}

export async function signIn(
  call: Awaited<ReturnType<typeof makeApp>>["call"],
  kp: Keypair
): Promise<string> {
  const wallet = kp.publicKey.toBase58();
  const n = await call("POST", "/auth/nonce", { wallet });
  if (n.status !== 200) throw new Error(`nonce ${n.status}`);
  const sig = nacl.sign.detached(new TextEncoder().encode(n.json.message), kp.secretKey);
  const v = await call("POST", "/auth/verify", {
    wallet,
    nonce: n.json.nonce,
    signature: Buffer.from(sig).toString("base64"),
  });
  if (v.status !== 200) throw new Error(`verify ${v.status} ${JSON.stringify(v.json)}`);
  return v.json.token;
}

/** Build a realistic signed v0 tx + RPC-shaped response for the verifier. */
export function fakeProgramTx(opts: {
  signer: Keypair;
  /** account[0] of the program ix (defaults to signer) */
  actor?: PublicKey;
  ix: keyof typeof IX_DISCRIMINATORS;
  programId?: string;
  logs?: string[];
  err?: unknown;
  blockTime: number;
  slot?: number;
  /** first u64 ix arg (amount/price/bet); default 1,000,000 GC so API-03 minimums pass */
  amountRaw?: bigint;
}): { signature: string; response: VersionedTransactionResponse } {
  const programId = new PublicKey(opts.programId ?? PROGRAM_ID);
  const actor = opts.actor ?? opts.signer.publicKey;
  const ix = new TransactionInstruction({
    programId,
    keys: [{ pubkey: actor, isSigner: actor.equals(opts.signer.publicKey), isWritable: true }],
    data: (() => {
      const args = Buffer.alloc(16);
      args.writeBigUInt64LE(opts.amountRaw ?? 1_000_000_000_000n, 0);
      return Buffer.concat([IX_DISCRIMINATORS[opts.ix], args]);
    })(),
  });
  const msg = new TransactionMessage({
    payerKey: opts.signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([opts.signer]);
  const signature = bs58.encode(tx.signatures[0]);
  return {
    signature,
    response: {
      slot: opts.slot ?? 1000,
      blockTime: opts.blockTime,
      transaction: { message: msg, signatures: [signature] },
      meta: {
        err: opts.err ?? null,
        fee: 5000,
        preBalances: [],
        postBalances: [],
        logMessages: opts.logs ?? [],
        loadedAddresses: { writable: [], readonly: [] },
      },
      version: 0,
    } as unknown as VersionedTransactionResponse,
  };
}

export function nftRevealedData(mint: PublicKey, mintIndex: number, tokenId: number, rarity: number): string {
  const ev = Buffer.alloc(8 + 32 + 2 + 2 + 1);
  NFT_REVEALED_EVENT_DISC.copy(ev, 0);
  mint.toBuffer().copy(ev, 8);
  ev.writeUInt16LE(mintIndex, 40);
  ev.writeUInt16LE(tokenId, 42);
  ev[44] = rarity;
  return `Program data: ${ev.toString("base64")}`;
}

export function nftMintedData(tokenId: number, rarity: number, buyer: PublicKey, mint: PublicKey): string {
  const ev = Buffer.alloc(8 + 2 + 1 + 64);
  NFT_MINTED_EVENT_DISC.copy(ev, 0);
  ev.writeUInt16LE(tokenId, 8);
  ev[10] = rarity;
  buyer.toBuffer().copy(ev, 11);
  mint.toBuffer().copy(ev, 43);
  return `Program data: ${ev.toString("base64")}`;
}
