-- ============================================================
-- Migration 0053: Compass Phase 3 — Feed Intelligence tables
-- ============================================================
-- Tables created:
--   compass_active_user_scores    — per-user rolling ActiveUserScore + tier
--   compass_active_user_events    — append-only activity events used in scoring
--   compass_active_user_badges    — badge eligibility per user
--   compass_city_reputation       — city-scoped reputation per user
--   compass_category_reputation   — category-scoped reputation per user
--   compass_visibility_boosts     — fair-exposure appearance tracking
--   compass_visibility_cooldowns  — cooldown records when appearance cap is hit
-- ============================================================

-- ── compass_active_user_scores ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compass_active_user_scores (
  user_id             UUID        PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  score_24h           NUMERIC(6,2) NOT NULL DEFAULT 0,
  score_7d            NUMERIC(6,2) NOT NULL DEFAULT 0,
  score_30d           NUMERIC(6,2) NOT NULL DEFAULT 0,
  score_90d           NUMERIC(6,2) NOT NULL DEFAULT 0,
  score_lifetime      NUMERIC(6,2) NOT NULL DEFAULT 0,
  active_user_score   NUMERIC(6,2) NOT NULL DEFAULT 0,
  trust_multiplier    NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  tier                TEXT         NOT NULL DEFAULT 'active_traveler'
    CHECK (tier IN ('active_traveler','local_guide','city_connector','city_ambassador_candidate')),
  boost_eligible      BOOLEAN      NOT NULL DEFAULT FALSE,
  boost_visibility_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_computed_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE compass_active_user_scores ENABLE ROW LEVEL SECURITY;

-- Only service role writes; users read own row
CREATE POLICY "users read own active user score"
  ON compass_active_user_scores FOR SELECT
  USING (auth.uid() = user_id);

-- ── compass_active_user_events ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compass_active_user_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL
    CHECK (event_type IN (
      'booking_completed','event_attended','review_posted','post_published',
      'no_show','dispute_raised','report_received','stamp_earned',
      'buddy_session_completed','trip_created'
    )),
  weight      NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  city        TEXT,
  category    TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compass_aue_user_created
  ON compass_active_user_events (user_id, created_at DESC);

ALTER TABLE compass_active_user_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own active user events"
  ON compass_active_user_events FOR SELECT
  USING (auth.uid() = user_id);

-- ── compass_active_user_badges ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compass_active_user_badges (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  badge_type    TEXT        NOT NULL
    CHECK (badge_type IN (
      'consistent_explorer','social_connector','trusted_guide',
      'city_ambassador_candidate','hidden_gem_finder','safety_champion'
    )),
  eligible      BOOLEAN     NOT NULL DEFAULT FALSE,
  awarded_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, badge_type)
);

ALTER TABLE compass_active_user_badges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own badges"
  ON compass_active_user_badges FOR SELECT
  USING (auth.uid() = user_id);

-- ── compass_city_reputation ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compass_city_reputation (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  city            TEXT        NOT NULL,
  reputation_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  visit_count     INTEGER     NOT NULL DEFAULT 0,
  last_active_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, city)
);

CREATE INDEX IF NOT EXISTS compass_city_rep_city
  ON compass_city_reputation (city, reputation_score DESC);

ALTER TABLE compass_city_reputation ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own city reputation"
  ON compass_city_reputation FOR SELECT
  USING (auth.uid() = user_id);

-- ── compass_category_reputation ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compass_category_reputation (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  category        TEXT        NOT NULL,
  reputation_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  interaction_count INTEGER   NOT NULL DEFAULT 0,
  last_active_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, category)
);

ALTER TABLE compass_category_reputation ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own category reputation"
  ON compass_category_reputation FOR SELECT
  USING (auth.uid() = user_id);

-- ── compass_visibility_boosts ─────────────────────────────────────────────────
-- Tracks fair-exposure appearances for new/verified users and new buddies.
CREATE TABLE IF NOT EXISTS compass_visibility_boosts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         TEXT        NOT NULL,
  item_type       TEXT        NOT NULL,
  author_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  appearance_count INTEGER    NOT NULL DEFAULT 0,
  cap             INTEGER     NOT NULL DEFAULT 10,
  boost_type      TEXT        NOT NULL DEFAULT 'fair_exposure'
    CHECK (boost_type IN ('fair_exposure','new_buddy','new_verified_user')),
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cap_hit_at      TIMESTAMPTZ,
  report_ended_at TIMESTAMPTZ,
  UNIQUE (item_id, item_type)
);

CREATE INDEX IF NOT EXISTS compass_vis_boosts_author
  ON compass_visibility_boosts (author_id, last_seen_at DESC);

ALTER TABLE compass_visibility_boosts ENABLE ROW LEVEL SECURITY;

-- ── compass_visibility_cooldowns ──────────────────────────────────────────────
-- Records cooldown periods for authors whose fair-exposure cap has been hit.
CREATE TABLE IF NOT EXISTS compass_visibility_cooldowns (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  cooldown_type   TEXT        NOT NULL DEFAULT 'fair_exposure_cap',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at         TIMESTAMPTZ NOT NULL,
  reason          TEXT,
  UNIQUE (author_id, cooldown_type)
);

CREATE INDEX IF NOT EXISTS compass_vis_cooldowns_author
  ON compass_visibility_cooldowns (author_id, ends_at);

ALTER TABLE compass_visibility_cooldowns ENABLE ROW LEVEL SECURITY;

-- Feature flag seeds (idempotent)
INSERT INTO feature_flags (flag, enabled, description)
VALUES
  ('COMPASS_FEED_ENABLED',             false, 'Compass Phase 3 feed builder'),
  ('COMPASS_DIVERSITY_ENABLED',        true,  'Compass diversity reordering within sections'),
  ('COMPASS_FAIR_EXPOSURE_ENABLED',    true,  'Fair exposure boost for new verified users/buddies'),
  ('COMPASS_ACTIVE_REWARDS_ENABLED',   true,  'Active user reward engine'),
  ('COMPASS_V1_RULE_BASED_ENABLED',    false, 'Use Compass scoring for discovery/for_you tab')
ON CONFLICT (flag) DO NOTHING;
