-- Migration 2051: add canonical_location_id to discovery_places
--
-- discovery_places is the denormalized search/browse cache for places.  The
-- canonical Living Destination Page (places.id) can be linked here so that
-- search results can surface a direct route to /place/:id without a separate
-- lookup.  NULL means no canonical page exists yet for that discovery entry.

ALTER TABLE discovery_places
  ADD COLUMN IF NOT EXISTS canonical_location_id UUID
    REFERENCES places(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS discovery_places_canonical_location_idx
  ON discovery_places (canonical_location_id)
  WHERE canonical_location_id IS NOT NULL;
