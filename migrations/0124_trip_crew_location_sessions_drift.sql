-- 0124: Fix schema drift on trip_crew_location_sessions.
-- TripCrewLiveShareService expects status/started_at/stopped_at/visibility_level
-- columns that were never created by 0041, causing the 5-minute expiry sweeper
-- to fail with PGRST204 in production.

ALTER TABLE trip_crew_location_sessions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'stopped', 'expired')),
  ADD COLUMN IF NOT EXISTS started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS stopped_at timestamptz,
  ADD COLUMN IF NOT EXISTS visibility_level text NOT NULL DEFAULT 'neighborhood'
    CHECK (visibility_level IN ('city_only', 'neighborhood', 'nearby'));

-- Backfill: sessions already ended or expired should not be treated as active.
UPDATE trip_crew_location_sessions
SET status = 'stopped', stopped_at = ended_at
WHERE ended_at IS NOT NULL AND status = 'active';

UPDATE trip_crew_location_sessions
SET status = 'expired', stopped_at = expires_at
WHERE ended_at IS NULL AND expires_at < now() AND status = 'active';

CREATE INDEX IF NOT EXISTS crew_loc_sessions_status_idx
  ON trip_crew_location_sessions(status, expires_at);

-- Audit log: the service writes event types beyond the original CHECK list.
ALTER TABLE trip_crew_location_events
  DROP CONSTRAINT IF EXISTS trip_crew_location_events_event_type_check;

ALTER TABLE trip_crew_location_events
  ADD CONSTRAINT trip_crew_location_events_event_type_check
  CHECK (event_type IN (
    'ghost_on', 'ghost_off',
    'live_share_start', 'live_share_end',
    'live_share_started', 'live_share_stopped',
    'live_share_expired', 'access_revoked'
  ));
