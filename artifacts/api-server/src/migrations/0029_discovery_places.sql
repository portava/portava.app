-- Migration: 0029_discovery_places.sql
-- Creates discovery_places table for community-submitted places.

CREATE TABLE IF NOT EXISTS discovery_places (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city          text NOT NULL,
  name          text NOT NULL,
  place_type    text NOT NULL,
  category      text,
  neighborhood  text,
  blurb         text,
  image_url     text,
  submitted_by  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  saved_count   integer NOT NULL DEFAULT 0,
  tag           text,
  note          text,
  rating        numeric(3,1),
  source        text,
  status        text NOT NULL DEFAULT 'active',
  verified      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_places_city_idx       ON discovery_places(city);
CREATE INDEX IF NOT EXISTS discovery_places_type_idx       ON discovery_places(place_type);
CREATE INDEX IF NOT EXISTS discovery_places_created_at_idx ON discovery_places(created_at);

ALTER TABLE discovery_places ENABLE ROW LEVEL SECURITY;

CREATE POLICY "discovery_places_public_read" ON discovery_places
  FOR SELECT USING (status = 'active');

CREATE POLICY "discovery_places_auth_insert" ON discovery_places
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "discovery_places_owner_update" ON discovery_places
  FOR UPDATE USING (auth.uid() = submitted_by);

CREATE POLICY "discovery_places_owner_delete" ON discovery_places
  FOR DELETE USING (auth.uid() = submitted_by);
