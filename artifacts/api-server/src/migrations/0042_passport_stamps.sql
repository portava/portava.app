-- ============================================================
-- Migration 0042 — Passport Stamps & Verified Location Memories
-- ============================================================

-- ── passport_stamps ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS passport_stamps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stamp_type      TEXT NOT NULL CHECK (stamp_type IN (
                    'city', 'neighborhood', 'plan', 'host', 'hidden_gem',
                    'safe_return', 'activity', 'trip_crew', 'compass_ai', 'qr_checkin'
                  )),
  country         TEXT,
  city            TEXT,
  neighborhood    TEXT,
  place_id        UUID,
  plan_id         UUID,
  trip_id         UUID,
  source_type     TEXT NOT NULL DEFAULT 'manual',
  verification_level TEXT NOT NULL DEFAULT 'unverified'
                      CHECK (verification_level IN ('unverified', 'gps', 'checkin', 'safe_return', 'crew', 'admin')),
  visibility      TEXT NOT NULL DEFAULT 'public'
                      CHECK (visibility IN ('public', 'circle_only', 'trip_crew', 'private')),
  earned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deduplication: one stamp per (user, type, country, city)
CREATE UNIQUE INDEX IF NOT EXISTS passport_stamps_dedup_idx
  ON passport_stamps (user_id, stamp_type, COALESCE(country, ''), COALESCE(city, ''));

CREATE INDEX IF NOT EXISTS passport_stamps_user_idx ON passport_stamps (user_id, earned_at DESC);
CREATE INDEX IF NOT EXISTS passport_stamps_country_idx ON passport_stamps (user_id, country) WHERE country IS NOT NULL;

-- RLS: owner reads own; service role writes
ALTER TABLE passport_stamps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "passport_stamps_owner_read" ON passport_stamps
  FOR SELECT USING (auth.uid() = user_id);

-- ── passport_memories ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS passport_memories (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'suggested'
                        CHECK (status IN ('suggested', 'active', 'dismissed')),
  title             TEXT,
  description       TEXT,
  country           TEXT,
  city              TEXT,
  neighborhood      TEXT,
  category          TEXT,
  visibility        TEXT NOT NULL DEFAULT 'private'
                        CHECK (visibility IN ('public', 'circle_only', 'trip_crew', 'private')),
  verification_level TEXT NOT NULL DEFAULT 'unverified'
                        CHECK (verification_level IN ('unverified', 'gps', 'checkin', 'safe_return', 'crew', 'admin')),
  source_type       TEXT,
  source_id         UUID,
  photo_url         TEXT,
  plan_id           UUID,
  trip_id           UUID,
  place_id          UUID,
  suggestion_reason TEXT,
  earned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS passport_memories_user_idx
  ON passport_memories (user_id, status, earned_at DESC);

-- RLS: owner manages own
ALTER TABLE passport_memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "passport_memories_owner_all" ON passport_memories
  FOR ALL USING (auth.uid() = user_id);

-- ── passport_contribution_events ───────────────────────────
CREATE TABLE IF NOT EXISTS passport_contribution_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL CHECK (event_type IN (
                      'city_visit_verified', 'plan_attendance_verified', 'plan_hosted',
                      'hidden_gem_verified', 'pulse_contribution', 'safe_return_completed',
                      'qr_checkin_validated', 'trip_crew_participation'
                    )),
  source_type       TEXT,
  source_id         UUID,
  verification_level TEXT NOT NULL DEFAULT 'unverified',
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS passport_contribution_user_idx
  ON passport_contribution_events (user_id, created_at DESC);

-- Prevent double-credit on same source
CREATE UNIQUE INDEX IF NOT EXISTS passport_contribution_dedup_idx
  ON passport_contribution_events (user_id, event_type, source_id)
  WHERE source_id IS NOT NULL;

-- RLS: owner reads own; service role inserts
ALTER TABLE passport_contribution_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "passport_contribution_owner_read" ON passport_contribution_events
  FOR SELECT USING (auth.uid() = user_id);

-- ── passport_visibility_preferences ───────────────────────
CREATE TABLE IF NOT EXISTS passport_visibility_preferences (
  user_id                  UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  default_stamp_visibility TEXT NOT NULL DEFAULT 'public'
                               CHECK (default_stamp_visibility IN ('public', 'circle_only', 'trip_crew', 'private')),
  default_memory_visibility TEXT NOT NULL DEFAULT 'private'
                                CHECK (default_memory_visibility IN ('public', 'circle_only', 'trip_crew', 'private')),
  show_city_map            BOOLEAN NOT NULL DEFAULT true,
  show_neighborhoods       BOOLEAN NOT NULL DEFAULT true,
  show_plan_stamps         BOOLEAN NOT NULL DEFAULT true,
  show_safe_return_stamps  BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: user manages own row
ALTER TABLE passport_visibility_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "passport_vis_prefs_owner" ON passport_visibility_preferences
  FOR ALL USING (auth.uid() = user_id);

-- ── Feature flags ─────────────────────────────────────────
INSERT INTO feature_flags (flag, enabled, description)
VALUES
  ('passport_stamps_enabled',              true,  'Passport stamps system — earn stamps from verified travel events'),
  ('passport_memories_enabled',            true,  'Passport memories — create privacy-safe travel narrative cards'),
  ('passport_map_enabled',                 true,  'Passport map — city-level markers, no exact GPS'),
  ('passport_contribution_events_enabled', true,  'Record passport contribution events for future trust scoring')
ON CONFLICT (flag) DO NOTHING;
