-- DiscoveryRankingService: stores 1-in-N sampled ranking score breakdowns for debugging.
--
-- Written asynchronously (fire-and-forget) by writeSampleAsync() inside
-- DiscoveryRankingService. Read by GET /admin/ranking/debug-samples (max 200 rows).
--
-- The table existed live with an older column set (content_id, final_score,
-- score_components, ranking_version, surface, sampled_at). The CREATE TABLE below
-- is a no-op against the live DB; the ALTER TABLE statements add the columns that
-- DiscoveryRankingService writes by name (item_id, session_id, components,
-- explanation_key).
--
-- Retention: old rows can be purged by the nightly cleanup job; no FK to profiles
-- so rows survive user deletion (anonymised by viewer_id only being a UUID).

CREATE TABLE IF NOT EXISTS ranking_debug_samples (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_id        UUID        NOT NULL,
  item_id          TEXT        NOT NULL,
  surface          TEXT        NOT NULL,
  session_id       TEXT,
  final_score      FLOAT       NOT NULL,
  components       JSONB       NOT NULL DEFAULT '{}',
  explanation_key  TEXT,
  content_type     TEXT,
  ranking_version  TEXT,
  sampled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add columns missing from the live table (table pre-existed with a different schema).
ALTER TABLE ranking_debug_samples ADD COLUMN IF NOT EXISTS item_id TEXT;
ALTER TABLE ranking_debug_samples ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE ranking_debug_samples ADD COLUMN IF NOT EXISTS components JSONB NOT NULL DEFAULT '{}';
ALTER TABLE ranking_debug_samples ADD COLUMN IF NOT EXISTS explanation_key TEXT;

-- Admin reads are always ordered by sampled_at DESC with optional surface/content_type filters.
CREATE INDEX IF NOT EXISTS ranking_debug_samples_sampled_at_idx
  ON ranking_debug_samples (sampled_at DESC);

CREATE INDEX IF NOT EXISTS ranking_debug_samples_surface_idx
  ON ranking_debug_samples (surface, sampled_at DESC);

-- RLS: service role writes; admin reads are done via service client (no policy needed for users).
ALTER TABLE ranking_debug_samples ENABLE ROW LEVEL SECURITY;
