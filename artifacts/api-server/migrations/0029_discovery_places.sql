-- Migration 0029: discovery_places
-- Community-submitted places for the Discovery screen.
-- Stores hidden gems and traveler picks with submitter attribution.
-- GET /api/discovery/community joins this table with profiles to resolve
-- submitted_by into real name + avatar so HighlightRing can fire.

CREATE TABLE IF NOT EXISTS discovery_places (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  city         text         NOT NULL,
  name         text         NOT NULL,
  place_type   text         NOT NULL DEFAULT 'hidden_gem',
  category     text         NOT NULL DEFAULT 'hidden_gem',
  neighborhood text,
  blurb        text,
  image_url    text,
  submitted_by uuid         REFERENCES profiles(id) ON DELETE SET NULL,
  saved_count  integer      NOT NULL DEFAULT 0,
  tag          text,
  note         text,
  rating       numeric(3,1),
  source       text         NOT NULL DEFAULT 'traveler',
  status       text         NOT NULL DEFAULT 'provisional',
  verified     boolean      NOT NULL DEFAULT false,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_places_city_idx
  ON discovery_places(lower(city));

CREATE INDEX IF NOT EXISTS discovery_places_place_type_idx
  ON discovery_places(place_type);

CREATE INDEX IF NOT EXISTS discovery_places_created_at_idx
  ON discovery_places(created_at DESC);

ALTER TABLE discovery_places ENABLE ROW LEVEL SECURITY;

CREATE POLICY "discovery_places_public_read"
  ON discovery_places FOR SELECT
  USING (true);

CREATE POLICY "discovery_places_auth_insert"
  ON discovery_places FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL AND submitted_by = auth.uid());

CREATE POLICY "discovery_places_owner_update"
  ON discovery_places FOR UPDATE
  USING (submitted_by = auth.uid());

CREATE POLICY "discovery_places_owner_delete"
  ON discovery_places FOR DELETE
  USING (submitted_by = auth.uid());
