"use client";

/**
 * /fund: devnet-only helper (unlisted, noindex) to move test SOL from the connected wallet (e.g. MetaMask
 * Solana) to the deployer, without touching the wallet's own network menu.
 *
 * Chain targeting:
 *  - Balances, blockhash and confirmation all go through the app's devnet `Connection` (useConnection()).
 *  - Before sending we check that connection really is devnet (genesis hash) and that its endpoint maps to
 *    `solana:devnet` under Wallet Standard's endpoint→chain rule, which is what wallet-adapter's
 *    StandardWalletAdapter passes as `chain` to `solana:signAndSendTransaction`. MetaMask maps that chain to
 *    its devnet scope (solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1) and asks to add devnet permission if needed.
 *  - Fallback (endpoint wouldn't map to devnet, or the wallet's send path fails): signTransaction on the SAME
 *    transaction (same devnet blockhash, so the signature is identical: no double send) and submit the raw
 *    bytes through the app's devnet connection with sendRawTransaction.
 *  - The devnet blockhash makes the transaction invalid on mainnet, so it cannot land there either way.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { PageHeader, Panel, Notice, Stat, btn, field, labelCls } from "@/components/ui";
import { WalletButton } from "@/components/WalletButton";
import { useToast } from "@/components/Toaster";
import { CLUSTER } from "@/lib/config";
import { explorerUrl, shortKey } from "@/lib/explorer";
import { friendlyError } from "@/lib/errors";
import { prefersSignThenSubmit } from "@/lib/walletSend";

const DESTINATION = new PublicKey("BVtgzT5Jpqgk5LyJQHMYpab2TwSyWiNPZthrpEKd8Tgp");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEFAULT_AMOUNT = "20";
/** Kept back in the sender wallet for the network fee. */
const FEE_RESERVE_SOL = 0.001;

/** Same rule as @solana/wallet-standard-util getChainForEndpoint (used by wallet-adapter for `chain`). */
function walletStandardChainFor(endpoint: string): string {
  if (endpoint.includes("https://api.mainnet-beta.solana.com")) return "solana:mainnet";
  if (/\bdevnet\b/i.test(endpoint)) return "solana:devnet";
  if (/\btestnet\b/i.test(endpoint)) return "solana:testnet";
  if (/\blocalhost\b/i.test(endpoint) || /\b127\.0\.0\.1\b/.test(endpoint)) return "solana:localnet";
  return "solana:mainnet";
}

function fmtSol(n: number | null): string {
  if (n === null) return "—";
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`;
}

export default function FundPage() {
  const { connection } = useConnection();
  const { publicKey, connected, sendTransaction, signTransaction, wallet } = useWallet();
  const { toast } = useToast();

  const [myBal, setMyBal] = useState<number | null>(null);
  const [destBal, setDestBal] = useState<number | null>(null);
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [genesisOk, setGenesisOk] = useState<boolean | null>(null);

  const isDevnetBuild = CLUSTER === "devnet";
  const endpointChain = useMemo(() => walletStandardChainFor(connection.rpcEndpoint), [connection.rpcEndpoint]);

  useEffect(() => {
    let live = true;
    connection
      .getGenesisHash()
      .then((g) => live && setGenesisOk(g === DEVNET_GENESIS))
      .catch(() => live && setGenesisOk(null));
    return () => {
      live = false;
    };
  }, [connection]);

  const refresh = useCallback(async () => {
    try {
      const [d, m] = await Promise.all([
        connection.getBalance(DESTINATION, "confirmed"),
        publicKey ? connection.getBalance(publicKey, "confirmed") : Promise.resolve(null),
      ]);
      setDestBal(d / LAMPORTS_PER_SOL);
      setMyBal(m === null ? null : m / LAMPORTS_PER_SOL);
    } catch (e) {
      console.warn("fund: balance read failed", e);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  const tooMuch = myBal !== null && amountValid && amountNum > myBal - FEE_RESERVE_SOL;
  const canSend = isDevnetBuild && genesisOk === true && connected && !!publicKey && amountValid && !tooMuch && !busy;

  const onSend = useCallback(async () => {
    if (!publicKey || !canSend) return;
    setBusy(true);
    setLastSig(null);
    try {
      // Hard guard: never sign anything unless the app's connection is devnet.
      const genesis = await connection.getGenesisHash();
      if (genesis !== DEVNET_GENESIS) throw new Error("The app's RPC connection is not devnet. Nothing was sent.");

      const lamports = Math.round(amountNum * LAMPORTS_PER_SOL);
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: DESTINATION, lamports }));
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signAndSubmitViaApp = async (): Promise<string> => {
        if (!signTransaction) throw new Error("This wallet can't sign a transaction for the app to submit.");
        setStatus("Approve in your wallet (sign only). The app submits it to devnet…");
        const signed = await signTransaction(tx);
        setStatus("Submitting to devnet…");
        return connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed", maxRetries: 3 });
      };

      let sig: string;
      if (endpointChain === "solana:devnet" && !prefersSignThenSubmit(wallet?.adapter.name)) {
        try {
          setStatus("Approve the devnet transfer in your wallet…");
          // wallet-adapter passes chain "solana:devnet" (derived from the devnet endpoint) to the wallet.
          sig = await sendTransaction(tx, connection, { preflightCommitment: "confirmed", maxRetries: 3 });
        } catch (e) {
          if (friendlyError(e).kind === "rejected") throw e;
          console.warn("fund: wallet send failed, falling back to sign + devnet submit", e);
          toast({ tone: "info", title: "Retrying: sign only, the app submits to devnet" });
          sig = await signAndSubmitViaApp();
        }
      } else {
        sig = await signAndSubmitViaApp();
      }

      setStatus("Confirming on devnet…");
      const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
      setLastSig(sig);
      toast({ tone: "success", title: `Sent ${amountNum} devnet SOL`, body: `To ${shortKey(DESTINATION.toBase58())}`, sig });
      await refresh();
    } catch (e) {
      const f = friendlyError(e);
      toast(
        f.kind === "rejected"
          ? { tone: "info", title: "Cancelled in your wallet", body: "Nothing was sent." }
          : { tone: "error", title: f.message, body: f.hint ?? (e instanceof Error ? e.message.slice(0, 200) : undefined) }
      );
    } finally {
      setStatus(null);
      setBusy(false);
    }
  }, [publicKey, canSend, connection, amountNum, endpointChain, sendTransaction, signTransaction, toast, refresh, wallet]);

  return (
    <>
      <PageHeader title="Fund (devnet)" subtitle="Send devnet test SOL from your wallet to the GreenCat deployer." />

      <div className="space-y-4">
        <Notice tone="warn" title="Devnet only">
          This page only sends <strong>devnet</strong> SOL (free test tokens with no value). The transaction is built
          with a devnet blockhash and checked against the devnet RPC before your wallet is asked to sign, so you
          don&apos;t need to change networks in MetaMask. Never use this page for mainnet funds.
        </Notice>

        {!isDevnetBuild && (
          <Notice tone="error" title="Disabled on this build">
            This deployment is configured for {CLUSTER}, not devnet. Sending is turned off.
          </Notice>
        )}
        {isDevnetBuild && genesisOk === false && (
          <Notice tone="error" title="RPC isn't devnet">
            The app&apos;s RPC endpoint doesn&apos;t report the devnet genesis hash. Sending is turned off.
          </Notice>
        )}

        <Panel title="Balances (devnet)" subtitle="Read from the app's devnet RPC connection." actions={
          <button type="button" className={btn.small} onClick={() => void refresh()}>
            Refresh
          </button>
        }>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Stat label="Your wallet" value={connected ? fmtSol(myBal) : "Not connected"} />
              {publicKey && (
                <a href={explorerUrl("address", publicKey.toBase58())} target="_blank" rel="noreferrer" className="mt-1 block break-all font-mono text-xs text-gc-mute underline">
                  {publicKey.toBase58()}
                </a>
              )}
              {wallet && <p className="mt-0.5 text-xs text-gc-mute">via {wallet.adapter.name}</p>}
            </div>
            <div>
              <Stat label="Destination (deployer)" value={fmtSol(destBal)} tone="lime" />
              <a href={explorerUrl("address", DESTINATION.toBase58())} target="_blank" rel="noreferrer" className="mt-1 block break-all font-mono text-xs text-gc-mute underline">
                {DESTINATION.toBase58()}
              </a>
            </div>
          </div>
        </Panel>

        <Panel title="Send devnet SOL">
          {!connected ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-gc-mute">Connect your wallet (MetaMask Solana is detected automatically).</p>
              <WalletButton />
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void onSend();
              }}
            >
              <div>
                <label htmlFor="fund-amount" className={labelCls}>
                  Amount (devnet SOL)
                </label>
                <input
                  id="fund-amount"
                  className={`${field} mt-1 max-w-xs`}
                  inputMode="decimal"
                  type="number"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                {!amountValid && <p className="mt-1 text-xs text-red-200">Enter an amount above 0.</p>}
                {tooMuch && <p className="mt-1 text-xs text-red-200">More than this wallet holds on devnet (keep a little for the fee).</p>}
              </div>
              <button type="submit" className={btn.primary} disabled={!canSend}>
                {busy ? "Sending…" : "Send devnet SOL"}
              </button>
              {status && (
                <p role="status" className="text-xs text-gc-mute">
                  {status}
                </p>
              )}
              {lastSig && (
                <p className="text-xs">
                  <a href={explorerUrl("tx", lastSig)} target="_blank" rel="noreferrer" className="text-gc-lime underline">
                    Last transfer on Solana Explorer (devnet) ↗
                  </a>
                </p>
              )}
            </form>
          )}
        </Panel>
      </div>
    </>
  );
}
