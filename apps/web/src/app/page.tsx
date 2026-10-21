"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { rawToUi } from "@greencat/sdk";
import { WalletPanel } from "@/components/WalletPanel";
import { WalletButton } from "@/components/WalletButton";
import { ScamNote, SocialLinks } from "@/components/Socials";
import { BuyGc } from "@/components/BuyGc";
import { CLUSTER, DEMO_URL, GC_DECIMALS, MAINNET_CA } from "@/lib/config";
import { formatGc } from "@/lib/balances";
import { usePoints } from "@/context/PointsContext";
import { useProgram } from "@/context/ProgramContext";
import { btn, focusRing, Skeleton } from "@/components/ui";

const NET = CLUSTER === "mainnet-beta" ? "Solana" : CLUSTER === "devnet" ? "Devnet" : CLUSTER;

function LaunchPill() {
  const { status, paused } = useProgram();
  if (status === "loading") return <Skeleton className="h-7 w-48 rounded-full" />;
  const live = status === "ready" && !paused;
  const text =
    status === "ready" ? (paused ? "Paused for maintenance" : `Live on ${NET}`) : status === "error" ? `Can't reach ${NET} right now` : `Launching soon on ${NET}`;
  return (
    <p
      role="status"
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wider shadow-neonSm ${
        live ? "border-gc-lime/50 bg-gc-lime/15 text-gc-lime" : "border-gc-lime/30 bg-gc-lime/10 text-gc-neon"
      }`}
    >
      <span aria-hidden className="relative flex h-2 w-2">
        {!live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gc-lime opacity-60 motion-reduce:hidden" />}
        <span className="relative inline-flex h-2 w-2 rounded-full bg-gc-lime" />
      </span>
      {text}
    </p>
  );
}

export default function HomePage() {
  const { connected } = useWallet();
  const { myPoints, myStreak, claimedPointsToday } = usePoints();
  const { status, config, collection, isAdmin } = useProgram();
  const loading = status === "loading";
  const notLive = status === "not_deployed" || status === "not_initialized";

  const revealText = !collection
    ? notLive
      ? "Launching soon"
      : "Not open yet"
    : `${Number(collection.mintedCount).toLocaleString()} / ${Number(collection.collectionSize).toLocaleString()} minted · instant reveal`;

  const soon = (live: string) => (notLive ? "Launching soon" : live);

  const tiles = [
    { href: "/mint", icon: "🎁", title: "Mint + reveal", stat: revealText },
    { href: "/market", icon: "🛒", title: "Marketplace", stat: soon("Buy and sell cats for $GC") },
    { href: "/stake", icon: "🔒", title: "Stake", stat: soon("Daily accrual or 365-day tranches") },
    { href: "/points", icon: "✨", title: "Points + leaderboard", stat: connected ? `${myPoints.toLocaleString()} pts${myStreak ? ` · 🔥 ${myStreak}d` : ""}` : "Live now: daily claims and streaks" },
    { href: "/airdrop", icon: "🪂", title: "Airdrop", stat: "Claim with your snapshot proof" },
    { href: "/profile", icon: "👤", title: "Profile", stat: connected ? "Your balances, points and cats" : "Connect to see your stats" },
    ...(isAdmin ? [{ href: "/admin", icon: "🛠️", title: "Admin", stat: config?.paused ? "Paused" : "Live" }] : []),
  ];

  return (
    <div className="space-y-8">
      {/* ── Hero ─────────────────────────────────────────────────────────────── */}
      <section aria-labelledby="hero-h" className="relative overflow-hidden rounded-3xl border border-gc-lime/25 bg-[radial-gradient(ellipse_at_80%_20%,rgba(184,255,60,0.16),transparent_55%)] p-5 shadow-neonSm sm:p-8">
        <div className="grid items-center gap-6 md:grid-cols-[1fr_auto]">
          <div className="min-w-0 space-y-4">
            <LaunchPill />
            <h1 id="hero-h" className="text-[2rem] font-black leading-[1.05] tracking-tight text-white sm:text-5xl">
              Meet <span className="text-gc-neon drop-shadow-[0_0_14px_rgba(184,255,60,0.5)]">GreenCat</span>, the lime-green vinyl cat of Solana
            </h1>
            <p className="max-w-xl text-sm leading-relaxed text-gc-mute sm:text-base">
              <strong className="text-gc-lime">$GC</strong> is GreenCat&apos;s community meme token. This app is the holder hub: mint a collectible cat, trade
              cats for $GC, stake and climb the points board. It&apos;s non-custodial, so you sign every action in your own wallet.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {connected ? (
                <Link href="/points" className={btn.primary}>
                  <span aria-hidden>✨</span> {claimedPointsToday ? "See your points" : "Claim daily points"}
                </Link>
              ) : (
                <div className="gc-hero-wallet">
                  <WalletButton />
                </div>
              )}
              <Link href="/market" className={btn.secondary}>
                View the collection <span aria-hidden>→</span>
              </Link>
            </div>
            <BuyGc />
            <SocialLinks />
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/mascot/greencat-full.webp"
            alt="GreenCat, the lime-green vinyl cat mascot, standing with a determined look"
            width={553}
            height={800}
            className="order-first mx-auto h-40 w-auto drop-shadow-[0_0_24px_rgba(184,255,60,0.35)] sm:h-56 md:order-none md:h-72"
          />
        </div>
      </section>

      {connected && (
        <Link
          href="/points"
          className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gc-lime/40 bg-gc-lime/10 px-4 py-3 text-sm shadow-neonSm transition hover:bg-gc-lime/15 motion-reduce:transition-none ${focusRing}`}
        >
          <span>
            <span className="font-black text-gc-neon">✨ Points</span>
            <span className="ml-2 text-gc-mute">{claimedPointsToday ? "claimed today" : "your daily claim is ready"}</span>
          </span>
          <span className="font-semibold text-gc-lime">Open →</span>
        </Link>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <nav aria-label="Features">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-gc-lime">What you can do</h2>
          <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
            {tiles.map((t) => (
              <li key={t.href}>
                <Link
                  href={t.href}
                  className={`group flex h-full items-start gap-3 rounded-2xl border border-gc-border bg-gc-panel/90 p-4 shadow-neonSm transition hover:border-gc-lime/60 hover:bg-gc-panel motion-reduce:transition-none ${focusRing}`}
                >
                  <span className="text-2xl" aria-hidden>
                    {t.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold text-gc-neon group-hover:underline">{t.title}</span>
                    {loading ? <Skeleton className="mt-1 h-4 w-32" /> : <span className="block text-sm text-gc-mute">{t.stat}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <WalletPanel />
      </div>

      <ScamNote />

      <section aria-labelledby="token-h" className="rounded-2xl border border-gc-border bg-gc-panel/60 p-4 text-sm text-gc-mute sm:p-5">
        <h2 id="token-h" className="mb-2 font-semibold text-gc-lime">
          Token
        </h2>
        <p>
          Canonical $GC (pump.fun, Token-2022, 6 decimals): <code className="break-all text-xs text-gc-neon">{MAINNET_CA}</code>
        </p>
        <p className="mt-2 text-xs">Always check the contract address. Anything else using the GreenCat name is not us.</p>
        <p className="mt-2 text-xs">
          Looking for the old client-only demo? It stays at{" "}
          <a className={`text-gc-neon underline ${focusRing}`} href={DEMO_URL} target="_blank" rel="noreferrer">
            greencat-holder-app.vercel.app
          </a>
          .
        </p>
      </section>
    </div>
  );
}
