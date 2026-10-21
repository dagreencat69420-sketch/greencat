-- NOTE (Oct 12, 2026): the community chat feature was removed by the owner. This migration and its
-- tables/data are intentionally kept (no DROP) so existing databases and deploys keep working.
-- Global chat slow mode (BUGSWEEP-2026-10-07 CH-03 decision: global slow mode, not a balance gate).
-- Settings are stored as JSON per key so the admin's choice survives redeploys. When the 'slow_mode' row is
-- missing the API uses its env defaults (CHAT_SLOW_MODE, default ON at 10 s).
CREATE TABLE IF NOT EXISTS chat_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,                 -- JSON
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The moderation log also records slow-mode changes.
ALTER TABLE chat_mod_log DROP CONSTRAINT IF EXISTS chat_mod_log_action_check;
ALTER TABLE chat_mod_log ADD CONSTRAINT chat_mod_log_action_check
  CHECK (action IN ('delete','mute','ban','unban','slow_mode'));
