-- 0130_rent_buddy_place_coords.sql
-- Carry picked-city coordinates into open buddy requests and the waitlist.
-- Adds lat/lng to rent_buddy_waitlist and (if present) rent_buddy_requests so
-- entries created from a canonical picked place keep coordinates for
-- proximity-aware matching and notifications.

ALTER TABLE rent_buddy_waitlist
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;

-- rent_buddy_requests is created by 0048_rent_buddy_marketplace.sql, which may
-- not be applied yet in every environment. That migration's CREATE TABLE now
-- includes lat/lng, so we only need to patch environments where the table
-- already exists.
ALTER TABLE IF EXISTS rent_buddy_requests
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
