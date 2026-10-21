/**
 * Parse GreenCat marketplace `msg!` log lines + Anchor `emit!` events (`Program data:`)
 * into structured indexer events. Keep in sync with programs/greencat/src/{marketplace,lib}.rs.
 *
 * Browser/Node safe (uses Buffer + PublicKey from web3.js only).
 */

import { PublicKey } from "@solana/web3.js";
import {
  NFT_MINTED_EVENT_DISC,
  NFT_REVEALED_EVENT_DISC,
  AIRDROP_CLAIMED_EVENT_DISC,
} from "./instructions";

export type IndexerEvent =
  | { type: "list_nft"; nftMint: string; seller: string; priceRaw: string }
  | { type: "cancel_listing"; nftMint: string; seller: string }
  | {
      type: "buy_nft";
      nftMint: string;
      buyer: string;
      priceRaw: string;
      feeRaw: string;
      sellerNetRaw: string;
    }
  | { type: "make_offer"; nftMint: string; bidder: string; amountRaw: string }
  | { type: "cancel_offer"; nftMint: string; bidder: string; amountRaw: string }
  | {
      type: "accept_offer";
      nftMint: string;
      owner: string;
      bidder: string;
      amountRaw: string;
      feeRaw: string;
      sellerNetRaw: string;
      fromListing: boolean;
    }
  | {
      type: "nft_minted";
      nftMint: string;
      buyer: string;
      /** 0 until revealed */
      tokenId: number;
      /** 0 common · 1 uncommon · 2 rare · 3 legendary · 255 unrevealed */
      rarity: number;
      mintIndex?: number;
    }
  | { type: "nft_revealed"; nftMint: string; mintIndex: number; tokenId: number; rarity: number }
  | { type: "airdrop_claimed"; distribution: string; index: string; claimant: string; amount: string };

export const MARKETPLACE_LOG_PATTERNS = {
  list_nft: /^list_nft: mint=(\w+) seller=(\w+) price=(\d+)$/,
  cancel_listing: /^cancel_listing: mint=(\w+) seller=(\w+)$/,
  buy_nft:
    /^buy_nft: mint=(\w+) buyer=(\w+) price=(\d+) fee=(\d+) seller_net=(\d+)$/,
  make_offer: /^make_offer: mint=(\w+) bidder=(\w+) amount=(\d+)$/,
  cancel_offer: /^cancel_offer: mint=(\w+) bidder=(\w+) amount=(\d+)$/,
  accept_offer:
    /^accept_offer: mint=(\w+) owner=(\w+) bidder=(\w+) amount=(\d+) fee=(\d+) seller_net=(\d+) from_listing=(true|false)$/,
  /** unrevealed mint (audit GC-17); the final id/rarity arrive via reveal_nft */
  mint_nft: /^mint_nft: mint_index=(\d+) buyer=(\w+) mint=(\w+) \(unrevealed\)$/,
  reveal_nft: /^reveal_nft: mint=(\w+) mint_index=(\d+) token_id=(\d+) rarity=(\w+)$/,
} as const;

const RARITY_LABEL_TO_U8: Record<string, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  legendary: 3,
};

/**
 * Only logs emitted while *our* program is the executing frame are considered
 * (tracks `Program <id> invoke` / `success` depth) so a malicious program can't
 * spoof "list_nft: …" lines in the same transaction.
 */
export function ownProgramLogLines(
  logs: readonly string[] | null | undefined,
  programId: string
): { logs: string[]; data: string[] } {
  const out = { logs: [] as string[], data: [] as string[] };
  if (!logs) return out;
  const stack: string[] = [];
  for (const line of logs) {
    let m = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (m) {
      stack.push(m[1]);
      continue;
    }
    m = /^Program (\w+) (success|failed.*)$/.exec(line);
    if (m && stack.length && stack[stack.length - 1] === m[1]) {
      stack.pop();
      continue;
    }
    const top = stack[stack.length - 1];
    if (top !== programId) continue;
    if (line.startsWith("Program log: ")) out.logs.push(line.slice(13).trim());
    else if (line.startsWith("Program data: ")) out.data.push(line.slice(14).trim());
  }
  return out;
}

function decodeAnchorEvent(b64: string): IndexerEvent | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (raw.length < 8) return null;
  const disc = raw.subarray(0, 8);
  try {
    if (disc.equals(NFT_MINTED_EVENT_DISC) && raw.length >= 8 + 2 + 1 + 64) {
      let o = 8;
      const tokenId = raw.readUInt16LE(o);
      o += 2;
      const rarity = raw[o++];
      const buyer = new PublicKey(raw.subarray(o, o + 32)).toBase58();
      o += 32;
      const nftMint = new PublicKey(raw.subarray(o, o + 32)).toBase58();
      o += 32;
      const mintIndex = raw.length >= o + 2 ? raw.readUInt16LE(o) : undefined;
      return { type: "nft_minted", tokenId, rarity, buyer, nftMint, mintIndex };
    }
    if (disc.equals(NFT_REVEALED_EVENT_DISC) && raw.length >= 8 + 32 + 5) {
      return {
        type: "nft_revealed",
        nftMint: new PublicKey(raw.subarray(8, 40)).toBase58(),
        mintIndex: raw.readUInt16LE(40),
        tokenId: raw.readUInt16LE(42),
        rarity: raw[44],
      };
    }
    if (disc.equals(AIRDROP_CLAIMED_EVENT_DISC) && raw.length >= 8 + 32 + 8 + 32 + 8) {
      return {
        type: "airdrop_claimed",
        distribution: new PublicKey(raw.subarray(8, 40)).toBase58(),
        index: raw.readBigUInt64LE(40).toString(),
        claimant: new PublicKey(raw.subarray(48, 80)).toBase58(),
        amount: raw.readBigUInt64LE(80).toString(),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Parse program logs into indexer events.
 * @param programId when given, only lines emitted by that program frame are used (recommended).
 */
export function parseProgramLogs(
  logMessages: readonly string[] | null | undefined,
  programId?: string
): IndexerEvent[] {
  if (!logMessages?.length) return [];
  let lines: string[];
  let data: string[];
  if (programId) {
    ({ logs: lines, data } = ownProgramLogLines(logMessages, programId));
  } else {
    lines = [];
    data = [];
    for (const l of logMessages) {
      if (l.startsWith("Program log: ")) lines.push(l.slice(13).trim());
      else if (l.startsWith("Program data: ")) data.push(l.slice(14).trim());
    }
  }

  const events: IndexerEvent[] = [];
  const mintedFromEvents = new Set<string>();
  const revealedFromEvents = new Set<string>();
  for (const d of data) {
    const ev = decodeAnchorEvent(d);
    if (ev) {
      events.push(ev);
      if (ev.type === "nft_minted") mintedFromEvents.add(ev.nftMint);
      if (ev.type === "nft_revealed") revealedFromEvents.add(ev.nftMint);
    }
  }

  const P = MARKETPLACE_LOG_PATTERNS;
  for (const line of lines) {
    let m: RegExpExecArray | null;
    if ((m = P.list_nft.exec(line))) {
      events.push({ type: "list_nft", nftMint: m[1], seller: m[2], priceRaw: m[3] });
    } else if ((m = P.cancel_listing.exec(line))) {
      events.push({ type: "cancel_listing", nftMint: m[1], seller: m[2] });
    } else if ((m = P.buy_nft.exec(line))) {
      events.push({
        type: "buy_nft",
        nftMint: m[1],
        buyer: m[2],
        priceRaw: m[3],
        feeRaw: m[4],
        sellerNetRaw: m[5],
      });
    } else if ((m = P.make_offer.exec(line))) {
      events.push({ type: "make_offer", nftMint: m[1], bidder: m[2], amountRaw: m[3] });
    } else if ((m = P.cancel_offer.exec(line))) {
      events.push({ type: "cancel_offer", nftMint: m[1], bidder: m[2], amountRaw: m[3] });
    } else if ((m = P.accept_offer.exec(line))) {
      events.push({
        type: "accept_offer",
        nftMint: m[1],
        owner: m[2],
        bidder: m[3],
        amountRaw: m[4],
        feeRaw: m[5],
        sellerNetRaw: m[6],
        fromListing: m[7] === "true",
      });
    } else if ((m = P.mint_nft.exec(line))) {
      // Fallback when the Anchor event was truncated from logs.
      if (!mintedFromEvents.has(m[3])) {
        events.push({
          type: "nft_minted",
          tokenId: 0,
          rarity: 255,
          buyer: m[2],
          nftMint: m[3],
          mintIndex: Number(m[1]),
        });
      }
    } else if ((m = P.reveal_nft.exec(line))) {
      if (!revealedFromEvents.has(m[1])) {
        events.push({
          type: "nft_revealed",
          nftMint: m[1],
          mintIndex: Number(m[2]),
          tokenId: Number(m[3]),
          rarity: RARITY_LABEL_TO_U8[m[4]] ?? 0,
        });
      }
    }
  }
  return events;
}
