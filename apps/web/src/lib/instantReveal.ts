"use client";

/**
 * Instant per-mint reveal (audit GC-17), client side.
 *
 * mint_nft pays + mints + requests one ORAO VRF. ORAO answers in seconds; then anyone can send
 * settle_mint for the queue head, which assigns the random token id and rewrites the metadata.
 *
 * Every transaction goes through `sendAndConfirmWithWallet` (lib/walletSend: Phantom on devnet = sign + app submits;
 * everyone else = wallet-adapter `sendTransaction`, i.e. Wallet Standard signAndSendTransaction
 * with the app's chain), which works the same in Phantom, Solflare, Backpack and MetaMask. Nothing is
 * pre-signed before it can simulate successfully (see mintAndReveal).
 */
import { useCallback } from "react";
import { sendAndConfirmWithWallet } from "@/lib/walletSend";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  type Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  SETTLE_MINT_COMPUTE_UNITS,
  buildRequestMintVrfIx,
  decodeNftRecordAccount,
  deriveNftRecordPda,
  fetchOraoTreasury,
  fetchRevealQueue,
  settleIxsFromQueue,
  type DecodedNftRecord,
} from "@greencat/sdk";
import { CLUSTER } from "@/lib/config";
import { UserFacingError } from "@/lib/errors";

export type RevealPhase =
  | { kind: "waiting_oracle" }
  | { kind: "queued"; ahead: number }
  | { kind: "settling" }
  | { kind: "needs_approval"; reason: string }
  | { kind: "revealed"; record: DecodedNftRecord; sig: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simulate on the app's RPC before the wallet sees the tx; a failure throws with the program logs (→ friendlyError). */
async function preflight(connection: Connection, tx: Transaction): Promise<void> {
  let sim;
  try {
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    sim = await connection.simulateTransaction(VersionedTransaction.deserialize(bytes), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
  } catch {
    return; // RPC hiccup: let the wallet / cluster decide
  }
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const e = new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}\n${logs.join("\n")}`) as Error & { logs?: string[] };
    e.logs = logs;
    throw e;
  }
}

export function useInstantReveal(programId: PublicKey) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction, wallet } = useWallet();
  const walletName = wallet?.adapter.name;
  const adapter = wallet?.adapter;

  const readRecord = useCallback(
    async (nftMint: PublicKey) => {
      const info = await connection.getAccountInfo(deriveNftRecordPda(nftMint, programId)[0], "confirmed");
      return info ? decodeNftRecordAccount(Buffer.from(info.data)) : null;
    },
    [connection, programId]
  );

  /** Settle the queue up to `nftMint` (and request its VRF if it never had one). One wallet approval per tx. */
  const revealNow = useCallback(
    async (nftMint: PublicKey, vrfExpirySecs: number): Promise<string | null> => {
      if (!publicKey) throw new UserFacingError("not_connected", "Connect your wallet first.");
      const rec = await readRecord(nftMint);
      if (!rec) throw new UserFacingError("unknown", "That isn't a GreenCat NFT.");
      if (rec.revealed) return null;
      const q = await fetchRevealQueue(connection, programId, 64);
      const mine = q.entries.find((e) => e.mintIndex === rec.mintIndex);
      const ixs: TransactionInstruction[] = [];
      let cu = 0;
      const now = Math.floor(Date.now() / 1000);
      if (mine && (!mine.nftMint || (!mine.fulfilled && now >= mine.requestedTs + vrfExpirySecs))) {
        // legacy NFT (minted before the instant-reveal upgrade) or an oracle timeout: (re-)request the VRF
        const treasury = await fetchOraoTreasury(connection);
        ixs.push(
          buildRequestMintVrfIx({
            payer: publicKey,
            nftMint,
            attempt: mine.nftMint ? mine.attempt + 1 : 1,
            previousAttempt: mine.nftMint ? mine.attempt : null,
            vrfTreasury: treasury,
            programId,
          })
        );
        cu += 200_000;
      } else {
        const settle = settleIxsFromQueue(q, programId, { max: 3, upToMintIndex: rec.mintIndex });
        if (!settle.length) {
          const head = q.entries[0];
          throw new UserFacingError(
            "unknown",
            head && head.mintIndex < rec.mintIndex
              ? `Waiting for ${rec.mintIndex - head.mintIndex} earlier mint(s) to get their oracle answer.`
              : "The oracle hasn't answered yet. Give it a few seconds."
          );
        }
        ixs.push(...settle);
        cu += SETTLE_MINT_COMPUTE_UNITS * settle.length;
      }
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs);
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      tx.feePayer = publicKey;
      await preflight(connection, tx);
      return sendAndConfirmWithWallet({ connection, publicKey, walletName, adapter, sendTransaction, signTransaction }, tx);
    },
    [connection, programId, publicKey, readRecord, sendTransaction, signTransaction, walletName, adapter]
  );

  /**
   * Mint with ONE normal wallet approval (wallet-adapter `sendTransaction` → Wallet Standard
   * `solana:signAndSendTransaction` with the app's chain), then `wait()` follows the oracle + reveal queue.
   *
   * We deliberately do NOT pre-sign the settle together with the mint (signAllTransactions): the settle can't
   * succeed until the mint has landed, so every wallet that previews transactions (MetaMask, Phantom, ...)
   * shows it as "reverted during simulation", and MetaMask implements signAll as sequential prompts on
   * `solana:signTransaction`. Declining that second prompt dropped the mint too. The reveal is a separate,
   * normal transaction that is only built once it will actually succeed.
   */
  const mintAndReveal = useCallback(
    async (mintIx: TransactionInstruction, nftMint: Keypair, opts: { cu: number; minSol: number }) => {
      if (!publicKey) throw new UserFacingError("not_connected", "Connect your wallet first.");
      const lamports = await connection.getBalance(publicKey, "confirmed");
      if (lamports < opts.minSol * LAMPORTS_PER_SOL) {
        throw new UserFacingError(
          "insufficient_sol",
          `You need about ${opts.minSol} SOL for fees, rent and the oracle fee; this wallet has ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL.`,
          `Add SOL on ${CLUSTER} and try again.`
        );
      }
      const mintTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu }), mintIx);
      mintTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      mintTx.feePayer = publicKey;

      // Pre-flight on the app's own RPC so a program error shows up as a clear message, not a wallet warning.
      await preflight(connection, mintTx);

      const mintSig = await sendAndConfirmWithWallet(
        { connection, publicKey, walletName, adapter, sendTransaction, signTransaction },
        mintTx,
        { signers: [nftMint] }
      );

      /** Resolves `revealed` (someone settled it, e.g. a later mint or the crank) or `needs_approval` (ready to settle). */
      const wait = async (onPhase: (p: RevealPhase) => void, timeoutMs = 90_000): Promise<RevealPhase> => {
        const started = Date.now();
        const deadline = started + timeoutMs;
        while (Date.now() < deadline) {
          try {
            const rec = await readRecord(nftMint.publicKey);
            if (rec?.revealed) {
              const p: RevealPhase = { kind: "revealed", record: rec, sig: null };
              onPhase(p);
              return p;
            }
            const q = await fetchRevealQueue(connection, programId, 64);
            const ixs = rec ? settleIxsFromQueue(q, programId, { max: 3, upToMintIndex: rec.mintIndex }) : [];
            // Prompt once the settle tx reaches THIS cat (oracle answered for it and everything before it), so it's
            // one reveal approval; after a grace period also accept settling an earlier backlog first.
            const coversMine = !!rec && ixs.length >= rec.mintIndex - q.head + 1;
            if (rec && ixs.length && (coversMine || Date.now() - started > 20_000)) {
              const p: RevealPhase = { kind: "needs_approval", reason: "The oracle answered. Approve the reveal in your wallet." };
              onPhase(p);
              return p;
            }
            onPhase(rec && q.head < rec.mintIndex ? { kind: "queued", ahead: rec.mintIndex - q.head } : { kind: "waiting_oracle" });
          } catch (e) {
            console.warn("reveal poll (retrying):", e); // transient RPC error: keep polling
          }
          await sleep(1500);
        }
        const p: RevealPhase = { kind: "needs_approval", reason: "The reveal is taking longer than usual." };
        onPhase(p);
        return p;
      };
      return { mintSig, wait };
    },
    [connection, programId, publicKey, readRecord, sendTransaction, signTransaction, walletName, adapter]
  );

  return { mintAndReveal, revealNow, readRecord };
}
