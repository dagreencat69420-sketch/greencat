/**
 * ORAO VRF v2 helpers (audit GC-15 / GC-17).
 *
 * The program CPIs `orao_vrf::request_v2(seed)`; ORAO fulfils off-chain and writes the
 * 64-byte randomness into the request PDA; `settle_spin` / `settle_mint` consume it.
 * Seeds are derived exactly like `programs/greencat/src/vrf.rs`.
 *
 * `buildOraoInitNetworkIx` / `buildOraoFulfillIxs` are **localnet-only** emulation helpers
 * (Orao's documented test approach: load the ORAO program, `init_network` with your own
 * fulfillment authority, then sign the seed with that key and call `fulfill_v2`).
 */
import {
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { GREENCAT_PROGRAM_ID } from "./constants";

export const ORAO_VRF_PROGRAM_ID = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
export const ORAO_CONFIG_SEED = Buffer.from("orao-vrf-network-configuration");
export const ORAO_RANDOMNESS_SEED = Buffer.from("orao-vrf-randomness-request");

/** Per-mint reveal (instant reveal). */
export const MINT_VRF_DOMAIN = Buffer.from("greencat-mint-vrf-v1");

const ORAO_IX = {
  init_network: Buffer.from("68e74979f0000594", "hex"),
  fulfill_v2: Buffer.from("a4e3ed54706f93c4", "hex"),
};
export const ORAO_RANDOMNESS_V2_DISC = Buffer.from("8befb8d7e356bfe2", "hex");
export const ORAO_NETWORK_STATE_DISC = Buffer.from("d4ed943861f533a9", "hex");

function pid(p?: PublicKey) {
  return p || new PublicKey(GREENCAT_PROGRAM_ID);
}

function u64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export function deriveOraoNetworkStatePda(vrfProgram = ORAO_VRF_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([ORAO_CONFIG_SEED], vrfProgram)[0];
}

export function deriveOraoRandomnessPda(seed: Uint8Array, vrfProgram = ORAO_VRF_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([ORAO_RANDOMNESS_SEED, Buffer.from(seed)], vrfProgram)[0];
}

/** sha256(domain ‖ program ‖ nft_mint ‖ attempt_u8) — matches `vrf::mint_vrf_seed`. */
export function mintVrfSeed(nftMint: PublicKey, attempt: number, programId?: PublicKey): Buffer {
  return Buffer.from(
    sha256(Buffer.concat([MINT_VRF_DOMAIN, pid(programId).toBuffer(), nftMint.toBuffer(), Buffer.from([attempt & 0xff])]))
  );
}

export type DecodedOraoRandomness = {
  client: string;
  seed: Buffer;
  /** null while pending */
  randomness: Buffer | null;
};

/** Decode an ORAO RandomnessV2 account (pending or fulfilled). */
export function decodeOraoRandomness(data: Buffer | Uint8Array | null | undefined): DecodedOraoRandomness | null {
  if (!data) return null;
  const d = Buffer.from(data);
  if (d.length < 8 + 1 + 64 || !d.subarray(0, 8).equals(ORAO_RANDOMNESS_V2_DISC)) return null;
  const tag = d[8];
  const client = new PublicKey(d.subarray(9, 41)).toBase58();
  const seed = Buffer.from(d.subarray(41, 73));
  if (tag === 1) return { client, seed, randomness: Buffer.from(d.subarray(73, 137)) };
  return { client, seed, randomness: null };
}

export type DecodedOraoNetworkState = {
  authority: string;
  treasury: string;
  requestFee: bigint;
  fulfillmentAuthorities: string[];
};

export function decodeOraoNetworkState(data: Buffer | Uint8Array | null | undefined): DecodedOraoNetworkState | null {
  if (!data) return null;
  const d = Buffer.from(data);
  if (d.length < 8 + 32 + 32 + 8 + 4 || !d.subarray(0, 8).equals(ORAO_NETWORK_STATE_DISC)) return null;
  let o = 8;
  const authority = new PublicKey(d.subarray(o, o + 32)).toBase58();
  o += 32;
  const treasury = new PublicKey(d.subarray(o, o + 32)).toBase58();
  o += 32;
  const requestFee = d.readBigUInt64LE(o);
  o += 8;
  const n = d.readUInt32LE(o);
  o += 4;
  const fulfillmentAuthorities: string[] = [];
  for (let i = 0; i < n; i++) {
    fulfillmentAuthorities.push(new PublicKey(d.subarray(o, o + 32)).toBase58());
    o += 32;
  }
  return { authority, treasury, requestFee, fulfillmentAuthorities };
}

/** Localnet only: initialise a test ORAO network (your treasury + fulfillment authority). */
export function buildOraoInitNetworkIx(params: {
  payer: PublicKey;
  treasury: PublicKey;
  configAuthority: PublicKey;
  fulfillmentAuthorities: PublicKey[];
  feeLamports: bigint;
  vrfProgram?: PublicKey;
}): TransactionInstruction {
  const vrf = params.vrfProgram || ORAO_VRF_PROGRAM_ID;
  const n = params.fulfillmentAuthorities.length;
  const data = Buffer.alloc(8 + 8 + 32 + 4 + 32 * n + 1);
  let o = 0;
  ORAO_IX.init_network.copy(data, o);
  o += 8;
  data.writeBigUInt64LE(params.feeLamports, o);
  o += 8;
  params.configAuthority.toBuffer().copy(data, o);
  o += 32;
  data.writeUInt32LE(n, o);
  o += 4;
  for (const k of params.fulfillmentAuthorities) {
    k.toBuffer().copy(data, o);
    o += 32;
  }
  data[o] = 0; // token_fee_config: None
  return new TransactionInstruction({
    programId: vrf,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: deriveOraoNetworkStatePda(vrf), isSigner: false, isWritable: true },
      { pubkey: params.treasury, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Localnet only: emulate an ORAO fulfilment. `signature` = ed25519 signature of `seed`
 * by a configured fulfillment authority; `client` comes from the pending request account.
 */
export function buildOraoFulfillIxs(params: {
  payer: PublicKey;
  seed: Uint8Array;
  client: PublicKey;
  fulfillmentAuthority: PublicKey;
  signature: Uint8Array;
  vrfProgram?: PublicKey;
}): TransactionInstruction[] {
  const vrf = params.vrfProgram || ORAO_VRF_PROGRAM_ID;
  return [
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: params.fulfillmentAuthority.toBytes(),
      message: Buffer.from(params.seed),
      signature: params.signature,
    }),
    new TransactionInstruction({
      programId: vrf,
      keys: [
        { pubkey: params.payer, isSigner: true, isWritable: true },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: deriveOraoNetworkStatePda(vrf), isSigner: false, isWritable: true },
        { pubkey: deriveOraoRandomnessPda(params.seed, vrf), isSigner: false, isWritable: true },
        { pubkey: params.client, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(ORAO_IX.fulfill_v2),
    }),
  ];
}

/** Mirror of on-chain `pool_index_from_randomness`: sha256(domain ‖ randomness ‖ nft_mint) → u64le % remaining. */
export function poolIndexFromRandomness(randomness: Uint8Array, nftMint: PublicKey, remaining: number): number {
  const h = Buffer.from(sha256(Buffer.concat([MINT_VRF_DOMAIN, Buffer.from(randomness), nftMint.toBuffer()])));
  return Number(h.readBigUInt64LE(0) % BigInt(remaining));
}
