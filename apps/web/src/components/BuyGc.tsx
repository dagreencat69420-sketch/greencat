import type { ReactNode } from "react";
import { CLUSTER, MAINNET_CA } from "@/lib/config";
import { BUY_SOL_HELP, JUPITER_BUY_GC_URL, MAINNET_CA_SHORT } from "@/lib/buy";
import { btn, focusRing } from "@/components/ui";

const link = `font-semibold text-gc-neon underline underline-offset-2 hover:text-gc-lime ${focusRing} rounded`;

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={link}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * Hero "Buy $GC" call to action: opens Jupiter (SOL → real mainnet $GC) in a new tab, with the address check
 * disclaimer and a small "no crypto yet?" help note. Always the mainnet token, even while the app runs on Devnet.
 */
export function BuyGc() {
  const testNet = CLUSTER !== "mainnet-beta";
  return (
    <div className="max-w-xl space-y-2">
      <div className="flex flex-col gap-2 min-[420px]:flex-row min-[420px]:items-center min-[420px]:gap-3">
        <a
          href={JUPITER_BUY_GC_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Buy $GC on Jupiter (opens in a new tab)"
          className={`${btn.primary} w-full px-7 text-base font-black min-[420px]:w-auto`}
        >
          <span aria-hidden>🐱</span> Buy $GC
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 17 17 7M9 7h8v8" />
          </svg>
        </a>
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs font-semibold text-gc-lime">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gc-lime" />
          Real $GC on Solana mainnet
          {testNet && <span className="font-normal text-gc-mute">(not the Devnet test $GC in this app)</span>}
        </p>
      </div>
      <p className="text-xs leading-relaxed text-gc-mute">
        Opens Jupiter, an independent exchange. Always check the token address:{" "}
        <code title={MAINNET_CA} className="whitespace-nowrap text-gc-neon">
          {MAINNET_CA_SHORT}
        </code>
      </p>
      <details className="group text-xs text-gc-mute">
        <summary
          className={`cursor-pointer list-none rounded py-1.5 text-gc-neon hover:text-gc-lime [&::-webkit-details-marker]:hidden ${focusRing}`}
        >
          <span className="underline decoration-gc-lime/40 underline-offset-2">No crypto yet? Buy SOL with a card in Phantom or Solflare</span>
          <span aria-hidden className="ml-1 inline-block transition group-open:rotate-90 motion-reduce:transition-none">
            ›
          </span>
        </summary>
        <div className="mt-1 space-y-1.5 rounded-xl border border-gc-border bg-black/30 p-3 leading-relaxed">
          <p>
            Both wallets have a built-in Buy option (card, Apple Pay or Google Pay, depending on your region) run by third-party payment
            providers. Fees and ID checks are set by the provider.
          </p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              Phantom: <Ext href={BUY_SOL_HELP.phantomMobile}>mobile guide</Ext> · <Ext href={BUY_SOL_HELP.phantomExtension}>browser extension guide</Ext>
            </li>
            <li>
              Solflare: <Ext href={BUY_SOL_HELP.solflare}>how to buy SOL</Ext>
            </li>
          </ul>
          <p>Once you have SOL in your wallet, come back and tap Buy $GC to swap it on Jupiter.</p>
        </div>
      </details>
    </div>
  );
}
