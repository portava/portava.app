-- Migration 0036: pulse_geo_tags
-- Location context tags attached to Pulse posts.

CREATE TABLE IF NOT EXISTS pulse_geo_tags (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         uuid        REFERENCES posts(id) ON DELETE CASCADE,
  geo_zone_id     uuid        REFERENCES geo_zones(id) ON DELETE CASCADE,
  tag_type        text        NOT NULL
                  CHECK (tag_type IN ('city', 'venue', 'neighborhood', 'country')),
  display_label   text,
  confidence_score numeric(4,3),
  source          text        NOT NULL DEFAULT 'gps'
                  CHECK (source IN ('gps', 'manual', 'inferred')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pulse_geo_tags ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS pulse_geo_tags_post_idx ON pulse_geo_tags(post_id);
CREATE INDEX IF NOT EXISTS pulse_geo_tags_zone_idx ON pulse_geo_tags(geo_zone_id);

CREATE POLICY "pulse_geo_tags_public_read" ON pulse_geo_tags
  FOR SELECT USING (true);

CREATE POLICY "pulse_geo_tags_service_write" ON pulse_geo_tags
  FOR ALL TO service_role USING (true);
