import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Points & leaderboard",
  description: "Claim daily GreenCat points, build streaks and climb the monthly leaderboard. Display-only, never spendable.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
