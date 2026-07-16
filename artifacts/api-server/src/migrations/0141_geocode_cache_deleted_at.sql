-- 0141_geocode_cache_deleted_at.sql
-- Adds a soft-delete tombstone column to city_country_geocode_cache so the
-- background correction sweep can propagate admin deletions to every instance
-- within one sweep cycle (≤ 5 minutes) — rather than waiting up to 30 days
-- for the TTL to expire on rarely-queried cities.
--
-- Flow:
--   1. Admin DELETE handler sets deleted_at = now() (soft delete, keeps the row).
--   2. Background sweep queries deleted_at >= since, evicts in-memory entries on
--      all instances, then hard-deletes the tombstoned rows (self-cleaning).
--   3. readDbCache treats rows with deleted_at set as "not found".
--   4. evictIfDbCorrected probe also evicts when deleted_at is set.

ALTER TABLE city_country_geocode_cache ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN city_country_geocode_cache.deleted_at IS
  'Set by the admin DELETE handler as a soft-delete tombstone. '
  'The background correction sweep finds rows with deleted_at >= sweep_window, '
  'evicts the corresponding in-memory cache entries on all instances, '
  'and then hard-deletes the tombstoned rows. NULL means the row is live.';

-- Partial index so the sweep query (deleted_at >= since WHERE deleted_at IS NOT NULL)
-- only scans the small set of tombstoned rows rather than the full table.
CREATE INDEX IF NOT EXISTS city_country_geocode_cache_deleted_at_idx
  ON city_country_geocode_cache (deleted_at)
  WHERE deleted_at IS NOT NULL;
