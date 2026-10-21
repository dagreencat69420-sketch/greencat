/**
 * One place that hands a transaction to the wallet and confirms it on the APP's cluster.
 *
 * Two paths:
 *  - "sign-and-send" (default): wallet-adapter `sendTransaction` → Wallet Standard `solana:signAndSendTransaction`
 *    with the chain derived from our RPC endpoint. MetaMask needs this path (its `signTransaction` carries no
 *    chain and simulates on mainnet, see ddd3c9a).
 *  - "sign-then-submit": the wallet only signs (`signTransaction`), and WE submit the raw bytes through the app's
 *    own RPC connection and rebroadcast until confirmed or expired. Used for Phantom on devnet/testnet/localnet:
 *    Phantom's signAndSendTransaction simulates and submits on the network selected in Phantom (Testnet Mode),
 *    not the `chain` the dApp passes. With Testnet Mode off it simulated on mainnet ("Failed to simulate the
 *    results of this request"), sent there, the devnet blockhash was unknown, nothing landed on devnet, and the
 *    app reported "The transaction expired before it confirmed". Submitting ourselves guarantees the tx reaches
 *    the cluster the app actually reads from.
 *
 * The blockhash is fetched right before the wallet prompt (after the app-side preflight), and confirmation uses
 * that blockhash's lastValidBlockHeight. If the wallet replaced the blockhash while signing we derive a new
 * expiry height instead of waiting on the wrong one.
 */
import type { Connection, Keypair, PublicKey, SendOptions, Transaction, TransactionSignature } from "@solana/web3.js";
import type { WalletName } from "@solana/wallet-adapter-base";
import { CLUSTER } from "@/lib/config";
import { UserFacingError } from "@/lib/errors";

type SendTransactionFn = (
  tx: Transaction,
  connection: Connection,
  options?: SendOptions & { signers?: Keypair[] }
) => Promise<TransactionSignature>;
type SignTransactionFn = <T extends Transaction>(tx: T) => Promise<T>;

export type WalletSendCtx = {
  connection: Connection;
  publicKey: PublicKey;
  walletName?: WalletName | string | null;
  /** wallet-adapter adapter; for Wallet Standard wallets we call `solana:signTransaction` with our chain. */
  adapter?: unknown;
  sendTransaction: SendTransactionFn;
  signTransaction?: SignTransactionFn;
};

/** Phantom (extension, in-app browser, or deeplink) on a non-mainnet build: sign only, the app submits. */
export function prefersSignThenSubmit(walletName: string | null | undefined, cluster: string = CLUSTER): boolean {
  if (cluster === "mainnet-beta") return false;
  return /phantom/i.test(walletName ?? "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CHAIN_FOR_CLUSTER: Record<string, string> = {
  devnet: "solana:devnet",
  testnet: "solana:testnet",
  localnet: "solana:localnet",
  "mainnet-beta": "solana:mainnet",
};

type StdAccount = { address: string };
type StdSignTx = {
  signTransaction: (...inputs: { account: StdAccount; transaction: Uint8Array; chain?: string }[]) => Promise<{ signedTransaction: Uint8Array }[]>;
};

/**
 * wallet-adapter's StandardWalletAdapter.signTransaction passes no `chain`, so the wallet previews on whatever
 * network it's set to. Call the Wallet Standard feature directly with the app's chain so a wallet that honours
 * it previews on devnet. Returns null when the adapter isn't a Wallet Standard one (caller falls back).
 */
async function signWithChain(adapter: unknown, publicKey: PublicKey, tx: Transaction): Promise<Transaction | null> {
  const w = (adapter as { wallet?: { features?: Record<string, unknown>; accounts?: readonly StdAccount[] } } | undefined)?.wallet;
  const feature = w?.features?.["solana:signTransaction"] as StdSignTx | undefined;
  const account = w?.accounts?.find((a) => a.address === publicKey.toBase58());
  if (!feature?.signTransaction || !account) return null;
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const [out] = await feature.signTransaction({ account, transaction: new Uint8Array(bytes), chain: CHAIN_FOR_CLUSTER[CLUSTER] });
  if (!out?.signedTransaction) return null;
  const { Transaction: Tx } = await import("@solana/web3.js");
  return Tx.from(out.signedTransaction);
}

/**
 * Give the wallet `tx` (fee payer + instructions set; extra `signers` are applied here after the final
 * blockhash is set) and wait for "confirmed" on the app's cluster. Throws on program failure / expiry.
 */
export async function sendAndConfirmWithWallet(
  ctx: WalletSendCtx,
  tx: Transaction,
  opts: { signers?: Keypair[]; onSubmitted?: (sig: string) => void } = {}
): Promise<string> {
  const { connection } = ctx;
  // Fresh blockhash immediately before the prompt (mobile approvals can take a while).
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = ctx.publicKey;

  if (!(prefersSignThenSubmit(ctx.walletName) && ctx.signTransaction)) {
    const sig = await ctx.sendTransaction(tx, connection, {
      signers: opts.signers?.length ? opts.signers : undefined,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });
    opts.onSubmitted?.(sig);
    const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  // Phantom signs FIRST, extra signers (e.g. the fresh NFT mint keypair) after: Phantom's guidance for multi-signer
  // txs ("sign it with Phantom first using signTransaction, then collect signatures from the other signers"), and
  // it stays correct even if the wallet adjusted the message (we sign whatever it returned).
  const signed = (await signWithChain(ctx.adapter, ctx.publicKey, tx)) ?? (await ctx.signTransaction(tx));
  if (opts.signers?.length) signed.partialSign(...opts.signers);
  if (!signed.signature) throw new UserFacingError("unknown", "Your wallet returned an unsigned transaction.", "Refresh the page and try again.");
  let expiryHeight = lastValidBlockHeight;
  const usedBlockhash = signed.recentBlockhash ?? blockhash;
  if (usedBlockhash !== blockhash) {
    // Wallet swapped in its own blockhash: ~150 blocks of validity from now is the conservative bound.
    expiryHeight = (await connection.getBlockHeight("confirmed")) + 150;
  }
  const raw = signed.serialize();
  // Preflight on the app's RPC: a program error comes back immediately with logs (→ friendlyError).
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
  opts.onSubmitted?.(sig);

  // Rebroadcast every 2 s until confirmed or the blockhash expires (public devnet RPC drops txs under load).
  let done = false;
  const rebroadcast = (async () => {
    while (!done) {
      await sleep(2000);
      if (done) break;
      try {
        await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
      } catch {
        /* already processed / transient: ignore */
      }
    }
  })();
  try {
    const res = await connection.confirmTransaction(
      { signature: sig, blockhash: usedBlockhash, lastValidBlockHeight: expiryHeight },
      "confirmed"
    );
    if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  } finally {
    done = true;
    void rebroadcast;
  }
}
