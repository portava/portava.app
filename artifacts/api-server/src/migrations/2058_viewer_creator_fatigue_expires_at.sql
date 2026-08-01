-- Migration 2058: add expires_at to viewer_creator_fatigue
--
-- The creator-fatigue suppression system in DiscoveryRankingService and the
-- admin ranking-config dashboard (GET /api/admin/ranking-config/fatigue-stats)
-- both query viewer_creator_fatigue rows by expires_at:
--
--   .gt("expires_at", nowIso)   → count currently-suppressed (viewer, creator) pairs
--   .lte("expires_at", in24h)   → count rows expiring within 24 h
--
-- Without this column every .gt("expires_at", ...) call returns PGRST204
-- (column not found) and the fatigue stats endpoint returns an error instead
-- of the dashboard data.
--
-- Column semantics:
--   NULL   — this suppression row has no expiry (permanent until cleared manually)
--   future — suppression is still active
--   past   — suppression window has closed; row is retained for analytics

ALTER TABLE viewer_creator_fatigue
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Partial index for the "find currently active suppressions" query pattern.
CREATE INDEX IF NOT EXISTS idx_viewer_creator_fatigue_expires_at
  ON viewer_creator_fatigue (expires_at)
  WHERE expires_at IS NOT NULL;
