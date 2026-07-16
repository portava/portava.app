-- 0139_geocode_cache_corrected_at.sql
-- Add corrected_at column to city_country_geocode_cache so that admin
-- corrections propagate to all server instances without a restart.
--
-- When an admin overwrites a row via PUT /admin/geocode-cache/:city_key the
-- endpoint sets corrected_at = now(). On the next cache read any instance
-- whose in-memory entry pre-dates corrected_at knows its copy is stale and
-- evicts it, forcing a fresh resolve from the DB.

ALTER TABLE city_country_geocode_cache
  ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ;
