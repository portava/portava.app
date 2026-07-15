-- ============================================================================
-- Migration 0050: user_suggestion_seen
-- Persists per-user seen-suggestion IDs so the strip stays fresh across
-- API server restarts.  Service role only — no user-facing RLS policies.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_suggestion_seen (
  user_id    uuid        PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  seen_ids   text[]      NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_suggestion_seen ENABLE ROW LEVEL SECURITY;

-- No user-facing policies: the service role (used by the API server) bypasses
-- RLS automatically.  Users never query this table directly.

CREATE INDEX IF NOT EXISTS user_suggestion_seen_expires_idx
  ON user_suggestion_seen (expires_at);
