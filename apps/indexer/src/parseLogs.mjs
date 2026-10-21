/**
 * Parse greencat marketplace msg! log lines into structured events.
 * Keep in sync with programs/greencat/src/marketplace.rs
 */

export const LOG_PATTERNS = {
  list_nft:
    /^list_nft: mint=(\w+) seller=(\w+) price=(\d+)$/,
  cancel_listing:
    /^cancel_listing: mint=(\w+) seller=(\w+)$/,
  buy_nft:
    /^buy_nft: mint=(\w+) buyer=(\w+) price=(\d+) fee=(\d+) seller_net=(\d+)$/,
  make_offer:
    /^make_offer: mint=(\w+) bidder=(\w+) amount=(\d+)$/,
  cancel_offer:
    /^cancel_offer: mint=(\w+) bidder=(\w+) amount=(\d+)$/,
  accept_offer:
    /^accept_offer: mint=(\w+) owner=(\w+) bidder=(\w+) amount=(\d+) fee=(\d+) seller_net=(\d+) from_listing=(true|false)$/,
  // unrevealed mint (audit GC-17); final id/rarity arrive via reveal_nft
  mint_nft:
    /^mint_nft: mint_index=(\d+) buyer=(\w+) mint=(\w+) \(unrevealed\)$/,
  reveal_nft:
    /^reveal_nft: mint=(\w+) mint_index=(\d+) token_id=(\d+) rarity=(\w+)$/,
};

/**
 * @param {string[] | null | undefined} logMessages
 * @returns {object[]}
 */
export function parseMarketplaceLogs(logMessages) {
  if (!logMessages?.length) return [];
  const events = [];
  for (const raw of logMessages) {
    const line = raw.replace(/^Program log: /, "").trim();
    let m;
    if ((m = LOG_PATTERNS.list_nft.exec(line))) {
      events.push({
        type: "list_nft",
        nftMint: m[1],
        seller: m[2],
        priceRaw: m[3],
      });
    } else if ((m = LOG_PATTERNS.cancel_listing.exec(line))) {
      events.push({ type: "cancel_listing", nftMint: m[1], seller: m[2] });
    } else if ((m = LOG_PATTERNS.buy_nft.exec(line))) {
      events.push({
        type: "buy_nft",
        nftMint: m[1],
        buyer: m[2],
        priceRaw: m[3],
        feeRaw: m[4],
        sellerNetRaw: m[5],
      });
    } else if ((m = LOG_PATTERNS.make_offer.exec(line))) {
      events.push({
        type: "make_offer",
        nftMint: m[1],
        bidder: m[2],
        amountRaw: m[3],
      });
    } else if ((m = LOG_PATTERNS.cancel_offer.exec(line))) {
      events.push({
        type: "cancel_offer",
        nftMint: m[1],
        bidder: m[2],
        amountRaw: m[3],
      });
    } else if ((m = LOG_PATTERNS.accept_offer.exec(line))) {
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
    } else if ((m = LOG_PATTERNS.mint_nft.exec(line))) {
      events.push({
        type: "mint_nft",
        mintIndex: Number(m[1]),
        tokenId: null,
        rarity: null,
        buyer: m[2],
        nftMint: m[3],
      });
    } else if ((m = LOG_PATTERNS.reveal_nft.exec(line))) {
      events.push({
        type: "reveal_nft",
        nftMint: m[1],
        mintIndex: Number(m[2]),
        tokenId: Number(m[3]),
        rarity: m[4],
      });
    }
  }
  return events;
}

/**
 * Apply events onto an in-memory store.
 * @param {{ listings: Record<string, object>, offers: Record<string, object>, trades: object[] }} store
 * @param {object[]} events
 * @param {{ sig?: string, slot?: number }} meta
 */
export function applyEvents(store, events, meta = {}) {
  const now = new Date().toISOString();
  for (const e of events) {
    if (e.type === "list_nft") {
      store.listings[e.nftMint] = {
        nftMint: e.nftMint,
        seller: e.seller,
        priceRaw: e.priceRaw,
        active: true,
        listedSig: meta.sig ?? null,
        listedSlot: meta.slot ?? null,
        updatedAt: now,
      };
    } else if (e.type === "cancel_listing") {
      const row = store.listings[e.nftMint];
      if (row) {
        row.active = false;
        row.updatedAt = now;
      } else {
        store.listings[e.nftMint] = {
          nftMint: e.nftMint,
          seller: e.seller,
          priceRaw: "0",
          active: false,
          updatedAt: now,
        };
      }
    } else if (e.type === "buy_nft") {
      const row = store.listings[e.nftMint];
      if (row) {
        row.active = false;
        row.updatedAt = now;
      }
      store.trades.push({
        kind: "buy",
        nftMint: e.nftMint,
        buyer: e.buyer,
        seller: row?.seller ?? null,
        priceRaw: e.priceRaw,
        feeRaw: e.feeRaw,
        sig: meta.sig ?? null,
        slot: meta.slot ?? null,
        tradedAt: now,
      });
    } else if (e.type === "make_offer") {
      const key = `${e.nftMint}:${e.bidder}`;
      store.offers[key] = {
        nftMint: e.nftMint,
        bidder: e.bidder,
        amountRaw: e.amountRaw,
        active: true,
        updatedAt: now,
      };
    } else if (e.type === "cancel_offer") {
      const key = `${e.nftMint}:${e.bidder}`;
      if (store.offers[key]) {
        store.offers[key].active = false;
        store.offers[key].updatedAt = now;
      }
    } else if (e.type === "accept_offer") {
      const key = `${e.nftMint}:${e.bidder}`;
      if (store.offers[key]) {
        store.offers[key].active = false;
        store.offers[key].updatedAt = now;
      }
      if (e.fromListing && store.listings[e.nftMint]) {
        store.listings[e.nftMint].active = false;
        store.listings[e.nftMint].updatedAt = now;
      }
      store.trades.push({
        kind: "accept_offer",
        nftMint: e.nftMint,
        buyer: e.bidder,
        seller: e.owner,
        priceRaw: e.amountRaw,
        feeRaw: e.feeRaw,
        sig: meta.sig ?? null,
        slot: meta.slot ?? null,
        tradedAt: now,
      });
    }
  }
}

export function activeListingsSorted(store, direction = "desc") {
  const rows = Object.values(store.listings).filter((l) => l.active);
  rows.sort((a, b) => {
    const av = BigInt(a.priceRaw);
    const bv = BigInt(b.priceRaw);
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return direction === "asc" ? cmp : -cmp;
  });
  return rows;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("parseLogs.mjs") ||
    process.argv.includes("--fixture"));

if (isMain && process.argv.includes("--fixture")) {
  const fixture = [
    "Program log: list_nft: mint=NftMint111 seller=Seller111 price=1000000000",
    "Program log: buy_nft: mint=NftMint111 buyer=Buyer222 price=1000000000 fee=10000000 seller_net=990000000",
    "Program log: make_offer: mint=NftMint333 bidder=Bidder444 amount=500000000",
    "Program log: accept_offer: mint=NftMint333 owner=Owner555 bidder=Bidder444 amount=500000000 fee=5000000 seller_net=495000000 from_listing=false",
  ];
  const events = parseMarketplaceLogs(fixture);
  const store = { listings: {}, offers: {}, trades: [] };
  applyEvents(store, events, { sig: "FixtureSig111" });
  console.log(
    JSON.stringify(
      { events, store, sorted: activeListingsSorted(store) },
      null,
      2
    )
  );
}
