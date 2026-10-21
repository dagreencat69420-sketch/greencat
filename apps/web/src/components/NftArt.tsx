"use client";

import { useState } from "react";
import {
  ART_LAYER_NAMES,
  RARITY_COLORS,
  RARITY_LABELS,
  getTokenArt,
  ipfsToGatewayUrl,
  tokenImageUri,
  type Rarity,
} from "@greencat/sdk";
import { IPFS_GATEWAY, NFT_IMAGE_BASE } from "@/lib/config";

/** Art-v1 WebP image for a token (falls back to a rarity-tinted placeholder if the PNG is unavailable). */
export function NftImage({
  tokenId,
  rarity,
  className = "",
  revealing = false,
}: {
  tokenId: number;
  rarity?: Rarity;
  className?: string;
  /** tokenId 0 + revealing: animated "Revealing…" placeholder while the per-mint draw settles */
  revealing?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const r = rarity ?? safeRarity(tokenId);
  const color = r ? RARITY_COLORS[r] : "#94A3B8";
  if (!tokenId) {
    return (
      <div
        role="img"
        aria-label={revealing ? "Revealing your GreenCat" : "Unrevealed GreenCat"}
        className={`relative flex aspect-square flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-gc-lime/25 ${revealing ? "motion-safe:animate-pulse" : ""} ${className}`}
        style={{ background: "radial-gradient(circle at 50% 35%, rgba(184,255,60,0.28), #0a120c 70%)" }}
      >
        <span aria-hidden className="text-4xl drop-shadow-[0_0_10px_rgba(184,255,60,0.6)]">
          {revealing ? "✨" : "🎁"}
        </span>
        <span aria-hidden className="text-[10px] font-bold uppercase tracking-[0.2em] text-gc-lime/80">
          {revealing ? "Revealing…" : "Reveal pending"}
        </span>
      </div>
    );
  }
  if (failed) {
    return (
      <div
        className={`flex aspect-square items-center justify-center rounded-lg text-xs text-white/70 ${className}`}
        style={{ background: `radial-gradient(circle at 50% 40%, ${color}55, #0A0F0A 75%)` }}
      >
        GreenCat #{tokenId || "?"}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={ipfsToGatewayUrl(tokenImageUri(tokenId, NFT_IMAGE_BASE), IPFS_GATEWAY)}
      alt={`GreenCat #${tokenId}`}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`aspect-square w-full rounded-lg object-cover ${className}`}
      style={{ boxShadow: `0 0 0 2px ${color}66` }}
    />
  );
}

function safeRarity(tokenId: number): Rarity | null {
  try {
    return getTokenArt(tokenId).rarity;
  } catch {
    return null;
  }
}

/** Trait list (Background, Fur, Eyes, Eyewear, Hat, Accessory, Aura + Catchphrase) for a token. */
export function NftTraits({ tokenId, compact = false }: { tokenId: number; compact?: boolean }) {
  let art;
  try {
    art = getTokenArt(tokenId);
  } catch {
    return null;
  }
  const layers = compact
    ? ART_LAYER_NAMES.filter((l) => art.traits[l] !== "None")
    : ART_LAYER_NAMES;
  return (
    <dl className={`grid grid-cols-2 gap-x-3 gap-y-1 ${compact ? "text-[10px]" : "text-xs"}`}>
      {!compact && (
        <>
          <dt className="text-gc-mute">Rarity</dt>
          <dd style={{ color: RARITY_COLORS[art.rarity] }}>{RARITY_LABELS[art.rarity]}</dd>
        </>
      )}
      {layers.map((l) => (
        <div key={l} className="contents">
          <dt className="text-gc-mute">{l}</dt>
          <dd className="truncate text-white" title={art.traits[l]}>
            {art.traits[l]}
          </dd>
        </div>
      ))}
      {!compact && (
        <>
          <dt className="text-gc-mute">Catchphrase</dt>
          <dd className="italic text-gc-lime">“{art.catchphrase}”</dd>
        </>
      )}
    </dl>
  );
}
