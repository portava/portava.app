-- Migration 0032: user_location_preferences
-- Five location modes + per-feature visibility overrides + pause flag
-- Safe to re-run: IF NOT EXISTS throughout

CREATE TABLE IF NOT EXISTS user_location_preferences (
  user_id                 UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- off | city_only | nearby | live_during_activity | trusted_circle_live
  location_mode           TEXT        NOT NULL DEFAULT 'city_only',
  sharing_paused          BOOLEAN     NOT NULL DEFAULT FALSE,
  -- per-feature overrides: null = inherit from location_mode
  pulse_visibility        TEXT,   -- city_only | neighborhood | venue_tagged | exact_hidden | no_location
  discovery_visibility    TEXT,   -- same enum
  safe_return_enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  -- trusted circle live share
  trusted_circle_share    BOOLEAN     NOT NULL DEFAULT FALSE,
  -- hotel/home proximity blur: post within ~200m of private_stay auto-caps at neighborhood
  hotel_blur_enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ulp_user_idx ON user_location_preferences (user_id);

ALTER TABLE user_location_preferences ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_location_preferences' AND policyname='ulp_select_own') THEN
    CREATE POLICY ulp_select_own ON user_location_preferences FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_location_preferences' AND policyname='ulp_insert_own') THEN
    CREATE POLICY ulp_insert_own ON user_location_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_location_preferences' AND policyname='ulp_update_own') THEN
    CREATE POLICY ulp_update_own ON user_location_preferences FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;
