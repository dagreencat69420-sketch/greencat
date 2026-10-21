/**
 * Treasury PDA helpers for GreenCat program.
 * Seeds match programs/greencat/src/lib.rs (REAL-APP-SPEC §A).
 *
 * All on-chain amounts are **raw** (UI × 10^decimals). Mainnet $GC = 6 decimals.
 */

import { PublicKey } from "@solana/web3.js";
import {
  GREENCAT_PROGRAM_ID,
  MAINNET_GC_DECIMALS,
  MAINNET_GC_MINT,
} from "./constants";

export const CONFIG_SEED = Buffer.from("config");
export const DAILY_REWARDS_SEED = Buffer.from("daily_rewards");
export const LONG_REWARDS_SEED = Buffer.from("long_rewards");
export const WHEEL_BANK_SEED = Buffer.from("wheel_bank");
export const NFT_FEE_TREASURY_SEED = Buffer.from("nft_fee_treasury");
export const MINT_PROCEEDS_SEED = Buffer.from("mint_proceeds");
export const AIRDROP_SEED = Buffer.from("airdrop");

/** pool_id 0..5 matching on-chain enum */
export enum PoolId {
  DailyRewards = 0,
  LongRewards = 1,
  WheelBank = 2,
  NftFeeTreasury = 3,
  MintProceeds = 4,
  Airdrop = 5,
}

export const POOL_SEEDS: Record<PoolId, Buffer> = {
  [PoolId.DailyRewards]: DAILY_REWARDS_SEED,
  [PoolId.LongRewards]: LONG_REWARDS_SEED,
  [PoolId.WheelBank]: WHEEL_BANK_SEED,
  [PoolId.NftFeeTreasury]: NFT_FEE_TREASURY_SEED,
  [PoolId.MintProceeds]: MINT_PROCEEDS_SEED,
  [PoolId.Airdrop]: AIRDROP_SEED,
};

export const POOL_LABELS: Record<PoolId, string> = {
  [PoolId.DailyRewards]: "daily_rewards",
  [PoolId.LongRewards]: "long_rewards",
  [PoolId.WheelBank]: "wheel_bank",
  [PoolId.NftFeeTreasury]: "nft_fee_treasury",
  [PoolId.MintProceeds]: "mint_proceeds",
  [PoolId.Airdrop]: "airdrop",
};

export const ALL_POOL_IDS: PoolId[] = [
  PoolId.DailyRewards,
  PoolId.LongRewards,
  PoolId.WheelBank,
  PoolId.NftFeeTreasury,
  PoolId.MintProceeds,
  PoolId.Airdrop,
];

export function getProgramId(override?: string): PublicKey {
  return new PublicKey(override || GREENCAT_PROGRAM_ID);
}

export function deriveConfigPda(
  programId: PublicKey = getProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

export function deriveTreasuryPda(
  poolId: PoolId,
  programId: PublicKey = getProgramId()
): [PublicKey, number] {
  const seed = POOL_SEEDS[poolId];
  if (!seed) throw new Error(`Invalid poolId ${poolId}`);
  return PublicKey.findProgramAddressSync([seed], programId);
}

export type TreasuryAddresses = {
  programId: string;
  config: string;
  configBump: number;
  pools: {
    poolId: PoolId;
    label: string;
    pda: string;
    bump: number;
  }[];
};

/** Derive config + all 6 treasury PDAs (pre-init safe). */
export function deriveAllTreasuryAddresses(
  programIdStr: string = GREENCAT_PROGRAM_ID
): TreasuryAddresses {
  const programId = new PublicKey(programIdStr);
  const [config, configBump] = deriveConfigPda(programId);
  const pools = ALL_POOL_IDS.map((poolId) => {
    const [pda, bump] = deriveTreasuryPda(poolId, programId);
    return {
      poolId,
      label: POOL_LABELS[poolId],
      pda: pda.toBase58(),
      bump,
    };
  });
  return {
    programId: programId.toBase58(),
    config: config.toBase58(),
    configBump,
    pools,
  };
}

/** UI amount → raw (u64-safe as bigint). */
export function uiToRaw(
  ui: number | string | bigint,
  decimals: number = MAINNET_GC_DECIMALS
): bigint {
  const scale = BigInt(10) ** BigInt(decimals);
  if (typeof ui === "bigint") return ui * scale;
  const s = String(ui);
  if (!s.includes(".")) return BigInt(s) * scale;
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * scale + BigInt(padded || "0");
}

/** Raw → UI number (lossy for display). */
export function rawToUi(
  raw: bigint | number | string,
  decimals: number = MAINNET_GC_DECIMALS
): number {
  const r = typeof raw === "bigint" ? raw : BigInt(raw);
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = r / scale;
  const frac = r % scale;
  return Number(whole) + Number(frac) / Number(scale);
}

/** Seed defaults as raw (6 decimals). */
export const DEFAULTS_RAW = {
  airdropMinHolding: uiToRaw(100_000),
  dailyPayoutAllowance: uiToRaw(20_000_000),
  /** Wheel removed Oct 12, 2026: the Config field stays for layout and starts at 0. */
  wheelPayoutAllowance: 0n,
  longStakeCapacity: uiToRaw(100_000_000),
} as const;

export { MAINNET_GC_MINT };
