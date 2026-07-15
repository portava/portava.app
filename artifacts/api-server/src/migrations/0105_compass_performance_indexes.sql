-- Migration 0105: Compass performance indexes
-- Adds covering indexes on the columns most queried by the Compass item hydrator.
-- All statements are idempotent (IF NOT EXISTS). Safe to re-run.

-- ── events ────────────────────────────────────────────────────────────────────
-- Compass hydrator queries: city filter + upcoming starts_at + status + visibility
CREATE INDEX IF NOT EXISTS events_compass_city_starts_idx
  ON events (city, starts_at, status, visibility);

CREATE INDEX IF NOT EXISTS events_compass_category_idx
  ON events (category, status, visibility, starts_at);

-- ── trips ─────────────────────────────────────────────────────────────────────
-- Compass hydrator queries: destination + upcoming trips + visibility + status
CREATE INDEX IF NOT EXISTS trips_compass_destination_idx
  ON trips (destination, starts_at, visibility, status);

-- ── places / discovery_places ─────────────────────────────────────────────────
-- Compass hydrator and discovery adapter queries
CREATE INDEX IF NOT EXISTS discovery_places_compass_city_idx
  ON discovery_places (city, category, moderation_status);

CREATE INDEX IF NOT EXISTS discovery_places_compass_category_idx
  ON discovery_places (category, is_active, moderation_status);

-- places table (canonical DB, may differ from OSM discovery_places)
CREATE INDEX IF NOT EXISTS places_compass_city_category_idx
  ON places (city, category, moderation_status) WHERE moderation_status != 'rejected';

-- ── profiles ──────────────────────────────────────────────────────────────────
-- Compass people/buddy queries: city + verification status
CREATE INDEX IF NOT EXISTS profiles_compass_city_idx
  ON profiles (city, verification_status) WHERE is_active = true;

-- Covering index for user search by city used in buddy/people sections
CREATE INDEX IF NOT EXISTS profiles_compass_city_role_idx
  ON profiles (city, role, is_active);
