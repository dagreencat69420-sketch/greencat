"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletButton } from "@/components/WalletButton";
import { usePoints } from "@/context/PointsContext";
import { useProgram } from "@/context/ProgramContext";
import { focusRing } from "@/components/ui";

const LINKS = [
  { href: "/", label: "Home", icon: "🏠" },
  { href: "/points", label: "Points", icon: "✨" },
  { href: "/mint", label: "Mint", icon: "🎁" },
  { href: "/market", label: "Market", icon: "🛒" },
  { href: "/stake", label: "Stake", icon: "🔒" },
  { href: "/airdrop", label: "Airdrop", icon: "🪂" },
  { href: "/profile", label: "Profile", icon: "👤" },
];

export function AppNav() {
  const pathname = usePathname();
  const { connected } = useWallet();
  const { myPoints, ready } = usePoints();
  const { isAdmin } = useProgram();
  const links = isAdmin ? [...LINKS, { href: "/admin", label: "Admin", icon: "🛠️" }] : LINKS;

  const mobileNav = useRef<HTMLElement>(null);
  // Keep the active tab visible in the scrollable mobile row.
  useEffect(() => {
    const nav = mobileNav.current;
    const el = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && el) nav.scrollLeft = el.offsetLeft - nav.clientWidth / 2 + el.clientWidth / 2;
  }, [pathname, isAdmin]);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/"));

  return (
    <header className="sticky top-0 z-40 border-b border-gc-border bg-gc-bg/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center gap-2 px-3 py-2 sm:px-4">
        <Link href="/" className={`flex shrink-0 items-center gap-2 rounded-lg ${focusRing}`} aria-label="GreenCat home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/mascot/greencat-avatar.webp" alt="" width={32} height={32} className="h-8 w-8 rounded-full border border-gc-lime/60 bg-gc-lime/10 object-contain p-0.5 shadow-neonSm" />
          <span className="font-black tracking-tight text-gc-neon max-[339px]:sr-only">GreenCat</span>
        </Link>
        <nav aria-label="Main" className="hidden min-w-0 flex-1 px-2 lg:block">
          <NavList links={links} isActive={isActive} wrap />
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isAdmin && (
            <Link
              href="/admin"
              aria-current={isActive("/admin") ? "page" : undefined}
              aria-label="Admin"
              className={`inline-flex min-h-[40px] items-center gap-1 rounded-full border px-3 text-xs font-bold ${focusRing} ${
                isActive("/admin") ? "border-gc-lime bg-gc-lime text-black" : "border-amber-300/60 text-amber-200 hover:bg-amber-500/10"
              }`}
            >
              <span aria-hidden>🛠️</span>
              <span className="max-[419px]:hidden">Admin</span>
            </Link>
          )}
          {ready && connected && (
            <Link
              href="/points"
              className={`hidden rounded-full border border-gc-lime/40 px-2.5 py-1 text-xs font-bold text-gc-neon sm:inline-block ${focusRing}`}
              aria-label={`${myPoints.toLocaleString()} points this month`}
            >
              {myPoints.toLocaleString()} pts
            </Link>
          )}
          <div className="gc-wallet-btn">
            <WalletButton />
          </div>
        </div>
      </div>
      {/* Mobile / tablet: horizontally scrollable tabs (the bottom of the screen is the lo-fi player). */}
      <nav ref={mobileNav} aria-label="Main (mobile)" className="gc-scroll-x border-t border-gc-border/60 lg:hidden">
        <div className="mx-auto max-w-5xl px-2 py-1.5">
          <NavList links={links} isActive={isActive} />
        </div>
      </nav>
    </header>
  );
}

function NavList({ links, isActive, wrap = false }: { links: typeof LINKS; isActive: (h: string) => boolean; wrap?: boolean }) {
  return (
    <ul className={wrap ? "flex flex-wrap gap-1" : "flex min-w-max gap-1"}>
      {links.map((l) => {
        const active = isActive(l.href);
        return (
          <li key={l.href}>
            <Link
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-[40px] items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition motion-reduce:transition-none ${focusRing} ${
                active ? "bg-gc-lime text-black shadow-neonSm" : "text-gc-mute hover:bg-gc-panel hover:text-gc-lime"
              }`}
            >
              <span className="mr-1 lg:hidden" aria-hidden>
                {l.icon}
              </span>
              {l.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
