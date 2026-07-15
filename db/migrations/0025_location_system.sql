-- ============================================================
-- 0025 — app-wide location system
-- user_location_state: per-user GPS / manual-city state
-- passport_stamps_gps: GPS-earned city/activity stamps
-- postcards: location stamp columns
-- ============================================================

-- ── user_location_state ──────────────────────────────────
CREATE TABLE IF NOT EXISTS user_location_state (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  permission_status   text        NULL,
  source              text        NULL,
  lat                 numeric     NULL,
  lng                 numeric     NULL,
  accuracy_meters     numeric     NULL,
  city                text        NULL,
  district            text        NULL,
  country             text        NULL,
  country_code        text        NULL,
  formatted_location  text        NULL,
  last_known_at       timestamptz NULL,
  manual_city         text        NULL,
  manual_country      text        NULL,
  manual_selected_at  timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_location_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_location_state: own row only"
  ON user_location_state
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── passport_stamps_gps ───────────────────────────────────
-- Separate from the gamification stamps table; these are GPS/activity earned.
CREATE TABLE IF NOT EXISTS passport_stamps_gps (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stamp_type            text        NOT NULL,  -- city_visit | postcard_created | hidden_gem_shared | food_spot_shared | trip_checkin | highlight_shared
  city                  text        NULL,
  district              text        NULL,
  country               text        NULL,
  country_code          text        NULL,
  lat                   numeric     NULL,
  lng                   numeric     NULL,
  source                text        NOT NULL DEFAULT 'gps',  -- gps | manual | trip_context
  related_postcard_id   uuid        NULL,
  related_trip_id       uuid        NULL,
  unlocked_at           timestamptz NOT NULL DEFAULT now(),
  metadata              jsonb       NULL,
  UNIQUE (user_id, stamp_type, country_code, city)
);

ALTER TABLE passport_stamps_gps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "passport_stamps_gps: own row read"
  ON passport_stamps_gps
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "passport_stamps_gps: own row write"
  ON passport_stamps_gps
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS passport_stamps_gps_user_idx
  ON passport_stamps_gps (user_id, unlocked_at DESC);

-- ── postcards: location stamp columns ────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'postcards'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'postcards'
        AND column_name = 'location_source'
    ) THEN
      ALTER TABLE postcards ADD COLUMN location_source  text        NULL;
      ALTER TABLE postcards ADD COLUMN stamp_city       text        NULL;
      ALTER TABLE postcards ADD COLUMN stamp_country    text        NULL;
      ALTER TABLE postcards ADD COLUMN stamp_label      text        NULL;
      ALTER TABLE postcards ADD COLUMN stamp_unlocked_at timestamptz NULL;
    END IF;
  END IF;
END $$;
