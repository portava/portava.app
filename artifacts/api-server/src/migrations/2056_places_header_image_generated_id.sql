-- Migration 2056: add header_image_generated_id to places
--
-- Links each canonical place to the generated_visuals row that is currently
-- serving as its header/cover image.  The column is written by the place-image
-- generation pipeline (src/lib/visuals/service.ts) and read by the admin
-- place-images route (src/routes/adminPlaceImages.ts) for pinning/unpinning
-- the active visual.
--
-- NULL means no generated visual has been assigned yet (places fall back to
-- provider imagery until one is generated and approved).
--
-- ON DELETE SET NULL: if the visual is deleted (e.g. a failed generation is
-- purged), the place gracefully loses its link rather than cascading to the
-- place row.

ALTER TABLE places
  ADD COLUMN IF NOT EXISTS header_image_generated_id UUID
    REFERENCES generated_visuals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_places_header_image_generated_id
  ON places (header_image_generated_id)
  WHERE header_image_generated_id IS NOT NULL;
