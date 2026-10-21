"use client";

import { useEffect, useMemo, useRef, type ComponentType, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import type { Adapter } from "@solana/wallet-adapter-base";
import { RPC_URL } from "@/lib/config";
import { MOCK_WALLET_NAME, MockWalletAdapter, mockWalletKey } from "@/lib/mockWallet";
import { friendlyError } from "@/lib/errors";
import { useToast } from "@/components/Toaster";

// wallet-adapter ships FC types that clash with @types/react under some resolvers
const Conn = ConnectionProvider as ComponentType<{
  endpoint: string;
  children?: ReactNode;
}>;
const Wall = WalletProvider as ComponentType<{
  wallets: Adapter[];
  autoConnect?: boolean;
  onError?: (e: Error) => void;
  children?: ReactNode;
}>;
const Modal = WalletModalProvider as ComponentType<{ children?: ReactNode }>;

export function WalletContextProvider({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => RPC_URL, []);
  const { toast } = useToast();
  // autoConnect can fail quietly on load (locked wallet); only toast for errors after the page has settled.
  const mountedAt = useRef(0);
  useEffect(() => {
    mountedAt.current = Date.now();
  }, []);
  const wallets = useMemo<Adapter[]>(() => {
    const mock = mockWalletKey();
    if (mock) {
      // Local screenshots / UI tests only (never on mainnet builds): auto-select the read-only mock.
      // sessionStorage "gc.mock.disconnected"=1 starts disconnected (to capture the not-connected UI).
      if (typeof window !== "undefined") {
        if (window.sessionStorage.getItem("gc.mock.disconnected") === "1") window.localStorage.removeItem("walletName");
        else window.localStorage.setItem("walletName", JSON.stringify(MOCK_WALLET_NAME));
      }
      return [new MockWalletAdapter(mock)];
    }
    return [new PhantomWalletAdapter()];
  }, []);

  return (
    <Conn endpoint={endpoint}>
      <Wall
        wallets={wallets}
        autoConnect
        onError={(e) => {
          // Connection-level errors. A closed popup is a normal "no thanks", so it stays quiet; anything else
          // (wallet locked, not installed, connection refused) gets one friendly toast. Actions show their own errors.
          const f = friendlyError(e);
          console.warn("wallet:", f.message);
          if (f.kind === "rejected" || e?.name === "WalletNotSelectedError" || Date.now() - mountedAt.current < 3000) return;
          // Signing / sending errors are reported by the action that asked (with the real reason), not as "can't connect".
          if (/^Wallet(Send|Sign)/.test(e?.name ?? "")) return;
          toast({ tone: "error", title: "Couldn't connect your wallet", body: "Unlock your wallet, check it's set to the right network, and try again." });
        }}
      >
        <Modal>{children}</Modal>
      </Wall>
    </Conn>
  );
}
