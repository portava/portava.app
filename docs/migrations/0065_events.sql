-- Migration 0065: Full Events System
-- Tables: events, event_rsvps, event_waitlist, event_roles, event_attendee_states
-- Run this in the Supabase SQL Editor (not applied automatically).

-- ── Enum types ────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE event_state AS ENUM (
    'draft', 'open', 'full', 'waitlist', 'started', 'completed', 'cancelled', 'archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE event_rsvp_status AS ENUM (
    'going', 'maybe', 'interested', 'cant_go'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE event_role_type AS ENUM (
    'host', 'co_host', 'moderator', 'banned'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE event_visibility AS ENUM (
    'public', 'friends_only', 'invite_only'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── events ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id             UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title               TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description         TEXT CHECK (char_length(description) <= 2000),
  location_name       TEXT CHECK (char_length(location_name) <= 300),
  location_lat        DOUBLE PRECISION,
  location_lng        DOUBLE PRECISION,
  starts_at           TIMESTAMPTZ,
  ends_at             TIMESTAMPTZ,
  cover_url           TEXT,
  max_attendees       INTEGER CHECK (max_attendees IS NULL OR max_attendees > 0),
  age_min             INTEGER CHECK (age_min IS NULL OR (age_min >= 13 AND age_min <= 100)),
  age_max             INTEGER CHECK (age_max IS NULL OR (age_max >= 13 AND age_max <= 100)),
  trust_score_min     NUMERIC(5,2) CHECK (trust_score_min IS NULL OR (trust_score_min >= 0 AND trust_score_min <= 100)),
  verified_only       BOOLEAN NOT NULL DEFAULT FALSE,
  visibility          event_visibility NOT NULL DEFAULT 'public',
  state               event_state NOT NULL DEFAULT 'draft',
  chat_thread_id      UUID,
  chat_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  waitlist_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  attendee_comments_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  price_type          TEXT CHECK (price_type IN ('free', 'external')),
  price_url           TEXT,
  rsvp_options        TEXT[] NOT NULL DEFAULT '{"going","maybe","interested","cant_go"}',
  going_count         INTEGER NOT NULL DEFAULT 0,
  waitlist_count      INTEGER NOT NULL DEFAULT 0,
  category            TEXT,
  city                TEXT,
  country             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT events_age_range_check CHECK (age_max IS NULL OR age_min IS NULL OR age_max >= age_min),
  CONSTRAINT events_date_range_check CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS events_host_idx          ON events(host_id);
CREATE INDEX IF NOT EXISTS events_state_idx         ON events(state);
CREATE INDEX IF NOT EXISTS events_starts_at_idx     ON events(starts_at);
CREATE INDEX IF NOT EXISTS events_city_idx          ON events(city);
CREATE INDEX IF NOT EXISTS events_created_at_idx    ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS events_visibility_state_idx ON events(visibility, state);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- Public can read public open/started events
CREATE POLICY IF NOT EXISTS "events_public_read" ON events
  FOR SELECT USING (
    visibility = 'public' AND state IN ('open', 'full', 'waitlist', 'started', 'completed')
  );

-- Auth users can read events they are invited to or RSVPd to
CREATE POLICY IF NOT EXISTS "events_participant_read" ON events
  FOR SELECT TO authenticated USING (
    host_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM event_rsvps WHERE event_id = events.id AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM event_roles WHERE event_id = events.id AND user_id = auth.uid()
    )
  );

-- Host / co_host can read all their events (including drafts)
CREATE POLICY IF NOT EXISTS "events_host_read" ON events
  FOR SELECT TO authenticated USING (
    host_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM event_roles
      WHERE event_id = events.id AND user_id = auth.uid() AND role IN ('host','co_host')
    )
  );

-- Service role manages all
CREATE POLICY IF NOT EXISTS "events_service_all" ON events
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ── event_rsvps ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status      event_rsvp_status NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS event_rsvps_user_idx     ON event_rsvps(user_id);
CREATE INDEX IF NOT EXISTS event_rsvps_event_status ON event_rsvps(event_id, status);

ALTER TABLE event_rsvps ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "event_rsvps_own_read" ON event_rsvps
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "event_rsvps_host_read" ON event_rsvps
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM events WHERE id = event_rsvps.event_id
      AND (host_id = auth.uid() OR EXISTS (
        SELECT 1 FROM event_roles WHERE event_id = events.id AND user_id = auth.uid() AND role IN ('host','co_host','moderator')
      ))
    )
  );

CREATE POLICY IF NOT EXISTS "event_rsvps_service_all" ON event_rsvps
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ── event_waitlist ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_waitlist (
  event_id         UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  offer_expires_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id),
  UNIQUE (event_id, position)
);

CREATE INDEX IF NOT EXISTS event_waitlist_user_idx ON event_waitlist(user_id);
CREATE INDEX IF NOT EXISTS event_waitlist_pos_idx  ON event_waitlist(event_id, position);

ALTER TABLE event_waitlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "event_waitlist_own_read" ON event_waitlist
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "event_waitlist_host_read" ON event_waitlist
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM events WHERE id = event_waitlist.event_id
      AND (host_id = auth.uid() OR EXISTS (
        SELECT 1 FROM event_roles WHERE event_id = events.id AND user_id = auth.uid() AND role IN ('host','co_host','moderator')
      ))
    )
  );

CREATE POLICY IF NOT EXISTS "event_waitlist_service_all" ON event_waitlist
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ── event_roles ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_roles (
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role        event_role_type NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS event_roles_user_idx  ON event_roles(user_id);
CREATE INDEX IF NOT EXISTS event_roles_event_idx ON event_roles(event_id, role);

ALTER TABLE event_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "event_roles_host_read" ON event_roles
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM events WHERE id = event_roles.event_id AND host_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM event_roles r2 WHERE r2.event_id = event_roles.event_id AND r2.user_id = auth.uid() AND r2.role IN ('host','co_host')
    )
  );

CREATE POLICY IF NOT EXISTS "event_roles_service_all" ON event_roles
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ── event_attendee_states ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_attendee_states (
  event_id       UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  checked_in_at  TIMESTAMPTZ,
  confirmed_at   TIMESTAMPTZ,
  no_show_at     TIMESTAMPTZ,
  confirmed_by   UUID REFERENCES public.profiles(id),
  no_show_by     UUID REFERENCES public.profiles(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS event_attendee_states_user_idx  ON event_attendee_states(user_id);
CREATE INDEX IF NOT EXISTS event_attendee_states_event_idx ON event_attendee_states(event_id);

ALTER TABLE event_attendee_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "event_attendee_states_own_read" ON event_attendee_states
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "event_attendee_states_host_read" ON event_attendee_states
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM events WHERE id = event_attendee_states.event_id
      AND (host_id = auth.uid() OR EXISTS (
        SELECT 1 FROM event_roles WHERE event_id = events.id AND user_id = auth.uid() AND role IN ('host','co_host','moderator')
      ))
    )
  );

CREATE POLICY IF NOT EXISTS "event_attendee_states_service_all" ON event_attendee_states
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ── event_join_requests ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_join_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  message     TEXT CHECK (char_length(message) <= 500),
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS event_join_requests_event_idx  ON event_join_requests(event_id, status);
CREATE INDEX IF NOT EXISTS event_join_requests_user_idx   ON event_join_requests(user_id);

ALTER TABLE event_join_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "event_join_requests_own_read" ON event_join_requests
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "event_join_requests_host_read" ON event_join_requests
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM events WHERE id = event_join_requests.event_id
      AND (host_id = auth.uid() OR EXISTS (
        SELECT 1 FROM event_roles WHERE event_id = events.id AND user_id = auth.uid() AND role IN ('host','co_host','moderator')
      ))
    )
  );

CREATE POLICY IF NOT EXISTS "event_join_requests_service_all" ON event_join_requests
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ── event_updates (pinned host updates) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_updates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  author_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body        TEXT NOT NULL CHECK (char_length(body) <= 1000),
  pinned      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_updates_event_idx ON event_updates(event_id, created_at DESC);

ALTER TABLE event_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "event_updates_public_read" ON event_updates
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM events WHERE id = event_updates.event_id
      AND state IN ('open','full','waitlist','started','completed')
    )
  );

CREATE POLICY IF NOT EXISTS "event_updates_service_all" ON event_updates
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ── event_reviews ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  reviewer_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rating       SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body         TEXT CHECK (char_length(body) <= 1000),
  anonymous    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, reviewer_id)
);

CREATE INDEX IF NOT EXISTS event_reviews_event_idx ON event_reviews(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS event_reviews_reviewer_idx ON event_reviews(reviewer_id);

ALTER TABLE event_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "event_reviews_public_read" ON event_reviews
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM events WHERE id = event_reviews.event_id
      AND state IN ('completed', 'archived')
    )
  );

CREATE POLICY IF NOT EXISTS "event_reviews_own_write" ON event_reviews
  FOR ALL TO authenticated USING (reviewer_id = auth.uid()) WITH CHECK (reviewer_id = auth.uid());

CREATE POLICY IF NOT EXISTS "event_reviews_service_all" ON event_reviews
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- Add review aggregation columns to events (idempotent)
ALTER TABLE events ADD COLUMN IF NOT EXISTS avg_rating  NUMERIC(3,1);
ALTER TABLE events ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0;

-- ── Feature flag seed ─────────────────────────────────────────────────────────

INSERT INTO feature_flags (flag, enabled, description)
VALUES
  ('events_enabled',            TRUE,  'Master switch for the Events system'),
  ('events_waitlist_enabled',   TRUE,  'Auto-promote waitlist on RSVP cancellation'),
  ('events_chat_enabled',       TRUE,  'Telegraph chat wiring for events'),
  ('events_trust_gates_enabled',TRUE,  'Enforce trust score / age / verified-only gates on RSVP')
ON CONFLICT (flag) DO NOTHING;
