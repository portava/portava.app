-- Migration 0043: Trust Score Engine
-- Tables: trust_profiles, trust_events, trust_caps, trust_restrictions,
--         trust_reviews, trust_settings, trust_admin_actions
-- Safe to re-run: IF NOT EXISTS throughout

-- ── trust_profiles ────────────────────────────────────────────────────────────
-- One row per user; stores computed scores and public level.

CREATE TABLE IF NOT EXISTS trust_profiles (
  user_id               UUID        PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  overall_score         NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  -- Nine category scores (0–100)
  plan_attendance       NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  host_quality          NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  communication         NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  respect_safety        NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  location_honesty      NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  content_quality       NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  community_value       NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  guide_accuracy        NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  passport_authenticity NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  -- Derived label (New Traveler … City Trusted)
  public_level          TEXT NOT NULL DEFAULT 'new_traveler'
                          CHECK (public_level IN (
                            'new_traveler','building_trust','reliable_traveler',
                            'trusted_traveler','highly_trusted','city_trusted'
                          )),
  -- Probation tracking
  on_probation          BOOLEAN NOT NULL DEFAULT FALSE,
  probation_ends_at     TIMESTAMPTZ,
  -- Lifecycle
  last_recalculated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trust_profiles_level_idx ON trust_profiles(public_level);

-- ── trust_events ──────────────────────────────────────────────────────────────
-- Append-only ledger; one row per trust signal received.

CREATE TABLE IF NOT EXISTS trust_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type    TEXT        NOT NULL,
  -- Source reference for deduplication
  source_type   TEXT        NOT NULL DEFAULT 'system',
  source_id     TEXT,
  -- Scoring
  category      TEXT        NOT NULL
                  CHECK (category IN (
                    'plan_attendance','host_quality','communication','respect_safety',
                    'location_honesty','content_quality','community_value',
                    'guide_accuracy','passport_authenticity'
                  )),
  delta         NUMERIC(6,2) NOT NULL DEFAULT 0,  -- positive = good, negative = bad
  severity      TEXT NOT NULL DEFAULT 'minor'
                  CHECK (severity IN ('minor','moderate','serious','severe')),
  status        TEXT NOT NULL DEFAULT 'applied'
                  CHECK (status IN ('applied','pending_review','confirmed','dismissed')),
  reviewed_by   UUID        REFERENCES profiles(id),
  reviewed_at   TIMESTAMPTZ,
  metadata      JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trust_events_user_idx    ON trust_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trust_events_type_idx    ON trust_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS trust_events_status_idx  ON trust_events(status) WHERE status IN ('pending_review','confirmed');
CREATE INDEX IF NOT EXISTS trust_events_source_idx  ON trust_events(user_id, event_type, source_type, source_id)
  WHERE source_id IS NOT NULL;

-- ── trust_caps ────────────────────────────────────────────────────────────────
-- Active score ceilings per user per category.

CREATE TABLE IF NOT EXISTS trust_caps (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  category        TEXT        NOT NULL,
  ceiling_score   NUMERIC(5,2) NOT NULL,
  reason_code     TEXT        NOT NULL,
  source_event_id UUID        REFERENCES trust_events(id),
  expires_at      TIMESTAMPTZ,
  lifted_at       TIMESTAMPTZ,
  lifted_by       UUID        REFERENCES profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trust_caps_user_idx    ON trust_caps(user_id) WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS trust_caps_expiry_idx  ON trust_caps(expires_at) WHERE expires_at IS NOT NULL AND lifted_at IS NULL;

-- ── trust_restrictions ────────────────────────────────────────────────────────
-- Active behavioural restrictions per user.

CREATE TABLE IF NOT EXISTS trust_restrictions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  restriction_type TEXT       NOT NULL
                    CHECK (restriction_type IN (
                      'hosting','private_plan_access','messaging','location_plan_join'
                    )),
  reason          TEXT        NOT NULL,
  source_event_id UUID        REFERENCES trust_events(id),
  expires_at      TIMESTAMPTZ,
  lifted_at       TIMESTAMPTZ,
  lifted_by       UUID        REFERENCES profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trust_restrictions_user_idx ON trust_restrictions(user_id) WHERE lifted_at IS NULL;

-- ── trust_reviews ─────────────────────────────────────────────────────────────
-- Admin-facing review queue (pending events + gaming suspicions).

CREATE TABLE IF NOT EXISTS trust_reviews (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  review_type     TEXT        NOT NULL
                    CHECK (review_type IN (
                      'event_review','gaming_suspected','admin_override','appeal'
                    )),
  source_event_id UUID        REFERENCES trust_events(id),
  status          TEXT        NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','in_progress','resolved','dismissed')),
  assigned_to     UUID        REFERENCES profiles(id),
  resolved_by     UUID        REFERENCES profiles(id),
  resolved_at     TIMESTAMPTZ,
  notes           TEXT,
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trust_reviews_open_idx ON trust_reviews(status, created_at) WHERE status IN ('open','in_progress');
CREATE INDEX IF NOT EXISTS trust_reviews_user_idx ON trust_reviews(user_id, created_at DESC);

-- ── trust_settings ────────────────────────────────────────────────────────────
-- Single-row config for weights, decay, and thresholds.

CREATE TABLE IF NOT EXISTS trust_settings (
  id                      INT  PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Category weights (must sum to 1.0 across categories used in overall score)
  weight_plan_attendance  NUMERIC(4,3) NOT NULL DEFAULT 0.180,
  weight_host_quality     NUMERIC(4,3) NOT NULL DEFAULT 0.120,
  weight_communication    NUMERIC(4,3) NOT NULL DEFAULT 0.100,
  weight_respect_safety   NUMERIC(4,3) NOT NULL DEFAULT 0.150,
  weight_location_honesty NUMERIC(4,3) NOT NULL DEFAULT 0.130,
  weight_content_quality  NUMERIC(4,3) NOT NULL DEFAULT 0.080,
  weight_community_value  NUMERIC(4,3) NOT NULL DEFAULT 0.080,
  weight_guide_accuracy   NUMERIC(4,3) NOT NULL DEFAULT 0.080,
  weight_passport_auth    NUMERIC(4,3) NOT NULL DEFAULT 0.080,
  -- Time decay: events older than decay_half_life_days contribute half as much
  decay_half_life_days    INT          NOT NULL DEFAULT 90,
  -- Public level thresholds (overall_score)
  level_building_trust    NUMERIC(5,2) NOT NULL DEFAULT 35.00,
  level_reliable          NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  level_trusted           NUMERIC(5,2) NOT NULL DEFAULT 65.00,
  level_highly_trusted    NUMERIC(5,2) NOT NULL DEFAULT 78.00,
  level_city_trusted      NUMERIC(5,2) NOT NULL DEFAULT 90.00,
  -- Earning caps per event type (daily)
  daily_cap_plan_attend   INT          NOT NULL DEFAULT 3,
  daily_cap_guide_verify  INT          NOT NULL DEFAULT 5,
  daily_cap_gem_save      INT          NOT NULL DEFAULT 10,
  -- Gaming detection thresholds
  gaming_checkin_cluster_limit  INT   NOT NULL DEFAULT 5,
  gaming_mutual_rate_threshold  NUMERIC(4,3) NOT NULL DEFAULT 0.80,
  gaming_rapid_jump_points      NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

INSERT INTO trust_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── trust_admin_actions ───────────────────────────────────────────────────────
-- Immutable audit trail for every admin mutation.

CREATE TABLE IF NOT EXISTS trust_admin_actions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID        NOT NULL REFERENCES profiles(id),
  target_user UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  action_type TEXT        NOT NULL
                CHECK (action_type IN (
                  'confirm_event','dismiss_event','apply_restriction','lift_restriction',
                  'apply_cap','lift_cap','score_override','resolve_review','flag_gaming'
                )),
  source_id   UUID,          -- event/cap/restriction that was acted on
  reason      TEXT        NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trust_admin_actions_target_idx ON trust_admin_actions(target_user, created_at DESC);
CREATE INDEX IF NOT EXISTS trust_admin_actions_admin_idx  ON trust_admin_actions(admin_id, created_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE trust_profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_caps          ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_restrictions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_reviews       ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_admin_actions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  -- trust_profiles: users read own row
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trust_profiles' AND policyname='tp_select_own') THEN
    CREATE POLICY tp_select_own ON trust_profiles FOR SELECT USING (auth.uid() = user_id);
  END IF;
  -- trust_events: users read own events that are not pending_review
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trust_events' AND policyname='te_select_own') THEN
    CREATE POLICY te_select_own ON trust_events FOR SELECT
      USING (auth.uid() = user_id AND status IN ('applied','confirmed','dismissed'));
  END IF;
  -- trust_caps: users read own active caps
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trust_caps' AND policyname='tc_select_own') THEN
    CREATE POLICY tc_select_own ON trust_caps FOR SELECT
      USING (auth.uid() = user_id AND lifted_at IS NULL);
  END IF;
  -- trust_restrictions: users read own active restrictions
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trust_restrictions' AND policyname='tr_select_own') THEN
    CREATE POLICY tr_select_own ON trust_restrictions FOR SELECT
      USING (auth.uid() = user_id AND lifted_at IS NULL);
  END IF;
  -- trust_reviews: no direct user access (admin only via service role)
  -- trust_settings: public read (feature-flag-alike)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trust_settings' AND policyname='ts_select_all') THEN
    CREATE POLICY ts_select_all ON trust_settings FOR SELECT USING (TRUE);
  END IF;
  -- trust_admin_actions: no direct user access
END $$;

-- ── Feature flags ─────────────────────────────────────────────────────────────

INSERT INTO feature_flags (key, enabled, description) VALUES
  ('trust_engine_enabled',          FALSE, 'Master switch for the Trust Score engine'),
  ('trust_public_levels_enabled',   FALSE, 'Show public trust level badges on profiles'),
  ('trust_caps_enabled',            FALSE, 'Enforce score caps when serious events are confirmed'),
  ('trust_restrictions_enabled',    FALSE, 'Apply hosting/messaging restrictions from trust engine'),
  ('trust_admin_dashboard_enabled', FALSE, 'Admin trust review queue and override tools'),
  ('trust_gaming_detection_enabled',FALSE, 'Scan for mutual-ring and check-in farming patterns')
ON CONFLICT (key) DO NOTHING;
