/**
 * Verify that a Solana transaction proves a GreenCat activity for a wallet.
 *
 * Checks (all must pass):
 *  1. tx exists at the configured commitment and `meta.err === null` (succeeded)
 *  2. optional freshness: blockTime within `maxAgeSec`
 *  3. a TOP-LEVEL instruction targets our program id with an Anchor discriminator
 *     that matches the claimed action (sha256("global:<ix>")[0..8])
 *  4. that instruction's first account (buyer/seller/staker/player) is the wallet
 *     AND the wallet is a signer of the transaction
 *  5. action-specific event/log proof emitted by OUR program frame
 *     (mint → NftMinted.buyer, list → list_nft seller)
 */
import {
  PublicKey,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import bs58 from "bs58";
import { IX_DISCRIMINATORS, parseProgramLogs } from "@greencat/sdk";

export type BonusKind = "mint" | "stake" | "list";
export const BONUS_KINDS: readonly BonusKind[] = ["mint", "stake", "list"];

/** Which program instructions count for each bonus kind. */
export const BONUS_INSTRUCTIONS: Record<BonusKind, (keyof typeof IX_DISCRIMINATORS)[]> = {
  mint: ["mint_nft"],
  stake: ["stake_daily", "add_daily", "stake_long"],
  list: ["list_nft"],
  // wheel bonus removed Oct 12, 2026 with the wheel feature.
};

/** Instructions whose first arg is the GC amount (u64): stake/add/stake_long amount, list price. */
const AMOUNT_IXS = new Set<string>(["stake_daily", "add_daily", "stake_long", "list_nft"]);

export type VerifyFailure = {
  ok: false;
  code:
    | "bad_signature"
    | "tx_not_found"
    | "tx_failed"
    | "tx_too_old"
    | "no_matching_instruction"
    | "wallet_not_signer"
    | "missing_event"
    | "amount_too_small";
  message: string;
  /** true → client may retry shortly (e.g. RPC hasn't seen the tx yet). */
  retryable?: boolean;
};

export type VerifySuccess = {
  ok: true;
  instruction: string;
  slot: number;
  blockTime: number | null;
  /** kind "list": the listed NFT (from the program's list_nft log for this seller). */
  listing?: { nftMint: string; priceRaw: string };
};

export type VerifyResult = VerifySuccess | VerifyFailure;

export function isValidTxSignature(sig: unknown): sig is string {
  if (typeof sig !== "string" || sig.length < 64 || sig.length > 100) return false;
  try {
    return bs58.decode(sig).length === 64;
  } catch {
    return false;
  }
}

export function verifyActivityTx(
  tx: VersionedTransactionResponse | null,
  opts: {
    wallet: string;
    kind: BonusKind;
    programId: string;
    nowSec?: number;
    maxAgeSec?: number;
    /** Audit API-03: minimum raw amount (first u64 arg of the matched ix). */
    minAmountRaw?: bigint;
  }
): VerifyResult {
  if (!tx) {
    return {
      ok: false,
      code: "tx_not_found",
      message: "Transaction not found (yet) on the configured RPC — retry in a few seconds",
      retryable: true,
    };
  }
  if (!tx.meta || tx.meta.err !== null) {
    return { ok: false, code: "tx_failed", message: "Transaction did not succeed" };
  }
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (opts.maxAgeSec && opts.maxAgeSec > 0 && typeof tx.blockTime === "number") {
    if (nowSec - tx.blockTime > opts.maxAgeSec) {
      return {
        ok: false,
        code: "tx_too_old",
        message: `Transaction is older than ${opts.maxAgeSec}s`,
      };
    }
  }

  const message = tx.transaction.message;
  const keys = message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined,
  });
  const programPk = new PublicKey(opts.programId);
  const walletPk = new PublicKey(opts.wallet);
  const allowed = BONUS_INSTRUCTIONS[opts.kind];

  let matched: string | null = null;
  let matchedAmount: bigint | null = null;
  let signerOk = false;
  for (const ix of message.compiledInstructions) {
    const pid = keys.get(ix.programIdIndex);
    if (!pid || !pid.equals(programPk)) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 8) continue;
    const disc = data.subarray(0, 8);
    const name = allowed.find((n) => disc.equals(IX_DISCRIMINATORS[n]));
    if (!name) continue;
    const firstIdx = ix.accountKeyIndexes[0];
    const first = firstIdx === undefined ? undefined : keys.get(firstIdx);
    if (!first || !first.equals(walletPk)) continue;
    matched = name;
    matchedAmount = AMOUNT_IXS.has(name) && data.length >= 16 ? data.readBigUInt64LE(8) : null;
    signerOk = message.isAccountSigner(firstIdx);
    if (signerOk) break;
  }

  if (!matched) {
    return {
      ok: false,
      code: "no_matching_instruction",
      message: `No ${allowed.join("/")} instruction for this wallet on program ${opts.programId}`,
    };
  }
  if (!signerOk) {
    return { ok: false, code: "wallet_not_signer", message: "Wallet did not sign this transaction" };
  }

  if (opts.minAmountRaw !== undefined && opts.minAmountRaw > 0n && matchedAmount !== null) {
    if (matchedAmount < opts.minAmountRaw) {
      return {
        ok: false,
        code: "amount_too_small",
        message: `${matched} amount ${matchedAmount} is below the bonus minimum ${opts.minAmountRaw} (raw units)`,
      };
    }
  }

  const events = parseProgramLogs(tx.meta.logMessages, opts.programId);
  const w = opts.wallet;
  let proof = true;
  let listing: VerifySuccess["listing"];
  if (opts.kind === "mint") {
    proof = events.some((e) => e.type === "nft_minted" && e.buyer === w);
  } else if (opts.kind === "list") {
    const ev = events.find((e) => e.type === "list_nft" && e.seller === w);
    proof = !!ev;
    if (ev && ev.type === "list_nft") listing = { nftMint: ev.nftMint, priceRaw: String(ev.priceRaw) };
  }
  if (!proof) {
    return {
      ok: false,
      code: "missing_event",
      message: `Program ${opts.kind} event for this wallet not found in tx logs`,
    };
  }

  return { ok: true, instruction: matched, slot: tx.slot, blockTime: tx.blockTime ?? null, listing };
}

export type TxFetcher = (signature: string) => Promise<VersionedTransactionResponse | null>;
