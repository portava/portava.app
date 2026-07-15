-- Migration 0042: Passport stamps, memories, contribution events, and visibility preferences
-- Applied: 2026-06-23

-- ── passport_stamps ─────────────────────────────────────────────────────────
-- Stores earned stamps per user. Unique per (user_id, stamp_type, country, city)
-- so the same city stamp is never double-credited.
-- INVARIANT: No lat/lng is stored here — only city/neighborhood labels.

CREATE TABLE IF NOT EXISTS passport_stamps (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stamp_type        text         NOT NULL CHECK (stamp_type IN (
    'city', 'neighborhood', 'plan', 'host', 'hidden_gem',
    'safe_return', 'activity', 'trip_crew', 'compass_ai', 'qr_checkin'
  )),
  country           text,
  city              text,
  neighborhood      text,
  -- place_id: opaque reference only — never a lat/lng
  place_id          text,
  plan_id           uuid         REFERENCES trip_plan_items(id) ON DELETE SET NULL,
  trip_id           uuid         REFERENCES trips(id) ON DELETE SET NULL,
  source_type       text         NOT NULL DEFAULT 'system',
  verification_level text        NOT NULL DEFAULT 'unverified' CHECK (verification_level IN (
    'unverified', 'gps', 'checkin', 'safe_return', 'crew', 'admin'
  )),
  visibility        text         NOT NULL DEFAULT 'public' CHECK (visibility IN (
    'public', 'circle_only', 'trip_crew', 'private'
  )),
  earned_at         timestamptz  NOT NULL DEFAULT now(),
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now()
);

-- Deduplication: one stamp per user per stamp_type per country/city
CREATE UNIQUE INDEX IF NOT EXISTS passport_stamps_dedup_idx
  ON passport_stamps (user_id, stamp_type, COALESCE(country, ''), COALESCE(city, ''));

CREATE INDEX IF NOT EXISTS passport_stamps_user_earned_idx
  ON passport_stamps (user_id, earned_at DESC);

-- RLS
ALTER TABLE passport_stamps ENABLE ROW LEVEL SECURITY;

-- Users read their own stamps
CREATE POLICY passport_stamps_owner_read ON passport_stamps
  FOR SELECT USING (auth.uid() = user_id);

-- Public stamps readable by anyone authenticated (privacy guard applied in application layer)
CREATE POLICY passport_stamps_public_read ON passport_stamps
  FOR SELECT USING (visibility = 'public');

-- Service role handles all writes
CREATE POLICY passport_stamps_service_write ON passport_stamps
  FOR ALL USING (auth.role() = 'service_role');

-- ── passport_memories ────────────────────────────────────────────────────────
-- Suggested memories start as 'suggested' (private) and become 'active' when
-- accepted by the user. Dismissed memories are soft-deleted.

CREATE TABLE IF NOT EXISTS passport_memories (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status            text         NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'active', 'dismissed')),
  title             text,
  description       text,
  country           text,
  city              text,
  neighborhood      text,
  category          text,
  visibility        text         NOT NULL DEFAULT 'private' CHECK (visibility IN (
    'public', 'circle_only', 'trip_crew', 'private'
  )),
  verification_level text        NOT NULL DEFAULT 'unverified',
  source_type       text,
  source_id         text,
  photo_url         text,
  plan_id           uuid         REFERENCES trip_plan_items(id) ON DELETE SET NULL,
  trip_id           uuid         REFERENCES trips(id) ON DELETE SET NULL,
  place_id          text,
  suggestion_reason text,
  earned_at         timestamptz  NOT NULL DEFAULT now(),
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS passport_memories_user_status_idx
  ON passport_memories (user_id, status, earned_at DESC);

-- RLS
ALTER TABLE passport_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY passport_memories_owner_all ON passport_memories
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY passport_memories_public_read ON passport_memories
  FOR SELECT USING (visibility = 'public' AND status = 'active');

CREATE POLICY passport_memories_service_write ON passport_memories
  FOR ALL USING (auth.role() = 'service_role');

-- ── passport_contribution_events ─────────────────────────────────────────────
-- Append-only log of positive travel actions. Does NOT modify Trust Score.
-- The unique index on (user_id, event_type, source_id) prevents double-credit.

CREATE TABLE IF NOT EXISTS passport_contribution_events (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type        text         NOT NULL CHECK (event_type IN (
    'city_visit_verified', 'plan_attendance_verified', 'plan_hosted',
    'hidden_gem_verified', 'pulse_contribution', 'safe_return_completed',
    'qr_checkin_validated', 'trip_crew_participation'
  )),
  source_type       text,
  source_id         text,
  verification_level text        NOT NULL DEFAULT 'unverified',
  metadata          jsonb        NOT NULL DEFAULT '{}',
  created_at        timestamptz  NOT NULL DEFAULT now()
);

-- Prevent double-credit per source event
CREATE UNIQUE INDEX IF NOT EXISTS passport_contribution_events_dedup_idx
  ON passport_contribution_events (user_id, event_type, source_id)
  WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS passport_contribution_events_user_idx
  ON passport_contribution_events (user_id, created_at DESC);

-- RLS
ALTER TABLE passport_contribution_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY passport_contribution_events_owner_read ON passport_contribution_events
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY passport_contribution_events_service_write ON passport_contribution_events
  FOR ALL USING (auth.role() = 'service_role');

-- ── passport_visibility_preferences ─────────────────────────────────────────
-- Per-user defaults for new stamp and memory visibility.
-- No GPS or location data stored here.

CREATE TABLE IF NOT EXISTS passport_visibility_preferences (
  user_id                 uuid    PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  default_stamp_visibility text   NOT NULL DEFAULT 'public' CHECK (default_stamp_visibility IN (
    'public', 'circle_only', 'trip_crew', 'private'
  )),
  default_memory_visibility text  NOT NULL DEFAULT 'private' CHECK (default_memory_visibility IN (
    'public', 'circle_only', 'trip_crew', 'private'
  )),
  show_city_map           boolean NOT NULL DEFAULT true,
  show_neighborhoods      boolean NOT NULL DEFAULT true,
  show_plan_stamps        boolean NOT NULL DEFAULT true,
  show_safe_return_stamps boolean NOT NULL DEFAULT false,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE passport_visibility_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY passport_visibility_preferences_owner ON passport_visibility_preferences
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY passport_visibility_preferences_service ON passport_visibility_preferences
  FOR ALL USING (auth.role() = 'service_role');

-- ── Feature flags ─────────────────────────────────────────────────────────────

INSERT INTO feature_flags (key, enabled, description) VALUES
  ('passport_stamps_enabled',              false, 'Enable passport stamp creation and display'),
  ('passport_memories_enabled',            false, 'Enable passport memories (suggestions, accept, dismiss)'),
  ('passport_map_enabled',                 false, 'Enable city-level stamp map on passport'),
  ('passport_contribution_events_enabled', false, 'Enable recording of contribution events')
ON CONFLICT (key) DO NOTHING;
