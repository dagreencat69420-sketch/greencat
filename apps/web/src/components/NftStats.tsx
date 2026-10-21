"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

const useLayoutEffectSafe = typeof window !== "undefined" ? useLayoutEffect : useEffect;

import { createPortal } from "react-dom";
import { placeTooltip } from "@/lib/tooltipPlacement";
import { RARITY_COLORS, RARITY_LABELS, COLLECTION_SIZE, type Rarity } from "@greencat/sdk";
import { NftImage } from "@/components/NftArt";
import { formatPct, ipfsTo4everland, tokenStats, useNftMetadata, type NftAttribute } from "@/lib/nftMetadata";

/**
 * The stats block shown on the mint reveal and on the profile (tooltip / modal): name + number, rarity tier,
 * rarity rank, image, traits with their share of the 10,000 cats, and the catchphrase.
 * Traits come from the NFT's metadata JSON when it loaded; otherwise from the bundled art catalog.
 */
export function NftStatsCard({
  tokenId,
  rarity,
  attributes,
  imageUri,
  name,
  compact = false,
  note,
}: {
  tokenId: number;
  rarity?: Rarity;
  attributes?: NftAttribute[];
  imageUri?: string;
  name?: string;
  compact?: boolean;
  note?: string;
}) {
  const s = tokenStats(tokenId, attributes);
  const r = rarity ?? s?.rarity;
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <div>
      <p className={`${compact ? "text-base" : "text-2xl"} font-black text-white`}>{name || `GreenCat #${tokenId}`}</p>
      {r && (
        <p className={`${compact ? "text-sm" : "text-lg"} font-semibold`} style={{ color: RARITY_COLORS[r] }}>
          {RARITY_LABELS[r]}
          {s && (
            <span className="ml-2 text-xs font-normal text-gc-mute">
              {formatPct(s.tierPct)} of cats · rank #{s.rank.toLocaleString()} / {COLLECTION_SIZE.toLocaleString()}
            </span>
          )}
        </p>
      )}
      <div className={`mt-3 grid min-w-0 gap-3 sm:gap-4 ${compact ? "grid-cols-[96px_minmax(0,1fr)]" : "grid-cols-1 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)] [@media(max-height:500px)]:grid-cols-[minmax(0,140px)_minmax(0,1fr)]"}`}>
        {imageUri && !imgFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={ipfsTo4everland(imageUri)}
            alt={name || `GreenCat #${tokenId}`}
            className={`aspect-square w-full rounded-lg object-cover ${compact ? "" : "mx-auto max-w-[min(160px,40dvh)] sm:max-w-none"}`}
            style={r ? { boxShadow: `0 0 0 2px ${RARITY_COLORS[r]}66` } : undefined}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className={compact ? "" : "mx-auto w-full max-w-[min(160px,40dvh)] sm:max-w-none"}>
            <NftImage tokenId={tokenId} rarity={r} />
          </div>
        )}
        {s ? (
          <dl className={`grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 ${compact ? "text-[11px]" : "text-xs"}`}>
            {s.traits.map((t) => (
              <div key={t.trait} className="contents">
                <dt className="text-gc-mute">{t.trait}</dt>
                <dd className="min-w-0 break-words text-white" title={t.value}>
                  {t.value}
                </dd>
                <dd className="text-right tabular-nums text-gc-mute">{formatPct(t.pct)}</dd>
              </div>
            ))}
            <dt className="text-gc-mute">Catchphrase</dt>
            <dd className="col-span-2 italic text-gc-lime">“{s.catchphrase}”</dd>
          </dl>
        ) : (
          <p className="text-xs text-gc-mute">Stats aren&apos;t available for this cat.</p>
        )}
      </div>
      {note && <p className="mt-2 text-[11px] text-gc-mute">{note}</p>}
    </div>
  );
}

/** Profile tile: hover / keyboard focus shows a tooltip (desktop); tap / Enter opens a dialog with the full stats. */
export function OwnedNftTile({
  tokenId,
  rarity,
  label,
  metadataBase,
}: {
  tokenId: number;
  rarity?: Rarity;
  label: string;
  metadataBase?: string | null;
}) {
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipStyle, setTipStyle] = useState<React.CSSProperties>({ visibility: "hidden", left: 0, top: 0 });
  useLayoutEffectSafe(() => {
    if (!hover || open) return;
    const place = () => {
      const a = wrapRef.current?.getBoundingClientRect();
      const t = tipRef.current;
      if (!a || !t) return;
      setTipStyle(placeTooltip(a, t.offsetWidth, t.offsetHeight, window.innerWidth, window.innerHeight));
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (tipRef.current) ro?.observe(tipRef.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      ro?.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [hover, open]);
  const revealed = tokenId > 0;
  const meta = useNftMetadata(tokenId, metadataBase, revealed && (hover || open));
  const note = meta.status === "error" ? "Metadata couldn't be loaded; showing stats from the collection catalog." : meta.status === "loading" ? "Loading metadata…" : undefined;

  if (!revealed) {
    return (
      <div className="rounded-xl border border-gc-border bg-black/30 p-2">
        <NftImage tokenId={0} />
        <p className="mt-2 truncate text-sm font-semibold text-gc-neon">{label}</p>
      </div>
    );
  }
  const card = (compact: boolean) => (
    <NftStatsCard
      tokenId={tokenId}
      rarity={rarity}
      attributes={meta.meta?.attributes}
      imageUri={meta.meta?.image}
      name={meta.meta?.name}
      compact={compact}
      note={note}
    />
  );
  return (
    <div ref={wrapRef} className="relative" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        type="button"
        className="block w-full rounded-xl border border-gc-border bg-black/30 p-2 text-left transition hover:border-gc-lime/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gc-lime"
        aria-haspopup="dialog"
        aria-describedby={hover ? tipId : undefined}
        aria-label={`${label}: show stats`}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onClick={() => {
          setHover(false);
          setOpen(true);
        }}
        data-testid="owned-nft"
      >
        <NftImage tokenId={tokenId} rarity={rarity} />
        <p className="mt-2 truncate text-sm font-semibold text-gc-neon">{label}</p>
      </button>
      {hover && !open && typeof document !== "undefined" &&
        createPortal(
          <div
          id={tipId}
          role="tooltip"
          ref={tipRef}
          style={tipStyle}
          className="pointer-events-none fixed z-[60] hidden w-80 max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-hidden rounded-xl border border-gc-lime/40 bg-[#0a120c] p-3 shadow-2xl [@media(hover:hover)]:block"
          data-testid="nft-tooltip"
        >
          {card(true)}
        </div>,
          document.body
        )}
      {open && typeof document !== "undefined" && createPortal(<StatsDialog label={label} onClose={() => setOpen(false)}>{card(false)}</StatsDialog>, document.body)}
    </div>
  );
}

function StatsDialog({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && boxRef.current) {
        const f = boxRef.current.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])");
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose]
  );
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [onKey]);
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 sm:items-center sm:p-3" onClick={onClose}>
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[90vh] max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-gc-lime/40 bg-[#0a120c] shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="nft-dialog"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gc-border px-4 py-2" style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}>
          <h2 id={titleId} className="text-xs uppercase tracking-wider text-gc-mute">
            Stats · {label}
          </h2>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded-lg border border-gc-border px-3 py-1 text-sm text-white hover:border-gc-lime focus:outline-none focus-visible:ring-2 focus-visible:ring-gc-lime">
            Close
          </button>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))", paddingLeft: "max(1rem, env(safe-area-inset-left))", paddingRight: "max(1rem, env(safe-area-inset-right))" }}
          data-testid="nft-dialog-body"
        >
          {children}
        </div>
      </div>
    </div>
  );
}
