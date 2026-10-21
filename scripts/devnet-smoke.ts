#!/usr/bin/env -S npx tsx
/**
 * Small Devnet smoke helpers for flows that have no dedicated script (stake/claim, tiny Merkle airdrop).
 *   npx tsx scripts/devnet-smoke.ts stake <UI>
 *   npx tsx scripts/devnet-smoke.ts claim-daily            # NothingToClaim until 24h after staking
 *   npx tsx scripts/devnet-smoke.ts airdrop-tiny <ID> <UI_EACH> <OTHER_PUBKEY>   # create 2-leaf tree + claim own leaf
 */
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  buildClaimAirdropIx,
  buildClaimDailyIx,
  buildCreateAirdropIx,
  buildMerkleTree,
  buildStakeDailyIx,
  deriveAirdropDistributionPda,
} from "@greencat/sdk";
import { PROGRAM_ID, die, gcMintAndProgram, loadKeypair, send, uiToRawGc } from "./lib/common";

const [cmd, a1, a2, a3] = process.argv.slice(2);
const link = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

async function main() {
  const me = loadKeypair();
  const { gcMint, tokenProgram } = await gcMintAndProgram();
  const ata = getAssociatedTokenAddressSync(gcMint, me.publicKey, false, tokenProgram);
  if (cmd === "stake") {
    const sig = await send([me], [buildStakeDailyIx({ staker: me.publicKey, gcMint, stakerAta: ata, amountRaw: uiToRawGc(a1 ?? "1000"), tokenProgramId: tokenProgram, programId: PROGRAM_ID })]);
    console.log(`stake_daily ${sig} ${link(sig)}`);
  } else if (cmd === "claim-daily") {
    const sig = await send([me], [buildClaimDailyIx({ staker: me.publicKey, gcMint, stakerAta: ata, tokenProgramId: tokenProgram, programId: PROGRAM_ID })]);
    console.log(`claim_daily ${sig} ${link(sig)}`);
  } else if (cmd === "airdrop-tiny") {
    const id = BigInt(a1 ?? die("id"));
    const each = uiToRawGc(a2 ?? "10");
    const other = new PublicKey(a3 ?? die("other pubkey"));
    const [dist] = deriveAirdropDistributionPda(id, PROGRAM_ID);
    const entries = [
      { claimant: me.publicKey.toBase58(), amount: each },
      { claimant: other.toBase58(), amount: each },
    ];
    const tree = buildMerkleTree(dist, entries);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 8 * 86400);
    const c = await send([me], [buildCreateAirdropIx({ authority: me.publicKey, gcMint, id, merkleRoot: tree.root, totalAmountRaw: each * 2n, expiryTs: expiry, tokenProgramId: tokenProgram, programId: PROGRAM_ID })]);
    console.log(`create_airdrop id=${id} root=${tree.root.toString("hex")} ${c} ${link(c)}`);
    const cl = await send([me], [buildClaimAirdropIx({ claimant: me.publicKey, gcMint, distributionId: id, index: 0n, amountRaw: each, proof: tree.proof(0), tokenProgramId: tokenProgram, programId: PROGRAM_ID })]);
    console.log(`claim_airdrop index=0 ${cl} ${link(cl)}`);
  } else die("usage: stake <UI> | claim-daily | airdrop-tiny <ID> <UI_EACH> <OTHER>");
}
main().catch((e) => die(String(e?.stack ?? e)));
