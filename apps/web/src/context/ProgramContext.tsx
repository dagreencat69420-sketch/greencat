"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  decodeCollectionAccount,
  decodeConfigAccount,
  deriveCollectionPda,
  deriveConfigPda,
  GREENCAT_PROGRAM_ID,
  type DecodedCollection,
  type DecodedConfig,
} from "@greencat/sdk";
import { CLUSTER, GC_DECIMALS, getActiveGcMint } from "@/lib/config";
import { fetchGcBalance, fetchSolBalance } from "@/lib/balances";
import { friendlyError, type FriendlyError } from "@/lib/errors";

const GENESIS: Partial<Record<string, string>> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

export type ProgramStatus = "loading" | "ready" | "not_deployed" | "not_initialized" | "error";

type ProgramState = {
  status: ProgramStatus;
  error: FriendlyError | null;
  config: DecodedConfig | null;
  collection: DecodedCollection | null;
  programId: PublicKey;
  /** Token program from the on-chain config (falls back to the cluster default before init). */
  tokenProgram: PublicKey;
  /** $GC mint: on-chain config is authoritative; env/cluster default before init. */
  gcMint: PublicKey | null;
  /** Set when NEXT_PUBLIC_GC_MINT disagrees with the deployed config. */
  mintMismatch: string | null;
  /** Set when the RPC endpoint is not the cluster the app was built for. */
  rpcMismatch: string | null;
  isAdmin: boolean;
  paused: boolean;
  sol: number | null;
  gc: number | null;
  balancesLoading: boolean;
  refresh: () => Promise<void>;
  refreshBalances: () => Promise<void>;
};

const Ctx = createContext<ProgramState | null>(null);

export function ProgramProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const programId = useMemo(() => new PublicKey(GREENCAT_PROGRAM_ID), []);
  const [status, setStatus] = useState<ProgramStatus>("loading");
  const [error, setError] = useState<FriendlyError | null>(null);
  const [config, setConfig] = useState<DecodedConfig | null>(null);
  const [collection, setCollection] = useState<DecodedCollection | null>(null);
  const [rpcMismatch, setRpcMismatch] = useState<string | null>(null);
  const [sol, setSol] = useState<number | null>(null);
  const [gc, setGc] = useState<number | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);

  const envMint = getActiveGcMint();
  const gcMintStr = config?.gcMint ?? envMint;
  const gcMint = useMemo(() => {
    try {
      return gcMintStr ? new PublicKey(gcMintStr) : null;
    } catch {
      return null;
    }
  }, [gcMintStr]);
  const tokenProgram = useMemo(
    () =>
      config
        ? new PublicKey(config.tokenProgram)
        : CLUSTER === "mainnet-beta"
          ? TOKEN_2022_PROGRAM_ID
          : TOKEN_PROGRAM_ID,
    [config]
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [cfgPda] = deriveConfigPda(programId);
      const [colPda] = deriveCollectionPda(programId);
      const [prog, cfg, col] = await connection.getMultipleAccountsInfo([programId, cfgPda, colPda], "confirmed");
      setConfig(cfg ? decodeConfigAccount(Buffer.from(cfg.data)) : null);
      setCollection(col ? decodeCollectionAccount(Buffer.from(col.data)) : null);
      setStatus(!prog ? "not_deployed" : !cfg ? "not_initialized" : "ready");
    } catch (e) {
      setError(friendlyError(e));
      setStatus("error");
    }
  }, [connection, programId]);

  const refreshBalances = useCallback(async () => {
    if (!publicKey) {
      setSol(null);
      setGc(null);
      return;
    }
    setBalancesLoading(true);
    try {
      const [s, g] = await Promise.all([
        fetchSolBalance(connection, publicKey),
        gcMintStr ? fetchGcBalance(connection, publicKey, gcMintStr, GC_DECIMALS) : Promise.resolve(null),
      ]);
      setSol(s);
      setGc(g);
    } catch {
      /* keep last known balances; panels surface RPC errors on actions */
    } finally {
      setBalancesLoading(false);
    }
  }, [connection, publicKey, gcMintStr]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    void refreshBalances();
    if (!publicKey) return;
    const id = window.setInterval(() => void refreshBalances(), 20_000);
    return () => window.clearInterval(id);
  }, [publicKey, refreshBalances]);

  useEffect(() => {
    const expected = GENESIS[CLUSTER];
    if (!expected) return;
    connection
      .getGenesisHash()
      .then((h) => setRpcMismatch(h === expected ? null : `The RPC endpoint is not ${CLUSTER}.`))
      .catch(() => {});
  }, [connection]);

  const mintMismatch =
    config && envMint && config.gcMint !== envMint
      ? `App is configured for $GC ${envMint.slice(0, 4)}… but the program uses ${config.gcMint.slice(0, 4)}…`
      : null;

  const value: ProgramState = {
    status,
    error,
    config,
    collection,
    programId,
    tokenProgram,
    gcMint,
    mintMismatch,
    rpcMismatch,
    isAdmin: !!(config && publicKey && config.authority === publicKey.toBase58()),
    paused: config?.paused === true,
    sol,
    gc,
    balancesLoading,
    refresh,
    refreshBalances,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProgram(): ProgramState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProgram must be used inside <ProgramProvider>");
  return v;
}

/** Re-render every `ms` and return the current unix time in seconds (for countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}
