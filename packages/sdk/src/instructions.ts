/**
 * Manual Anchor instruction builders (no IDL required).
 * Discriminators = sha256("global:<name>")[0..8].
 */

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
// Buffer is global via Next/web3 polyfill
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { GREENCAT_PROGRAM_ID } from "./constants";
import {
  ALL_POOL_IDS,
  deriveConfigPda,
  deriveTreasuryPda,
  PoolId,
  type TreasuryAddresses,
  deriveAllTreasuryAddresses,
} from "./treasuries";
import {
  deriveCollectionPda,
  deriveNftRecordPda,
  deriveMetadataPda,
  deriveMasterEditionPda,
  deriveNftAuthorityPda,
  deriveCollectionMintPda,
  TOKEN_METADATA_PROGRAM_ID,
} from "./collection";
import {
  ORAO_VRF_PROGRAM_ID,
  deriveOraoNetworkStatePda,
  deriveOraoRandomnessPda,
  mintVrfSeed,
} from "./vrf";
import { deriveMintPoolPda } from "./mintPool";
import { deriveAirdropDistributionPda, deriveAirdropClaimPda } from "./merkle";
import {
  deriveListingPda,
  deriveOfferPda,
  deriveListingEscrowNftAta,
  deriveOfferGcEscrowAta,
} from "./marketplace";
import {
  deriveDailyStakePda,
  deriveLongStatePda,
  deriveLongTranchePda,
  deriveDailyPrincipalPda,
  deriveLongPrincipalPda,
  deriveDailyPrincipalVaultAta,
  deriveLongPrincipalVaultAta,
} from "./stake";

export const IX_DISCRIMINATORS = {
  initialize_treasuries: Buffer.from("df44aff3581d1713", "hex"),
  initialize_collection: Buffer.from("703e358bad98625d", "hex"),
  create_collection_nft: Buffer.from("39bb9dfe6e1314fd", "hex"),
  set_royalty: Buffer.from("4823aaa22f0d5607", "hex"),
  close_mint: Buffer.from("95fb9dd441b5eb81", "hex"),
  deposit_treasury: Buffer.from("028148d6325e97e6", "hex"),
  withdraw_treasury: Buffer.from("283f7a9e90d85360", "hex"),
  mint_nft: Buffer.from("d33906a70fdb23fb", "hex"),
  init_mint_pool: Buffer.from("931275c703f06c79", "hex"),
  request_mint_vrf: Buffer.from("e6ba66b73eb83749", "hex"),
  settle_mint: Buffer.from("c9a8a4e9aa522860", "hex"),
  list_nft: Buffer.from("58dd5da63fdc6ae8", "hex"),
  cancel_listing: Buffer.from("29b732e8e6e99d46", "hex"),
  buy_nft: Buffer.from("60001cbe316b53de", "hex"),
  make_offer: Buffer.from("d66261233b0c2cb2", "hex"),
  cancel_offer: Buffer.from("5ccbdf285c593577", "hex"),
  accept_offer: Buffer.from("e352ea8301123002", "hex"),
  stake_daily: Buffer.from("63b7633c888f253f", "hex"),
  add_daily: Buffer.from("fce902ae4e0aa603", "hex"),
  claim_daily: Buffer.from("0de2999a1ba86f67", "hex"),
  unstake_daily: Buffer.from("8bb8d016688226b9", "hex"),
  stake_long: Buffer.from("bff72252424b89cb", "hex"),
  claim_long: Buffer.from("a543e509d763f519", "hex"),
  propose_authority: Buffer.from("1494ecc64c77638e", "hex"),
  accept_authority: Buffer.from("6b56c65b210c6ba0", "hex"),
  set_paused: Buffer.from("5b3c7dc0b0e1a6da", "hex"),
  set_vrf_expiry: Buffer.from("e2eec837fbe53af4", "hex"),
  set_staking_enabled: Buffer.from("a3f08842f8f99473", "hex"),
  set_airdrop_threshold: Buffer.from("f53a0b41fd48b49c", "hex"),
  sweep_fee_treasury_sol: Buffer.from("da60aad704eb9244", "hex"),
  create_airdrop: Buffer.from("e387d04289b1505e", "hex"),
  claim_airdrop: Buffer.from("89327a6f59fe0814", "hex"),
  reclaim_airdrop: Buffer.from("5b88e04496dd12cf", "hex"),
} as const;

export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

/** ProgramData account of an upgradeable program (audit GC-20 init gating). */
export function deriveProgramDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_PROGRAM_ID)[0];
}

function meta(
  pubkey: PublicKey,
  isSigner: boolean,
  isWritable: boolean
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } {
  return { pubkey, isSigner, isWritable };
}

export function resolveTokenProgram(tokenProgramId?: PublicKey): PublicKey {
  return tokenProgramId || TOKEN_2022_PROGRAM_ID;
}

/** Derive vault ATA for a treasury PDA (allowOwnerOffCurve for PDA owner). */
export function deriveTreasuryVaultAta(
  mint: PublicKey,
  treasuryPda: PublicKey,
  tokenProgramId: PublicKey = TOKEN_2022_PROGRAM_ID
): PublicKey {
  return getAssociatedTokenAddressSync(
    mint,
    treasuryPda,
    true,
    tokenProgramId
  );
}

/** initialize_treasuries creates 6 vault ATAs (Token-2022 ATAs cost more) → raise the CU limit. */
export const INIT_TREASURIES_COMPUTE_UNITS = 400_000;

export type InitTreasuriesParams = {
  authority: PublicKey;
  gcMint: PublicKey;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

export function buildInitializeTreasuriesIx(
  params: InitTreasuriesParams
): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);

  const keys = [
    meta(params.authority, true, true),
    meta(config, false, true),
    meta(params.gcMint, false, false),
  ];

  for (const poolId of ALL_POOL_IDS) {
    const [pda] = deriveTreasuryPda(poolId, programId);
    const vault = deriveTreasuryVaultAta(params.gcMint, pda, tokenProgram);
    keys.push(meta(pda, false, false));
    keys.push(meta(vault, false, true));
  }

  keys.push(
    meta(tokenProgram, false, false),
    meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    meta(SystemProgram.programId, false, false),
    // audit GC-20: signer must be the program's upgrade authority
    meta(programId, false, false),
    meta(deriveProgramDataAddress(programId), false, false)
  );

  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(IX_DISCRIMINATORS.initialize_treasuries),
  });
}

export type DepositParams = {
  depositor: PublicKey;
  depositorAta: PublicKey;
  gcMint: PublicKey;
  poolId: PoolId;
  amountRaw: bigint;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

export function buildDepositTreasuryIx(
  params: DepositParams
): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [treasury] = deriveTreasuryPda(params.poolId, programId);
  const vault = deriveTreasuryVaultAta(params.gcMint, treasury, tokenProgram);

  const data = Buffer.alloc(8 + 1 + 8);
  IX_DISCRIMINATORS.deposit_treasury.copy(data, 0);
  data.writeUInt8(params.poolId, 8);
  data.writeBigUInt64LE(params.amountRaw, 9);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.depositor, true, false),
      meta(config, false, true),
      meta(params.gcMint, false, false),
      meta(treasury, false, false),
      meta(vault, false, true),
      meta(params.depositorAta, false, true),
      meta(tokenProgram, false, false),
    ],
    data,
  });
}

export type WithdrawParams = {
  authority: PublicKey;
  destinationAta: PublicKey;
  gcMint: PublicKey;
  poolId: PoolId;
  amountRaw: bigint;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

export function buildWithdrawTreasuryIx(
  params: WithdrawParams
): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [treasury] = deriveTreasuryPda(params.poolId, programId);
  const vault = deriveTreasuryVaultAta(params.gcMint, treasury, tokenProgram);

  const data = Buffer.alloc(8 + 1 + 8);
  IX_DISCRIMINATORS.withdraw_treasury.copy(data, 0);
  data.writeUInt8(params.poolId, 8);
  data.writeBigUInt64LE(params.amountRaw, 9);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.authority, true, false),
      meta(config, false, true),
      meta(params.gcMint, false, false),
      meta(treasury, false, false),
      meta(vault, false, true),
      meta(params.destinationAta, false, true),
      meta(tokenProgram, false, false),
    ],
    data,
  });
}

export type SetThresholdParams = {
  authority: PublicKey;
  minHoldingRaw: bigint;
  programId?: PublicKey;
};

export function buildSetAirdropThresholdIx(
  params: SetThresholdParams
): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const [config] = deriveConfigPda(programId);
  const data = Buffer.alloc(8 + 8);
  IX_DISCRIMINATORS.set_airdrop_threshold.copy(data, 0);
  data.writeBigUInt64LE(params.minHoldingRaw, 8);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.authority, true, false),
      meta(config, false, true),
    ],
    data,
  });
}

/** Decode on-chain Config account data (312 bytes; see programs/greencat/src/lib.rs). */
export type DecodedConfig = {
  authority: string;
  gcMint: string;
  tokenProgram: string;
  bump: number;
  bumps: {
    dailyRewards: number;
    longRewards: number;
    wheelBank: number;
    nftFeeTreasury: number;
    mintProceeds: number;
    airdrop: number;
  };
  paused: boolean;
  airdropMinHolding: bigint;
  dailyPayoutAllowance: bigint;
  wheelPayoutAllowance: bigint;
  longStakeCapacity: bigint;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  dailyLifetimePaid: bigint;
  longStaked: bigint;
  /** $GC in the airdrop vault reserved for open Merkle distributions (GC-22). */
  airdropReserved: bigint;
  /** Sum of owed 365-day bonuses (withdraw floor of pool 1). */
  longBonusOutstanding: bigint;
  wheelLifetimePaid: bigint;
  wheelLifetimeLost: bigint;
  /** Sum of edge-adjusted wins reserved for pending spins (GC-09). */
  wheelReserved: bigint;
  /** Proposed authority (two-step handover, GC-19); default key = none. */
  pendingAuthority: string;
  wheelMinBet: bigint;
  wheelMaxBet: bigint;
  vrfExpirySecs: bigint;
  lastPauseChangeTs: bigint;
  wheelHouseEdgeBps: number;
  /** Raw `Config.staking_enabled` byte (only meaningful when `stakingFlagSet`). */
  stakingEnabledRaw: boolean;
  /** `Config.staking_flag_set`: false on a Config created before the staking-switch upgrade. */
  stakingFlagSet: boolean;
  /**
   * Effective switch, same rule as the program's `staking_enabled()`: new stakes (daily + 365) are allowed
   * when the flag was never written (pre-upgrade Config) or is set to enabled. Unstake/claim are never gated.
   */
  stakingEnabled: boolean;
};

export const CONFIG_ACCOUNT_LEN = 312;
/** Byte offsets of the staking switch inside Config (old `_reserved[0..2]`). */
export const CONFIG_STAKING_ENABLED_OFFSET = 282;
export const CONFIG_STAKING_FLAG_SET_OFFSET = 283;

/** Program rule for the staking switch (mirror of `staking_enabled()` in lib.rs). */
export function isStakingEnabled(cfg: { stakingFlagSet: boolean; stakingEnabledRaw: boolean }): boolean {
  return !cfg.stakingFlagSet || cfg.stakingEnabledRaw;
}

export function decodeConfigAccount(data: Buffer): DecodedConfig | null {
  if (data.length < CONFIG_ACCOUNT_LEN - 30) return null;
  let o = 8;
  const readPk = () => {
    const pk = new PublicKey(data.subarray(o, o + 32)).toBase58();
    o += 32;
    return pk;
  };
  const readU8 = () => data[o++];
  const readU64 = () => {
    const v = data.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const readI64 = () => {
    const v = data.readBigInt64LE(o);
    o += 8;
    return v;
  };
  return {
    authority: readPk(),
    gcMint: readPk(),
    tokenProgram: readPk(),
    bump: readU8(),
    bumps: {
      dailyRewards: readU8(),
      longRewards: readU8(),
      wheelBank: readU8(),
      nftFeeTreasury: readU8(),
      mintProceeds: readU8(),
      airdrop: readU8(),
    },
    paused: readU8() !== 0,
    airdropMinHolding: readU64(),
    dailyPayoutAllowance: readU64(),
    wheelPayoutAllowance: readU64(),
    longStakeCapacity: readU64(),
    totalDeposited: readU64(),
    totalWithdrawn: readU64(),
    dailyLifetimePaid: readU64(),
    longStaked: readU64(),
    airdropReserved: readU64(),
    longBonusOutstanding: readU64(),
    wheelLifetimePaid: readU64(),
    wheelLifetimeLost: readU64(),
    wheelReserved: readU64(),
    pendingAuthority: readPk(),
    wheelMinBet: readU64(),
    wheelMaxBet: readU64(),
    vrfExpirySecs: readI64(),
    lastPauseChangeTs: readI64(),
    wheelHouseEdgeBps: data.readUInt16LE(o),
    ...(() => {
      const stakingEnabledRaw = data.length > CONFIG_STAKING_ENABLED_OFFSET && data[CONFIG_STAKING_ENABLED_OFFSET] !== 0;
      const stakingFlagSet = data.length > CONFIG_STAKING_FLAG_SET_OFFSET && data[CONFIG_STAKING_FLAG_SET_OFFSET] !== 0;
      return { stakingEnabledRaw, stakingFlagSet, stakingEnabled: isStakingEnabled({ stakingEnabledRaw, stakingFlagSet }) };
    })(),
  };
}

export {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  deriveAllTreasuryAddresses,
};
export type { TreasuryAddresses };


export type InitCollectionParams = {
  authority: PublicKey;
  metadataBaseUri?: string;
  programId?: PublicKey;
};

export function buildInitializeCollectionIx(
  params: InitCollectionParams
): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const [config] = deriveConfigPda(programId);
  const [collection] = deriveCollectionPda(programId);
  const uri = params.metadataBaseUri ?? "";
  const uriBuf = Buffer.from(uri, "utf8");
  // Anchor string: 4-byte LE length + bytes
  const data = Buffer.alloc(8 + 4 + uriBuf.length);
  IX_DISCRIMINATORS.initialize_collection.copy(data, 0);
  data.writeUInt32LE(uriBuf.length, 8);
  uriBuf.copy(data, 12);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.authority, true, true),
      meta(config, false, false),
      meta(collection, false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data,
  });
}

/** initialize_collection builds the 10k rarity bitmap on-chain (seeded shuffle) → needs a raised CU limit. */
export const INIT_COLLECTION_COMPUTE_UNITS = 1_400_000;

export type MintNftParams = {
  buyer: PublicKey;
  nftMint: PublicKey;
  gcMint: PublicKey;
  buyerGcAta: PublicKey;
  buyerNftAta: PublicKey;
  /** ORAO treasury (read it from the ORAO network state: `fetchOraoTreasury`). */
  vrfTreasury: PublicKey;
  tokenProgramId?: PublicKey; // $GC token program
  programId?: PublicKey;
};

/** Recommended compute-unit limit for mint_nft (create mint + metadata + edition + verify + ORAO request). */
export const MINT_NFT_COMPUTE_UNITS = 450_000;
/** Recommended compute-unit limit for one settle_mint (pool draw + metadata update). */
export const SETTLE_MINT_COMPUTE_UNITS = 150_000;

/**
 * Mint (audit GC-17/18): pays, mints the NFT with placeholder metadata, queues it and requests its
 * ORAO VRF. `settle_mint` reveals it seconds later (`GreenCat #id`, `{base}{id}.json`).
 */
export function buildMintNftIx(params: MintNftParams): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [collection] = deriveCollectionPda(programId);
  const [mintProceeds] = deriveTreasuryPda(PoolId.MintProceeds, programId);
  const vault = deriveTreasuryVaultAta(params.gcMint, mintProceeds, tokenProgram);
  const [nftRecord] = deriveNftRecordPda(params.nftMint, programId);
  const [metadata] = deriveMetadataPda(params.nftMint);
  const [masterEdition] = deriveMasterEditionPda(params.nftMint);
  const [nftAuthority] = deriveNftAuthorityPda(programId);
  const [collectionMint] = deriveCollectionMintPda(programId);
  const [collectionMetadata] = deriveMetadataPda(collectionMint);
  const [collectionEdition] = deriveMasterEditionPda(collectionMint);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.buyer, true, true),
      meta(params.nftMint, true, true),
      meta(config, false, false),
      meta(collection, false, true),
      meta(params.gcMint, false, false),
      meta(mintProceeds, false, false),
      meta(vault, false, true),
      meta(params.buyerGcAta, false, true),
      meta(params.buyerNftAta, false, true),
      meta(metadata, false, true),
      meta(masterEdition, false, true),
      meta(nftRecord, false, true),
      meta(nftAuthority, false, false),
      meta(collectionMint, false, false),
      meta(collectionMetadata, false, true),
      meta(collectionEdition, false, false),
      meta(tokenProgram, false, false),
      meta(TOKEN_PROGRAM_ID, false, false), // classic SPL for NFT
      meta(TOKEN_METADATA_PROGRAM_ID, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
      meta(SYSVAR_RENT_PUBKEY, false, false),
      // per-mint reveal
      meta(deriveMintPoolPda(programId)[0], false, true),
      meta(deriveOraoNetworkStatePda(), false, true),
      meta(params.vrfTreasury, false, true),
      meta(deriveOraoRandomnessPda(mintVrfSeed(params.nftMint, 1, programId)), false, true),
      meta(ORAO_VRF_PROGRAM_ID, false, false),
    ],
    data: Buffer.from(IX_DISCRIMINATORS.mint_nft),
  });
}

/** Authority: create the sized collection NFT (mint PDA, update authority = nft_authority PDA). */
export function buildCreateCollectionNftIx(params: { authority: PublicKey; programId?: PublicKey }): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const [config] = deriveConfigPda(programId);
  const [collection] = deriveCollectionPda(programId);
  const [nftAuthority] = deriveNftAuthorityPda(programId);
  const [collectionMint] = deriveCollectionMintPda(programId);
  const tokenAccount = getAssociatedTokenAddressSync(collectionMint, nftAuthority, true, TOKEN_PROGRAM_ID);
  const [md] = deriveMetadataPda(collectionMint);
  const [ed] = deriveMasterEditionPda(collectionMint);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.authority, true, true),
      meta(config, false, false),
      meta(collection, false, true),
      meta(nftAuthority, false, false),
      meta(collectionMint, false, true),
      meta(tokenAccount, false, true),
      meta(md, false, true),
      meta(ed, false, true),
      meta(TOKEN_METADATA_PROGRAM_ID, false, false),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
      meta(SYSVAR_RENT_PUBKEY, false, false),
    ],
    data: Buffer.from(IX_DISCRIMINATORS.create_collection_nft),
  });
}

/** Authority: royalty bps (≤ 1000) + recipient; only before the first mint. */
export function buildSetRoyaltyIx(params: {
  authority: PublicKey;
  royaltyBps: number;
  recipient: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const [config] = deriveConfigPda(programId);
  const [collection] = deriveCollectionPda(programId);
  const [nftAuthority] = deriveNftAuthorityPda(programId);
  const [collectionMint] = deriveCollectionMintPda(programId);
  const [md] = deriveMetadataPda(collectionMint);
  const data = Buffer.alloc(8 + 2 + 32);
  IX_DISCRIMINATORS.set_royalty.copy(data, 0);
  data.writeUInt16LE(params.royaltyBps, 8);
  params.recipient.toBuffer().copy(data, 10);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.authority, true, false),
      meta(config, false, false),
      meta(collection, false, true),
      meta(nftAuthority, false, false),
      meta(md, false, true),
      meta(TOKEN_METADATA_PROGRAM_ID, false, false),
    ],
    data,
  });
}

export function buildCloseMintIx(params: { authority: PublicKey; programId?: PublicKey }): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const [config] = deriveConfigPda(programId);
  const [collection] = deriveCollectionPda(programId);
  return new TransactionInstruction({
    programId,
    keys: [meta(params.authority, true, false), meta(config, false, false), meta(collection, false, true)],
    data: Buffer.from(IX_DISCRIMINATORS.close_mint),
  });
}

/** Anyone: create / grow the remaining-ids pool PDA (≤ 10 KiB per ix; send `MINT_POOL_INIT_STEPS` of them). */
export function buildInitMintPoolIx(params: { payer: PublicKey; programId?: PublicKey }): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.payer, true, true),
      meta(deriveMintPoolPda(programId)[0], false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data: Buffer.from(IX_DISCRIMINATORS.init_mint_pool),
  });
}

/**
 * Anyone: VRF request for an NFT minted before the per-mint upgrade (`attempt` = 1, no
 * `previousAttempt`), or a re-request after an expired, unfulfilled request
 * (`attempt` = slot.attempt + 1, `previousAttempt` = slot.attempt).
 */
export function buildRequestMintVrfIx(params: {
  payer: PublicKey;
  nftMint: PublicKey;
  attempt: number;
  previousAttempt?: number | null;
  vrfTreasury: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const [config] = deriveConfigPda(programId);
  const [collection] = deriveCollectionPda(programId);
  const [record] = deriveNftRecordPda(params.nftMint, programId);
  const prev = params.previousAttempt ? deriveOraoRandomnessPda(mintVrfSeed(params.nftMint, params.previousAttempt, programId)) : programId;
  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.payer, true, true),
      meta(config, false, false),
      meta(collection, false, false),
      meta(deriveMintPoolPda(programId)[0], false, true),
      meta(params.nftMint, false, false),
      meta(record, false, false),
      meta(deriveOraoNetworkStatePda(), false, true),
      meta(params.vrfTreasury, false, true),
      meta(deriveOraoRandomnessPda(mintVrfSeed(params.nftMint, params.attempt, programId)), false, true),
      // Anchor optional account: program id = None
      meta(prev, false, false),
      meta(ORAO_VRF_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data: Buffer.from(IX_DISCRIMINATORS.request_mint_vrf),
  });
}

/** Anyone: reveal the queue head (`nftMint` must be the head; `attempt` = its queue slot attempt, usually 1). */
export function buildSettleMintIx(params: { nftMint: PublicKey; attempt?: number; programId?: PublicKey }): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const [config] = deriveConfigPda(programId);
  const [collection] = deriveCollectionPda(programId);
  const [record] = deriveNftRecordPda(params.nftMint, programId);
  const [md] = deriveMetadataPda(params.nftMint);
  const [nftAuthority] = deriveNftAuthorityPda(programId);
  const [collectionMint] = deriveCollectionMintPda(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(config, false, false),
      meta(collection, false, true),
      meta(deriveMintPoolPda(programId)[0], false, true),
      meta(params.nftMint, false, false),
      meta(record, false, true),
      meta(md, false, true),
      meta(nftAuthority, false, false),
      meta(collectionMint, false, false),
      meta(deriveOraoRandomnessPda(mintVrfSeed(params.nftMint, params.attempt ?? 1, programId)), false, false),
      meta(TOKEN_METADATA_PROGRAM_ID, false, false),
    ],
    data: Buffer.from(IX_DISCRIMINATORS.settle_mint),
  });
}

/** Parse NftMinted event from tx meta logMessages (Anchor event). */
export type NftMintedEvent = {
  /** 0 until settle_mint */
  tokenId: number;
  /** 255 until settle_mint */
  rarity: number;
  buyer: string;
  mint: string;
  mintIndex: number;
};

export function parseNftMintedFromLogs(
  logs: string[] | null | undefined
): NftMintedEvent | null {
  if (!logs) return null;
  for (const line of logs) {
    const m = /^Program data: (.+)$/.exec(line);
    if (!m) continue;
    try {
      const raw = Buffer.from(m[1], "base64");
      if (raw.length < 8 + 2 + 1 + 32 + 32) continue;
      if (!raw.subarray(0, 8).equals(NFT_MINTED_EVENT_DISC)) continue;
      let o = 8;
      const tokenId = raw.readUInt16LE(o); o += 2;
      const rarity = raw[o++];
      const buyer = new PublicKey(raw.subarray(o, o + 32)).toBase58(); o += 32;
      const mint = new PublicKey(raw.subarray(o, o + 32)).toBase58(); o += 32;
      const mintIndex = raw.length >= o + 2 ? raw.readUInt16LE(o) : 0;
      return { tokenId, rarity, buyer, mint, mintIndex };
    } catch {
      // continue
    }
  }
  for (const line of logs) {
    const m = /mint_nft: mint_index=(\d+) buyer=(\w+) mint=(\w+)/.exec(line);
    if (m) return { tokenId: 0, rarity: 255, buyer: m[2], mint: m[3], mintIndex: Number(m[1]) };
  }
  return null;
}

/** sha256("event:NftMinted")[0..8] */
export const NFT_MINTED_EVENT_DISC = Buffer.from("af1d6900c302f526", "hex");
/** sha256("event:NftRevealed")[0..8] */
export const NFT_REVEALED_EVENT_DISC = Buffer.from("1c1506f39816ba59", "hex");

export type NftRevealedEvent = { mint: string; mintIndex: number; tokenId: number; rarity: number };

export function parseNftRevealedFromLogs(logs: string[] | null | undefined): NftRevealedEvent | null {
  if (!logs) return null;
  for (const line of logs) {
    const m = /^Program data: (.+)$/.exec(line);
    if (!m) continue;
    const raw = Buffer.from(m[1], "base64");
    if (raw.length < 8 + 32 + 2 + 2 + 1 || !raw.subarray(0, 8).equals(NFT_REVEALED_EVENT_DISC)) continue;
    return {
      mint: new PublicKey(raw.subarray(8, 40)).toBase58(),
      mintIndex: raw.readUInt16LE(40),
      tokenId: raw.readUInt16LE(42),
      rarity: raw[44],
    };
  }
  return null;
}

// ─── Marketplace (§D) ───────────────────────────────────────────────────────

export type ListNftParams = {
  seller: PublicKey;
  nftMint: PublicKey;
  sellerNftAta: PublicKey;
  priceRaw: bigint;
  programId?: PublicKey;
};

export function buildListNftIx(params: ListNftParams): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const [config] = deriveConfigPda(programId);
  const [listing] = deriveListingPda(params.nftMint, programId);
  const escrow = deriveListingEscrowNftAta(params.nftMint, listing);
  const [nftRecord] = deriveNftRecordPda(params.nftMint, programId);
  const data = Buffer.alloc(8 + 8);
  IX_DISCRIMINATORS.list_nft.copy(data, 0);
  data.writeBigUInt64LE(params.priceRaw, 8);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.seller, true, true),
      meta(config, false, false),
      meta(params.nftMint, false, false),
      meta(listing, false, true),
      meta(params.sellerNftAta, false, true),
      meta(escrow, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
      // audit GC-08: only program-minted NFTs (NftRecord exists) can be listed
      meta(nftRecord, false, false),
    ],
    data,
  });
}

export type CancelListingParams = {
  seller: PublicKey;
  nftMint: PublicKey;
  sellerNftAta: PublicKey;
  programId?: PublicKey;
};

export function buildCancelListingIx(
  params: CancelListingParams
): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const [config] = deriveConfigPda(programId);
  const [listing] = deriveListingPda(params.nftMint, programId);
  const escrow = deriveListingEscrowNftAta(params.nftMint, listing);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.seller, true, true),
      meta(config, false, false),
      meta(params.nftMint, false, false),
      meta(listing, false, true),
      meta(escrow, false, true),
      meta(params.sellerNftAta, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data: Buffer.from(IX_DISCRIMINATORS.cancel_listing),
  });
}

export type BuyNftParams = {
  buyer: PublicKey;
  seller: PublicKey;
  nftMint: PublicKey;
  gcMint: PublicKey;
  buyerGcAta: PublicKey;
  sellerGcAta: PublicKey;
  buyerNftAta: PublicKey;
  /** audit GC-21: tx reverts unless the listing price still equals this. */
  expectedPriceRaw: bigint;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

export function buildBuyNftIx(params: BuyNftParams): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [listing] = deriveListingPda(params.nftMint, programId);
  const escrow = deriveListingEscrowNftAta(params.nftMint, listing);
  const [feeTreasury] = deriveTreasuryPda(PoolId.NftFeeTreasury, programId);
  const feeVault = deriveTreasuryVaultAta(params.gcMint, feeTreasury, tokenProgram);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.buyer, true, true),
      meta(params.seller, false, true),
      meta(config, false, false),
      meta(params.gcMint, false, false),
      meta(params.nftMint, false, false),
      meta(listing, false, true),
      meta(escrow, false, true),
      meta(params.buyerNftAta, false, true),
      meta(params.buyerGcAta, false, true),
      meta(params.sellerGcAta, false, true),
      meta(feeTreasury, false, false),
      meta(feeVault, false, true),
      meta(tokenProgram, false, false),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data: (() => {
      const d = Buffer.alloc(16);
      IX_DISCRIMINATORS.buy_nft.copy(d, 0);
      d.writeBigUInt64LE(params.expectedPriceRaw, 8);
      return d;
    })(),
  });
}

export type MakeOfferParams = {
  bidder: PublicKey;
  nftMint: PublicKey;
  gcMint: PublicKey;
  bidderGcAta: PublicKey;
  amountRaw: bigint;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

export function buildMakeOfferIx(params: MakeOfferParams): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [nftRecord] = deriveNftRecordPda(params.nftMint, programId);
  const [offer] = deriveOfferPda(params.nftMint, params.bidder, programId);
  const escrow = deriveOfferGcEscrowAta(params.gcMint, offer, tokenProgram);
  const data = Buffer.alloc(8 + 8);
  IX_DISCRIMINATORS.make_offer.copy(data, 0);
  data.writeBigUInt64LE(params.amountRaw, 8);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.bidder, true, true),
      meta(config, false, false),
      meta(params.gcMint, false, false),
      meta(params.nftMint, false, false),
      meta(nftRecord, false, false),
      meta(offer, false, true),
      meta(params.bidderGcAta, false, true),
      meta(escrow, false, true),
      meta(tokenProgram, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data,
  });
}

export type CancelOfferParams = {
  bidder: PublicKey;
  nftMint: PublicKey;
  gcMint: PublicKey;
  bidderGcAta: PublicKey;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

export function buildCancelOfferIx(
  params: CancelOfferParams
): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [offer] = deriveOfferPda(params.nftMint, params.bidder, programId);
  const escrow = deriveOfferGcEscrowAta(params.gcMint, offer, tokenProgram);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.bidder, true, true),
      meta(config, false, false),
      meta(params.gcMint, false, false),
      meta(params.nftMint, false, false),
      meta(offer, false, true),
      meta(params.bidderGcAta, false, true),
      meta(escrow, false, true),
      meta(tokenProgram, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data: Buffer.from(IX_DISCRIMINATORS.cancel_offer),
  });
}

export type AcceptOfferParams = {
  owner: PublicKey;
  bidder: PublicKey;
  nftMint: PublicKey;
  gcMint: PublicKey;
  ownerGcAta: PublicKey;
  ownerNftAta: PublicKey;
  bidderNftAta: PublicKey;
  /** audit GC-21: tx reverts if the escrowed offer is below this. */
  minAmountRaw: bigint;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

export function buildAcceptOfferIx(
  params: AcceptOfferParams
): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [offer] = deriveOfferPda(params.nftMint, params.bidder, programId);
  const offerEscrow = deriveOfferGcEscrowAta(params.gcMint, offer, tokenProgram);
  const [feeTreasury] = deriveTreasuryPda(PoolId.NftFeeTreasury, programId);
  const feeVault = deriveTreasuryVaultAta(params.gcMint, feeTreasury, tokenProgram);
  const [listing] = deriveListingPda(params.nftMint, programId);
  const listingEscrow = deriveListingEscrowNftAta(params.nftMint, listing);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.owner, true, true),
      meta(params.bidder, false, true),
      meta(config, false, false),
      meta(params.gcMint, false, false),
      meta(params.nftMint, false, false),
      meta(offer, false, true),
      meta(offerEscrow, false, true),
      meta(params.ownerGcAta, false, true),
      meta(feeTreasury, false, false),
      meta(feeVault, false, true),
      meta(params.ownerNftAta, false, true),
      meta(listingEscrow, false, true),
      meta(listing, false, true),
      meta(params.bidderNftAta, false, true),
      meta(tokenProgram, false, false),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data: (() => {
      const d = Buffer.alloc(16);
      IX_DISCRIMINATORS.accept_offer.copy(d, 0);
      d.writeBigUInt64LE(params.minAmountRaw, 8);
      return d;
    })(),
  });
}

// ─── Staking (§E / §F) ──────────────────────────────────────────────────────

export type StakeDailyParams = {
  staker: PublicKey;
  gcMint: PublicKey;
  stakerAta: PublicKey;
  amountRaw: bigint;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

export function buildStakeDailyIx(params: StakeDailyParams): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [dailyStake] = deriveDailyStakePda(params.staker, programId);
  const [dailyPrincipal] = deriveDailyPrincipalPda(programId);
  const vault = deriveDailyPrincipalVaultAta(params.gcMint, tokenProgram, programId);

  const data = Buffer.alloc(8 + 8);
  IX_DISCRIMINATORS.stake_daily.copy(data, 0);
  data.writeBigUInt64LE(params.amountRaw, 8);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.staker, true, true),
      meta(config, false, true),
      meta(params.gcMint, false, false),
      meta(dailyStake, false, true),
      meta(dailyPrincipal, false, false),
      meta(vault, false, true),
      meta(params.stakerAta, false, true),
      meta(tokenProgram, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data,
  });
}

export function buildAddDailyIx(params: StakeDailyParams): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [dailyStake] = deriveDailyStakePda(params.staker, programId);
  const [dailyPrincipal] = deriveDailyPrincipalPda(programId);
  const vault = deriveDailyPrincipalVaultAta(params.gcMint, tokenProgram, programId);

  const data = Buffer.alloc(8 + 8);
  IX_DISCRIMINATORS.add_daily.copy(data, 0);
  data.writeBigUInt64LE(params.amountRaw, 8);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.staker, true, true),
      meta(config, false, true),
      meta(params.gcMint, false, false),
      meta(dailyStake, false, true),
      meta(dailyPrincipal, false, false),
      meta(vault, false, true),
      meta(params.stakerAta, false, true),
      meta(tokenProgram, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data,
  });
}

export type ClaimDailyParams = {
  staker: PublicKey;
  gcMint: PublicKey;
  stakerAta: PublicKey;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

export function buildClaimDailyIx(params: ClaimDailyParams): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [dailyStake] = deriveDailyStakePda(params.staker, programId);
  const [dailyRewards] = deriveTreasuryPda(PoolId.DailyRewards, programId);
  const rewardsVault = deriveTreasuryVaultAta(params.gcMint, dailyRewards, tokenProgram);

  const data = Buffer.alloc(8);
  IX_DISCRIMINATORS.claim_daily.copy(data, 0);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.staker, true, true),
      meta(config, false, true),
      meta(params.gcMint, false, false),
      meta(dailyStake, false, true),
      meta(dailyRewards, false, false),
      meta(rewardsVault, false, true),
      meta(params.stakerAta, false, true),
      meta(tokenProgram, false, false),
    ],
    data,
  });
}

export type UnstakeDailyParams = {
  staker: PublicKey;
  gcMint: PublicKey;
  stakerAta: PublicKey;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

export function buildUnstakeDailyIx(params: UnstakeDailyParams): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [dailyStake] = deriveDailyStakePda(params.staker, programId);
  const [dailyPrincipal] = deriveDailyPrincipalPda(programId);
  const principalVault = deriveDailyPrincipalVaultAta(params.gcMint, tokenProgram, programId);
  const [dailyRewards] = deriveTreasuryPda(PoolId.DailyRewards, programId);
  const rewardsVault = deriveTreasuryVaultAta(params.gcMint, dailyRewards, tokenProgram);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.staker, true, true),
      meta(config, false, true),
      meta(params.gcMint, false, false),
      meta(dailyStake, false, true),
      meta(dailyPrincipal, false, false),
      meta(principalVault, false, true),
      meta(dailyRewards, false, false),
      meta(rewardsVault, false, true),
      meta(params.stakerAta, false, true),
      meta(tokenProgram, false, false),
    ],
    data: Buffer.from(IX_DISCRIMINATORS.unstake_daily),
  });
}

export type StakeLongParams = {
  staker: PublicKey;
  gcMint: PublicKey;
  stakerAta: PublicKey;
  amountRaw: bigint;
  trancheId: bigint | number;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

export function buildStakeLongIx(params: StakeLongParams): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [longState] = deriveLongStatePda(params.staker, programId);
  const trancheId = BigInt(params.trancheId);
  const [tranche] = deriveLongTranchePda(params.staker, trancheId, programId);
  const [longPrincipal] = deriveLongPrincipalPda(programId);
  const vault = deriveLongPrincipalVaultAta(params.gcMint, tokenProgram, programId);

  const data = Buffer.alloc(8 + 8 + 8);
  IX_DISCRIMINATORS.stake_long.copy(data, 0);
  data.writeBigUInt64LE(params.amountRaw, 8);
  data.writeBigUInt64LE(trancheId, 16);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.staker, true, true),
      meta(config, false, true),
      meta(params.gcMint, false, false),
      meta(longState, false, true),
      meta(tranche, false, true),
      meta(longPrincipal, false, false),
      meta(vault, false, true),
      meta(params.stakerAta, false, true),
      meta(tokenProgram, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data,
  });
}

export type ClaimLongParams = {
  staker: PublicKey;
  gcMint: PublicKey;
  stakerAta: PublicKey;
  trancheId: bigint | number;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

export function buildClaimLongIx(params: ClaimLongParams): TransactionInstruction {
  const programId = params.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(params.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const trancheId = BigInt(params.trancheId);
  const [tranche] = deriveLongTranchePda(params.staker, trancheId, programId);
  const [longPrincipal] = deriveLongPrincipalPda(programId);
  const principalVault = deriveLongPrincipalVaultAta(params.gcMint, tokenProgram, programId);
  const [longRewards] = deriveTreasuryPda(PoolId.LongRewards, programId);
  const rewardsVault = deriveTreasuryVaultAta(params.gcMint, longRewards, tokenProgram);

  const data = Buffer.alloc(8 + 8);
  IX_DISCRIMINATORS.claim_long.copy(data, 0);
  data.writeBigUInt64LE(trancheId, 8);

  return new TransactionInstruction({
    programId,
    keys: [
      meta(params.staker, true, true),
      meta(config, false, true),
      meta(params.gcMint, false, false),
      meta(tranche, false, true),
      meta(longPrincipal, false, false),
      meta(principalVault, false, true),
      meta(longRewards, false, false),
      meta(rewardsVault, false, true),
      meta(params.stakerAta, false, true),
      meta(tokenProgram, false, false),
    ],
    data,
  });
}

// ─── Admin (audit GC-19) ────────────────────────────────────────────────────

function adminIx(
  name: keyof typeof IX_DISCRIMINATORS,
  signer: PublicKey,
  args: Buffer,
  programId?: PublicKey
): TransactionInstruction {
  const pid = programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const [config] = deriveConfigPda(pid);
  return new TransactionInstruction({
    programId: pid,
    keys: [meta(signer, true, false), meta(config, false, true)],
    data: Buffer.concat([IX_DISCRIMINATORS[name], args]),
  });
}

export function buildProposeAuthorityIx(p: { authority: PublicKey; newAuthority: PublicKey; programId?: PublicKey }) {
  return adminIx("propose_authority", p.authority, p.newAuthority.toBuffer(), p.programId);
}

export function buildAcceptAuthorityIx(p: { newAuthority: PublicKey; programId?: PublicKey }) {
  return adminIx("accept_authority", p.newAuthority, Buffer.alloc(0), p.programId);
}

export function buildSetPausedIx(p: { authority: PublicKey; paused: boolean; programId?: PublicKey }) {
  return adminIx("set_paused", p.authority, Buffer.from([p.paused ? 1 : 0]), p.programId);
}

export function buildSetVrfExpiryIx(p: { authority: PublicKey; expirySecs: bigint | number; programId?: PublicKey }) {
  const a = Buffer.alloc(8);
  a.writeBigInt64LE(BigInt(p.expirySecs), 0);
  return adminIx("set_vrf_expiry", p.authority, a, p.programId);
}

/** Admin: open (`enabled: true`) or lock NEW stakes (daily + 365-day). Unstake/claim are never gated. */
export function buildSetStakingEnabledIx(p: { authority: PublicKey; enabled: boolean; programId?: PublicKey }) {
  return adminIx("set_staking_enabled", p.authority, Buffer.from([p.enabled ? 1 : 0]), p.programId);
}

export function buildSweepFeeTreasurySolIx(p: {
  authority: PublicKey;
  destination: PublicKey;
  lamports: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const [config] = deriveConfigPda(programId);
  const [feeTreasury] = deriveTreasuryPda(PoolId.NftFeeTreasury, programId);
  const data = Buffer.alloc(16);
  IX_DISCRIMINATORS.sweep_fee_treasury_sol.copy(data, 0);
  data.writeBigUInt64LE(p.lamports, 8);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(p.authority, true, false),
      meta(config, false, false),
      meta(feeTreasury, false, true),
      meta(p.destination, false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data,
  });
}

// ─── Merkle airdrop (audit GC-22) ──────────────────────────────────────────

export function buildCreateAirdropIx(p: {
  authority: PublicKey;
  gcMint: PublicKey;
  id: bigint;
  merkleRoot: Uint8Array;
  totalAmountRaw: bigint;
  expiryTs: bigint;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(p.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [airdrop] = deriveTreasuryPda(PoolId.Airdrop, programId);
  const vault = deriveTreasuryVaultAta(p.gcMint, airdrop, tokenProgram);
  const [dist] = deriveAirdropDistributionPda(p.id, programId);
  const data = Buffer.alloc(8 + 8 + 32 + 8 + 8);
  IX_DISCRIMINATORS.create_airdrop.copy(data, 0);
  data.writeBigUInt64LE(p.id, 8);
  Buffer.from(p.merkleRoot).copy(data, 16);
  data.writeBigUInt64LE(p.totalAmountRaw, 48);
  data.writeBigInt64LE(p.expiryTs, 56);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(p.authority, true, true),
      meta(config, false, true),
      meta(p.gcMint, false, false),
      meta(airdrop, false, false),
      meta(vault, false, false),
      meta(dist, false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data,
  });
}

export function buildClaimAirdropIx(p: {
  claimant: PublicKey;
  gcMint: PublicKey;
  distributionId: bigint;
  index: bigint;
  amountRaw: bigint;
  proof: Uint8Array[];
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const tokenProgram = resolveTokenProgram(p.tokenProgramId);
  const [config] = deriveConfigPda(programId);
  const [airdrop] = deriveTreasuryPda(PoolId.Airdrop, programId);
  const vault = deriveTreasuryVaultAta(p.gcMint, airdrop, tokenProgram);
  const [dist] = deriveAirdropDistributionPda(p.distributionId, programId);
  const [claim] = deriveAirdropClaimPda(dist, p.index, programId);
  const claimantAta = getAssociatedTokenAddressSync(p.gcMint, p.claimant, false, tokenProgram);
  const data = Buffer.alloc(8 + 8 + 8 + 4 + 32 * p.proof.length);
  IX_DISCRIMINATORS.claim_airdrop.copy(data, 0);
  data.writeBigUInt64LE(p.index, 8);
  data.writeBigUInt64LE(p.amountRaw, 16);
  data.writeUInt32LE(p.proof.length, 24);
  p.proof.forEach((h, i) => Buffer.from(h).copy(data, 28 + 32 * i));
  return new TransactionInstruction({
    programId,
    keys: [
      meta(p.claimant, true, true),
      meta(config, false, true),
      meta(dist, false, true),
      meta(claim, false, true),
      meta(p.gcMint, false, false),
      meta(airdrop, false, false),
      meta(vault, false, true),
      meta(claimantAta, false, true),
      meta(tokenProgram, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data,
  });
}

export function buildReclaimAirdropIx(p: { authority: PublicKey; distributionId: bigint; programId?: PublicKey }) {
  const programId = p.programId || new PublicKey(GREENCAT_PROGRAM_ID);
  const [config] = deriveConfigPda(programId);
  const [dist] = deriveAirdropDistributionPda(p.distributionId, programId);
  return new TransactionInstruction({
    programId,
    keys: [meta(p.authority, true, false), meta(config, false, true), meta(dist, false, true)],
    data: Buffer.from(IX_DISCRIMINATORS.reclaim_airdrop),
  });
}

export type DecodedAirdropDistribution = {
  id: bigint;
  merkleRoot: Buffer;
  totalAmount: bigint;
  claimedAmount: bigint;
  claimedCount: bigint;
  expiryTs: bigint;
  createdTs: bigint;
  reclaimed: boolean;
};

export function decodeAirdropDistributionAccount(d: Buffer): DecodedAirdropDistribution | null {
  if (d.length < 8 + 8 + 32 + 40 + 1) return null;
  return {
    id: d.readBigUInt64LE(8),
    merkleRoot: Buffer.from(d.subarray(16, 48)),
    totalAmount: d.readBigUInt64LE(48),
    claimedAmount: d.readBigUInt64LE(56),
    claimedCount: d.readBigUInt64LE(64),
    expiryTs: d.readBigInt64LE(72),
    createdTs: d.readBigInt64LE(80),
    reclaimed: d[88] !== 0,
  };
}

/** sha256("event:AirdropClaimed")[0..8] */
export const AIRDROP_CLAIMED_EVENT_DISC = Buffer.from("7dfbc3b7ca7e5944", "hex");
