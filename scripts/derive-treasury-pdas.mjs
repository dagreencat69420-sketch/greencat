#!/usr/bin/env node
/**
 * Dry-run: derive config + 6 treasury PDAs (+ vault ATAs for a mint).
 * Does not require a funded wallet or deployed program.
 *
 * Usage:
 *   node scripts/derive-treasury-pdas.mjs
 *   PROGRAM_ID=... GC_MINT=... TOKEN_PROGRAM=token2022|spl node scripts/derive-treasury-pdas.mjs
 */
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const PROGRAM_ID = process.env.PROGRAM_ID || "8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE";
const GC_MINT = process.env.GC_MINT || "G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump";
const tokenProgram =
  process.env.TOKEN_PROGRAM === "spl" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

const POOLS = [
  [0, "daily_rewards"],
  [1, "long_rewards"],
  [2, "wheel_bank"],
  [3, "nft_fee_treasury"],
  [4, "mint_proceeds"],
  [5, "airdrop"],
];

const UI_SCALE = 1_000_000n;
const DEFAULTS = {
  airdrop_min_holding: 100_000n * UI_SCALE,
  daily_payout_allowance: 20_000_000n * UI_SCALE,
  wheel_payout_allowance: 0n, // wheel removed Oct 12, 2026
  long_stake_capacity: 100_000_000n * UI_SCALE,
};

const programId = new PublicKey(PROGRAM_ID);
const mint = new PublicKey(GC_MINT);
const [config, configBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  programId
);

console.log("=== GreenCat treasury PDAs (derived, pre-init safe) ===");
console.log("programId:", programId.toBase58());
console.log("gcMint:   ", mint.toBase58(), process.env.GC_MINT ? "(env)" : "(mainnet CA)");
console.log("tokenProg:", tokenProgram.toBase58());
console.log("config:   ", config.toBase58(), `bump=${configBump}`);
console.log("");
console.log(
  "pool_id | label              | PDA                                      | vault ATA"
);
console.log("-".repeat(120));
for (const [id, label] of POOLS) {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(label)],
    programId
  );
  const ata = getAssociatedTokenAddressSync(mint, pda, true, tokenProgram);
  console.log(
    `${String(id).padStart(7)} | ${label.padEnd(18)} | ${pda.toBase58()} | ${ata.toBase58()}  (bump=${bump})`
  );
}
console.log("");
console.log("Defaults (raw, 6 decimals):");
for (const [k, v] of Object.entries(DEFAULTS)) {
  console.log(`  ${k.padEnd(24)} ${v.toString()}`);
}
