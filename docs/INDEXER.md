# Marketplace indexer (off-chain browse / sort)

Status: **spec + local stub** (2026-09-25). On-chain list/buy/offer works; browse/sort still needs this cache (REAL-APP-SPEC §D TODO).

Paid Helius keys are **optional**. Local validator / public RPC poller is enough to develop.

> **Current implementation:** `apps/api` (`src/indexer/*`, `src/worker.ts`) writes to Postgres/PGlite and serves
> `GET /listings` and `GET /nft/:mint`. `apps/indexer` is the original JSON stub, kept as `npm run indexer:legacy`.
> Hosting: see [`HOSTING.md`](HOSTING.md).

## Why

Listing PDAs exist on-chain (`seeds = ["listing", nft_mint]`), but scanning every possible mint is expensive. An indexer:

1. Watches marketplace log lines / account changes
2. Upserts a `listings` (+ offers) table
3. Serves sorted browse APIs to `apps/web`

## Events to index

Program currently emits **`msg!` log strings** (not Anchor `emit!` events) for marketplace. Parse these from `meta.logMessages`:

| Log prefix | Meaning | Indexer action |
|------------|---------|----------------|
| `list_nft: mint=S seller=S price=N` | New / re-list | Upsert listing `active=true`, price, seller |
| `cancel_listing: mint=S seller=S` | Cancel | Set listing `active=false` |
| `buy_nft: mint=S buyer=S price=N fee=N seller_net=N` | Sale | Mark listing inactive; insert trade row |
| `make_offer: mint=S bidder=S amount=N` | Offer escrowed | Upsert offer `active=true` |
| `cancel_offer: mint=S bidder=S amount=N` | Offer cancelled | Offer `active=false` |
| `accept_offer: mint=… owner=… bidder=… amount=… fee=… seller_net=… from_listing=…` | Offer filled | Offer inactive; listing inactive if `from_listing`; trade row |

Also useful (mint path, already has Anchor event + msg):

| `mint_nft: token_id=N rarity=… buyer=… mint=…` | New NFT | Optional catalog/owner cache |

**Future:** add Anchor `emit!(NftListed {…})` etc. for cleaner CPI consumers; stub parsers should keep supporting `msg!` lines for back-compat.

## Suggested stacks

| Mode | Stack | When |
|------|-------|------|
| **Local (default stub)** | `getSignaturesForAddress(programId)` + `getTransaction` poll loop | `solana-test-validator` / CI |
| **Devnet/mainnet free** | Same poller against public or self-hosted RPC | Low volume OK |
| **Production** | Helius webhooks (account/tx) → worker → Postgres/Supabase | Fast browse, admin stats |

Do **not** hard-require `HELIUS_API_KEY` for the stub.

## Env vars (apps/api)

```bash
RPC_URL=http://127.0.0.1:8899                 # Helius URL in prod
GREENCAT_PROGRAM_ID=8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE
DATABASE_URL=postgres://…                     # unset → PGlite at apps/api/data/pglite
RUN_INDEXER=true                              # run inside the API process, or: npm run indexer:poll (worker)
INDEXER_MODE=poll                             # poll | ws (logsSubscribe + safety poll)
POLL_MS=5000                                  # ≥60000 on Helius Free
INDEXER_SAFETY_POLL_MS=300000
INDEXER_PAGE_SIZE=100
INDEXER_BACKFILL_MAX=5000
HELIUS_WEBHOOK_SECRET=                        # optional: enables POST /webhooks/helius (raw webhook)
```

Browse API: `GET /listings?rarity=rare,legendary&minPrice=10&maxPrice=500&sort=price_asc|price_desc|recent|token_id&seller=…&limit=24&offset=0`,
`GET /nft/:mint`. The cursor is in `indexer_cursor`, and ingestion is idempotent by signature (re-polls are no-ops).

## Schema (listings table)

SQL sketch (`apps/indexer/src/schema.sql`):

```sql
CREATE TABLE listings (
  nft_mint       TEXT PRIMARY KEY,
  seller         TEXT NOT NULL,
  price_raw      NUMERIC NOT NULL,  -- u64 as string/numeric
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  listed_slot    BIGINT,
  listed_sig     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX listings_active_price ON listings (active, price_raw DESC);

CREATE TABLE offers (
  nft_mint       TEXT NOT NULL,
  bidder         TEXT NOT NULL,
  amount_raw     NUMERIC NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (nft_mint, bidder)
);

CREATE TABLE trades (
  id             BIGSERIAL PRIMARY KEY,
  nft_mint       TEXT NOT NULL,
  buyer          TEXT,
  seller         TEXT,
  price_raw      NUMERIC NOT NULL,
  fee_raw        NUMERIC,
  kind           TEXT NOT NULL, -- 'buy' | 'accept_offer'
  sig            TEXT NOT NULL UNIQUE,
  slot           BIGINT,
  traded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```



## Stub package

```bash
npm run indexer:poll
# or:
npm run start --workspace=@greencat/indexer
```

Parses program logs locally, updates in-memory map, optionally writes `INDEXER_DB_PATH`. No Postgres required.

## Web UI

When `NEXT_PUBLIC_API_URL` is set, `MarketplacePanel` renders `MarketplaceBrowse` (`GET /listings`, with rarity, price, and sort filters, paging, and click-to-load).
Without it, the panel shows a hint, and single-mint load via PDA still works.
