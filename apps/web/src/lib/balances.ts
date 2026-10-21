import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

export async function fetchSolBalance(
  connection: Connection,
  pubkey: PublicKey
): Promise<number> {
  const lamports = await connection.getBalance(pubkey, "confirmed");
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Read SPL (or Token-2022) $GC balance as UI amount.
 * Tries classic SPL ATA first, then Token-2022.
 */
export async function fetchGcBalance(
  connection: Connection,
  owner: PublicKey,
  mintStr: string,
  decimals: number
): Promise<number | null> {
  if (!mintStr) return null;
  let mint: PublicKey;
  try {
    mint = new PublicKey(mintStr);
  } catch {
    return null;
  }

  for (const programId of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
    try {
      const ata = getAssociatedTokenAddressSync(
        mint,
        owner,
        false,
        programId
      );
      const info = await connection.getTokenAccountBalance(ata, "confirmed");
      if (info?.value) {
        return Number(info.value.uiAmountString ?? info.value.uiAmount ?? 0);
      }
    } catch {
      // ATA missing or wrong program — try next
    }
  }

  // Fallback: scan token accounts by mint
  try {
    const resp = await connection.getParsedTokenAccountsByOwner(owner, {
      mint,
    });
    const acc = resp.value[0];
    if (!acc) return 0;
    const amt = acc.account.data.parsed?.info?.tokenAmount;
    if (!amt) return 0;
    return Number(amt.uiAmountString ?? amt.uiAmount ?? 0);
  } catch {
    return 0;
  }
}

export function formatGc(n: number | null, digits = 2): string {
  if (n === null) return "—";
  return n.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}
