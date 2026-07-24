-- Migration 0186: geo-column drift reconcile + spatial btree indexes
--
-- Phase 3 (#12) of the map audit: give the hot proximity tables real indexes so
-- lat/lng bounding-box scans stop being sequential. Today /map/travelers,
-- /events/nearby, /hidden-gems/nearby and the posts geofence watcher all filter
-- on lat/lng with NO supporting index (they survive only on row caps + freshness
-- filters). Only fsq_places had a (latitude,longitude) btree — this brings the
-- rest up to the same bar.
--
-- Two parts:
--   1. RECONCILE — the events/posts/user_location_state lat/lng columns exist in
--      the LIVE database but never entered src/migrations (schema drift), so they
--      could not carry migration-defined indexes. ADD COLUMN IF NOT EXISTS is a
--      no-op where they already exist; it just makes the chain authoritative.
--   2. INDEX — partial btrees matched to each query's real filter.
--
-- Idempotent & reversible: every statement is IF NOT EXISTS; each index can be
-- dropped with DROP INDEX IF EXISTS <name>. Targets the live DB (same way the
-- other reconcile migrations, e.g. 0167, are run). Safe to re-run.
--
-- NOT included: PostGIS. Enabling the extension + geometry columns + GiST/KNN is
-- the right long-term answer for indexed radius/containment, but it is a
-- production extension change requiring explicit sign-off, rollback, and perf
-- docs (see the Phase 0 audit, Section 30/36 #18). A compound (lat,lng) btree is
-- sufficient at current scale. This migration deliberately stops short of it.

-- ═══ 1. Reconcile drifted geo columns (no-op where already present) ═══════════

ALTER TABLE user_location_state
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION;

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION;

-- ═══ 2. Spatial btree indexes ════════════════════════════════════════════════
-- Partial WHERE clauses keep each index small and matched to the query:
--   • only rows that actually carry coordinates are indexed;
--   • hidden_gems is additionally scoped to status='active' (the only status
--     /nearby ever queries), so the index covers exactly the proximity rows.
-- NOTE: plain CREATE INDEX briefly locks the table for writes while it builds.
-- These tables are modest today; if any grows large, build instead with
-- CREATE INDEX CONCURRENTLY (run OUTSIDE a transaction — Supabase SQL editor
-- runs statements un-wrapped, so CONCURRENTLY works there if you prefer it).

-- Discovery live map (lib/mapTravelers): bbox over user_location_state.
CREATE INDEX IF NOT EXISTS user_location_state_geo_idx
  ON user_location_state (lat, lng)
  WHERE lat IS NOT NULL AND lng IS NOT NULL;

-- Events proximity (/events/nearby): bbox over events.location_lat/lng.
CREATE INDEX IF NOT EXISTS events_geo_idx
  ON events (location_lat, location_lng)
  WHERE location_lat IS NOT NULL AND location_lng IS NOT NULL;

-- Posts geofence watcher: lookups on posts.location_lat/lng.
CREATE INDEX IF NOT EXISTS posts_geo_idx
  ON posts (location_lat, location_lng)
  WHERE location_lat IS NOT NULL AND location_lng IS NOT NULL;

-- Hidden gems /nearby: the query is status='active' AND (exact box OR approx
-- box). One partial index per coordinate pair lets the planner satisfy each
-- side of the OR.
CREATE INDEX IF NOT EXISTS hidden_gems_geo_idx
  ON hidden_gems (latitude, longitude)
  WHERE status = 'active' AND latitude IS NOT NULL AND longitude IS NOT NULL;

CREATE INDEX IF NOT EXISTS hidden_gems_approx_geo_idx
  ON hidden_gems (approx_latitude, approx_longitude)
  WHERE status = 'active' AND approx_latitude IS NOT NULL AND approx_longitude IS NOT NULL;

-- Refresh planner statistics so the new indexes are considered immediately.
ANALYZE user_location_state;
ANALYZE events;
ANALYZE posts;
ANALYZE hidden_gems;
