-- GreenCat API schema v1 (Postgres dialect; also runs on embedded PGlite).

-- ─── Points (server-authoritative, engagement only, never spendable) ─────────

CREATE TABLE IF NOT EXISTS points_wallets (
  wallet                  TEXT PRIMARY KEY,
  display_name            TEXT,
  points_month            TEXT NOT NULL,              -- YYYY-MM (America/Vancouver)
  points                  INTEGER NOT NULL DEFAULT 0, -- mirror of points_monthly for points_month
  streak                  INTEGER NOT NULL DEFAULT 0,
  last_claim_date         TEXT,                       -- YYYY-MM-DD (America/Vancouver)
  streak_milestones       JSONB NOT NULL DEFAULT '[]'::jsonb,
  lofi_date               TEXT,
  lofi_today              INTEGER NOT NULL DEFAULT 0,
  lofi_last_heartbeat_at  DOUBLE PRECISION,           -- ms epoch
  lofi_interval_start_at  DOUBLE PRECISION,           -- ms epoch
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-month totals (leaderboard source). Monthly reset == new month key.
CREATE TABLE IF NOT EXISTS points_monthly (
  month       TEXT NOT NULL,
  wallet      TEXT NOT NULL,
  points      INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (month, wallet)
);
CREATE INDEX IF NOT EXISTS points_monthly_rank_idx ON points_monthly (month, points DESC, wallet);

-- Append-only award ledger (audit + dedupe).
CREATE TABLE IF NOT EXISTS points_events (
  id          BIGSERIAL PRIMARY KEY,
  wallet      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('claim','milestone','mint','stake','list','wheel','lofi')),
  amount      INTEGER NOT NULL,
  month       TEXT NOT NULL,
  day         TEXT NOT NULL,
  tx_sig      TEXT UNIQUE,         -- activity bonus tx: one award per signature, ever
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS points_events_one_claim_per_day
  ON points_events (wallet, day) WHERE kind = 'claim';
CREATE INDEX IF NOT EXISTS points_events_wallet_day ON points_events (wallet, day, kind);

-- SIWS nonces (single use, short TTL).
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce       TEXT PRIMARY KEY,
  wallet      TEXT NOT NULL,
  message     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_nonces_expires ON auth_nonces (expires_at);

-- ─── Marketplace indexer ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nfts (
  mint          TEXT PRIMARY KEY,
  token_id      INTEGER,
  rarity        SMALLINT,               -- 0 common · 1 uncommon · 2 rare · 3 legendary
  minter        TEXT,
  owner         TEXT,
  minted_sig    TEXT,
  minted_slot   BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nfts_rarity ON nfts (rarity);
CREATE INDEX IF NOT EXISTS nfts_owner ON nfts (owner);

CREATE TABLE IF NOT EXISTS listings (
  nft_mint      TEXT PRIMARY KEY,
  seller        TEXT NOT NULL,
  price_raw     NUMERIC(20,0) NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  listed_slot   BIGINT,
  listed_sig    TEXT,
  updated_slot  BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listings_active_price ON listings (active, price_raw);
CREATE INDEX IF NOT EXISTS listings_active_slot ON listings (active, listed_slot DESC);

CREATE TABLE IF NOT EXISTS offers (
  nft_mint      TEXT NOT NULL,
  bidder        TEXT NOT NULL,
  amount_raw    NUMERIC(20,0) NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  sig           TEXT,
  updated_slot  BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (nft_mint, bidder)
);

CREATE TABLE IF NOT EXISTS trades (
  id          BIGSERIAL PRIMARY KEY,
  nft_mint    TEXT NOT NULL,
  buyer       TEXT,
  seller      TEXT,
  price_raw   NUMERIC(20,0) NOT NULL,
  fee_raw     NUMERIC(20,0),
  kind        TEXT NOT NULL CHECK (kind IN ('buy','accept_offer')),
  sig         TEXT NOT NULL,
  slot        BIGINT,
  traded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sig, nft_mint)
);
CREATE INDEX IF NOT EXISTS trades_mint ON trades (nft_mint, slot DESC);

CREATE TABLE IF NOT EXISTS indexed_txs (
  sig         TEXT PRIMARY KEY,
  slot        BIGINT,
  block_time  BIGINT,
  events      INTEGER NOT NULL DEFAULT 0,
  failed      BOOLEAN NOT NULL DEFAULT FALSE,
  indexed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexer_cursor (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_sig    TEXT,
  last_slot   BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
