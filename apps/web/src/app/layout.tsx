import type { Metadata, Viewport } from "next";
import "./globals.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import { WalletContextProvider } from "@/components/WalletProvider";
import { PointsProvider } from "@/context/PointsContext";
import { ProgramProvider } from "@/context/ProgramContext";
import { AppNav } from "@/components/AppNav";
import { PointsToast } from "@/components/PointsToast";
import { LofiPlayer } from "@/components/LofiPlayer";
import { ConnectedRedirect } from "@/components/ConnectedRedirect";
import { ClusterBanner } from "@/components/WalletNotice";
import { ToastProvider } from "@/components/Toaster";
import { SiteFooter } from "@/components/SiteFooter";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://greencat-app.vercel.app";
const DESCRIPTION =
  "GreenCat ($GC) is the lime-green vinyl cat of Solana. Mint a GreenCat, trade on the $GC marketplace, stake and climb the points board, all from your own wallet.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "GreenCat · $GC holder app on Solana", template: "%s · GreenCat" },
  description: DESCRIPTION,
  applicationName: "GreenCat",
  keywords: ["GreenCat", "$GC", "Solana", "meme token", "NFT", "staking", "lo-fi"],
  openGraph: {
    type: "website",
    siteName: "GreenCat",
    title: "GreenCat · $GC holder app on Solana",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    site: "@GreenCatCrypto",
    creator: "@GreenCatCrypto",
    title: "GreenCat · $GC holder app on Solana",
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#070a08",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <a
          href="#main"
          className="sr-only z-[70] rounded-full bg-gc-lime px-4 py-2 font-semibold text-black focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
        >
          Skip to content
        </a>
        <ToastProvider>
          <WalletContextProvider>
            <ProgramProvider>
              <PointsProvider>
                <AppNav />
                <ClusterBanner />
                <ConnectedRedirect />
                <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl px-4 pb-8 pt-6 outline-none sm:pt-8">
                  {children}
                </main>
                <SiteFooter />
                <PointsToast />
                <LofiPlayer />
              </PointsProvider>
            </ProgramProvider>
          </WalletContextProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
