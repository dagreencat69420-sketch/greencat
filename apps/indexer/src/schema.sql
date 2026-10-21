-- GreenCat marketplace indexer schema (Postgres / Supabase target).
-- Local stub uses JSON; apply this when wiring DATABASE_URL.

CREATE TABLE IF NOT EXISTS listings (
  nft_mint       TEXT PRIMARY KEY,
  seller         TEXT NOT NULL,
  price_raw      NUMERIC NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  listed_slot    BIGINT,
  listed_sig     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listings_active_price
  ON listings (active, price_raw DESC);

CREATE TABLE IF NOT EXISTS offers (
  nft_mint       TEXT NOT NULL,
  bidder         TEXT NOT NULL,
  amount_raw     NUMERIC NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (nft_mint, bidder)
);

CREATE TABLE IF NOT EXISTS trades (
  id             BIGSERIAL PRIMARY KEY,
  nft_mint       TEXT NOT NULL,
  buyer          TEXT,
  seller         TEXT,
  price_raw      NUMERIC NOT NULL,
  fee_raw        NUMERIC,
  kind           TEXT NOT NULL CHECK (kind IN ('buy', 'accept_offer')),
  sig            TEXT NOT NULL UNIQUE,
  slot           BIGINT,
  traded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexer_cursor (
  id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_sig       TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
