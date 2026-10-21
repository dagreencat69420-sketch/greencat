import Link from "next/link";
import { ScamNote, SocialLinks } from "@/components/Socials";

export function SiteFooter() {
  return (
    <footer className="mx-auto w-full max-w-5xl px-4 pb-28">
      <div className="space-y-4 border-t border-gc-border pt-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/" className="inline-flex items-center gap-2 self-start rounded-lg font-black text-gc-neon focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gc-neon">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/mascot/greencat-avatar.webp" alt="" width={28} height={28} className="h-7 w-7 rounded-full border border-gc-lime/50 bg-gc-lime/10 object-contain p-0.5" />
            GreenCat <span className="font-semibold text-gc-mute">$GC</span>
          </Link>
          <SocialLinks variant="icons" />
        </div>
        <ScamNote compact />
        <p className="text-[11px] text-gc-mute">
          Faceless mascot only · no guaranteed returns · points are never spendable · non-custodial: every action is signed by your own wallet.
        </p>
      </div>
    </footer>
  );
}
