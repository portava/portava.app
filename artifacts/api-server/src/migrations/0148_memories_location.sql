-- 0148: Memory location tagging.
-- Nullable location columns on memories, matching the posts table's shape
-- (city/country display strings, coarse coordinates, canonical registry id).
-- memories.place_id (text, provider place reference) already exists.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS location_city text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS location_country text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS location_lat numeric;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS location_lng numeric;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS canonical_location_id uuid;
