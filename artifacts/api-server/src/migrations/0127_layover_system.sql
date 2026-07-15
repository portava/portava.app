-- Migration 0127: Layover System (repair + completion)
-- The original 0044_airport_layover.sql lived only in the stale migrations dir and
-- was never applied: none of the layover tables exist in the live database and its
-- feature-flag seed used a nonexistent `key` column. This migration recreates the
-- full system with the fixes and extensions for the completed Layover experience:
--   * airport_profiles           — curated airport intelligence (+ canonical link)
--   * layover_sessions           — user layover windows (+ canonical city, sharing,
--                                  reminder timestamp)
--   * layover_recommendations    — generated suggestion cards
--   * layover_plan_stops         — NEW: mini-itinerary stops per session
--   * layover_events             — audit trail
--   * feature flag seeds         — correct `flag` column, enabled
-- Safe to re-run: IF NOT EXISTS / ON CONFLICT throughout.

-- ── airport_profiles ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS airport_profiles (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  iata_code                 TEXT        NOT NULL UNIQUE,
  name                      TEXT        NOT NULL,
  city                      TEXT        NOT NULL,
  country                   TEXT        NOT NULL,
  country_code              TEXT        NOT NULL,
  timezone                  TEXT        NOT NULL DEFAULT 'UTC',
  lat                       NUMERIC(10,7) NOT NULL DEFAULT 0,
  lng                       NUMERIC(10,7) NOT NULL DEFAULT 0,
  terminal_info             JSONB       DEFAULT '{}',
  domestic_buffer_min       INTEGER     NOT NULL DEFAULT 60,
  domestic_buffer_max       INTEGER     NOT NULL DEFAULT 90,
  international_buffer_min  INTEGER     NOT NULL DEFAULT 120,
  international_buffer_max  INTEGER     NOT NULL DEFAULT 180,
  immigration_extra_min     INTEGER     NOT NULL DEFAULT 30,
  checked_bags_extra_min    INTEGER     NOT NULL DEFAULT 15,
  traffic_extra_min         INTEGER     NOT NULL DEFAULT 20,
  -- Bridge into the universal location system
  canonical_location_id     UUID        REFERENCES canonical_locations(id) ON DELETE SET NULL,
  verified                  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_by                UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS airport_profiles_city_idx    ON airport_profiles(city);
CREATE INDEX IF NOT EXISTS airport_profiles_country_idx ON airport_profiles(country_code);

ALTER TABLE airport_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "airport_profiles_read" ON airport_profiles;
CREATE POLICY "airport_profiles_read"
  ON airport_profiles FOR SELECT TO authenticated USING (TRUE);

-- ── layover_sessions ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layover_sessions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  airport_id          UUID        REFERENCES airport_profiles(id) ON DELETE SET NULL,
  trip_id             UUID        REFERENCES trips(id) ON DELETE SET NULL,
  -- Universal location bridge: canonical city row for the airport's city
  canonical_city_id   UUID        REFERENCES canonical_locations(id) ON DELETE SET NULL,
  -- Time window (UTC instants; airport-local wall times converted server-side)
  arrival_time        TIMESTAMPTZ NOT NULL,
  departure_time      TIMESTAMPTZ NOT NULL,
  boarding_time       TIMESTAMPTZ,
  layover_minutes     INTEGER     GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (departure_time - arrival_time)) / 60
  ) STORED,
  flight_type         TEXT        NOT NULL DEFAULT 'domestic'
                        CHECK (flight_type IN ('domestic','international')),
  immigration_required BOOLEAN    NOT NULL DEFAULT FALSE,
  checked_bags        BOOLEAN     NOT NULL DEFAULT FALSE,
  lounge_access       BOOLEAN     NOT NULL DEFAULT FALSE,
  wants_to_leave      BOOLEAN     NOT NULL DEFAULT TRUE,
  comfort_level       TEXT        NOT NULL DEFAULT 'moderate'
                        CHECK (comfort_level IN ('safe_only','moderate','adventurous')),
  vibe_chips          TEXT[]      NOT NULL DEFAULT '{}',
  -- Manual airport fallback (legacy path when no profile row could be created)
  manual_airport_name TEXT,
  manual_city         TEXT,
  manual_country      TEXT,
  manual_iata         TEXT,
  -- Opt-in city-level social visibility ("On a layover in Tokyo")
  share_city_status   BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Return reminder the user asked for (UTC instant), if any
  return_reminder_at  TIMESTAMPTZ,
  status              TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','completed','cancelled','expired')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS layover_sessions_user_status_idx ON layover_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS layover_sessions_departure_idx   ON layover_sessions(departure_time);
-- Presence lookups: active + shared sessions per airport city
CREATE INDEX IF NOT EXISTS layover_sessions_share_idx
  ON layover_sessions(status, share_city_status) WHERE share_city_status = TRUE;

ALTER TABLE layover_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "layover_sessions_owner" ON layover_sessions;
CREATE POLICY "layover_sessions_owner"
  ON layover_sessions FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── layover_recommendations ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layover_recommendations (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID        NOT NULL REFERENCES layover_sessions(id) ON DELETE CASCADE,
  rec_type          TEXT        NOT NULL
                      CHECK (rec_type IN (
                        'inside_airport','near_airport','food','rest',
                        'quick_city_escape','meetup','hidden_gem','activity',
                        'nightlife'
                      )),
  title             TEXT        NOT NULL,
  description       TEXT,
  place_id          UUID,
  plan_item_id      UUID,
  safety_rating     TEXT        NOT NULL DEFAULT 'safe'
                      CHECK (safety_rating IN (
                        'safe','possible_but_risky','not_recommended','airport_only'
                      )),
  travel_time_min   INTEGER     NOT NULL DEFAULT 0,
  activity_time_min INTEGER     NOT NULL DEFAULT 30,
  return_buffer_min INTEGER     NOT NULL DEFAULT 90,
  hard_return_time  TIMESTAMPTZ,
  warning_reason    TEXT,
  inside_airport    BOOLEAN     NOT NULL DEFAULT FALSE,
  location_label    TEXT,
  city              TEXT,
  neighborhood      TEXT,
  status            TEXT        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'hidden', 'flagged')),
  source            TEXT        NOT NULL DEFAULT 'ai'
                      CHECK (source IN ('ai', 'user', 'admin')),
  sort_order        INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS layover_recs_session_idx ON layover_recommendations(session_id);

ALTER TABLE layover_recommendations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "layover_recs_owner" ON layover_recommendations;
CREATE POLICY "layover_recs_owner"
  ON layover_recommendations FOR ALL TO authenticated
  USING (
    session_id IN (
      SELECT id FROM layover_sessions WHERE user_id = auth.uid()
    )
  );

-- ── layover_plan_stops (NEW: mini-itinerary) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS layover_plan_stops (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID        NOT NULL REFERENCES layover_sessions(id) ON DELETE CASCADE,
  title           TEXT        NOT NULL,
  description     TEXT,
  stop_order      INTEGER     NOT NULL DEFAULT 0,
  duration_min    INTEGER     NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 720),
  travel_min      INTEGER     NOT NULL DEFAULT 0  CHECK (travel_min BETWEEN 0 AND 240),
  place_id        UUID,
  recommendation_id UUID      REFERENCES layover_recommendations(id) ON DELETE SET NULL,
  lat             NUMERIC(10,7),
  lng             NUMERIC(10,7),
  location_label  TEXT,
  inside_airport  BOOLEAN     NOT NULL DEFAULT FALSE,
  source          TEXT        NOT NULL DEFAULT 'user'
                    CHECK (source IN ('user','recommendation','ai')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS layover_plan_stops_session_idx
  ON layover_plan_stops(session_id, stop_order);

ALTER TABLE layover_plan_stops ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "layover_plan_stops_owner" ON layover_plan_stops;
CREATE POLICY "layover_plan_stops_owner"
  ON layover_plan_stops FOR ALL TO authenticated
  USING (
    session_id IN (
      SELECT id FROM layover_sessions WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    session_id IN (
      SELECT id FROM layover_sessions WHERE user_id = auth.uid()
    )
  );

-- ── layover_events ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layover_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID        NOT NULL REFERENCES layover_sessions(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL
                CHECK (event_type IN (
                  'session_created','session_updated','session_completed',
                  'session_cancelled','session_expired',
                  'recommendation_generated','recommendation_saved',
                  'compass_question_asked','plan_created',
                  'plan_stop_added','plan_stop_updated','plan_stop_removed',
                  'plan_reordered','share_toggled',
                  'return_deadline_set','safe_return_suggested',
                  'passport_seam_emitted','telegraph_suggestion_sent'
                )),
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS layover_events_session_idx ON layover_events(session_id);
CREATE INDEX IF NOT EXISTS layover_events_user_idx    ON layover_events(user_id, created_at DESC);

ALTER TABLE layover_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "layover_events_owner" ON layover_events;
CREATE POLICY "layover_events_owner"
  ON layover_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ── feature flags (correct column name; enabled) ──────────────────────────────

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('airport_mode_enabled',          TRUE, 'Master gate for Airport/Layover Mode'),
  ('layover_safety_engine_enabled', TRUE, 'Layover Safety Engine scoring'),
  ('airport_pulse_enabled',         TRUE, 'Airport Pulse tab in City Pulse'),
  ('layover_plans_enabled',         TRUE, 'Layover plan creation from session'),
  ('layover_compass_enabled',       TRUE, 'Compass AI layover-context answers')
ON CONFLICT (flag) DO UPDATE SET enabled = EXCLUDED.enabled, description = EXCLUDED.description;
