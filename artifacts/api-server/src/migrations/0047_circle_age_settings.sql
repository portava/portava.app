-- Migration: 0047_circle_age_settings.sql
-- Per-circle-owner age settings. One row per circle owner (PK = owner_id).

CREATE TABLE IF NOT EXISTS circle_age_settings (
  owner_id           uuid      PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  age_limit_enabled  boolean   NOT NULL DEFAULT false,
  min_age            integer,
  max_age            integer,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE circle_age_settings ENABLE ROW LEVEL SECURITY;

-- Owner can read and write their own row
CREATE POLICY "owner_read_own_age_settings" ON circle_age_settings
  FOR SELECT USING (auth.uid() = owner_id);

CREATE POLICY "owner_write_own_age_settings" ON circle_age_settings
  FOR ALL USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);
