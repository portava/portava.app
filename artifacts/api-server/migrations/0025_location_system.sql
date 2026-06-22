-- Migration 0025: location system — user_location_state + passport_stamps_gps
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS

-- Per-user location state: upserted by the mobile app whenever GPS updates
CREATE TABLE IF NOT EXISTS user_location_state (
  user_id              UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  permission_status    TEXT,
  source               TEXT,
  lat                  DOUBLE PRECISION,
  lng                  DOUBLE PRECISION,
  accuracy_meters      DOUBLE PRECISION,
  last_known_at        TIMESTAMPTZ,
  city                 TEXT,
  district             TEXT,
  country              TEXT,
  country_code         TEXT,
  formatted_location   TEXT,
  manual_city          TEXT,
  manual_country       TEXT,
  manual_selected_at   TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_location_state_updated_idx ON user_location_state (updated_at);

ALTER TABLE user_location_state ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_location_state' AND policyname='uls_select_own') THEN
    CREATE POLICY uls_select_own ON user_location_state FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_location_state' AND policyname='uls_insert_own') THEN
    CREATE POLICY uls_insert_own ON user_location_state FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_location_state' AND policyname='uls_update_own') THEN
    CREATE POLICY uls_update_own ON user_location_state FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_location_state' AND policyname='uls_delete_own') THEN
    CREATE POLICY uls_delete_own ON user_location_state FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- GPS-earned passport stamps: one row per (user, stamp_type, country_code, city)
CREATE TABLE IF NOT EXISTS passport_stamps_gps (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stamp_type           TEXT        NOT NULL,
  city                 TEXT,
  district             TEXT,
  country              TEXT,
  country_code         TEXT,
  lat                  DOUBLE PRECISION,
  lng                  DOUBLE PRECISION,
  source               TEXT        NOT NULL DEFAULT 'gps',
  unlocked_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  related_postcard_id  UUID,
  related_trip_id      UUID,
  metadata             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, stamp_type, country_code, city)
);

CREATE INDEX IF NOT EXISTS passport_stamps_gps_user_idx ON passport_stamps_gps (user_id);
CREATE INDEX IF NOT EXISTS passport_stamps_gps_unlocked_idx ON passport_stamps_gps (unlocked_at);

ALTER TABLE passport_stamps_gps ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='passport_stamps_gps' AND policyname='psg_select_own') THEN
    CREATE POLICY psg_select_own ON passport_stamps_gps FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='passport_stamps_gps' AND policyname='psg_insert_own') THEN
    CREATE POLICY psg_insert_own ON passport_stamps_gps FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='passport_stamps_gps' AND policyname='psg_update_own') THEN
    CREATE POLICY psg_update_own ON passport_stamps_gps FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;

-- postcards: add location_source column if postcards table exists
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='postcards') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='postcards' AND column_name='location_source') THEN
      ALTER TABLE postcards ADD COLUMN location_source TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='postcards' AND column_name='stamp_city') THEN
      ALTER TABLE postcards ADD COLUMN stamp_city TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='postcards' AND column_name='stamp_country') THEN
      ALTER TABLE postcards ADD COLUMN stamp_country TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='postcards' AND column_name='stamp_label') THEN
      ALTER TABLE postcards ADD COLUMN stamp_label TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='postcards' AND column_name='stamp_unlocked_at') THEN
      ALTER TABLE postcards ADD COLUMN stamp_unlocked_at TIMESTAMPTZ;
    END IF;
  END IF;
END $$;
