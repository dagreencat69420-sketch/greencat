/**
 * Measures the SOL (rent + fees) each init / user step costs on a local validator, so the
 * Devnet/Mainnet funding estimate in docs/DEPLOY.md is empirical. ORAO fee here is the localnet test
 * network's 0.001 SOL (devnet uses 0.0003 SOL? see docs) and is reported separately.
 *   npx tsx test/measure-costs-localnet.ts
 */
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  INIT_COLLECTION_COMPUTE_UNITS,
  INIT_TREASURIES_COMPUTE_UNITS,
  MINT_NFT_COMPUTE_UNITS,
  PoolId,
  buildCreateCollectionNftIx,
  buildDepositTreasuryIx,
  buildInitializeCollectionIx,
  buildInitializeTreasuriesIx,
  buildMintNftIx,
} from "@greencat/sdk";
import { PID, airdrop, initMintPool, initOrao, sendIxs, settleQueue, startLocalnet } from "./localnet";

const UI = 1_000_000n;
async function main() {
  const tokenProgram = process.env.GC_TOKEN === "spl" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const ln = await startLocalnet({ port: 19500, tag: "cost" });
  try {
    const { conn, upgradeAuthority: a } = ln;
    const orao = await initOrao(conn, a, 1_000_000n);
    const user = Keypair.generate();
    await airdrop(conn, user.publicKey, 10);
    const gcMint = await createMint(conn, a, a.publicKey, null, 6, undefined, undefined, tokenProgram);
    for (const o of [a, user]) {
      const ata = await getOrCreateAssociatedTokenAccount(conn, a, gcMint, o.publicKey, false, undefined, undefined, tokenProgram);
      await mintTo(conn, a, gcMint, ata.address, a, Number(1_000_000n * UI), [], undefined, tokenProgram);
    }
    const rows: [string, number][] = [];
    const step = async (label: string, payer: Keypair, fn: () => Promise<unknown>) => {
      const b = await conn.getBalance(payer.publicKey, "confirmed");
      await fn();
      const d = b - (await conn.getBalance(payer.publicKey, "confirmed"));
      rows.push([label, d / LAMPORTS_PER_SOL]);
    };
    await step("initialize_treasuries (Config + 6 pool ATAs)", a, () =>
      sendIxs(conn, [a], [buildInitializeTreasuriesIx({ authority: a.publicKey, gcMint, tokenProgramId: tokenProgram })], INIT_TREASURIES_COMPUTE_UNITS));
    await step("initialize_collection (Collection 2824 B)", a, () =>
      sendIxs(conn, [a], [buildInitializeCollectionIx({ authority: a.publicKey, metadataBaseUri: "https://example.invalid/gc/" })], INIT_COLLECTION_COMPUTE_UNITS));
    await step("create_collection_nft (mint+metadata+edition+ATA)", a, () =>
      sendIxs(conn, [a], [buildCreateCollectionNftIx({ authority: a.publicKey })], 400_000));
    await step("init_mint_pool ×4 (remaining-ids pool + reveal queue, 32,296 B)", a, () => initMintPool(conn, a));
    const adminAta = getAssociatedTokenAddressSync(gcMint, a.publicKey, false, tokenProgram);
    await step("deposit_treasury (daily rewards)", a, () =>
      sendIxs(conn, [a], [buildDepositTreasuryIx({ depositor: a.publicKey, depositorAta: adminAta, gcMint, poolId: PoolId.DailyRewards, amountRaw: 900_000n * UI, tokenProgramId: tokenProgram })]));
    const userAta = getAssociatedTokenAddressSync(gcMint, user.publicKey, false, tokenProgram);
    await step("user: mint_nft (NFT accounts + NftRecord + ORAO request + ORAO fee)", user, async () => {
      const nft = Keypair.generate();
      await sendIxs(conn, [user, nft], [buildMintNftIx({ buyer: user.publicKey, nftMint: nft.publicKey, gcMint, buyerGcAta: userAta, buyerNftAta: getAssociatedTokenAddressSync(nft.publicKey, user.publicKey), vrfTreasury: orao.treasury, tokenProgramId: tokenProgram })], MINT_NFT_COMPUTE_UNITS);
    });
    await step("user: settle_mint (tx fee only)", user, () => settleQueue(conn, orao, user));
    const so = (await conn.getAccountInfo(new PublicKey(PID)))!;
    void so;
    console.log(`ORAO fee on this localnet: ${Number(orao.feeLamports) / LAMPORTS_PER_SOL} SOL (included in the mint VRF row)`);
    for (const [l, s] of rows) console.log(`${s.toFixed(6).padStart(10)} SOL  ${l}`);
    const soLen = (await import("node:fs")).statSync(new URL("../../../target/deploy/greencat.so", import.meta.url)).size;
    const progData = await conn.getMinimumBalanceForRentExemption(soLen + 45);
    const buf = await conn.getMinimumBalanceForRentExemption(soLen + 37);
    const prog2x = await conn.getMinimumBalanceForRentExemption(2 * soLen + 45);
    console.log(`.so ${soLen} B`);
    console.log(`rent: programdata(1x)=${progData / 1e9} buffer=${buf / 1e9} programdata(2x)=${prog2x / 1e9} program acct=${(await conn.getMinimumBalanceForRentExemption(36)) / 1e9}`);
  } finally {
    ln.stop();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
