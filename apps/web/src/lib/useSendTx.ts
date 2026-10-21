"use client";

import { useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  type Keypair,
  type TransactionInstruction,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { friendlyError, UserFacingError } from "@/lib/errors";
import { useToast } from "@/components/Toaster";
import { CLUSTER } from "@/lib/config";
import { sendAndConfirmWithWallet } from "@/lib/walletSend";

export type SendOpts = {
  /** Compute-unit limit (adds a ComputeBudget ix). */
  cu?: number;
  /** Extra signers (e.g. a fresh NFT mint keypair). */
  signers?: Keypair[];
  /** Minimum SOL the wallet should hold (fees + any rent the tx creates). */
  minSol?: number;
  /** Toast title on success (default "Transaction confirmed"). Pass `false` to skip toasts for this send. */
  toast?: string | false;
  /** Simulate on the app's RPC before the wallet prompt, so program errors (e.g. LiabilityFloor) show as clear messages. */
  preflight?: boolean;
};

/** Simulate before the wallet sees the tx; a failure throws with the program logs (→ friendlyError). RPC hiccups are ignored. */
async function preflight(connection: Connection, tx: Transaction): Promise<void> {
  let sim;
  try {
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    sim = await connection.simulateTransaction(VersionedTransaction.deserialize(bytes), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  } catch {
    return;
  }
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const e = new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}\n${logs.join("\n")}`) as Error & { logs?: string[] };
    e.logs = logs;
    throw e;
  }
}

/**
 * Send + confirm with a fresh blockhash and its lastValidBlockHeight, so an expired tx surfaces as a
 * clear "expired" error instead of hanging. Pre-checks SOL for fees/rent.
 */
export function useSendTx() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction, connected, wallet } = useWallet();
  const walletName = wallet?.adapter.name;
  const adapter = wallet?.adapter;
  const { toast } = useToast();

  const sendRaw = useCallback(
    async (ixs: TransactionInstruction[], opts: SendOpts = {}): Promise<string> => {
      if (!publicKey || !connected) throw new UserFacingError("not_connected", "Connect your wallet first.");
      const minSol = opts.minSol ?? 0.002;
      const lamports = await connection.getBalance(publicKey, "confirmed");
      if (lamports < minSol * LAMPORTS_PER_SOL) {
        throw new UserFacingError(
          "insufficient_sol",
          `You need about ${minSol} SOL for fees and rent; this wallet has ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL.`,
          `Add SOL on ${CLUSTER} and try again.`
        );
      }
      const tx = new Transaction();
      if (opts.cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu }));
      tx.add(...ixs);
      if (opts.preflight) {
        // Simulate with any recent blockhash (replaceRecentBlockhash); the real one is set right before the wallet prompt.
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
        tx.feePayer = publicKey;
        await preflight(connection, tx);
      }
      const sig = await sendAndConfirmWithWallet(
        { connection, publicKey, walletName, adapter, sendTransaction, signTransaction },
        tx,
        { signers: opts.signers }
      );
      return sig;
    },
    [connection, publicKey, sendTransaction, signTransaction, connected, walletName, adapter]
  );

  // Every transaction result gets the same toast (panels still show their inline notices).
  return useCallback(
    async (ixs: TransactionInstruction[], opts: SendOpts = {}): Promise<string> => {
      try {
        const sig = await sendRaw(ixs, opts);
        if (opts.toast !== false) toast({ tone: "success", title: opts.toast || "Transaction confirmed", sig });
        return sig;
      } catch (e) {
        if (opts.toast !== false) {
          const f = friendlyError(e);
          toast(
            f.kind === "rejected"
              ? { tone: "info", title: "Cancelled in your wallet", body: "Nothing was sent." }
              : { tone: "error", title: f.message, body: f.hint ?? f.detail }
          );
        }
        throw e;
      }
    },
    [sendRaw, toast]
  );
}
