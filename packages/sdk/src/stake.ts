/**
 * Daily + 365 staking helpers (REAL-APP-SPEC §E/§F).
 * Accrual math mirrors on-chain `programs/greencat/src/stake.rs`.
 */

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { GREENCAT_PROGRAM_ID, MAINNET_GC_DECIMALS } from "./constants";
import { getProgramId, uiToRaw } from "./treasuries";

export const DAILY_STAKE_SEED = Buffer.from("daily_stake");
export const LONG_STATE_SEED = Buffer.from("long_state");
export const LONG_TRANCHE_SEED = Buffer.from("long_tranche");
export const DAILY_PRINCIPAL_SEED = Buffer.from("daily_principal");
export const LONG_PRINCIPAL_SEED = Buffer.from("long_principal");

/** Seconds per accrual / min-unstake period. */
export const SECONDS_PER_DAY = 86_400;
export const LONG_LOCK_SECONDS = SECONDS_PER_DAY * 365;

/** pending_raw ≈ pending_scaled / PENDING_SCALE */
export const PENDING_SCALE = 1_000_000_000_000n; // 1e12
/** Rate = DAILY_RATE_NUM / PENDING_SCALE = 0.000136986301 per 24h */
export const DAILY_RATE_NUM = 136_986_301n;
export const DAILY_ACCRUAL_RATE = 0.000136986301;
export const DAILY_ACCRUAL_RATE_PERCENT = 0.0136986301;

export function deriveDailyStakePda(
  owner: PublicKey,
  programId: PublicKey = getProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DAILY_STAKE_SEED, owner.toBuffer()],
    programId
  );
}

export function deriveLongStatePda(
  owner: PublicKey,
  programId: PublicKey = getProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [LONG_STATE_SEED, owner.toBuffer()],
    programId
  );
}

export function deriveLongTranchePda(
  owner: PublicKey,
  trancheId: bigint | number,
  programId: PublicKey = getProgramId()
): [PublicKey, number] {
  const id = BigInt(trancheId);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(id);
  return PublicKey.findProgramAddressSync(
    [LONG_TRANCHE_SEED, owner.toBuffer(), buf],
    programId
  );
}

export function deriveDailyPrincipalPda(
  programId: PublicKey = getProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([DAILY_PRINCIPAL_SEED], programId);
}

export function deriveLongPrincipalPda(
  programId: PublicKey = getProgramId()
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([LONG_PRINCIPAL_SEED], programId);
}

export function deriveDailyPrincipalVaultAta(
  mint: PublicKey,
  tokenProgramId: PublicKey,
  programId: PublicKey = getProgramId()
): PublicKey {
  const [auth] = deriveDailyPrincipalPda(programId);
  return getAssociatedTokenAddressSync(mint, auth, true, tokenProgramId);
}

export function deriveLongPrincipalVaultAta(
  mint: PublicKey,
  tokenProgramId: PublicKey,
  programId: PublicKey = getProgramId()
): PublicKey {
  const [auth] = deriveLongPrincipalPda(programId);
  return getAssociatedTokenAddressSync(mint, auth, true, tokenProgramId);
}

/** Accrue whole 24h periods (raw units / scaled pending). */
export function accrueDailyPending(
  principalRaw: bigint,
  pendingScaled: bigint,
  lastAccrualTs: bigint | number,
  nowTs: bigint | number
): { pendingScaled: bigint; lastAccrualTs: bigint; periods: bigint } {
  const last = BigInt(lastAccrualTs);
  const now = BigInt(nowTs);
  if (principalRaw <= 0n || now <= last) {
    return { pendingScaled, lastAccrualTs: last, periods: 0n };
  }
  const periods = (now - last) / BigInt(SECONDS_PER_DAY);
  if (periods <= 0n) {
    return { pendingScaled, lastAccrualTs: last, periods: 0n };
  }
  const earned = principalRaw * DAILY_RATE_NUM * periods;
  return {
    pendingScaled: pendingScaled + earned,
    lastAccrualTs: last + periods * BigInt(SECONDS_PER_DAY),
    periods,
  };
}

/** Floor pending to whole raw token units. */
export function floorClaimableRaw(pendingScaled: bigint): bigint {
  if (pendingScaled <= 0n) return 0n;
  return pendingScaled / PENDING_SCALE;
}

export function dailyRemainPayout(
  allowanceRaw: bigint,
  lifetimePaidRaw: bigint
): bigint {
  return allowanceRaw > lifetimePaidRaw ? allowanceRaw - lifetimePaidRaw : 0n;
}

/** Preview claim pay = min(floor(pending), pool, remain). */
export function previewDailyPayout(
  pendingScaled: bigint,
  poolRaw: bigint,
  remainPayoutRaw: bigint
): bigint {
  const claimable = floorClaimableRaw(pendingScaled);
  let pay = claimable;
  if (poolRaw < pay) pay = poolRaw;
  if (remainPayoutRaw < pay) pay = remainPayoutRaw;
  return pay < 0n ? 0n : pay;
}

export type DecodedDailyStake = {
  owner: string;
  principal: bigint;
  pendingScaled: bigint;
  lastAccrualTs: bigint;
  startedAt: bigint;
  bump: number;
};

export function decodeDailyStakeAccount(data: Buffer): DecodedDailyStake | null {
  // disc(8)+owner(32)+principal(8)+pending(16)+last(8)+started(8)+bump(1) = 81
  if (data.length < 81) return null;
  let o = 8;
  const owner = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const principal = data.readBigUInt64LE(o);
  o += 8;
  // Borsh u128 = two u64 LE (lo, hi)
  const lo = data.readBigUInt64LE(o);
  const hi = data.readBigUInt64LE(o + 8);
  const pendingScaled = lo + (hi << 64n);
  o += 16;
  const lastAccrualTs = data.readBigInt64LE(o);
  o += 8;
  const startedAt = data.readBigInt64LE(o);
  o += 8;
  const bump = data[o];
  return {
    owner,
    principal,
    pendingScaled,
    lastAccrualTs,
    startedAt,
    bump,
  };
}

export type DecodedLongState = {
  owner: string;
  nextTrancheId: bigint;
  bump: number;
};

export function decodeLongStateAccount(data: Buffer): DecodedLongState | null {
  if (data.length < 49) return null;
  let o = 8;
  const owner = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const nextTrancheId = data.readBigUInt64LE(o);
  o += 8;
  return { owner, nextTrancheId, bump: data[o] };
}

export type DecodedLongTranche = {
  owner: string;
  trancheId: bigint;
  principal: bigint;
  bonusOwed: bigint;
  startedAt: bigint;
  unlockAt: bigint;
  bump: number;
};

export function decodeLongTrancheAccount(
  data: Buffer
): DecodedLongTranche | null {
  if (data.length < 81) return null;
  let o = 8;
  const owner = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const trancheId = data.readBigUInt64LE(o);
  o += 8;
  const principal = data.readBigUInt64LE(o);
  o += 8;
  const bonusOwed = data.readBigUInt64LE(o);
  o += 8;
  const startedAt = data.readBigInt64LE(o);
  o += 8;
  const unlockAt = data.readBigInt64LE(o);
  o += 8;
  return {
    owner,
    trancheId,
    principal,
    bonusOwed,
    startedAt,
    unlockAt,
    bump: data[o],
  };
}

/** Demo-parity UI default capacities (raw, 6 decimals). */
export const STAKE_DEFAULTS_RAW = {
  dailyPayoutAllowance: uiToRaw(20_000_000, MAINNET_GC_DECIMALS),
  longStakeCapacity: uiToRaw(100_000_000, MAINNET_GC_DECIMALS),
} as const;

export { GREENCAT_PROGRAM_ID };
