-- Migration 0105: Compass performance indexes (rewritten 2026-07-17 against the live schema)
-- Adds covering indexes on the columns most queried by the Compass item hydrator.
-- All statements are idempotent (IF NOT EXISTS). Safe to re-run.
--
-- 2026-07-17 rewrite notes (original file referenced columns that do not exist live):
--   events.status            -> events.state (enum event_state)
--   trips.destination        -> trips.destination_city
--   trips.starts_at          -> trips.start_date
--   places table             -> does not exist live; index removed
--   discovery_places.moderation_status / is_active -> discovery_places.status
--   profiles.is_active / role / city -> profiles.current_city / verification_status

-- ── events ────────────────────────────────────────────────────────────────────
-- Compass hydrator queries: city filter + upcoming starts_at + state + visibility
CREATE INDEX IF NOT EXISTS events_compass_city_starts_idx
  ON events (city, starts_at, state, visibility);

CREATE INDEX IF NOT EXISTS events_compass_category_idx
  ON events (category, state, visibility, starts_at);

-- ── trips ─────────────────────────────────────────────────────────────────────
-- Compass queries: destination city + upcoming trips + visibility + status
CREATE INDEX IF NOT EXISTS trips_compass_destination_idx
  ON trips (destination_city, start_date, visibility, status);

-- ── discovery_places ──────────────────────────────────────────────────────────
-- Compass hydrator and fallback feed queries filter by city + status
CREATE INDEX IF NOT EXISTS discovery_places_compass_city_idx
  ON discovery_places (city, category, status);

CREATE INDEX IF NOT EXISTS discovery_places_compass_category_idx
  ON discovery_places (category, status);

-- ── profiles ──────────────────────────────────────────────────────────────────
-- Compass people/buddy queries: current city + verification status
CREATE INDEX IF NOT EXISTS profiles_compass_city_idx
  ON profiles (current_city, verification_status);
