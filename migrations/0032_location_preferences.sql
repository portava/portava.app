-- Migration 0032: location_preferences
-- Per-user location sharing and privacy preferences.

CREATE TABLE IF NOT EXISTS location_preferences (
  user_id               uuid        PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  location_mode         text        NOT NULL DEFAULT 'city'
                        CHECK (location_mode IN ('precise', 'city', 'off')),
  sharing_paused        boolean     NOT NULL DEFAULT false,
  pulse_visibility      text        NOT NULL DEFAULT 'everyone'
                        CHECK (pulse_visibility IN ('everyone', 'circle', 'trip_members', 'nobody')),
  discovery_visibility  text        NOT NULL DEFAULT 'everyone'
                        CHECK (discovery_visibility IN ('everyone', 'circle', 'trip_members', 'nobody')),
  safe_return_enabled   boolean     NOT NULL DEFAULT false,
  trusted_circle_share  boolean     NOT NULL DEFAULT true,
  hotel_blur_enabled    boolean     NOT NULL DEFAULT true,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE location_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "location_prefs_own" ON location_preferences
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "location_prefs_service" ON location_preferences
  FOR ALL TO service_role USING (true);
