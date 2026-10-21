"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";

const FLAG = "greencat.pointsRedirected";

/**
 * On first wallet connect this session, land on Points (demo parity).
 * Subsequent visits to `/` keep the full hub (mint/stake/market/…) so panels stay reachable.
 */
export function ConnectedRedirect() {
  const { connected } = useWallet();
  const pathname = usePathname();
  const router = useRouter();
  const wasConnected = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!connected) {
      wasConnected.current = false;
      return;
    }
    const justConnected = !wasConnected.current;
    wasConnected.current = true;
    if (!justConnected) return;
    if (pathname !== "/") return;
    if (sessionStorage.getItem(FLAG) === "1") return;
    sessionStorage.setItem(FLAG, "1");
    router.replace("/points");
  }, [connected, pathname, router]);

  return null;
}
