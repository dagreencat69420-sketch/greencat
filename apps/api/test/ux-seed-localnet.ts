/**
 * Seed a long-running localnet for web UX screenshots (not part of CI).
 *
 *   UX_RPC_PORT=19500 UX_STATE=/tmp/gc-ux/state.json npx tsx apps/api/test/ux-seed-localnet.ts
 *
 * Phase A (immediately): init, funded pools, open mint with NFTs, listings, stakes, a Merkle airdrop,
 * Writes UX_STATE (mock wallet =
 * upgrade authority, $GC mint, proofs file).
 * bob's mints are revealed right away (instant per-mint reveal); one of mine stays "revealing…" until
 * phase B (touch $UX_STATE.b). An emulated ORAO fulfiller then answers every new request within ~1 s,
 * so mints from the web UI reveal like on devnet (the UI sends settle_mint itself).
 * Ctrl-C stops the validator. Localnet airdrops only; no real SOL.
 */
import fs from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent, createMint, getAssociatedTokenAddressSync, mintTo } from "@solana/spl-token";
import {
  PoolId,
  buildCreateAirdropIx,
  buildDepositTreasuryIx,
  buildListNftIx,
  buildMerkleTree,
  buildMintNftIx,
  fetchRevealQueue,
  mintVrfSeed,
  buildSetVrfExpiryIx,
  buildStakeDailyIx,
  buildStakeLongIx,
  deriveAirdropDistributionPda,
  GREENCAT_PROGRAM_ID,
  MINT_NFT_COMPUTE_UNITS,
} from "@greencat/sdk";
import { ROOT, SO_SHORT, PID, airdrop, fulfillOrao, initOrao, initProgram, sendIxs, settleQueue, sleep, startLocalnet } from "./localnet";

const UI = 1_000_000n;
const TOKEN = TOKEN_PROGRAM_ID;

async function main() {
  const port = Number(process.env.UX_RPC_PORT || 19500);
  const statePath = process.env.UX_STATE || "/tmp/gc-ux/state.json";
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const ln = await startLocalnet({ so: SO_SHORT, port, tag: "ux" });
  const { conn } = ln;
  process.on("SIGINT", () => (ln.stop(), process.exit(0)));
  process.on("SIGTERM", () => (ln.stop(), process.exit(0)));

  const me = ln.upgradeAuthority; // mock wallet: admin + player
  const bob = Keypair.generate();
  await airdrop(conn, bob.publicKey, 20);
  const orao = await initOrao(conn, me);
  const gcMint = await createMint(conn, me, me.publicKey, null, 6, undefined, undefined, TOKEN);
  const ata = (o: PublicKey) => createAssociatedTokenAccountIdempotent(conn, me, gcMint, o, {}, TOKEN);
  const meGc = await ata(me.publicKey);
  const bobGc = await ata(bob.publicKey);
  await mintTo(conn, me, gcMint, meGc, me, Number(2_000_000n * UI), [], undefined, TOKEN);
  await mintTo(conn, me, gcMint, bobGc, me, Number(300_000n * UI), [], undefined, TOKEN);
  await initProgram(ln, gcMint, TOKEN);
  const deposit = (poolId: PoolId, amount: bigint) =>
    sendIxs(conn, [me], [buildDepositTreasuryIx({ depositor: me.publicKey, depositorAta: meGc, gcMint, poolId, amountRaw: amount * UI, tokenProgramId: TOKEN })]);
  await deposit(PoolId.DailyRewards, 100_000n);
  await deposit(PoolId.LongRewards, 100_000n);
  await deposit(PoolId.Airdrop, 150_000n);

  const mintNft = async (who: Keypair, whoGc: PublicKey) => {
    const nft = Keypair.generate();
    await sendIxs(
      conn,
      [who, nft],
      [buildMintNftIx({ buyer: who.publicKey, nftMint: nft.publicKey, gcMint, buyerGcAta: whoGc, buyerNftAta: getAssociatedTokenAddressSync(nft.publicKey, who.publicKey, false, TOKEN), vrfTreasury: orao.treasury, tokenProgramId: TOKEN })],
      MINT_NFT_COMPUTE_UNITS
    );
    return nft.publicKey;
  };
  const bobNfts = [await mintNft(bob, bobGc), await mintNft(bob, bobGc), await mintNft(bob, bobGc)];
  const myNfts = [await mintNft(me, meGc), await mintNft(me, meGc)];
  await settleQueue(conn, orao, bob);
  myNfts.push(await mintNft(me, meGc)); // stays "revealing…" until phase B
  const list = (who: Keypair, m: PublicKey, price: bigint) =>
    sendIxs(conn, [who], [buildListNftIx({ seller: who.publicKey, nftMint: m, sellerNftAta: getAssociatedTokenAddressSync(m, who.publicKey, false, TOKEN), priceRaw: price * UI })]);
  await list(bob, bobNfts[0], 18_000n);
  await list(bob, bobNfts[1], 42_500n);
  await list(bob, bobNfts[2], 9_900n);
  await list(me, myNfts[2], 25_000n);

  await sendIxs(conn, [me], [buildStakeDailyIx({ staker: me.publicKey, gcMint, stakerAta: meGc, amountRaw: 25_000n * UI, tokenProgramId: TOKEN })]);
  await sendIxs(conn, [me], [buildStakeLongIx({ staker: me.publicKey, gcMint, stakerAta: meGc, amountRaw: 10_000n * UI, trancheId: 0n, tokenProgramId: TOKEN })]);

  // Merkle airdrop (30-day window) with the mock wallet in the snapshot.
  const distId = 1n;
  const [dist] = deriveAirdropDistributionPda(distId, PID);
  const entries = [
    { claimant: me.publicKey.toBase58(), amount: 12_345n * UI },
    { claimant: bob.publicKey.toBase58(), amount: 5_000n * UI },
  ];
  const tree = buildMerkleTree(dist, entries);
  const total = entries.reduce((a, e) => a + e.amount, 0n);
  const expiryTs = Math.floor(Date.now() / 1000) + 30 * 86_400;
  await sendIxs(conn, [me], [buildCreateAirdropIx({ authority: me.publicKey, gcMint, id: distId, merkleRoot: tree.root, totalAmountRaw: total, expiryTs: BigInt(expiryTs), tokenProgramId: TOKEN })]);
  const proofs = {
    version: 1,
    programId: GREENCAT_PROGRAM_ID,
    gcMint: gcMint.toBase58(),
    distributionId: distId.toString(),
    distribution: dist.toBase58(),
    merkleRoot: tree.root.toString("hex"),
    totalAmountRaw: total.toString(),
    expiryTs,
    claims: entries.map((e, i) => ({ index: i, claimant: e.claimant, amountRaw: e.amount.toString(), proof: tree.proof(i).map((b) => b.toString("hex")) })),
  };
  const proofsPath = path.join(path.dirname(statePath), "ux-proofs.json");
  fs.writeFileSync(proofsPath, JSON.stringify(proofs, null, 2));

  const state = { rpcUrl: ln.rpcUrl, mockWallet: me.publicKey.toBase58(), bob: bob.publicKey.toBase58(), gcMint: gcMint.toBase58(), proofsPath, myNfts: myNfts.map(String), bobNfts: bobNfts.map(String), phase: "A" };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`[ux] phase A ready: ${JSON.stringify(state)}`);

  const waitFor = async (f: string) => {
    while (!fs.existsSync(f)) await sleep(500);
  };
  await waitFor(statePath + ".b");
  fs.writeFileSync(statePath, JSON.stringify({ ...state, phase: "B" }, null, 2));
  console.log("[ux] phase B: emulated ORAO fulfiller running");
  for (;;) {
    try {
      const q = await fetchRevealQueue(conn, PID);
      for (const e of q.entries) if (e.nftMint && !e.fulfilled) await fulfillOrao(conn, orao, mintVrfSeed(new PublicKey(e.nftMint), e.attempt, PID));
    } catch (e) {
      console.error(String(e).slice(0, 200));
    }
    await sleep(1000);
  }
  void ROOT;
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
