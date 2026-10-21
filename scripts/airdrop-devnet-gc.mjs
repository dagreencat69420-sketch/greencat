#!/usr/bin/env node
/**
 * Mint test $GC from the create-devnet-gc-mint authority to a wallet.
 *
 * Usage:
 *   node scripts/airdrop-devnet-gc.mjs <RECIPIENT_PUBKEY> [AMOUNT_UI]
 *
 * Default amount: 100000
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH || path.join(ROOT, "keys/devnet-authority.json");
const RPC_URL = process.env.RPC_URL || clusterApiUrl("devnet");
const CFG_PATH = path.join(ROOT, "packages/sdk/src/generated/devnet.json");

const recipientStr = process.argv[2];
const amountUi = Number(process.argv[3] || 100_000);

if (!recipientStr) {
  console.error("Usage: node scripts/airdrop-devnet-gc.mjs <RECIPIENT_PUBKEY> [AMOUNT_UI]");
  process.exit(1);
}

if (!fs.existsSync(CFG_PATH)) {
  console.error("Missing", CFG_PATH, "— run create-devnet-gc-mint.mjs first");
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")))
);
const connection = new Connection(RPC_URL, "confirmed");
const mint = new PublicKey(cfg.mint);
const recipient = new PublicKey(recipientStr);

const ata = await getOrCreateAssociatedTokenAccount(
  connection,
  authority,
  mint,
  recipient
);
const raw = BigInt(amountUi) * BigInt(10 ** cfg.decimals);
await mintTo(connection, authority, mint, ata.address, authority, raw);
console.log(`Minted ${amountUi} $GC → ${recipient.toBase58()}`);
console.log("ATA:", ata.address.toBase58());
