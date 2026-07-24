-- Migration 2031: add photos array to discovery_places
--
-- The community place submission form now supports up to 3 optional photos.
-- Photos are stored as an array of CDN URLs. image_url (existing) remains
-- the primary/representative photo used by existing surfaces; photos holds
-- the full submitted set.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS.

ALTER TABLE discovery_places
  ADD COLUMN IF NOT EXISTS photos text[] DEFAULT NULL;
