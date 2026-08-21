-- Safe containment rollback for 2120_journey_privacy_foundation.sql.
--
-- This intentionally does not drop consent history, revocation jobs, health
-- history, or columns that the hardened ingest function references. It returns
-- the capability to a fail-closed state that is compatible with older
-- application code. A destructive schema reversal should use a database
-- checkpoint only after all revocation work is complete and has been audited.

BEGIN;

-- Stop all Journey write paths before changing consent/session state.
UPDATE public.feature_flags
   SET enabled = false
 WHERE flag IN (
   'COMPASS_JOURNEY_ENGINE_ENABLED',
   'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED'
 );

-- The BEFORE trigger records server-side revocation time, ends active
-- Journey-purpose sessions, synchronously erases restricted rows, and
-- atomically enqueues durable deletion evidence.
UPDATE public.user_location_preferences
   SET journey_observation_enabled = false,
       updated_at = clock_timestamp()
 WHERE journey_observation_enabled = true;

UPDATE public.location_sessions
   SET ended_at = COALESCE(ended_at, clock_timestamp())
 WHERE journey_purpose = 'journey_observation_v1'
   AND ended_at IS NULL;

-- A rolled-back worker must never leave a fresh-looking healthy authorization
-- row. Retention cleanup may continue independently while the capability is off.
UPDATE public.journey_retention_health
   SET last_status = 'STALE',
       updated_at = clock_timestamp()
 WHERE job = 'journey_observation_retention';

COMMIT;

-- Postconditions to verify before rolling application code back:
--   1. both Journey flags are false;
--   2. no preference has journey_observation_enabled=true;
--   3. no Journey-purpose session is active;
--   4. every incomplete journey_revocation_jobs row remains available to the
--      retention worker or is explicitly resolved by an operator.
--
-- Full schema removal is deliberately not automated: dropping the durable queue
-- would erase required deletion evidence and could strand restricted data.