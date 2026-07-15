-- Migration 0052: Compass Pipeline Logs
-- Creates audit/log tables for the four Compass pipeline stages:
--   compass_safety_filter_logs, compass_eligibility_logs,
--   compass_privacy_guard_logs, compass_recommendation_scores

-- ── compass_safety_filter_logs ────────────────────────────────────────────────
-- Records every item blocked by the Safety Filter (hard blocks only).
CREATE TABLE IF NOT EXISTS compass_safety_filter_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL,
  item_type     TEXT NOT NULL,
  block_reason  TEXT NOT NULL,
  author_id     UUID NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS csfl_viewer_created_idx
  ON compass_safety_filter_logs(viewer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS csfl_item_idx
  ON compass_safety_filter_logs(item_id, item_type);

-- RLS: service role only (internal audit log — not user-facing)
ALTER TABLE compass_safety_filter_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY csfl_service_all ON compass_safety_filter_logs
  USING (auth.role() = 'service_role');

-- ── compass_eligibility_logs ──────────────────────────────────────────────────
-- Records every item rejected by the Eligibility Engine.
CREATE TABLE IF NOT EXISTS compass_eligibility_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL,
  item_type       TEXT NOT NULL,
  rejection_reason TEXT NOT NULL,
  author_id       UUID NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cel_viewer_created_idx
  ON compass_eligibility_logs(viewer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cel_item_idx
  ON compass_eligibility_logs(item_id, item_type);

ALTER TABLE compass_eligibility_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY cel_service_all ON compass_eligibility_logs
  USING (auth.role() = 'service_role');

-- ── compass_privacy_guard_logs ────────────────────────────────────────────────
-- Records every scrubbing event applied by the Privacy Guard.
CREATE TABLE IF NOT EXISTS compass_privacy_guard_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id          TEXT NOT NULL,
  item_type        TEXT NOT NULL,
  scrubbed_fields  TEXT[] NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cpgl_viewer_created_idx
  ON compass_privacy_guard_logs(viewer_id, created_at DESC);

ALTER TABLE compass_privacy_guard_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY cpgl_service_all ON compass_privacy_guard_logs
  USING (auth.role() = 'service_role');

-- ── compass_recommendation_scores ────────────────────────────────────────────
-- Stores the top-5 score components per item per pipeline run for debugging.
CREATE TABLE IF NOT EXISTS compass_recommendation_scores (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id           TEXT NOT NULL,
  item_type         TEXT NOT NULL,
  final_score       NUMERIC(6,3) NOT NULL,
  score_components  JSONB NOT NULL DEFAULT '{}',
  context_state     TEXT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crs_viewer_created_idx
  ON compass_recommendation_scores(viewer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crs_item_idx
  ON compass_recommendation_scores(item_id, item_type);
-- Keep table lean: auto-purge rows older than 7 days via nightly cleanup job
CREATE INDEX IF NOT EXISTS crs_created_purge_idx
  ON compass_recommendation_scores(created_at);

ALTER TABLE compass_recommendation_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY crs_service_all ON compass_recommendation_scores
  USING (auth.role() = 'service_role');
