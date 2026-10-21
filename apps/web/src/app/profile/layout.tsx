import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Profile",
  description: "Your GreenCat wallet: balances, points, streak and cats in one place.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
