import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildMerkleTree,
  merkleLeaf,
  merkleNode,
  verifyMerkleProof,
  mintVrfSeed,
  poolIndexFromRandomness,
  poolGet,
  poolTake,
  decodeMintPool,
  MINT_POOL_LEN,
  MINT_POOL_DISC,
  buildMintNftIx,
  decodeOraoRandomness,
  ORAO_RANDOMNESS_SEED,
  getRarityTable,
  RARITY_COUNTS,
  buildBuyNftIx,
  buildAcceptOfferIx,
  parseProgramLogs,
} from "../src/index";

const A = new PublicKey(Buffer.alloc(32, 1));
const B = new PublicKey(Buffer.alloc(32, 2));
const P = new PublicKey(Buffer.alloc(32, 3));

describe("on-chain parity vectors (same values asserted in lib.rs sdk_parity_vectors)", () => {
  it("merkle leaf/node", () => {
    expect(merkleLeaf(A, 7, B, 1000n).toString("hex")).toBe(
      "b5658ac0e1c023da1eb4c882a865d90fa6cf62fa6f6c397ab0bf33c87b2aba30"
    );
    expect(merkleNode(Buffer.alloc(32, 9), Buffer.alloc(32, 4)).toString("hex")).toBe(
      "9bfb1d42619a095d43c65a1d2f3b201a184e512c14cc6dfdff55838d7ee8bdb8"
    );
  });
  it("vrf seed + mapping", () => {
    expect(mintVrfSeed(A, 1, P).toString("hex")).toBe(
      "c77b282c19d31f3a8b20ca0d5bbcf4ebe3c2114289c2bdc7468538fb49e5174d"
    );
    expect(poolIndexFromRandomness(Buffer.alloc(64, 5), A, 10_000)).toBe(9818);
  });
});

describe("merkle airdrop tree (GC-22)", () => {
  const dist = Keypair.generate().publicKey;
  const entries = Array.from({ length: 13 }, (_, i) => ({
    claimant: Keypair.generate().publicKey.toBase58(),
    amount: BigInt(1000 + i),
  }));
  const tree = buildMerkleTree(dist, entries);
  it("every proof verifies", () => {
    entries.forEach((e, i) => {
      expect(verifyMerkleProof(tree.proof(i), tree.root, merkleLeaf(dist, i, new PublicKey(e.claimant), e.amount))).toBe(true);
    });
  });
  it("negatives: wrong amount / claimant / index fail", () => {
    const e = entries[3];
    const p = tree.proof(3);
    expect(verifyMerkleProof(p, tree.root, merkleLeaf(dist, 3, new PublicKey(e.claimant), e.amount + 1n))).toBe(false);
    expect(verifyMerkleProof(p, tree.root, merkleLeaf(dist, 3, Keypair.generate().publicKey, e.amount))).toBe(false);
    expect(verifyMerkleProof(p, tree.root, merkleLeaf(dist, 4, new PublicKey(e.claimant), e.amount))).toBe(false);
  });
});

describe("per-mint reveal pool (GC-17)", () => {
  it("swap-and-pop hands out every id once with exact rarity counts", () => {
    const table = getRarityTable();
    const ids = new Uint16Array(10_000);
    const seen = new Set<number>();
    const counts: Record<string, number> = {};
    for (let k = 0; k < 10_000; k++) {
      const remaining = 10_000 - k;
      const r = Buffer.alloc(64);
      r.writeUInt32LE(k, 0);
      const j = poolIndexFromRandomness(r, A, remaining);
      expect(j).toBeLessThan(remaining);
      const id = poolTake(ids, j, remaining);
      seen.add(id);
      counts[table[id - 1]] = (counts[table[id - 1]] || 0) + 1;
    }
    expect(seen.size).toBe(10_000);
    expect(counts).toEqual(RARITY_COUNTS);
  });
  it("pool edges + decode", () => {
    const ids = new Uint16Array(5);
    expect(poolTake(ids, 4, 5)).toBe(5);
    expect(poolTake(ids, 0, 4)).toBe(1);
    expect(poolGet(ids, 0)).toBe(4);
    expect(MINT_POOL_LEN).toBe(32_296);
    expect(decodeMintPool(Buffer.alloc(MINT_POOL_LEN))).toBeNull(); // no discriminator yet = still growing
    const d = Buffer.alloc(MINT_POOL_LEN);
    MINT_POOL_DISC.copy(d, 0);
    d.writeUInt16LE(77, 8);
    A.toBuffer().copy(d, 8 + 20_000 + 48 * 3);
    d[8 + 20_000 + 48 * 3 + 40] = 2;
    const p = decodeMintPool(d)!;
    expect(poolGet(p.ids, 0)).toBe(77);
    expect(p.queue[3]).toMatchObject({ nftMint: A.toBase58(), attempt: 2 });
    expect(p.queue[4].nftMint).toBeNull();
  });
  it("mint_nft carries the ORAO request for attempt 1", () => {
    const ix = buildMintNftIx({ buyer: A, nftMint: B, gcMint: P, buyerGcAta: P, buyerNftAta: P, vrfTreasury: P, programId: P });
    expect(ix.keys.length).toBe(27);
  });
});

describe("market builders (GC-21)", () => {
  it("buy/accept encode slippage", () => {
    const buy = buildBuyNftIx({
      buyer: A, seller: B, nftMint: P, gcMint: P, buyerGcAta: P, sellerGcAta: P, buyerNftAta: P, expectedPriceRaw: 77n,
    });
    expect(buy.data.readBigUInt64LE(8)).toBe(77n);
    const acc = buildAcceptOfferIx({
      owner: A, bidder: B, nftMint: P, gcMint: P, ownerGcAta: P, ownerNftAta: P, bidderNftAta: P, minAmountRaw: 55n,
    });
    expect(acc.data.readBigUInt64LE(8)).toBe(55n);
  });
});

describe("ORAO account decode", () => {
  it("pending vs fulfilled", () => {
    const disc = Buffer.from("8befb8d7e356bfe2", "hex");
    const pending = Buffer.concat([disc, Buffer.from([0]), A.toBuffer(), Buffer.alloc(32, 7), Buffer.alloc(4)]);
    expect(decodeOraoRandomness(Buffer.concat([pending, Buffer.alloc(64)]))?.randomness).toBeNull();
    const ful = Buffer.concat([disc, Buffer.from([1]), A.toBuffer(), Buffer.alloc(32, 7), Buffer.alloc(64, 8)]);
    expect(decodeOraoRandomness(ful)?.randomness?.equals(Buffer.alloc(64, 8))).toBe(true);
    expect(ORAO_RANDOMNESS_SEED.toString()).toBe("orao-vrf-randomness-request");
  });
});

describe("indexer log parsing", () => {
  it("parses unrevealed mint + reveal lines", () => {
    const ev = parseProgramLogs([
      "Program log: mint_nft: mint_index=4 buyer=Buyer1 mint=Mint1 (unrevealed)",
      "Program log: reveal_nft: mint=Mint1 mint_index=4 token_id=7000 rarity=rare",
    ]);
    expect(ev).toEqual([
      { type: "nft_minted", tokenId: 0, rarity: 255, buyer: "Buyer1", nftMint: "Mint1", mintIndex: 4 },
      { type: "nft_revealed", nftMint: "Mint1", mintIndex: 4, tokenId: 7000, rarity: 2 },
    ]);
  });
});
