/**
 * Shared helpers for the operational scripts (run with `npx tsx scripts/<name>.ts`).
 * Env: RPC_URL (default: Helius devnet if HELIUS_DEVNET_API_KEY / HELIUS_API_KEY_NEW is set, else public devnet), KEYPAIR_PATH (default keys/devnet-authority.json),
 *      PROGRAM_ID (default SDK id), GC_MINT, TOKEN_PROGRAM=spl|token2022 (default: read from Config).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { GREENCAT_PROGRAM_ID, decodeConfigAccount, deriveConfigPda } from "@greencat/sdk";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || GREENCAT_PROGRAM_ID);
const HELIUS_DEVNET_KEY = process.env.HELIUS_DEVNET_API_KEY || process.env.HELIUS_API_KEY_NEW;
export const RPC_URL =
  process.env.RPC_URL || (HELIUS_DEVNET_KEY ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_DEVNET_KEY}` : clusterApiUrl("devnet"));
export const conn = new Connection(RPC_URL, "confirmed");
export const UI = 1_000_000n;

export function loadKeypair(p = process.env.KEYPAIR_PATH || path.join(ROOT, "keys/devnet-authority.json")): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export async function send(signers: Keypair[], ixs: TransactionInstruction[], cu = 200_000): Promise<string> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}

export async function readConfig() {
  const info = await conn.getAccountInfo(deriveConfigPda(PROGRAM_ID)[0], "confirmed");
  return info ? decodeConfigAccount(Buffer.from(info.data)) : null;
}

/** $GC mint + token program: env first, then the on-chain Config. */
export async function gcMintAndProgram(): Promise<{ gcMint: PublicKey; tokenProgram: PublicKey }> {
  const offline = process.env.GC_MINT && process.env.TOKEN_PROGRAM;
  const cfg = offline ? null : await readConfig();
  const gcMint = process.env.GC_MINT ? new PublicKey(process.env.GC_MINT) : cfg ? new PublicKey(cfg.gcMint) : null;
  if (!gcMint) throw new Error("Set GC_MINT (Config not initialized)");
  const tokenProgram =
    process.env.TOKEN_PROGRAM === "spl"
      ? TOKEN_PROGRAM_ID
      : process.env.TOKEN_PROGRAM === "token2022"
        ? TOKEN_2022_PROGRAM_ID
        : cfg
          ? new PublicKey(cfg.tokenProgram)
          : TOKEN_2022_PROGRAM_ID;
  return { gcMint, tokenProgram };
}

export function uiToRawGc(ui: string | number): bigint {
  const [w, f = ""] = String(ui).split(".");
  return BigInt(w) * UI + BigInt((f + "000000").slice(0, 6));
}

export function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}
