import { findProgramError } from "@greencat/sdk";
import { CLUSTER } from "@/lib/config";

export type FriendlyKind =
  | "rejected"
  | "insufficient_sol"
  | "insufficient_gc"
  | "no_token_account"
  | "expired"
  | "network"
  | "wrong_network"
  | "not_connected"
  | "program"
  | "unknown";

export type FriendlyError = {
  kind: FriendlyKind;
  /** One-line, user-facing message. */
  message: string;
  /** Optional hint / next step. */
  hint?: string;
  /** Program error name or raw message for the "details" disclosure. */
  detail?: string;
};

/** Thrown by our own pre-flight checks so the UI can show a precise message. */
export class UserFacingError extends Error {
  constructor(
    public kind: FriendlyKind,
    message: string,
    public hint?: string
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}

/** Collect every piece of text a wallet / web3.js error may carry (message, logs, nested causes). */
function errorText(e: unknown, depth = 0): string {
  if (e == null || depth > 4) return "";
  if (typeof e === "string") return e;
  if (typeof e !== "object") return String(e);
  const o = e as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o.name === "string") parts.push(o.name);
  if (typeof o.message === "string") parts.push(o.message);
  if (typeof o.code === "number" || typeof o.code === "string") parts.push(`code:${o.code}`);
  if (Array.isArray(o.logs)) parts.push((o.logs as unknown[]).join("\n"));
  if (Array.isArray(o.transactionLogs)) parts.push((o.transactionLogs as unknown[]).join("\n"));
  for (const k of ["error", "cause", "data", "InstructionError"]) {
    if (o[k] && o[k] !== e) parts.push(errorText(o[k], depth + 1));
  }
  if (parts.length === 0) {
    try {
      parts.push(JSON.stringify(o));
    } catch {
      /* ignore */
    }
  }
  return parts.join("\n");
}

const otherNetwork = CLUSTER === "mainnet-beta" ? "devnet/testnet" : "mainnet";

/** Where to switch a wallet to this build's cluster (Phantom's menu wording, Oct 2026). */
export const WALLET_NETWORK_HINT =
  CLUSTER === "mainnet-beta"
    ? "In Phantom: Settings → Developer Settings → turn Testnet Mode off (Solana Mainnet)."
    : CLUSTER === "devnet"
      ? "In Phantom: Settings → Developer Settings → Testnet Mode on → Solana Devnet. Then refresh this page."
      : "Point your wallet at the local validator (Developer Settings → Localnet).";

/** Map any wallet / RPC / program error to a short, friendly message. */
export function friendlyError(e: unknown): FriendlyError {
  if (e instanceof UserFacingError) return { kind: e.kind, message: e.message, hint: e.hint };
  const text = errorText(e);
  const raw = (e instanceof Error ? e.message : text).slice(0, 300);

  if (
    /User rejected|rejected the request|Transaction cancelled|Request rejected|declined|code:4001/i.test(
      text
    )
  ) {
    return { kind: "rejected", message: "You cancelled the request in your wallet. Nothing was sent." };
  }
  if (/WalletNotConnectedError|Wallet not connected/i.test(text)) {
    return { kind: "not_connected", message: "Connect your wallet first." };
  }

  const prog = findProgramError(text);
  if (prog) return { kind: "program", message: prog.friendly, detail: `${prog.name} (${prog.code})` };

  if (/no record of a prior credit|insufficient lamports|insufficient funds for (fee|rent)|InsufficientFundsForFee|InsufficientFundsForRent/i.test(text)) {
    return {
      kind: "insufficient_sol",
      message: "Not enough SOL for network fees and account rent.",
      hint: `Add a little SOL (≈0.01–0.03) to this wallet on ${CLUSTER} and try again.`,
      detail: raw,
    };
  }
  if (/Error: insufficient funds|custom program error: 0x1\b|"Custom":1\b/i.test(text)) {
    return {
      kind: "insufficient_gc",
      message: "Not enough $GC in this wallet for that amount.",
      hint: "Lower the amount or top up $GC.",
      detail: raw,
    };
  }
  if (/AccountNotInitialized|could not find account|AccountNotFound|InvalidAccountData|custom program error: 0xbc4\b/i.test(text)) {
    return {
      kind: "no_token_account",
      message: "A required account doesn't exist yet. Usually this means you don't hold $GC on this network.",
      hint: `This app runs on ${CLUSTER}. If your wallet is set to ${otherNetwork}, switch networks in your wallet settings.`,
      detail: raw,
    };
  }
  if (/TransactionExpiredTimeoutError|was not confirmed in/i.test(text)) {
    return {
      kind: "expired",
      message: "We couldn't confirm the transaction in time. It may still land.",
      hint: "Check the activity tab in your wallet (or refresh here) before trying again, so you don't send it twice.",
      detail: raw,
    };
  }
  if (/block height exceeded|Blockhash not found|TransactionExpired|has expired/i.test(text)) {
    return {
      kind: "expired",
      message: "The transaction expired before it confirmed. Your balance is unchanged, so it's safe to try again.",
      hint:
        CLUSTER === "mainnet-beta"
          ? "Networks get congested sometimes. Retry, and approve quickly in your wallet."
          : `This app runs on ${CLUSTER}. Check your wallet is on ${CLUSTER} too. ${WALLET_NETWORK_HINT}`,
      detail: raw,
    };
  }
  if (/Failed to fetch|NetworkError|ECONNREFUSED|429|Too Many Requests|fetch failed|timed out|503|502/i.test(text)) {
    return {
      kind: "network",
      message: "Couldn't reach the Solana RPC. Check your connection and try again.",
      detail: raw,
    };
  }
  if (/reverted during simulation|simulation failed|Simulation failed/i.test(text)) {
    return {
      kind: "unknown",
      message: "The transaction would fail, so it wasn't sent. Nothing was charged.",
      hint: "Refresh the page and try again. If it keeps happening, copy the details below and send them to us.",
      detail: text.slice(0, 600),
    };
  }
  const walletErr = /^(Wallet\w*Error)/m.exec(text)?.[1];
  if (walletErr && !(e instanceof Error && e.message)) {
    return {
      kind: "unknown",
      message: "Your wallet couldn't complete the request.",
      hint: "Unlock your wallet, make sure it's on " + CLUSTER + ", refresh the page and try again.",
      detail: walletErr,
    };
  }
  return { kind: "unknown", message: raw || "Something went wrong.", detail: raw === text ? undefined : text.slice(0, 600) };
}
