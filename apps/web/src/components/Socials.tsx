import { SOCIALS } from "@/lib/socials";

const ring =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gc-neon focus-visible:ring-offset-2 focus-visible:ring-offset-gc-bg";

function Icon({ path, className = "h-4 w-4" }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className} fill="currentColor">
      <path d={path} />
    </svg>
  );
}

/** Official channel links. `variant="pills"` shows names (hero); `"icons"` is compact (footer). */
export function SocialLinks({ variant = "pills", className = "" }: { variant?: "pills" | "icons"; className?: string }) {
  return (
    <ul className={`flex flex-wrap gap-2 ${className}`} aria-label="Official GreenCat channels">
      {SOCIALS.map((s) => (
        <li key={s.id}>
          <a
            href={s.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`GreenCat on ${s.label} (opens in a new tab)`}
            title={`${s.label}: ${s.handle}`}
            className={
              variant === "pills"
                ? `inline-flex min-h-[40px] items-center gap-2 rounded-full border border-gc-lime/35 bg-black/30 px-3.5 text-sm font-semibold text-gc-neon transition hover:border-gc-lime hover:bg-gc-lime/10 motion-reduce:transition-none ${ring}`
                : `inline-flex h-10 w-10 items-center justify-center rounded-full border border-gc-border text-gc-mute transition hover:border-gc-lime/60 hover:text-gc-neon motion-reduce:transition-none ${ring}`
            }
          >
            <Icon path={s.path} />
            {variant === "pills" && <span>{s.label === "X (Twitter)" ? "X" : s.label}</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Anti-scam reminder, shown on the home page and in the footer. */
export function ScamNote({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="text-xs text-amber-100/90">
        <span aria-hidden>🛡️ </span>
        <strong>GreenCat never DMs you.</strong> No admin will ask for your seed phrase, private key, or to &quot;verify&quot; your wallet.
      </p>
    );
  }
  return (
    <aside
      aria-labelledby="scam-h"
      className="flex gap-3 rounded-2xl border border-amber-400/40 bg-amber-500/10 p-4 text-sm text-amber-100 sm:p-5"
    >
      <span aria-hidden className="text-2xl leading-none">
        🛡️
      </span>
      <div className="min-w-0 space-y-1">
        <h2 id="scam-h" className="font-bold text-amber-50">
          GreenCat never DMs you
        </h2>
        <p className="leading-relaxed text-amber-100/90">
          No GreenCat team member, mod, or &quot;support&quot; account will ever message you first, ask for your seed phrase or private key, or
          send you a link to &quot;verify&quot;, &quot;sync&quot;, or &quot;claim&quot;. Only trust links from this site and the official channels above. If in
          doubt, don&apos;t sign.
        </p>
      </div>
    </aside>
  );
}
