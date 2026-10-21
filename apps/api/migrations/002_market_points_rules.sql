-- Marketplace points anti-farming rules (list/delist loop fix + wash-trade-limited sale points).

-- 'sale' joins the award ledger kinds.
ALTER TABLE points_events DROP CONSTRAINT IF EXISTS points_events_kind_check;
ALTER TABLE points_events ADD CONSTRAINT points_events_kind_check
  CHECK (kind IN ('claim','milestone','mint','stake','list','wheel','lofi','sale'));

-- Listing points are DEFERRED: POST /bonus {kind:"list"} only registers a pending award;
-- the settler credits it once the indexer shows the same listing (listed_sig = tx_sig) stayed
-- active for LIST_POINTS_MIN_ACTIVE_SEC. One row per list tx. Any row (pending/awarded/void)
-- for a mint inside LIST_POINTS_NFT_WINDOW_SEC blocks another listing award for that mint.
CREATE TABLE IF NOT EXISTS listing_awards (
  id          BIGSERIAL PRIMARY KEY,
  wallet      TEXT NOT NULL,
  nft_mint    TEXT NOT NULL,
  tx_sig      TEXT NOT NULL UNIQUE,
  listed_at   TIMESTAMPTZ NOT NULL,             -- block time of the list tx
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','awarded','void')),
  reason      TEXT,
  amount      INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS listing_awards_mint ON listing_awards (nft_mint, listed_at DESC);
CREATE INDEX IF NOT EXISTS listing_awards_wallet ON listing_awards (wallet, listed_at DESC);
CREATE INDEX IF NOT EXISTS listing_awards_pending ON listing_awards (status) WHERE status = 'pending';

-- Legacy list awards whose tx is still the indexed listing for a mint: record them so the
-- per-NFT 24h window also covers listings that were rewarded under the old rules.
INSERT INTO listing_awards (wallet, nft_mint, tx_sig, listed_at, status, reason, amount, created_at, settled_at)
SELECT e.wallet, l.nft_mint, e.tx_sig, e.created_at, 'awarded', 'legacy', e.amount, e.created_at, e.created_at
  FROM points_events e JOIN listings l ON l.listed_sig = e.tx_sig
 WHERE e.kind = 'list'
ON CONFLICT (tx_sig) DO NOTHING;

-- One decision per indexed trade (sale points to seller/buyer, or the reason for none).
CREATE TABLE IF NOT EXISTS sale_awards (
  trade_id       BIGINT PRIMARY KEY,
  nft_mint       TEXT NOT NULL,
  buyer          TEXT,
  seller         TEXT,
  traded_at      TIMESTAMPTZ NOT NULL,
  seller_points  INTEGER NOT NULL DEFAULT 0,
  buyer_points   INTEGER NOT NULL DEFAULT 0,
  reason         TEXT,
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sale_awards_mint ON sale_awards (nft_mint, traded_at DESC);
CREATE INDEX IF NOT EXISTS trades_pair ON trades (nft_mint, buyer, seller, traded_at DESC);

-- Trades indexed before these rules shipped never earn retroactive sale points.
INSERT INTO sale_awards (trade_id, nft_mint, buyer, seller, traded_at, reason)
SELECT id, nft_mint, buyer, seller, traded_at, 'pre_rules' FROM trades
ON CONFLICT (trade_id) DO NOTHING;
