-- 0135_rent_buddy_meetup_base_coords.sql
-- Approximate meetup-base coordinates for buddy profiles.
-- Buddies may pin a neighbourhood-level point (their preferred meetup base)
-- so search distance chips measure to their actual meetup area rather than
-- the city centre. Privacy: these are approximate, buddy-chosen coordinates —
-- never a home address; both columns are nullable and optional.

ALTER TABLE rent_buddy_profiles
  ADD COLUMN IF NOT EXISTS meetup_base_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS meetup_base_lng DOUBLE PRECISION;

-- Keep any stored values in valid coordinate ranges.
ALTER TABLE rent_buddy_profiles
  DROP CONSTRAINT IF EXISTS rent_buddy_profiles_meetup_base_lat_check;
ALTER TABLE rent_buddy_profiles
  ADD CONSTRAINT rent_buddy_profiles_meetup_base_lat_check
    CHECK (meetup_base_lat IS NULL OR (meetup_base_lat >= -90 AND meetup_base_lat <= 90));
ALTER TABLE rent_buddy_profiles
  DROP CONSTRAINT IF EXISTS rent_buddy_profiles_meetup_base_lng_check;
ALTER TABLE rent_buddy_profiles
  ADD CONSTRAINT rent_buddy_profiles_meetup_base_lng_check
    CHECK (meetup_base_lng IS NULL OR (meetup_base_lng >= -180 AND meetup_base_lng <= 180));
