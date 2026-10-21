#!/usr/bin/env node
/**
 * Create a classic SPL $GC clone mint on Solana devnet for testing.
 * Mainnet $GC (Token-2022, 6 decimals) cannot be used on devnet.
 *
 * Usage:
 *   node scripts/create-devnet-gc-mint.mjs
 *
 * Env:
 *   KEYPAIR_PATH  (default: keys/devnet-authority.json)
 *   RPC_URL       (default: https://api.devnet.solana.com)
 *   DECIMALS      (default: 6)
 *   INITIAL_SUPPLY_UI  (default: 1000000000) — minted to authority ATA
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ||
  path.join(ROOT, "keys/devnet-authority.json");
const RPC_URL = process.env.RPC_URL || clusterApiUrl("devnet");
const DECIMALS = Number(process.env.DECIMALS || 6);
const INITIAL_SUPPLY_UI = Number(process.env.INITIAL_SUPPLY_UI || 1_000_000_000);

function loadKeypair(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  if (!fs.existsSync(KEYPAIR_PATH)) {
    console.error(`Missing keypair at ${KEYPAIR_PATH}`);
    console.error("Generate with: solana-keygen new -o keys/devnet-authority.json");
    process.exit(1);
  }

  const authority = loadKeypair(KEYPAIR_PATH);
  const connection = new Connection(RPC_URL, "confirmed");

  const bal = await connection.getBalance(authority.publicKey);
  console.log("Authority:", authority.publicKey.toBase58());
  console.log("Balance:", bal / 1e9, "SOL");
  console.log("RPC:", RPC_URL);

  if (bal < 0.05 * 1e9) {
    console.error(
      "Need ≥0.05 SOL on authority. Try: solana airdrop 2 -k keys/devnet-authority.json --url devnet"
    );
    console.error("Or use an alternate faucet / RPC if public airdrop is rate-limited.");
    process.exit(2);
  }

  console.log(`Creating mint (decimals=${DECIMALS})…`);
  const mint = await createMint(
    connection,
    authority,
    authority.publicKey,
    null,
    DECIMALS,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );
  console.log("Mint:", mint.toBase58());

  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    mint,
    authority.publicKey
  );
  console.log("Authority ATA:", ata.address.toBase58());

  const rawAmount = BigInt(INITIAL_SUPPLY_UI) * BigInt(10 ** DECIMALS);
  await mintTo(
    connection,
    authority,
    mint,
    ata.address,
    authority,
    rawAmount
  );
  console.log(`Minted ${INITIAL_SUPPLY_UI.toLocaleString()} $GC to authority ATA`);

  const out = {
    mint: mint.toBase58(),
    decimals: DECIMALS,
    authorityPubkey: authority.publicKey.toBase58(),
    cluster: "devnet",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    authorityAta: ata.address.toBase58(),
    initialSupplyUi: INITIAL_SUPPLY_UI,
    note: "Classic SPL clone for devnet. Mainnet $GC is Token-2022 at G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump",
    createdAt: new Date().toISOString(),
  };

  const genDir = path.join(ROOT, "packages/sdk/src/generated");
  fs.mkdirSync(genDir, { recursive: true });
  const outPath = path.join(genDir, "devnet.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log("Wrote", outPath);

  // Also write apps/web/.env.local snippet
  const envPath = path.join(ROOT, "apps/web/.env.local");
  const envBody = [
    "NEXT_PUBLIC_SOLANA_NETWORK=devnet",
    `NEXT_PUBLIC_RPC_URL=${RPC_URL}`,
    `NEXT_PUBLIC_GC_MINT=${mint.toBase58()}`,
    "",
  ].join("\n");
  fs.writeFileSync(envPath, envBody);
  console.log("Wrote", envPath);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
