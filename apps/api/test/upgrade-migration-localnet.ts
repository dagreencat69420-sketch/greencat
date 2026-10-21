/**
 * Upgrade rehearsal for the per-mint reveal (mirrors the Devnet upgrade exactly, fully offline):
 *
 *  OLD program (collection-wide reveal, /workspace/tmp/greencat-old.so or OLD_SO) → init → 3 legacy
 *  "unrevealed" mints → propose_authority (pending handover) → `solana program extend` + `deploy`
 *  (upgrade, same program id, same upgrade authority) → state preserved (Config authority + pending,
 *  Collection counters, NftRecords) → mint blocked until init_mint_pool → permissionless pool init →
 *  new mint queues behind the legacy ones → request_mint_vrf for the legacy NFTs → settle the queue in
 *  order → every NFT (legacy + new) is a real cat (GreenCat #id, {base}{id}.json, verified collection).
 *
 *   OLD_SO=/path/old.so npx tsx test/upgrade-migration-localnet.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent, createMint, getAssociatedTokenAddressSync, mintTo } from "@solana/spl-token";
import {
  INIT_COLLECTION_COMPUTE_UNITS,
  INIT_TREASURIES_COMPUTE_UNITS,
  MINT_NFT_COMPUTE_UNITS,
  buildAcceptAuthorityIx,
  buildCreateCollectionNftIx,
  buildInitializeCollectionIx,
  buildInitializeTreasuriesIx,
  buildMintNftIx,
  buildProposeAuthorityIx,
  buildRequestMintVrfIx,
  buildSettleMintIx,
  decodeCollectionAccount,
  decodeConfigAccount,
  decodeNftRecordAccount,
  deriveCollectionMintPda,
  deriveCollectionPda,
  deriveConfigPda,
  deriveMetadataPda,
  deriveNftRecordPda,
  fetchRevealQueue,
  getTokenRarity,
  poolIndexFromRandomness,
  poolTake,
  rarityToU8,
} from "@greencat/sdk";
import { PID, SIMD_0500_FEATURE, SO_DEFAULT, airdrop, assert, expectFail, initMintPool, initOrao, parseMetadata, sendIxs, settleQueue, sleep, startLocalnet } from "./localnet";

const UI = 1_000_000n;
const TOKEN = TOKEN_PROGRAM_ID;
const OLD_SO = process.env.OLD_SO || "/workspace/tmp/greencat-old.so";
const BASE = "ipfs://bafybeihq3n4h2756mmonwi5ckia3vztc47zuzcglx5dqxmt6dfk2zmzap4/";

async function main() {
  assert(fs.existsSync(OLD_SO), `missing ${OLD_SO}`);
  const port = Number(process.env.E2E_RPC_PORT || 19300);
  const ln = await startLocalnet({ so: OLD_SO, port, tag: "upgrade", deactivateFeatures: [SIMD_0500_FEATURE] });
  const { conn, rpcUrl } = ln;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gc-upg-"));
  try {
    const admin = ln.upgradeAuthority;
    const user = Keypair.generate();
    const newAdmin = Keypair.generate();
    await airdrop(conn, user.publicKey, 20);
    await airdrop(conn, newAdmin.publicKey, 2);
    const orao = await initOrao(conn, admin);
    const gcMint = await createMint(conn, admin, admin.publicKey, null, 6, undefined, undefined, TOKEN);
    const userGc = await createAssociatedTokenAccountIdempotent(conn, admin, gcMint, user.publicKey, {}, TOKEN);
    await mintTo(conn, admin, gcMint, userGc, admin, Number(100_000n * UI), [], undefined, TOKEN);

    // ── OLD program: init + 3 legacy unrevealed mints + pending handover ──
    await sendIxs(conn, [admin], [buildInitializeTreasuriesIx({ authority: admin.publicKey, gcMint, tokenProgramId: TOKEN })], INIT_TREASURIES_COMPUTE_UNITS);
    await sendIxs(conn, [admin], [buildInitializeCollectionIx({ authority: admin.publicKey, metadataBaseUri: BASE })], INIT_COLLECTION_COMPUTE_UNITS);
    await sendIxs(conn, [admin], [buildCreateCollectionNftIx({ authority: admin.publicKey })], 400_000);
    const mintOne = async () => {
      const nft = Keypair.generate();
      await sendIxs(conn, [user, nft], [buildMintNftIx({ buyer: user.publicKey, nftMint: nft.publicKey, gcMint, buyerGcAta: userGc, buyerNftAta: getAssociatedTokenAddressSync(nft.publicKey, user.publicKey, false, TOKEN_PROGRAM_ID), vrfTreasury: orao.treasury, tokenProgramId: TOKEN })], MINT_NFT_COMPUTE_UNITS);
      return nft.publicKey;
    };
    const legacy = [await mintOne(), await mintOne(), await mintOne()];
    const md0 = parseMetadata((await conn.getAccountInfo(deriveMetadataPda(legacy[0])[0]))!.data);
    assert(md0.name === "GreenCat Mint #1" && md0.uri === `${BASE}unrevealed.json`, `legacy placeholder ${md0.name} ${md0.uri}`);
    await sendIxs(conn, [admin], [buildProposeAuthorityIx({ authority: admin.publicKey, newAuthority: newAdmin.publicKey })]);
    const colBefore = Buffer.from((await conn.getAccountInfo(deriveCollectionPda(PID)[0]))!.data);
    const cfgBefore = Buffer.from((await conn.getAccountInfo(deriveConfigPda(PID)[0]))!.data);
    console.log(`[upgrade] old program: 3 legacy unrevealed mints, handover to ${newAdmin.publicKey.toBase58().slice(0, 6)}… pending`);

    // ── upgrade (same commands as Devnet) ──
    const key = path.join(tmp, "upgrade-authority.json");
    fs.writeFileSync(key, JSON.stringify(Array.from(admin.secretKey)));
    const bin = process.env.SOLANA_BIN || path.join(os.homedir(), ".local/share/solana/install/active_release/bin");
    const sol = (args: string[]) => execFileSync(path.join(bin, "solana"), [...args, "-u", rpcUrl, "-k", key], { encoding: "utf8" });
    const oldLen = fs.statSync(OLD_SO).size;
    const newLen = fs.statSync(SO_DEFAULT).size;
    if (newLen > oldLen) console.log(sol(["program", "extend", PID.toBase58(), String(newLen - oldLen)]).trim());
    console.log(sol(["program", "deploy", SO_DEFAULT, "--program-id", PID.toBase58(), "--upgrade-authority", key]).trim());
    await sleep(1500);

    // ── state preserved ──
    const colAfter = Buffer.from((await conn.getAccountInfo(deriveCollectionPda(PID)[0]))!.data);
    const cfgAfter = Buffer.from((await conn.getAccountInfo(deriveConfigPda(PID)[0]))!.data);
    assert(colAfter.equals(colBefore) && cfgAfter.equals(cfgBefore), "Collection + Config bytes unchanged by the upgrade");
    const cfg = decodeConfigAccount(cfgAfter)!;
    assert(cfg.authority === admin.publicKey.toBase58() && cfg.pendingAuthority === newAdmin.publicKey.toBase58(), "authority + pending handover preserved");

    // ── new program before the pool exists ──
    await expectFail(mintOne(), /AccountNotInitialized|AccountOwnedByWrongProgram|3012|3007|AccountDiscriminator/, "mint before init_mint_pool");
    await initMintPool(conn, user); // permissionless (Config authority not needed)
    const fresh = await mintOne();
    const q = await fetchRevealQueue(conn, PID);
    assert(q.head === 0 && q.minted === 4 && q.entries.slice(0, 3).every((e) => e.nftMint === null) && q.entries[3].nftMint === fresh.toBase58(), "new mint queued behind 3 unrequested legacy entries");
    await expectFail(sendIxs(conn, [user], [buildSettleMintIx({ nftMint: fresh })], 200_000), "NotQueueHead", "new mint cannot jump the legacy queue");

    // ── legacy migration: anyone requests their VRF, then the queue settles in order ──
    for (const m of legacy) await sendIxs(conn, [user], [buildRequestMintVrfIx({ payer: user.publicKey, nftMint: m, attempt: 1, vrfTreasury: orao.treasury })]);
    await expectFail(
      sendIxs(conn, [user], [buildRequestMintVrfIx({ payer: user.publicKey, nftMint: legacy[0], attempt: 1, vrfTreasury: orao.treasury })]),
      "RevealAlreadyRequested",
      "legacy request twice"
    );
    const settled = await settleQueue(conn, orao, user);
    const order = [...legacy, fresh].map(String);
    assert(settled.map((s) => s.mint).join() === order.join(), `settled in mint order: ${settled.map((s) => s.mintIndex).join(",")}`);
    const mirror = new Uint16Array(10_000);
    const [collectionMint] = deriveCollectionMintPda(PID);
    for (let k = 0; k < settled.length; k++) {
      const s = settled[k];
      const want = poolTake(mirror, poolIndexFromRandomness(s.randomness, new PublicKey(s.mint), 10_000 - k), 10_000 - k);
      assert(s.tokenId === want && s.rarity === rarityToU8(getTokenRarity(want)), `#${k} id ${s.tokenId} == ${want}`);
      const md = parseMetadata((await conn.getAccountInfo(deriveMetadataPda(new PublicKey(s.mint))[0]))!.data);
      assert(md.name === `GreenCat #${want}` && md.uri === `${BASE}${want}.json` && md.collection?.verified && md.collection.key === collectionMint.toBase58(), `md ${md.name} ${md.uri}`);
      const rec = decodeNftRecordAccount(Buffer.from((await conn.getAccountInfo(deriveNftRecordPda(new PublicKey(s.mint), PID)[0]))!.data))!;
      assert(rec.revealed && rec.mintIndex === k, "record revealed");
    }
    const col = decodeCollectionAccount(Buffer.from((await conn.getAccountInfo(deriveCollectionPda(PID)[0]))!.data))!;
    assert(col.revealedCount === 4n && col.mintedCount === 4n, "counters");
    console.log(`[upgrade] legacy + new revealed: ${settled.map((s) => `#${s.mintIndex}→GreenCat #${s.tokenId}`).join(", ")}`);

    // handover can still be completed on the new program
    await sendIxs(conn, [newAdmin], [buildAcceptAuthorityIx({ newAuthority: newAdmin.publicKey })]);
    assert(decodeConfigAccount(Buffer.from((await conn.getAccountInfo(deriveConfigPda(PID)[0]))!.data))!.authority === newAdmin.publicKey.toBase58(), "accept after upgrade");
    console.log("UPGRADE MIGRATION PASS");
  } finally {
    ln.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
