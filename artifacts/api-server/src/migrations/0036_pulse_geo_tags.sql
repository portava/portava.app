-- Migration: 0036_pulse_geo_tags.sql
-- Creates pulse_geo_tags for location context on pulse posts.

CREATE TYPE IF NOT EXISTS pulse_geo_tag_type AS ENUM (
  'venue', 'neighborhood', 'city', 'custom'
);

CREATE TYPE IF NOT EXISTS pulse_geo_source AS ENUM (
  'gps', 'manual', 'inferred'
);

CREATE TABLE IF NOT EXISTS pulse_geo_tags (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id          uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  geo_zone_id      uuid REFERENCES geo_zones(id) ON DELETE SET NULL,
  tag_type         pulse_geo_tag_type NOT NULL,
  display_label    text,
  confidence_score double precision,
  source           pulse_geo_source NOT NULL DEFAULT 'gps',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pulse_geo_tags_post_idx ON pulse_geo_tags(post_id);

ALTER TABLE pulse_geo_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pulse_geo_tags_public_read" ON pulse_geo_tags
  FOR SELECT USING (true);
