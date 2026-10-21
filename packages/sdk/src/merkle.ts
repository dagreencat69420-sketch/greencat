/**
 * Merkle airdrop tree (audit GC-22). Must match programs/greencat/src/airdrop.rs:
 *   leaf = sha256(0x00 ‖ distribution ‖ index u64le ‖ claimant ‖ amount u64le)
 *   node = sha256(0x01 ‖ min(a,b) ‖ max(a,b))     (sorted pairs, odd node promoted)
 */
import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { GREENCAT_PROGRAM_ID } from "./constants";

export const AIRDROP_DIST_SEED = Buffer.from("airdrop_dist");
export const AIRDROP_CLAIM_SEED = Buffer.from("airdrop_claim");
export const MAX_PROOF_LEN = 32;

function u64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export function deriveAirdropDistributionPda(id: bigint | number, programId?: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [AIRDROP_DIST_SEED, u64le(id)],
    programId || new PublicKey(GREENCAT_PROGRAM_ID)
  );
}

export function deriveAirdropClaimPda(
  distribution: PublicKey,
  index: bigint | number,
  programId?: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [AIRDROP_CLAIM_SEED, distribution.toBuffer(), u64le(index)],
    programId || new PublicKey(GREENCAT_PROGRAM_ID)
  );
}

export function merkleLeaf(distribution: PublicKey, index: bigint | number, claimant: PublicKey, amount: bigint): Buffer {
  return Buffer.from(
    sha256(Buffer.concat([Buffer.from([0]), distribution.toBuffer(), u64le(index), claimant.toBuffer(), u64le(amount)]))
  );
}

export function merkleNode(a: Buffer, b: Buffer): Buffer {
  const [l, r] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(sha256(Buffer.concat([Buffer.from([1]), l, r])));
}

export type AirdropEntry = { claimant: string; amount: bigint };

export type MerkleTree = {
  root: Buffer;
  layers: Buffer[][];
  leaves: Buffer[];
  proof(index: number): Buffer[];
};

export function buildMerkleTree(distribution: PublicKey, entries: AirdropEntry[]): MerkleTree {
  if (entries.length === 0) throw new Error("empty airdrop");
  const leaves = entries.map((e, i) => merkleLeaf(distribution, i, new PublicKey(e.claimant), e.amount));
  const layers: Buffer[][] = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? merkleNode(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  return {
    root: layers[layers.length - 1][0],
    layers,
    leaves,
    proof(index: number) {
      const p: Buffer[] = [];
      let i = index;
      for (const l of layers.slice(0, -1)) {
        const sib = i ^ 1;
        if (sib < l.length) p.push(l[sib]);
        i = Math.floor(i / 2);
      }
      return p;
    },
  };
}

export function verifyMerkleProof(proof: Buffer[], root: Buffer, leaf: Buffer): boolean {
  let h = leaf;
  for (const p of proof) h = merkleNode(h, p);
  return h.equals(root);
}
