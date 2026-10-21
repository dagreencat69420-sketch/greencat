-- NOTE (Oct 12, 2026): the community chat feature was removed by the owner. This migration and its
-- tables/data are intentionally kept (no DROP) so existing databases and deploys keep working.
-- Community chat (off-chain, moderated). Everyone can read; any SIWS-signed-in wallet can post.
-- Plain text only: bodies are sanitized server-side and rendered as text (never HTML) by the web app.

CREATE TABLE IF NOT EXISTS chat_messages (
  id            BIGSERIAL PRIMARY KEY,
  wallet        TEXT NOT NULL,                     -- poster (base58), or 'system' for the welcome message
  display_name  TEXT,                              -- snapshot of the poster's chat name at post time (NULL = none set)
  body          TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  dup_key       TEXT NOT NULL DEFAULT '',          -- normalized body for the duplicate-spam check
  kind          TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted       BOOLEAN NOT NULL DEFAULT false,
  deleted_at    TIMESTAMPTZ,
  deleted_by    TEXT                               -- admin wallet that removed it
);
CREATE INDEX IF NOT EXISTS chat_messages_live ON chat_messages (id DESC) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS chat_messages_wallet ON chat_messages (wallet, created_at DESC);

-- Off-chain chat profile keyed by wallet. name_key = lower(display_name), unique (case-insensitive).
CREATE TABLE IF NOT EXISTS chat_profiles (
  wallet        TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  name_key      TEXT NOT NULL UNIQUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Current mute / ban per wallet (one row; unban deletes it). until NULL = permanent.
CREATE TABLE IF NOT EXISTS chat_sanctions (
  wallet        TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('mute','ban')),
  until         TIMESTAMPTZ,
  reason        TEXT,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only moderation log (who did what, when).
CREATE TABLE IF NOT EXISTS chat_mod_log (
  id            BIGSERIAL PRIMARY KEY,
  action        TEXT NOT NULL CHECK (action IN ('delete','mute','ban','unban')),
  target_wallet TEXT,
  message_id    BIGINT,
  until         TIMESTAMPTZ,
  reason        TEXT,
  by_wallet     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_mod_log_recent ON chat_mod_log (id DESC);

-- One welcome message from the system (not a fake user).
INSERT INTO chat_messages (wallet, display_name, body, kind)
VALUES (
  'system',
  'GreenCat',
  'Welcome to the GreenCat community chat! Be nice. No links or contract addresses. Admins will never DM you first, and never share your seed phrase with anyone.',
  'system'
);
