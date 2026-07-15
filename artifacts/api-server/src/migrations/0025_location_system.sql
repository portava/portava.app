-- Migration: 0025_location_system.sql
-- Creates user_location_state and passport_stamps_gps tables.

CREATE TABLE IF NOT EXISTS user_location_state (
  user_id        uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  latitude       double precision,
  longitude      double precision,
  accuracy       double precision,
  city           text,
  country        text,
  location_source text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_location_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_location" ON user_location_state
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


CREATE TABLE IF NOT EXISTS passport_stamps_gps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stamp_type   text NOT NULL,
  country      text,
  city         text,
  latitude     double precision,
  longitude    double precision,
  unlocked_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stamps_gps_unique UNIQUE (user_id, stamp_type, country, city)
);

ALTER TABLE passport_stamps_gps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_view_own_gps_stamps" ON passport_stamps_gps
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_gps_stamp" ON passport_stamps_gps
  FOR INSERT WITH CHECK (auth.uid() = user_id);
