import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Airdrop",
  description: "Claim your share of a GreenCat $GC holder snapshot with your Merkle proof.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
