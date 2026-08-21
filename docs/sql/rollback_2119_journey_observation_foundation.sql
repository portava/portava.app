-- Rollback for 2119_journey_observation_foundation.sql
--
-- PRECONDITIONS:
--   1. Set both COMPASS_JOURNEY_* flags false and verify ingestion has stopped.
--   2. Stop all API instances that contain the ingestion route.
--   3. Run/verify the observation purge. Raw rows are intentionally disposable.
--
-- This rollback removes only Phase 1 observation-foundation objects. It does
-- not touch Compass, Discovery, Sense, Live, Autopilot, outcomes, graph data,
-- location sessions, or existing location preference fields.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.feature_flags
     WHERE flag IN (
       'COMPASS_JOURNEY_ENGINE_ENABLED',
       'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED'
     )
       AND enabled
  ) THEN
    RAISE EXCEPTION 'ROLLBACK BLOCKED: Journey flags must be disabled first';
  END IF;
END $$;

DROP TRIGGER IF EXISTS user_location_preferences_purge_journey_on_revocation
  ON public.user_location_preferences;
DROP TRIGGER IF EXISTS location_sessions_purge_journey_on_revocation
  ON public.location_sessions;
DROP FUNCTION IF EXISTS public.purge_journey_observations_on_consent_revocation();
DROP FUNCTION IF EXISTS public.purge_journey_observations_on_session_revocation();
DROP FUNCTION IF EXISTS public.ingest_journey_observation_v1(
  uuid, uuid, smallint, timestamptz, text,
  double precision, double precision, double precision, double precision,
  double precision, jsonb, text, text, text
);
DROP TABLE IF EXISTS public.journey_observations;
DROP FUNCTION IF EXISTS public.prevent_journey_observation_update();
DROP FUNCTION IF EXISTS public.is_valid_journey_world_ref(jsonb);

ALTER TABLE public.user_location_preferences
  DROP COLUMN IF EXISTS journey_observation_enabled;

DELETE FROM public.feature_flags
 WHERE flag IN (
   'COMPASS_JOURNEY_ENGINE_ENABLED',
   'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED'
 );

COMMIT;