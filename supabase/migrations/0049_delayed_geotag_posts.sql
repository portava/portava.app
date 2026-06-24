-- Migration 0049: Delayed geotag posting — post now, share after you leave
-- Adds location-privacy lifecycle to the posts table and creates the
-- event-log table used by the background publisher and anti-abuse guards.

-- ── New enum types ────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE post_location_privacy_mode AS ENUM (
    'none',
    'hidden',
    'city_only',
    'delayed_until_exit',
    'delayed_until_time',
    'trusted_circle_only'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE location_sensitivity_level AS ENUM ('low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE delayed_post_status AS ENUM (
    'draft',
    'private',
    'pending_location_exit',
    'pending_delay',
    'pending_safety_review',
    'published',
    'canceled',
    'expired'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE delayed_post_event_type AS ENUM (
    'created_pending',
    'exit_detected',
    'published',
    'canceled',
    'privacy_changed',
    'publish_without_location',
    'geotag_credit_awarded',
    'credit_rate_limited',
    'worker_skipped'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Add columns to posts ──────────────────────────────────────────────────────

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS location_privacy_mode   post_location_privacy_mode NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS geotag_verified         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS geotag_credit_awarded   BOOLEAN NOT NULL DEFAULT FALSE,
  -- private coordinates: stored but NEVER returned in public responses
  ADD COLUMN IF NOT EXISTS original_lat            DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS original_lng            DOUBLE PRECISION,
  -- public coordinates: revealed only when the user opts in after exit
  ADD COLUMN IF NOT EXISTS public_lat              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS public_lng              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS venue_id                TEXT,
  ADD COLUMN IF NOT EXISTS venue_name              TEXT,
  ADD COLUMN IF NOT EXISTS public_location_label   TEXT,
  ADD COLUMN IF NOT EXISTS geofence_radius_meters  INTEGER NOT NULL DEFAULT 400,
  ADD COLUMN IF NOT EXISTS publish_after_exit      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS publish_after_time      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exited_geofence_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS publish_eligible_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS location_sensitivity_level location_sensitivity_level NOT NULL DEFAULT 'low',
  ADD COLUMN IF NOT EXISTS post_status             delayed_post_status NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS delayed_location_reason TEXT;

-- Indexes for the background worker query
CREATE INDEX IF NOT EXISTS posts_post_status_idx         ON posts (post_status);
CREATE INDEX IF NOT EXISTS posts_publish_eligible_at_idx ON posts (publish_eligible_at)
  WHERE post_status IN ('pending_location_exit', 'pending_delay');

-- ── Delayed post location events ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS delayed_post_location_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type  delayed_post_event_type NOT NULL,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS delayed_post_events_post_id_idx  ON delayed_post_location_events (post_id);
CREATE INDEX IF NOT EXISTS delayed_post_events_user_id_idx  ON delayed_post_location_events (user_id);
-- Anti-abuse: fast lookup for rate-limit check (credit events per user+venue)
CREATE INDEX IF NOT EXISTS delayed_post_events_credit_idx
  ON delayed_post_location_events (user_id, event_type, created_at)
  WHERE event_type = 'geotag_credit_awarded';

-- RLS: users can read their own events; service role writes all
ALTER TABLE delayed_post_location_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own delayed post events"
  ON delayed_post_location_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "service role manages delayed post events"
  ON delayed_post_location_events FOR ALL
  USING (true)
  WITH CHECK (true);
