-- Migration 0036: pulse_geo_tags
-- Location-visibility metadata for Pulse posts
-- Safe to re-run: IF NOT EXISTS throughout

CREATE TABLE IF NOT EXISTS pulse_geo_tags (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id               UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id               UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- city_only | neighborhood | venue_tagged | exact_hidden | no_location
  location_visibility   TEXT        NOT NULL DEFAULT 'city_only',
  -- public labels only — no exact coords
  city                  TEXT,
  district              TEXT,
  country               TEXT,
  country_code          TEXT,
  venue_name            TEXT,
  -- approximate distance bucket for "nearby" context (set server-side)
  approx_distance_label TEXT,
  -- hotel_blur applied?
  hotel_blur_applied    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pgt_post_uniq ON pulse_geo_tags (post_id);
CREATE INDEX IF NOT EXISTS pgt_user_idx         ON pulse_geo_tags (user_id);
CREATE INDEX IF NOT EXISTS pgt_city_idx         ON pulse_geo_tags (city);

ALTER TABLE pulse_geo_tags ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pulse_geo_tags' AND policyname='pgt_select_all') THEN
    CREATE POLICY pgt_select_all ON pulse_geo_tags FOR SELECT USING (TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pulse_geo_tags' AND policyname='pgt_insert_own') THEN
    CREATE POLICY pgt_insert_own ON pulse_geo_tags FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pulse_geo_tags' AND policyname='pgt_update_own') THEN
    CREATE POLICY pgt_update_own ON pulse_geo_tags FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pulse_geo_tags' AND policyname='pgt_delete_own') THEN
    CREATE POLICY pgt_delete_own ON pulse_geo_tags FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;
