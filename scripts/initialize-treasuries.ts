#!/usr/bin/env -S npx tsx
/**
 * Step 1 of init (docs/HOSTING.md): Config + 6 treasury vault ATAs.
 * Audit GC-20: the signer MUST be the program's upgrade authority (checked on-chain via ProgramData).
 * With the `mainnet` feature the program only accepts G2b4…pump + Token-2022.
 *
 *   GC_MINT=<mint> TOKEN_PROGRAM=spl|token2022 KEYPAIR_PATH=<upgrade-authority.json> RPC_URL=… \
 *     npx tsx scripts/initialize-treasuries.ts
 */
import { PublicKey } from "@solana/web3.js";
import { INIT_TREASURIES_COMPUTE_UNITS, buildInitializeTreasuriesIx, deriveAllTreasuryAddresses, deriveProgramDataAddress } from "@greencat/sdk";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PROGRAM_ID, RPC_URL, conn, die, loadKeypair, readConfig, send } from "./lib/common";

const GC_MINT = process.env.GC_MINT || die("GC_MINT required");
const tokenProgram = process.env.TOKEN_PROGRAM === "spl" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

async function main() {
  const authority = loadKeypair();
  if (await readConfig()) die("Config already initialized");
  const pd = await conn.getAccountInfo(deriveProgramDataAddress(PROGRAM_ID));
  if (!pd) die(`ProgramData for ${PROGRAM_ID.toBase58()} not found — deploy first (upgradeable loader)`);
  const upgradeAuth = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : "(immutable)";
  if (upgradeAuth !== authority.publicKey.toBase58()) die(`signer ${authority.publicKey.toBase58()} is not the upgrade authority (${upgradeAuth})`);
  console.log(`RPC ${RPC_URL}\nprogram ${PROGRAM_ID.toBase58()}\nauthority ${authority.publicKey.toBase58()}\nmint ${GC_MINT} (${tokenProgram.equals(TOKEN_PROGRAM_ID) ? "spl" : "token2022"})`);
  const sig = await send(
    [authority],
    [buildInitializeTreasuriesIx({ authority: authority.publicKey, gcMint: new PublicKey(GC_MINT), tokenProgramId: tokenProgram, programId: PROGRAM_ID })],
    INIT_TREASURIES_COMPUTE_UNITS
  );
  console.log(`initialize_treasuries ${sig}`);
  console.log(JSON.stringify(deriveAllTreasuryAddresses(PROGRAM_ID.toBase58()), null, 2));
}
main().catch((e) => die(String(e?.stack ?? e)));
