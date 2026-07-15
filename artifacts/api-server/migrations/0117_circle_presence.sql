-- Find Your Circle — Migration 0117
-- Current presence snapshot per user per context.
-- One row per (user, context_type, context_id) — upserted on each presence push.
-- No GPS coordinates stored in V1.

CREATE TABLE IF NOT EXISTS circle_presence (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type      TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id        UUID NOT NULL,
  -- Semantic status broadcasted to the circle.
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','arrived','with_group','leaving','safe','needs_help')),
  -- Human-readable label visible in status_only and above modes.
  status_label      TEXT,
  -- Broad area label (neighbourhood/district) for approximate_area mode.
  approximate_label TEXT,
  -- Explicit venue name for venue_checkin mode (only populated when checked in).
  venue_label       TEXT,
  checked_in        BOOLEAN NOT NULL DEFAULT false,
  -- Presence goes stale if last_seen_at + stale_after < now().
  -- Stored as seconds so the cleanup job can use it without INTERVAL parsing.
  stale_after_secs  INTEGER NOT NULL DEFAULT 1800,  -- 30 minutes
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- When this presence record should be fully expired and removed.
  expires_at        TIMESTAMPTZ,
  is_stale          BOOLEAN NOT NULL DEFAULT false,
  -- Safety flag set by needs-help action; never exposed in normal member response.
  needs_help        BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, context_type, context_id)
);

CREATE INDEX IF NOT EXISTS cp_context_idx
  ON circle_presence (context_type, context_id);

CREATE INDEX IF NOT EXISTS cp_expires_at_idx
  ON circle_presence (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS cp_last_seen_idx
  ON circle_presence (last_seen_at);

ALTER TABLE circle_presence ENABLE ROW LEVEL SECURITY;

-- Users read only their own row; the API server service role reads all.
DROP POLICY IF EXISTS cp_owner_read ON circle_presence;
CREATE POLICY cp_owner_read ON circle_presence
  FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS cp_owner_write ON circle_presence;
CREATE POLICY cp_owner_write ON circle_presence
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cp_service_all ON circle_presence;
CREATE POLICY cp_service_all ON circle_presence
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
