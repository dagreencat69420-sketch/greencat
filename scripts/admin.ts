#!/usr/bin/env -S npx tsx
/**
 * Config-authority actions (audit GC-19). With a Squads multisig, use `PRINT_ONLY=1` to print the
 * instruction (program id, accounts, base58 data) and create a Squads vault transaction instead.
 *
 *   npx tsx scripts/admin.ts status
 *   npx tsx scripts/admin.ts propose <NEW_AUTHORITY>      # step 1 of handover (default pubkey cancels)
 *   npx tsx scripts/admin.ts accept                       # step 2, signed by the NEW authority
 *   npx tsx scripts/admin.ts pause | unpause
 *   npx tsx scripts/admin.ts vrf-expiry <SECS>            # 3600..604800
 *   npx tsx scripts/admin.ts staking open | lock          # new stakes on/off (unstake + claim always work)
 *   npx tsx scripts/admin.ts royalty <BPS> <RECIPIENT>    # before the first mint only
 *   npx tsx scripts/admin.ts close-mint                   # stop minting permanently
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  buildAcceptAuthorityIx,
  buildCloseMintIx,
  buildProposeAuthorityIx,
  buildSetPausedIx,
  buildSetRoyaltyIx,
  buildSetStakingEnabledIx,
  buildSetVrfExpiryIx,
} from "@greencat/sdk";
import { PROGRAM_ID, die, loadKeypair, readConfig, send, uiToRawGc } from "./lib/common";

const [cmd, a1, a2, a3] = process.argv.slice(2);

async function main() {
  if (!cmd || cmd === "status") {
    const c = await readConfig();
    if (!c) die("Config not initialized");
    console.log({
      authority: c.authority,
      pendingAuthority: c.pendingAuthority,
      paused: c.paused,
      staking: c.stakingEnabled ? "open" : "locked",
      stakingFlagSet: c.stakingFlagSet,
      vrfExpirySecs: c.vrfExpirySecs.toString(),
      reserved: { longBonus: c.longBonusOutstanding.toString(), airdrop: c.airdropReserved.toString() },
    });
    return;
  }
  const signer = process.env.PRINT_ONLY ? null : loadKeypair();
  const who = signer?.publicKey ?? new PublicKey(process.env.AUTHORITY || die("PRINT_ONLY needs AUTHORITY=<multisig vault>"));
  const programId = PROGRAM_ID;
  let ix: TransactionInstruction;
  switch (cmd) {
    case "propose": ix = buildProposeAuthorityIx({ authority: who, newAuthority: new PublicKey(a1 || die("NEW_AUTHORITY")), programId }); break;
    case "accept": ix = buildAcceptAuthorityIx({ newAuthority: who, programId }); break;
    case "pause": ix = buildSetPausedIx({ authority: who, paused: true, programId }); break;
    case "unpause": ix = buildSetPausedIx({ authority: who, paused: false, programId }); break;
    case "vrf-expiry": ix = buildSetVrfExpiryIx({ authority: who, expirySecs: BigInt(a1), programId }); break;
    case "staking":
      if (a1 !== "open" && a1 !== "lock") die("usage: staking open | lock");
      ix = buildSetStakingEnabledIx({ authority: who, enabled: a1 === "open", programId });
      break;
    case "royalty": ix = buildSetRoyaltyIx({ authority: who, royaltyBps: Number(a1), recipient: new PublicKey(a2), programId }); break;
    case "close-mint": ix = buildCloseMintIx({ authority: who, programId }); break;
    default: die(`unknown command ${cmd}`);
  }
  if (!signer) {
    console.log(JSON.stringify({ programId: ix.programId.toBase58(), keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: bs58.encode(ix.data) }, null, 2));
    return;
  }
  console.log(`${cmd} ${await send([signer], [ix])}`);
}
main().catch((e) => die(String(e?.stack ?? e)));
