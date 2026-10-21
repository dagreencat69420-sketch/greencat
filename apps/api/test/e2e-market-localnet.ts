/**
 * Localnet marketplace + mint/reveal e2e (audit round 2). Fully offline (fixtures).
 *
 *  init (upgrade authority) → collection + verified collection NFT (PDA update authority)
 *  → 2 mints (verified collection item, 5% royalty to the fee-treasury PDA, ORAO request per mint)
 *  → emulated fulfil → settle_mint ×2 (instant per-mint reveal, FIFO, swap-and-pop pool)
 *  → list → buy (expected_price) → offer → accept (min_amount)
 *  → indexer pollOnce → /listings, /nft/:mint (revealed ids), trades → /bonus mint + list.
 *
 *   npm run test:e2e:market --workspace=@greencat/api      (GC_TOKEN=spl|token2022, default spl)
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import {
  MINT_NFT_COMPUTE_UNITS,
  PoolId,
  buildAcceptOfferIx,
  buildBuyNftIx,
  buildListNftIx,
  buildMakeOfferIx,
  buildMintNftIx,
  decodeCollectionAccount,
  decodeNftRecordAccount,
  deriveCollectionMintPda,
  deriveCollectionPda,
  deriveMetadataPda,
  deriveNftAuthorityPda,
  deriveNftRecordPda,
  deriveTreasuryPda,
  getTokenRarity,
  rarityToU8,
  poolIndexFromRandomness,
  poolTake,
} from "@greencat/sdk";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { migrate, openDb } from "../src/db";
import { pollOnce } from "../src/indexer/worker";
import { PID, airdrop, assert, initOrao, initProgram, parseMetadata, sendIxs, settleQueue, startLocalnet } from "./localnet";

const UI = 1_000_000n;
const TOKEN = process.env.GC_TOKEN === "token2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

async function main() {
  const ln = await startLocalnet({ port: Number(process.env.E2E_RPC_PORT || 18899), tag: "e2e-market" });
  const { conn, rpcUrl } = ln;
  try {
    const admin = ln.upgradeAuthority;
    const seller = Keypair.generate();
    const buyer = Keypair.generate();
    await airdrop(conn, seller.publicKey, 20);
    await airdrop(conn, buyer.publicKey, 20);
    const orao = await initOrao(conn, admin);
    const gcMint = await createMint(conn, admin, admin.publicKey, null, 6, undefined, undefined, TOKEN);
    const ata = async (owner: PublicKey) => createAssociatedTokenAccountIdempotent(conn, admin, gcMint, owner, {}, TOKEN);
    const sellerGc = await ata(seller.publicKey);
    const buyerGc = await ata(buyer.publicKey);
    await mintTo(conn, admin, gcMint, sellerGc, admin, Number(50_000n * UI), [], undefined, TOKEN);
    await mintTo(conn, admin, gcMint, buyerGc, admin, Number(50_000n * UI), [], undefined, TOKEN);
    await initProgram(ln, gcMint, TOKEN);

    // ── collection NFT checks (GC-18) ──
    const [nftAuthority] = deriveNftAuthorityPda(PID);
    const [collectionMint] = deriveCollectionMintPda(PID);
    const [feeTreasury] = deriveTreasuryPda(PoolId.NftFeeTreasury, PID);
    const colMd = parseMetadata((await conn.getAccountInfo(deriveMetadataPda(collectionMint)[0]))!.data);
    assert(colMd.updateAuthority === nftAuthority.toBase58(), "collection update authority = nft_authority PDA");
    console.log(`[e2e-market] collection NFT ${collectionMint.toBase58().slice(0, 8)}… update authority = PDA`);

    // ── 2 mints by the seller (placeholder metadata until settle_mint, seconds later) ──
    const mints: PublicKey[] = [];
    let mintSig = "";
    for (let i = 0; i < 2; i++) {
      const nft = Keypair.generate();
      const nftAta = getAssociatedTokenAddressSync(nft.publicKey, seller.publicKey, false, TOKEN_PROGRAM_ID);
      mintSig = await sendIxs(
        conn,
        [seller, nft],
        [buildMintNftIx({ buyer: seller.publicKey, nftMint: nft.publicKey, gcMint, buyerGcAta: sellerGc, buyerNftAta: nftAta, vrfTreasury: orao.treasury, tokenProgramId: TOKEN })],
        MINT_NFT_COMPUTE_UNITS
      );
      mints.push(nft.publicKey);
    }
    const md0 = parseMetadata((await conn.getAccountInfo(deriveMetadataPda(mints[0])[0]))!.data);
    assert(md0.updateAuthority === nftAuthority.toBase58(), "item update authority = PDA");
    assert(md0.collection?.verified && md0.collection.key === collectionMint.toBase58(), "verified collection item");
    assert(md0.sellerFeeBasisPoints === 500, `royalty 500 bps (got ${md0.sellerFeeBasisPoints})`);
    assert(
      md0.creators.length === 2 &&
        md0.creators[0].address === nftAuthority.toBase58() && md0.creators[0].verified && md0.creators[0].share === 0 &&
        md0.creators[1].address === feeTreasury.toBase58() && md0.creators[1].share === 100,
      `creators ${JSON.stringify(md0.creators)}`
    );
    assert(md0.name === "GreenCat Mint #1" && md0.uri.endsWith("unrevealed.json"), `placeholder ${md0.name} ${md0.uri}`);
    console.log("[e2e-market] 2 mints (revealing…): verified collection, PDA update authority, 500 bps → fee-treasury PDA");

    // ── instant per-mint reveal (GC-17): ORAO fulfil → settle_mint (FIFO head) ──
    const settled = await settleQueue(conn, orao, buyer);
    assert(settled.length === 2 && settled.map((x) => x.mint).join() === mints.map((m) => m.toBase58()).join(), "settled in mint order");
    const mirror = new Uint16Array(10_000);
    const tokenIds: number[] = [];
    for (let i = 0; i < settled.length; i++) {
      const want = poolTake(mirror, poolIndexFromRandomness(settled[i].randomness, mints[i], 10_000 - i), 10_000 - i);
      const rec = decodeNftRecordAccount((await conn.getAccountInfo(deriveNftRecordPda(mints[i], PID)[0]))!.data)!;
      assert(rec.revealed && rec.tokenId === want, `token id ${rec.tokenId} == mirror ${want}`);
      assert(rec.rarity === rarityToU8(getTokenRarity(want)), "rarity from the fixed catalog");
      const md = parseMetadata((await conn.getAccountInfo(deriveMetadataPda(mints[i])[0]))!.data);
      assert(md.name === `GreenCat #${want}` && md.uri.endsWith(`/${want}.json`) && md.collection?.verified, `revealed md ${md.name}`);
      tokenIds.push(want);
    }
    assert(tokenIds[0] !== tokenIds[1], "distinct ids");
    const col = decodeCollectionAccount((await conn.getAccountInfo(deriveCollectionPda(PID)[0]))!.data)!;
    assert(col.revealedCount === 2n, "revealedCount 2");
    console.log(`[e2e-market] instant reveal → token ids ${tokenIds.join(", ")} (VRF per mint, swap-and-pop, metadata updated by PDA)`);

    // ── list → buy (expected_price) ──
    const price = 1_000n * UI;
    const sellerNft0 = getAssociatedTokenAddressSync(mints[0], seller.publicKey, false, TOKEN_PROGRAM_ID);
    const listSig = await sendIxs(conn, [seller], [buildListNftIx({ seller: seller.publicKey, nftMint: mints[0], sellerNftAta: sellerNft0, priceRaw: price })]);
    const before = (await getAccount(conn, sellerGc, "confirmed", TOKEN)).amount;
    await sendIxs(conn, [buyer], [
      buildBuyNftIx({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        nftMint: mints[0],
        gcMint,
        buyerGcAta: buyerGc,
        sellerGcAta: sellerGc,
        buyerNftAta: getAssociatedTokenAddressSync(mints[0], buyer.publicKey, false, TOKEN_PROGRAM_ID),
        expectedPriceRaw: price,
        tokenProgramId: TOKEN,
      }),
    ]);
    const after = (await getAccount(conn, sellerGc, "confirmed", TOKEN)).amount;
    assert(after - before === (price * 99n) / 100n, `seller net 99% (${after - before})`);
    console.log("[e2e-market] list → buy with expected_price: seller +99%, 1% fee");

    // ── offer → accept (min_amount) ──
    const offer = 500n * UI;
    await sendIxs(conn, [buyer], [buildMakeOfferIx({ bidder: buyer.publicKey, nftMint: mints[1], gcMint, bidderGcAta: buyerGc, amountRaw: offer, tokenProgramId: TOKEN })]);
    await sendIxs(conn, [seller], [
      buildAcceptOfferIx({
        owner: seller.publicKey,
        bidder: buyer.publicKey,
        nftMint: mints[1],
        gcMint,
        ownerGcAta: sellerGc,
        ownerNftAta: getAssociatedTokenAddressSync(mints[1], seller.publicKey, false, TOKEN_PROGRAM_ID),
        bidderNftAta: getAssociatedTokenAddressSync(mints[1], buyer.publicKey, false, TOKEN_PROGRAM_ID),
        minAmountRaw: offer,
        tokenProgramId: TOKEN,
      }),
    ]);
    console.log("[e2e-market] offer → accept with min_amount");

    // ── indexer + API ──
    const db = await openDb("pglite:memory");
    await migrate(db);
    const r = await pollOnce({ db, connection: conn, programId: PID.toBase58() });
    console.log(`[e2e-market] indexed txs=${r.txs} events=${r.events}`);
    const { rows: nfts } = await db.query<{ mint: string; token_id: number | null; minted_sig: string }>(
      "SELECT mint, token_id, minted_sig FROM nfts WHERE minted_sig IS NOT NULL ORDER BY token_id"
    );
    assert(nfts.length === 2 && nfts.every((n) => n.token_id !== null), `indexer: 2 revealed nfts ${JSON.stringify(nfts)}`);
    assert(
      [...nfts.map((n) => Number(n.token_id))].sort().join() === [...tokenIds].sort().join(),
      "indexer token ids match on-chain reveal"
    );
    const { rows: trades } = await db.query<{ kind: string }>("SELECT kind FROM trades ORDER BY slot");
    assert(trades.map((t) => t.kind).join() === "buy,accept_offer", `trades ${JSON.stringify(trades)}`);

    const cfg = loadConfig({ NODE_ENV: "test", JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret-00000", RPC_URL: rpcUrl } as NodeJS.ProcessEnv);
    const app = createApp({ db, config: cfg });
    const call = async (method: string, p: string, body?: unknown, token?: string) => {
      const res = await app.request(p, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: (await res.json()) as any };
    };
    const sold = await call("GET", `/nft/${mints[0].toBase58()}`);
    assert(sold.status === 200 && sold.json.tokenId === tokenIds[0] && sold.json.owner === buyer.publicKey.toBase58(), `/nft ${JSON.stringify(sold.json)}`);
    assert(sold.json.trades[0]?.kind === "buy" && sold.json.listing.active === false, "/nft trades + closed listing");
    console.log(`[e2e-market] /nft/${mints[0].toBase58().slice(0, 6)}… token #${sold.json.tokenId} ${sold.json.rarity} owner=buyer`);

    const n = await call("POST", "/auth/nonce", { wallet: seller.publicKey.toBase58() });
    const sig = nacl.sign.detached(new TextEncoder().encode(n.json.message), seller.secretKey);
    const token = (await call("POST", "/auth/verify", { wallet: seller.publicKey.toBase58(), nonce: n.json.nonce, signature: Buffer.from(sig).toString("base64") })).json.token as string;
    const bm = await call("POST", "/bonus", { kind: "mint", signature: mintSig }, token);
    assert(bm.status === 200 && bm.json.gained === 15, `mint bonus ${JSON.stringify(bm.json)}`);
    assert((await call("POST", "/bonus", { kind: "mint", signature: mintSig }, token)).status === 409, "mint replay 409");
    const bl = await call("POST", "/bonus", { kind: "list", signature: listSig }, token);
    // Listing points are deferred: registered now (pending), credited after 10 min active.
    assert(bl.status === 202 && bl.json.pending === true && bl.json.gained === 0, `list bonus ${JSON.stringify(bl.json)}`);
    console.log("[e2e-market] /bonus mint (+15, replay 409) and list (pending, +10 after 10 min) verified on real txs");
    await db.close();
    console.log(`E2E MARKET PASS (${TOKEN.equals(TOKEN_PROGRAM_ID) ? "spl" : "token2022"})`);
  } finally {
    ln.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
