"use client";

import dynamic from "next/dynamic";

const LABELS = {
  "change-wallet": "Change wallet",
  connecting: "Connecting…",
  "copy-address": "Copy address",
  copied: "Copied!",
  disconnect: "Disconnect",
  "has-wallet": "Connect",
  "no-wallet": "Connect wallet",
};

/**
 * Wallet button (Phantom + any Wallet Standard wallet, e.g. MetaMask Solana, Solflare, Backpack, auto-detected).
 * It renders the remembered wallet's icon from localStorage, which never matches the server HTML, so it loads
 * client-only behind a same-size placeholder to avoid hydration errors.
 */
export const WalletButton = dynamic(
  async () => {
    const { BaseWalletMultiButton } = await import("@solana/wallet-adapter-react-ui");
    function GcWalletButton() {
      return <BaseWalletMultiButton labels={LABELS} />;
    }
    return GcWalletButton;
  },
  {
    ssr: false,
    loading: () => (
      <span
        role="status"
        aria-label="Loading wallet"
        className="inline-block h-10 w-[140px] animate-pulse rounded-full bg-gc-lime/20 motion-reduce:animate-none"
      />
    ),
  }
);
