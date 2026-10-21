/**
 * Admin helpers for the airdrop pool (treasury pool 5), used by the /admin "Fund airdrop pool" and
 * "Withdraw from airdrop pool" buttons and by the localnet check (apps/api/test/airdrop-pool-localnet.ts).
 *
 * No new on-chain instruction is needed:
 *  - deposit  = `deposit_treasury(pool 5, amount)`: any signer moves $GC from their own ATA into the pool.
 *  - withdraw = `withdraw_treasury(pool 5, amount)`: authority-only (`config.authority` must sign) and the
 *    program refuses to leave less than `config.airdrop_reserved` in the vault (LiabilityFloor), so money
 *    still owed to claimants of a live round can't be taken. A round's reservation is only released by
 *    `reclaim_airdrop` (authority, after the round's expiry, not while paused / within 3 days of an unpause).
 *    `buildAirdropPoolWithdrawIxs` can put that reclaim in front of the withdraw so one signature does both.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PoolId } from "./treasuries";
import { buildDepositTreasuryIx, buildReclaimAirdropIx, buildWithdrawTreasuryIx, resolveTokenProgram } from "./instructions";

/** $GC (raw) the authority may take out of the airdrop pool right now: vault balance minus what's reserved for open rounds. */
export function airdropPoolWithdrawable(vaultRaw: bigint, reservedRaw: bigint, releasableRaw: bigint = 0n): bigint {
  const free = vaultRaw - reservedRaw + releasableRaw;
  return free > 0n ? (free > vaultRaw ? vaultRaw : free) : 0n;
}

/** On-chain `MIN_AIRDROP_WINDOW_SECS` (production build): `create_airdrop` needs expiry ≥ now + 7 days. */
export const AIRDROP_MIN_WINDOW_SECS = 7 * 86_400;
/** On-chain `RECLAIM_GRACE_AFTER_UNPAUSE_SECS` (production build). */
export const AIRDROP_RECLAIM_GRACE_SECS = 3 * 86_400;

/** Last moment (unix s) `create_airdrop` still accepts a proofs file with this `expiryTs` (7-day minimum window). */
export function airdropPostDeadline(expiryTs: number): number {
  return expiryTs - AIRDROP_MIN_WINDOW_SECS;
}

/**
 * Earliest moment (unix s) `reclaim_airdrop` succeeds: after expiry and ≥ 3 days after the last pause change.
 * Returns null while the program is paused (it can't be reclaimed until it's resumed, and the 3 days restart then).
 */
export function airdropReclaimOpensAt(expiryTs: number, lastPauseChangeTs: number, paused: boolean): number | null {
  if (paused) return null;
  return Math.max(expiryTs, lastPauseChangeTs + AIRDROP_RECLAIM_GRACE_SECS);
}

/** Unclaimed $GC a distribution would release on reclaim (0 if already reclaimed). */
export function airdropUnclaimed(d: { totalAmount: bigint; claimedAmount: bigint; reclaimed: boolean }): bigint {
  if (d.reclaimed) return 0n;
  const u = d.totalAmount - d.claimedAmount;
  return u > 0n ? u : 0n;
}

/**
 * Parse a UI amount ("1000", "1,000.5") into raw units. Returns null for anything that isn't a positive
 * number with at most `decimals` fractional digits.
 */
export function parseGcAmount(input: string, decimals: number): bigint | null {
  const s = input.replace(/[,_\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  const raw = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return raw > 0n && raw <= 0xffff_ffff_ffff_ffffn ? raw : null;
}

export type AirdropPoolDepositParams = {
  depositor: PublicKey;
  gcMint: PublicKey;
  amountRaw: bigint;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

/** One instruction: move `amountRaw` $GC from the depositor's own ATA into the airdrop pool vault. */
export function buildAirdropPoolDepositIxs(p: AirdropPoolDepositParams): TransactionInstruction[] {
  const tokenProgram = resolveTokenProgram(p.tokenProgramId);
  const depositorAta = getAssociatedTokenAddressSync(p.gcMint, p.depositor, false, tokenProgram);
  return [
    buildDepositTreasuryIx({
      depositor: p.depositor,
      depositorAta,
      gcMint: p.gcMint,
      poolId: PoolId.Airdrop,
      amountRaw: p.amountRaw,
      tokenProgramId: tokenProgram,
      programId: p.programId,
    }),
  ];
}

export type AirdropPoolWithdrawParams = {
  authority: PublicKey;
  gcMint: PublicKey;
  amountRaw: bigint;
  /** Reclaim this ended distribution first (same transaction), releasing its unclaimed reservation. */
  reclaimDistributionId?: bigint;
  tokenProgramId?: PublicKey;
  programId?: PublicKey;
};

/**
 * [create authority's $GC ATA if missing] → [reclaim_airdrop(id)] → withdraw_treasury(pool 5) to the authority's ATA.
 * Always sends to the signing authority's own wallet.
 */
export function buildAirdropPoolWithdrawIxs(p: AirdropPoolWithdrawParams): TransactionInstruction[] {
  const tokenProgram = resolveTokenProgram(p.tokenProgramId);
  const destinationAta = getAssociatedTokenAddressSync(p.gcMint, p.authority, false, tokenProgram);
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(p.authority, destinationAta, p.authority, p.gcMint, tokenProgram),
  ];
  if (p.reclaimDistributionId !== undefined) {
    ixs.push(buildReclaimAirdropIx({ authority: p.authority, distributionId: p.reclaimDistributionId, programId: p.programId }));
  }
  ixs.push(
    buildWithdrawTreasuryIx({
      authority: p.authority,
      destinationAta,
      gcMint: p.gcMint,
      poolId: PoolId.Airdrop,
      amountRaw: p.amountRaw,
      tokenProgramId: tokenProgram,
      programId: p.programId,
    })
  );
  return ixs;
}
