#!/usr/bin/env node
/**
 * Deposit raw $GC into a treasury vault (anyone can deposit).
 *
 * Usage:
 *   GC_MINT=... POOL_ID=0 AMOUNT_UI=1000 KEYPAIR_PATH=... \\
 *     TOKEN_PROGRAM=token2022|spl node scripts/deposit-treasury.mjs
 *
 * POOL_ID: 0=daily 1=long 2=wheel 3=nft_fee 4=mint_proceeds 5=airdrop
 * AMOUNT_UI is human units (× 10^decimals → raw). Or set AMOUNT_RAW.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE"
);
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH || path.join(ROOT, "keys/devnet-authority.json");
const RPC_URL = process.env.RPC_URL || clusterApiUrl("devnet");
const GC_MINT = process.env.GC_MINT;
const POOL_ID = Number(process.env.POOL_ID ?? 0);
const tokenProgram =
  process.env.TOKEN_PROGRAM === "spl" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

const POOLS = [
  "daily_rewards",
  "long_rewards",
  "wheel_bank",
  "nft_fee_treasury",
  "mint_proceeds",
  "airdrop",
];
const IX_DEP = Buffer.from("028148d6325e97e6", "hex");

function loadKeypair(p) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")))
  );
}
function meta(pubkey, isSigner, isWritable) {
  return { pubkey, isSigner, isWritable };
}

async function main() {
  if (!GC_MINT) {
    console.error("Set GC_MINT");
    process.exit(1);
  }
  if (POOL_ID < 0 || POOL_ID > 5) {
    console.error("POOL_ID must be 0..5");
    process.exit(1);
  }
  const depositor = loadKeypair(KEYPAIR_PATH);
  const mint = new PublicKey(GC_MINT);
  const connection = new Connection(RPC_URL, "confirmed");
  const mintInfo = await getMint(connection, mint, "confirmed", tokenProgram);
  const decimals = mintInfo.decimals;

  let amountRaw;
  if (process.env.AMOUNT_RAW) {
    amountRaw = BigInt(process.env.AMOUNT_RAW);
  } else {
    const ui = Number(process.env.AMOUNT_UI || 1000);
    amountRaw = BigInt(Math.round(ui * 10 ** decimals));
  }

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );
  const [treasury] = PublicKey.findProgramAddressSync(
    [Buffer.from(POOLS[POOL_ID])],
    PROGRAM_ID
  );
  const vault = getAssociatedTokenAddressSync(mint, treasury, true, tokenProgram);
  const depositorAta = getAssociatedTokenAddressSync(
    mint,
    depositor.publicKey,
    false,
    tokenProgram
  );

  const data = Buffer.alloc(17);
  IX_DEP.copy(data, 0);
  data.writeUInt8(POOL_ID, 8);
  data.writeBigUInt64LE(amountRaw, 9);

  const ix = {
    programId: PROGRAM_ID,
    keys: [
      meta(depositor.publicKey, true, false),
      meta(config, false, true),
      meta(mint, false, false),
      meta(treasury, false, false),
      meta(vault, false, true),
      meta(depositorAta, false, true),
      meta(tokenProgram, false, false),
    ],
    data,
  };

  console.log(`Deposit pool=${POOL_ID} (${POOLS[POOL_ID]}) amount_raw=${amountRaw}`);
  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(ix),
    [depositor],
    { commitment: "confirmed" }
  );
  console.log("OK", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
