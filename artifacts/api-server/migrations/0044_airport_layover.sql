-- Migration 0044: Airport / Layover Mode
-- Tables: airport_profiles, layover_sessions, layover_recommendations, layover_events
-- Safe to re-run: IF NOT EXISTS throughout

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
  -- Terminal info (optional JSON blob)
  terminal_info             JSONB       DEFAULT '{}',
  -- Default buffer minutes per flight type
  domestic_buffer_min       INTEGER     NOT NULL DEFAULT 60,
  domestic_buffer_max       INTEGER     NOT NULL DEFAULT 90,
  international_buffer_min  INTEGER     NOT NULL DEFAULT 120,
  international_buffer_max  INTEGER     NOT NULL DEFAULT 180,
  -- Extra buffer defaults
  immigration_extra_min     INTEGER     NOT NULL DEFAULT 30,
  checked_bags_extra_min    INTEGER     NOT NULL DEFAULT 15,
  traffic_extra_min         INTEGER     NOT NULL DEFAULT 20,
  -- Meta
  verified                  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_by                UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS airport_profiles_city_idx ON airport_profiles(city);
CREATE INDEX IF NOT EXISTS airport_profiles_country_idx ON airport_profiles(country_code);

-- RLS: public read, service-role manages
ALTER TABLE airport_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "airport_profiles_read" ON airport_profiles;
CREATE POLICY "airport_profiles_read"
  ON airport_profiles FOR SELECT TO authenticated USING (TRUE);

-- ── layover_sessions ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layover_sessions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  airport_id          UUID        REFERENCES airport_profiles(id) ON DELETE SET NULL,
  -- Optional trip linkage
  trip_id             UUID        REFERENCES trips(id) ON DELETE SET NULL,
  -- Time window
  arrival_time        TIMESTAMPTZ NOT NULL,
  departure_time      TIMESTAMPTZ NOT NULL,
  boarding_time       TIMESTAMPTZ,
  layover_minutes     INTEGER     GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (departure_time - arrival_time)) / 60
  ) STORED,
  -- Flight type
  flight_type         TEXT        NOT NULL DEFAULT 'domestic'
                        CHECK (flight_type IN ('domestic','international')),
  -- Options
  immigration_required BOOLEAN    NOT NULL DEFAULT FALSE,
  checked_bags        BOOLEAN     NOT NULL DEFAULT FALSE,
  lounge_access       BOOLEAN     NOT NULL DEFAULT FALSE,
  wants_to_leave      BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Preferences
  comfort_level       TEXT        NOT NULL DEFAULT 'moderate'
                        CHECK (comfort_level IN ('safe_only','moderate','adventurous')),
  vibe_chips          TEXT[]      NOT NULL DEFAULT '{}',
  -- Manual airport override (when airport_id not found)
  manual_airport_name TEXT,
  manual_city         TEXT,
  manual_country      TEXT,
  manual_iata         TEXT,
  -- Status
  status              TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','completed','cancelled','expired')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS layover_sessions_user_status_idx ON layover_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS layover_sessions_departure_idx ON layover_sessions(departure_time);

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
  -- Category
  rec_type          TEXT        NOT NULL
                      CHECK (rec_type IN (
                        'inside_airport','near_airport','food','rest',
                        'quick_city_escape','meetup','hidden_gem','activity',
                        'nightlife'
                      )),
  title             TEXT        NOT NULL,
  description       TEXT,
  -- References (optional)
  place_id          UUID,
  plan_item_id      UUID,
  -- Safety rating
  safety_rating     TEXT        NOT NULL DEFAULT 'safe'
                      CHECK (safety_rating IN (
                        'safe','possible_but_risky','not_recommended','airport_only'
                      )),
  -- Time breakdown (minutes)
  travel_time_min   INTEGER     NOT NULL DEFAULT 0,
  activity_time_min INTEGER     NOT NULL DEFAULT 30,
  return_buffer_min INTEGER     NOT NULL DEFAULT 90,
  -- Hard return deadline (UTC)
  hard_return_time  TIMESTAMPTZ,
  -- Warning when risky
  warning_reason    TEXT,
  -- Is inside the airport (no travel time needed)
  inside_airport    BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Privacy: no exact coords stored here
  location_label    TEXT,
  city              TEXT,
  neighborhood      TEXT,
  -- Order for display
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
                  'return_deadline_set','safe_return_suggested',
                  'passport_seam_emitted','telegraph_suggestion_sent'
                )),
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS layover_events_session_idx ON layover_events(session_id);
CREATE INDEX IF NOT EXISTS layover_events_user_idx ON layover_events(user_id, created_at DESC);

ALTER TABLE layover_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "layover_events_owner" ON layover_events;
CREATE POLICY "layover_events_owner"
  ON layover_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ── feature flags ─────────────────────────────────────────────────────────────

INSERT INTO feature_flags (key, enabled, description) VALUES
  ('airport_mode_enabled',          FALSE, 'Master gate for Airport/Layover Mode'),
  ('layover_safety_engine_enabled', FALSE, 'Layover Safety Engine scoring'),
  ('airport_pulse_enabled',         FALSE, 'Airport Pulse tab in City Pulse'),
  ('layover_plans_enabled',         FALSE, 'Layover plan creation from session'),
  ('layover_compass_enabled',       FALSE, 'Compass AI layover-context answers')
ON CONFLICT (key) DO NOTHING;
