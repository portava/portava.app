-- Migration: 0032_location_preferences.sql
-- Creates location_preferences table for per-user location sharing preferences.

CREATE TYPE IF NOT EXISTS location_mode_enum AS ENUM (
  'off', 'city_only', 'neighborhood', 'precise'
);

CREATE TYPE IF NOT EXISTS visibility_enum AS ENUM (
  'public', 'circle_only', 'trip_only', 'none'
);

CREATE TABLE IF NOT EXISTS location_preferences (
  user_id                 uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  location_mode           location_mode_enum NOT NULL DEFAULT 'city_only',
  sharing_paused          boolean NOT NULL DEFAULT false,
  pulse_visibility        visibility_enum NOT NULL DEFAULT 'public',
  discovery_visibility    visibility_enum NOT NULL DEFAULT 'circle_only',
  safe_return_enabled     boolean NOT NULL DEFAULT false,
  trusted_circle_share    boolean NOT NULL DEFAULT true,
  hotel_blur_enabled      boolean NOT NULL DEFAULT true,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE location_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_location_prefs" ON location_preferences
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
