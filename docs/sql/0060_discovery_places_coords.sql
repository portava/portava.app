-- ============================================================
-- Migration 0060 — discovery_places lat/lng columns
--
-- Adds lat and lng to community-submitted places so they can
-- appear on DiscoveryMapView alongside OSM results.
--
-- Apply BEFORE running seed-discovery-places.ts --backfill-coords.
-- The seed script skips these columns if they're absent; run
-- --backfill-coords after applying this to fill in coordinates.
--
-- HOW TO APPLY: paste into Supabase SQL Editor → Run.
-- Fully idempotent (ADD COLUMN IF NOT EXISTS).
-- ============================================================

ALTER TABLE public.discovery_places
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;

-- Partial index: fast map-view query (only rows that have coords)
CREATE INDEX IF NOT EXISTS discovery_places_has_coords_idx
  ON public.discovery_places (city, place_type)
  WHERE lat IS NOT NULL AND lng IS NOT NULL;

-- ── Verification ──────────────────────────────────────────────
--
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name   = 'discovery_places'
--   AND column_name  IN ('lat', 'lng')
-- ORDER BY column_name;
--
-- Expected: 2 rows (lat double precision, lng double precision)
