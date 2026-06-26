-- Migration 0029: discovery_places
-- Community-submitted travel places shown in the Discovery tab.

CREATE TABLE IF NOT EXISTS discovery_places (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  city          text        NOT NULL,
  name          text        NOT NULL,
  place_type    text        NOT NULL,
  category      text,
  neighborhood  text,
  blurb         text,
  image_url     text,
  submitted_by  uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  saved_count   integer     NOT NULL DEFAULT 0,
  tag           text,
  note          text,
  rating        numeric(3,1),
  source        text,
  status        text        NOT NULL DEFAULT 'active',
  verified      boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_places ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS discovery_places_city_idx       ON discovery_places(city);
CREATE INDEX IF NOT EXISTS discovery_places_place_type_idx ON discovery_places(place_type);
CREATE INDEX IF NOT EXISTS discovery_places_created_at_idx ON discovery_places(created_at);

CREATE POLICY "discovery_places_public_read" ON discovery_places
  FOR SELECT USING (true);

CREATE POLICY "discovery_places_auth_insert" ON discovery_places
  FOR INSERT WITH CHECK (auth.uid() = submitted_by);

CREATE POLICY "discovery_places_own_update" ON discovery_places
  FOR UPDATE USING (auth.uid() = submitted_by);

CREATE POLICY "discovery_places_own_delete" ON discovery_places
  FOR DELETE USING (auth.uid() = submitted_by);

CREATE POLICY "discovery_places_service" ON discovery_places
  FOR ALL TO service_role USING (true);
