import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fund (devnet)",
  description: "Devnet-only helper to send test SOL to the GreenCat deployer.",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
