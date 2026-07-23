-- Migration 0173: Neighborhood Match v1 (OSM-based)
--
-- Adds:
--   neighborhood_areas    — per-city cached neighborhood centroids with
--                           OSM-density-derived category scores (nightlife,
--                           food, culture, shopping, quiet), POI counts,
--                           day/night character, sample size and confidence.
--   trip_area_preferences — per-member "where should I stay" preferences
--                           (sleep-vs-play + category priority weights).
--
-- Scores are DERIVED from OpenStreetMap POI density only — they are labelled
-- with sample_size + confidence so clients can present them honestly.
--
-- Safe to re-run: IF NOT EXISTS / DO $$ policy guards / ON CONFLICT DO NOTHING
-- throughout (style of 0167_safety_ddl_reconcile.sql).

-- ── neighborhood_areas ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS neighborhood_areas (
  id              UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  city_name       TEXT             NOT NULL,
  country         TEXT             NULL,
  name            TEXT             NOT NULL,
  center_lat      DOUBLE PRECISION NOT NULL,
  center_lng      DOUBLE PRECISION NOT NULL,
  radius_m        INT              NOT NULL DEFAULT 1200,
  source          TEXT             NOT NULL CHECK (source IN ('osm', 'grid')),
  -- { nightlife: 0-100, food: 0-100, culture: 0-100, shopping: 0-100, quiet: 0-100 }
  category_scores JSONB            NOT NULL DEFAULT '{}',
  -- raw assigned-POI counts per category (the evidence behind the scores)
  poi_counts      JSONB            NOT NULL DEFAULT '{}',
  -- { day: 'lively'|'moderate'|'quieter', night: 'lively'|'moderate'|'quieter' }
  day_night       JSONB            NOT NULL DEFAULT '{}',
  sample_size     INT              NOT NULL DEFAULT 0,
  confidence      TEXT             NOT NULL DEFAULT 'low'
    CHECK (confidence IN ('low', 'medium', 'high')),
  computed_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ      NOT NULL DEFAULT now(),
  UNIQUE (city_name, name)
);

CREATE INDEX IF NOT EXISTS neighborhood_areas_city_idx ON neighborhood_areas (city_name);

ALTER TABLE neighborhood_areas ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'neighborhood_areas' AND policyname = 'na_read_authenticated'
  ) THEN
    -- Derived from public OSM data; readable by any signed-in user.
    CREATE POLICY na_read_authenticated ON neighborhood_areas
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'neighborhood_areas' AND policyname = 'na_svc'
  ) THEN
    CREATE POLICY na_svc ON neighborhood_areas
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── trip_area_preferences ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trip_area_preferences (
  trip_id       UUID        NOT NULL REFERENCES trips(id)      ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- stay inside the action, close to it, or away from it
  sleep_vs_play TEXT        NULL CHECK (sleep_vs_play IN ('inside', 'close', 'away')),
  -- { nightlife?: 0-1, food?: 0-1, culture?: 0-1, shopping?: 0-1, quiet?: 0-1 }
  priorities    JSONB       NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (trip_id, user_id)
);

ALTER TABLE trip_area_preferences ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_area_preferences' AND policyname = 'tap_own'
  ) THEN
    CREATE POLICY tap_own ON trip_area_preferences USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_area_preferences' AND policyname = 'tap_svc'
  ) THEN
    CREATE POLICY tap_svc ON trip_area_preferences
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── Feature flag ──────────────────────────────────────────────────────────────
-- NOTE: the feature_flags PK column is `flag` (see 0166_feature_flags_reconcile).

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('neighborhood_match_enabled', false, 'Neighborhood categorization + personalized area ranking')
ON CONFLICT (flag) DO NOTHING;
