-- 0043_hidden_gems.sql
-- Hidden Gems & Local Guide system
-- Sensitivity levels: public | approximate | reveal_after_save | reveal_after_acceptance | protected
-- Verification levels: unverified | community | guide | gps_verified | admin

-- ── Enums ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE hidden_gem_sensitivity AS ENUM (
    'public', 'approximate', 'reveal_after_save',
    'reveal_after_acceptance', 'protected'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE hidden_gem_verification_level AS ENUM (
    'unverified', 'community', 'guide', 'gps_verified', 'admin'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE hidden_gem_status AS ENUM ('pending', 'active', 'hidden', 'merged');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── hidden_gems ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hidden_gems (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  category               TEXT NOT NULL,
  city                   TEXT NOT NULL,
  country                TEXT,
  neighborhood           TEXT,
  description            TEXT CHECK (char_length(description) <= 2000),
  -- Exact coords — may be NULL for approximate/protected gems
  latitude               DOUBLE PRECISION,
  longitude              DOUBLE PRECISION,
  -- Approx neighbourhood centroid (always populated for map rendering)
  approx_latitude        DOUBLE PRECISION,
  approx_longitude       DOUBLE PRECISION,
  vibe_tags              TEXT[] DEFAULT '{}',
  price_range            TEXT CHECK (price_range IN ('free','$','$$','$$$','$$$$')),
  safety_notes           TEXT CHECK (char_length(safety_notes) <= 1000),
  best_time_to_go        TEXT CHECK (char_length(best_time_to_go) <= 300),
  local_etiquette        TEXT CHECK (char_length(local_etiquette) <= 500),
  layover_safe           BOOLEAN DEFAULT FALSE,
  minimum_layover_minutes INTEGER,
  sensitivity_level      hidden_gem_sensitivity NOT NULL DEFAULT 'public',
  verification_level     hidden_gem_verification_level NOT NULL DEFAULT 'unverified',
  status                 hidden_gem_status NOT NULL DEFAULT 'pending',
  submitted_by           UUID REFERENCES profiles(id) ON DELETE SET NULL,
  guide_verified_by      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  save_count             INTEGER NOT NULL DEFAULT 0,
  visit_count            INTEGER NOT NULL DEFAULT 0,
  report_count           INTEGER NOT NULL DEFAULT 0,
  merged_into            UUID REFERENCES hidden_gems(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hidden_gems_city_idx        ON hidden_gems (city);
CREATE INDEX IF NOT EXISTS hidden_gems_category_idx    ON hidden_gems (category);
CREATE INDEX IF NOT EXISTS hidden_gems_status_idx      ON hidden_gems (status);
CREATE INDEX IF NOT EXISTS hidden_gems_submitted_by_idx ON hidden_gems (submitted_by);
CREATE INDEX IF NOT EXISTS hidden_gems_layover_idx     ON hidden_gems (layover_safe) WHERE layover_safe = TRUE;

ALTER TABLE hidden_gems ENABLE ROW LEVEL SECURITY;

-- Public active gems with public sensitivity → anyone can read
CREATE POLICY hidden_gems_public_read ON hidden_gems
  FOR SELECT USING (status = 'active' AND sensitivity_level = 'public');

-- Submitted user can always read own gems
CREATE POLICY hidden_gems_owner_read ON hidden_gems
  FOR SELECT USING (submitted_by = auth.uid());

-- Authenticated users can insert (pending review)
CREATE POLICY hidden_gems_insert ON hidden_gems
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND submitted_by = auth.uid());

-- Owners can update own pending/active gems
CREATE POLICY hidden_gems_owner_update ON hidden_gems
  FOR UPDATE USING (submitted_by = auth.uid());

-- ── hidden_gem_verifications ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hidden_gem_verifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gem_id        UUID NOT NULL REFERENCES hidden_gems(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  method        TEXT NOT NULL CHECK (method IN ('gps_proximity', 'community', 'guide', 'admin')),
  result        TEXT NOT NULL CHECK (result IN ('approved', 'rejected', 'suspicious', 'pending_review')),
  distance_m    DOUBLE PRECISION,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gem_id, user_id, method)
);

ALTER TABLE hidden_gem_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY hgv_select ON hidden_gem_verifications
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY hgv_insert ON hidden_gem_verifications
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid());

-- ── hidden_gem_reports ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hidden_gem_reports (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gem_id     UUID NOT NULL REFERENCES hidden_gems(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL CHECK (reason IN (
               'inaccurate', 'unsafe', 'outdated', 'duplicate', 'spam', 'offensive', 'other'
             )),
  notes      TEXT CHECK (char_length(notes) <= 500),
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gem_id, reporter_id)
);

ALTER TABLE hidden_gem_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY hgr_own_read ON hidden_gem_reports
  FOR SELECT USING (reporter_id = auth.uid());

CREATE POLICY hgr_insert ON hidden_gem_reports
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND reporter_id = auth.uid());

-- ── hidden_gem_saves ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hidden_gem_saves (
  gem_id     UUID NOT NULL REFERENCES hidden_gems(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (gem_id, user_id)
);

ALTER TABLE hidden_gem_saves ENABLE ROW LEVEL SECURITY;

CREATE POLICY hgs_own_read ON hidden_gem_saves
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY hgs_insert ON hidden_gem_saves
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid());

CREATE POLICY hgs_delete ON hidden_gem_saves
  FOR DELETE USING (user_id = auth.uid());

-- ── hidden_gem_visits ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hidden_gem_visits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gem_id          UUID NOT NULL REFERENCES hidden_gems(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  distance_m      DOUBLE PRECISION,
  trust_level     TEXT NOT NULL DEFAULT 'manual',
  is_suspicious   BOOLEAN NOT NULL DEFAULT FALSE,
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,
  visited_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE hidden_gem_visits ENABLE ROW LEVEL SECURITY;

CREATE POLICY hgvis_own_read ON hidden_gem_visits
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY hgvis_insert ON hidden_gem_visits
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid());

-- ── local_guide_profiles ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS local_guide_profiles (
  user_id            UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  guide_level        INTEGER NOT NULL DEFAULT 0 CHECK (guide_level BETWEEN 0 AND 5),
  city_expertise     TEXT[] DEFAULT '{}',
  contribution_count INTEGER NOT NULL DEFAULT 0,
  helpful_votes      INTEGER NOT NULL DEFAULT 0,
  accuracy_score     DOUBLE PRECISION DEFAULT 0.0,
  status             TEXT NOT NULL DEFAULT 'applicant' CHECK (status IN ('applicant', 'active', 'suspended', 'demoted')),
  bio                TEXT CHECK (char_length(bio) <= 500),
  verified_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE local_guide_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY lgp_public_read ON local_guide_profiles
  FOR SELECT USING (status = 'active');

CREATE POLICY lgp_own_read ON local_guide_profiles
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY lgp_insert ON local_guide_profiles
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid());

CREATE POLICY lgp_own_update ON local_guide_profiles
  FOR UPDATE USING (user_id = auth.uid());

-- ── local_guide_contributions ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS local_guide_contributions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  gem_id          UUID REFERENCES hidden_gems(id) ON DELETE SET NULL,
  contribution_type TEXT NOT NULL CHECK (contribution_type IN (
    'gem_submitted', 'safety_notes', 'best_time', 'etiquette', 'verification', 'report_flagged', 'merge_suggested'
  )),
  helpful_votes   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE local_guide_contributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY lgc_own_read ON local_guide_contributions
  FOR SELECT USING (guide_id = auth.uid());

CREATE POLICY lgc_insert ON local_guide_contributions
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND guide_id = auth.uid());

-- ── Feature flag seeds ────────────────────────────────────────────────────────

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('hidden_gems_enabled',           TRUE,  'Main Hidden Gems discovery feature'),
  ('hidden_gem_verification_enabled', TRUE, 'GPS proximity check-in and verification'),
  ('local_guides_enabled',          TRUE,  'Local Guide profile and contributions'),
  ('hidden_gems_compass_enabled',   TRUE,  'Compass AI includes Hidden Gems context'),
  ('hidden_gems_passport_enabled',  TRUE,  'Passport stamps/memories from gem visits'),
  ('hidden_gems_layover_enabled',   TRUE,  'Layover Mode gem filtering'),
  ('hidden_gems_pulse_enabled',     TRUE,  'City Pulse gems tab')
ON CONFLICT (flag) DO NOTHING;
