-- ─────────────────────────────────────────────────────────────────────────────
-- 0055_compass_admin.sql
-- Compass Phase 6 — Admin & Ops tables
--
-- Tables created:
--   compass_admin_weight_sets    — per-factor scoring weight presets
--   compass_algorithm_versions   — versioned activation history
--   compass_rollbacks            — rollback audit log
--   compass_admin_actions        — all admin action audit trail
--   compass_testing_scenarios    — saved sandbox test scenarios
--
-- Also ensures prerequisite tables from earlier phases exist:
--   compass_served_recommendations (Phase 5)
--   compass_suspension_requests    (Phase 5b)
--
-- Feature flag seeds:
--   COMPASS_FALLBACK_MODE_ENABLED  (off by default)
--   COMPASS_V2_AB_ENABLED          (off by default — A/B stub)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── compass_served_recommendations (Phase 5 prerequisite) ────────────────────
CREATE TABLE IF NOT EXISTS compass_served_recommendations (
  id                       UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                  UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recommendation_id        TEXT        NOT NULL UNIQUE,
  explanation_key          TEXT        NOT NULL,
  item_id                  TEXT        NOT NULL,
  item_type                TEXT        NOT NULL,
  section_name             TEXT,
  explanation_looked_up_at TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compass_served_recommendations_user_idx
  ON compass_served_recommendations(user_id);

ALTER TABLE compass_served_recommendations ENABLE ROW LEVEL SECURITY;

-- Only allow users to read their own served recommendations.
DROP POLICY IF EXISTS compass_served_rec_read ON compass_served_recommendations;
CREATE POLICY compass_served_rec_read ON compass_served_recommendations
  FOR SELECT USING (auth.uid() = user_id);

-- ── compass_suspension_requests (Phase 5b prerequisite) ──────────────────────
CREATE TABLE IF NOT EXISTS compass_suspension_requests (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason      TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'pending_review',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compass_suspension_requests_user_idx
  ON compass_suspension_requests(user_id);
CREATE INDEX IF NOT EXISTS compass_suspension_requests_status_idx
  ON compass_suspension_requests(status);

ALTER TABLE compass_suspension_requests ENABLE ROW LEVEL SECURITY;

-- Service role manages all rows; no direct user access.

-- ── compass_admin_weight_sets ─────────────────────────────────────────────────
-- Stores per-factor scoring weight configurations. Creating a weight set does
-- NOT activate it; activation happens via compass_algorithm_versions.
CREATE TABLE IF NOT EXISTS compass_admin_weight_sets (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT        NOT NULL,
  description TEXT,
  weights     JSONB       NOT NULL DEFAULT '{}',
  created_by  UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE compass_admin_weight_sets ENABLE ROW LEVEL SECURITY;
-- No user-facing RLS — only accessible via service role.

-- ── compass_algorithm_versions ────────────────────────────────────────────────
-- Activation log: each row represents a weight set being made the live algorithm.
CREATE TABLE IF NOT EXISTS compass_algorithm_versions (
  id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  weight_set_id        UUID        REFERENCES compass_admin_weight_sets(id) ON DELETE SET NULL,
  version_tag          TEXT        NOT NULL,
  launched_by_admin_id UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  rollout_status       TEXT        NOT NULL DEFAULT 'active'
                         CHECK (rollout_status IN ('active', 'rolled_back', 'retired')),
  rollback_available   BOOLEAN     NOT NULL DEFAULT TRUE,
  notes                TEXT,
  launched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS compass_algorithm_versions_status_idx
  ON compass_algorithm_versions(rollout_status);

ALTER TABLE compass_algorithm_versions ENABLE ROW LEVEL SECURITY;

-- ── compass_rollbacks ─────────────────────────────────────────────────────────
-- Append-only audit trail for every rollback action.
CREATE TABLE IF NOT EXISTS compass_rollbacks (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  from_version_id UUID        REFERENCES compass_algorithm_versions(id) ON DELETE SET NULL,
  to_version_id   UUID        REFERENCES compass_algorithm_versions(id) ON DELETE SET NULL,
  rolled_back_by  UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE compass_rollbacks ENABLE ROW LEVEL SECURITY;

-- ── compass_admin_actions ─────────────────────────────────────────────────────
-- Fire-and-forget audit log: every admin mutation appends a row here.
CREATE TABLE IF NOT EXISTS compass_admin_actions (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_id    UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  action_type TEXT        NOT NULL,
  target_id   TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compass_admin_actions_admin_idx  ON compass_admin_actions(admin_id);
CREATE INDEX IF NOT EXISTS compass_admin_actions_type_idx   ON compass_admin_actions(action_type);
CREATE INDEX IF NOT EXISTS compass_admin_actions_created_idx ON compass_admin_actions(created_at DESC);

ALTER TABLE compass_admin_actions ENABLE ROW LEVEL SECURITY;

-- ── compass_testing_scenarios ─────────────────────────────────────────────────
-- Saved sandbox scenarios that admins can re-run from the cockpit.
CREATE TABLE IF NOT EXISTS compass_testing_scenarios (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT        NOT NULL,
  created_by  UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  scenario    JSONB       NOT NULL DEFAULT '{}',
  last_result JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique per (name, created_by) so each admin can have their own scenario namespace
-- and upserts on (name, created_by) are unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS compass_testing_scenarios_name_creator_idx
  ON compass_testing_scenarios(name, created_by);

ALTER TABLE compass_testing_scenarios ENABLE ROW LEVEL SECURITY;

-- ── Feature flag seeds ────────────────────────────────────────────────────────
INSERT INTO feature_flags (flag, enabled, description) VALUES
  (
    'COMPASS_FALLBACK_MODE_ENABLED',
    FALSE,
    'When TRUE, all feed endpoints return the safe fallback feed instead of running the full Compass pipeline'
  ),
  (
    'COMPASS_V2_AB_ENABLED',
    FALSE,
    'A/B test capability stub — blocked behind this flag. Must never weaken safety, privacy, age rules, or eligibility'
  )
ON CONFLICT (flag) DO NOTHING;
