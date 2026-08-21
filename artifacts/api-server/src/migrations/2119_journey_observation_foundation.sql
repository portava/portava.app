-- 2119_journey_observation_foundation.sql
--
-- Phase 1 Journey foundation: a restricted, append-only observation boundary.
-- There is deliberately no segment, recommendation, social, notification,
-- graph, outcome, or plan consumer in this migration.
--
-- Reconciled prerequisites (2026-08-21):
--   * public.user_location_preferences is the canonical settings table used by
--     shipping /api/me/location-preferences route.
--   * public.location_sessions is the canonical session table and has
--     id/user_id/session_type/started_at/ended_at/expires_at in the live
--     2026-08-19 baseline.
--
-- Fail rather than silently creating a parallel contract if those prerequisites
-- drift. A committed migration is not evidence that either table exists live.

BEGIN;

DO $$
DECLARE
  missing text[];
BEGIN
  IF to_regclass('public.user_location_preferences') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.user_location_preferences is missing';
  END IF;
  IF to_regclass('public.location_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.location_sessions is missing';
  END IF;

  SELECT array_agg(required.column_name ORDER BY required.column_name)
    INTO missing
    FROM (
      VALUES
        ('id'), ('user_id'), ('session_type'), ('started_at'),
        ('ended_at'), ('expires_at')
    ) AS required(column_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'location_sessions'
        AND c.column_name = required.column_name
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: public.location_sessions is missing required columns: %',
      array_to_string(missing, ', ');
  END IF;
END $$;

-- Explicit per-owner consent. Existing location modes are necessary but are not
-- sufficient consent for a new purpose, so this defaults off independently.
ALTER TABLE public.user_location_preferences
  ADD COLUMN IF NOT EXISTS journey_observation_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_location_preferences.journey_observation_enabled IS
  'Explicit owner opt-in for restricted Journey observation ingestion. Defaults false and is re-read for every batch.';

-- The only accepted coarse-reference keys. Values must be scalar strings/null;
-- nested metadata cannot be used to smuggle coordinates or addresses.
CREATE FUNCTION public.is_valid_journey_world_ref(ref jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT
    jsonb_typeof(ref) = 'object'
    AND ref ?| ARRAY['countryCode', 'regionId', 'cityId', 'districtId', 'placeId']
    AND NOT EXISTS (
      SELECT 1
        FROM jsonb_each(ref) entry
       WHERE entry.key <> ALL (
         ARRAY['countryCode', 'regionId', 'cityId', 'districtId', 'placeId']
       )
          OR jsonb_typeof(entry.value) NOT IN ('string', 'null')
          OR (
            jsonb_typeof(entry.value) = 'string'
            AND (
              length(entry.value #>> '{}') = 0
              OR length(entry.value #>> '{}') > 128
            )
          )
    );
$$;

REVOKE ALL ON FUNCTION public.is_valid_journey_world_ref(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_valid_journey_world_ref(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.is_valid_journey_world_ref(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.is_valid_journey_world_ref(jsonb) TO service_role;

CREATE TABLE public.journey_observations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  location_session_id  uuid NOT NULL REFERENCES public.location_sessions(id) ON DELETE CASCADE,
  event_version        smallint NOT NULL DEFAULT 1,
  observed_at          timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  source               text NOT NULL,
  lat                  double precision,
  lng                  double precision,
  accuracy_m           double precision,
  speed_mps            double precision,
  heading_deg          double precision,
  world_ref            jsonb,
  consent_scope        text NOT NULL,
  idempotency_key      text NOT NULL,
  trust_class          text NOT NULL,
  expires_at           timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT journey_observations_event_version_check
    CHECK (event_version = 1),
  CONSTRAINT journey_observations_source_check
    CHECK (source IN ('foreground_gps', 'background_gps', 'plan_checkin', 'manual')),
  CONSTRAINT journey_observations_consent_scope_check
    CHECK (consent_scope = 'journey_observation_v1'),
  CONSTRAINT journey_observations_idempotency_key_check
    CHECK (
      length(idempotency_key) BETWEEN 1 AND 128
      AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ),
  CONSTRAINT journey_observations_trust_class_check
    CHECK (trust_class IN ('accepted', 'low_accuracy', 'suspicious', 'manual')),
  CONSTRAINT journey_observations_coordinate_range_check
    CHECK (
      (lat IS NULL OR lat BETWEEN -90 AND 90)
      AND (lng IS NULL OR lng BETWEEN -180 AND 180)
      AND (accuracy_m IS NULL OR accuracy_m > 0 AND accuracy_m <= 10000)
      AND (speed_mps IS NULL OR speed_mps >= 0 AND speed_mps <= 350)
      AND (heading_deg IS NULL OR heading_deg >= 0 AND heading_deg < 360)
    ),
  CONSTRAINT journey_observations_shape_check
    CHECK (
      (
        source IN ('foreground_gps', 'background_gps')
        AND lat IS NOT NULL
        AND lng IS NOT NULL
        AND accuracy_m IS NOT NULL
        AND world_ref IS NULL
      )
      OR
      (
        source IN ('plan_checkin', 'manual')
        AND lat IS NULL
        AND lng IS NULL
        AND accuracy_m IS NULL
        AND speed_mps IS NULL
        AND heading_deg IS NULL
        AND world_ref IS NOT NULL
        AND public.is_valid_journey_world_ref(world_ref)
      )
    ),
  CONSTRAINT journey_observations_observed_at_check
    CHECK (
      observed_at >= received_at - interval '24 hours'
      AND observed_at <= received_at + interval '5 minutes'
    ),
  CONSTRAINT journey_observations_expiry_check
    CHECK (
      expires_at > received_at
      AND expires_at <= received_at + interval '72 hours'
    ),
  CONSTRAINT journey_observations_idempotency_unique
    UNIQUE (user_id, location_session_id, idempotency_key)
);

COMMENT ON TABLE public.journey_observations IS
  'RESTRICTED PRECISE LOCATION. Append-only service boundary; no authenticated/public reads, no model/Compass/social/graph consumers. Raw TTL is 24h, hard maximum 72h.';
COMMENT ON COLUMN public.journey_observations.lat IS
  'Restricted exact latitude. Ingestion/safety/purge boundary only.';
COMMENT ON COLUMN public.journey_observations.lng IS
  'Restricted exact longitude. Ingestion/safety/purge boundary only.';

CREATE INDEX journey_observations_user_observed_idx
  ON public.journey_observations (user_id, observed_at DESC);
CREATE INDEX journey_observations_expiry_idx
  ON public.journey_observations (expires_at);

-- Append-only means even service_role cannot rewrite history. Purge and account
-- deletion remain possible through DELETE.
CREATE FUNCTION public.prevent_journey_observation_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'journey_observations is append-only';
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_journey_observation_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_journey_observation_update() FROM anon;
REVOKE ALL ON FUNCTION public.prevent_journey_observation_update() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_journey_observation_update() TO service_role;

CREATE TRIGGER journey_observations_prevent_update
  BEFORE UPDATE ON public.journey_observations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_journey_observation_update();

-- No owner SELECT policy exists by design: owners use the authenticated ingest
-- route and deletion/account-removal paths, never a raw-row read API.
ALTER TABLE public.journey_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_observations FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.journey_observations FROM PUBLIC;
REVOKE ALL ON TABLE public.journey_observations FROM anon;
REVOKE ALL ON TABLE public.journey_observations FROM authenticated;
REVOKE UPDATE ON TABLE public.journey_observations FROM service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.journey_observations TO service_role;

-- Atomic authorization + insert boundary.
--
-- The API performs an early uncached read so a disabled switch rejects quickly,
-- but this function is authoritative. Row locks serialize consent/session/flag
-- changes with the insert: a revocation that has committed cannot race with a
-- stale application-side check, and a concurrent revocation waits for an
-- already-authorized insert before atomically purging it in the same transaction.
CREATE FUNCTION public.ingest_journey_observation_v1(
  p_user_id uuid,
  p_location_session_id uuid,
  p_event_version smallint,
  p_observed_at timestamptz,
  p_source text,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision,
  p_speed_mps double precision,
  p_heading_deg double precision,
  p_world_ref jsonb,
  p_consent_scope text,
  p_idempotency_key text,
  p_trust_class text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_master_enabled boolean;
  v_ingest_enabled boolean;
  v_global_stop boolean;
  v_preferences record;
  v_session record;
  v_received_at timestamptz := clock_timestamp();
  v_inserted_id uuid;
BEGIN
  -- Lock each control row so the decision and insert are ordered against admin
  -- flag writes. Missing capability rows are false; a missing STOP row is not
  -- engaged. Any query/function failure aborts without an insert.
  SELECT enabled
    INTO v_master_enabled
    FROM public.feature_flags
   WHERE flag = 'COMPASS_JOURNEY_ENGINE_ENABLED'
   FOR SHARE;

  SELECT enabled
    INTO v_ingest_enabled
    FROM public.feature_flags
   WHERE flag = 'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED'
   FOR SHARE;

  SELECT enabled
    INTO v_global_stop
    FROM public.feature_flags
   WHERE flag = 'disable_location_sharing'
   FOR SHARE;

  IF v_master_enabled IS DISTINCT FROM true
     OR v_ingest_enabled IS DISTINCT FROM true
     OR v_global_stop IS true THEN
    RETURN 'feature_disabled';
  END IF;

  SELECT
      journey_observation_enabled,
      sharing_paused,
      location_mode
    INTO v_preferences
    FROM public.user_location_preferences
   WHERE user_id = p_user_id
   FOR SHARE;

  IF NOT FOUND THEN
    RETURN 'not_authorized';
  END IF;
  IF v_preferences.journey_observation_enabled IS DISTINCT FROM true
     OR v_preferences.sharing_paused IS DISTINCT FROM false
     OR v_preferences.location_mode NOT IN (
       'city_only', 'nearby', 'live_during_activity', 'trusted_circle_live'
     ) THEN
    RETURN 'not_authorized';
  END IF;

  SELECT id, user_id, session_type, started_at, ended_at, expires_at
    INTO v_session
    FROM public.location_sessions
   WHERE id = p_location_session_id
     AND user_id = p_user_id
   FOR SHARE;

  IF NOT FOUND THEN
    RETURN 'not_authorized';
  END IF;
  IF v_session.ended_at IS NOT NULL
     OR v_session.expires_at IS NULL
     OR v_session.expires_at <= v_received_at
     OR p_observed_at < v_session.started_at
     OR p_observed_at > v_session.expires_at
     OR p_observed_at < v_received_at - interval '24 hours'
     OR p_observed_at > v_received_at + interval '5 minutes' THEN
    RETURN 'not_authorized';
  END IF;

  IF p_source IN ('foreground_gps', 'background_gps') THEN
    IF v_preferences.location_mode NOT IN (
      'live_during_activity', 'trusted_circle_live'
    ) THEN
      RETURN 'not_authorized';
    END IF;
    IF p_source = 'foreground_gps'
       AND v_session.session_type NOT IN ('live_share', 'trip_check_in') THEN
      RETURN 'not_authorized';
    END IF;
    IF p_source = 'background_gps'
       AND v_session.session_type <> 'live_share' THEN
      RETURN 'not_authorized';
    END IF;
  ELSIF p_source IN ('plan_checkin', 'manual') THEN
    IF v_session.session_type <> 'trip_check_in' THEN
      RETURN 'not_authorized';
    END IF;
  ELSE
    RETURN 'not_authorized';
  END IF;

  INSERT INTO public.journey_observations (
    user_id,
    location_session_id,
    event_version,
    observed_at,
    received_at,
    source,
    lat,
    lng,
    accuracy_m,
    speed_mps,
    heading_deg,
    world_ref,
    consent_scope,
    idempotency_key,
    trust_class,
    expires_at
  ) VALUES (
    p_user_id,
    p_location_session_id,
    p_event_version,
    p_observed_at,
    v_received_at,
    p_source,
    p_lat,
    p_lng,
    p_accuracy_m,
    p_speed_mps,
    p_heading_deg,
    p_world_ref,
    p_consent_scope,
    p_idempotency_key,
    p_trust_class,
    v_received_at + interval '24 hours'
  )
  ON CONFLICT (user_id, location_session_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN 'deduplicated';
  END IF;
  RETURN 'accepted';
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_journey_observation_v1(
  uuid, uuid, smallint, timestamptz, text,
  double precision, double precision, double precision, double precision,
  double precision, jsonb, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ingest_journey_observation_v1(
  uuid, uuid, smallint, timestamptz, text,
  double precision, double precision, double precision, double precision,
  double precision, jsonb, text, text, text
) FROM anon;
REVOKE ALL ON FUNCTION public.ingest_journey_observation_v1(
  uuid, uuid, smallint, timestamptz, text,
  double precision, double precision, double precision, double precision,
  double precision, jsonb, text, text, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_journey_observation_v1(
  uuid, uuid, smallint, timestamptz, text,
  double precision, double precision, double precision, double precision,
  double precision, jsonb, text, text, text
) TO service_role;

-- A pause, explicit Journey opt-out, mode-off transition, or settings-row
-- deletion is a revocation event. Delete already-collected raw observations in
-- the SAME transaction; do not wait for the periodic TTL purge. The preference
-- row lock orders direct owner updates against the append RPC's FOR SHARE read:
-- an earlier append is deleted here, while a later append sees revoked consent.
CREATE FUNCTION public.purge_journey_observations_on_consent_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_revoked boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
    v_revoked := true;
  ELSE
    v_user_id := NEW.user_id;
    v_revoked :=
      OLD.journey_observation_enabled = true
      AND (
        NEW.journey_observation_enabled IS DISTINCT FROM true
        OR NEW.sharing_paused IS DISTINCT FROM false
        OR NEW.location_mode NOT IN (
          'city_only', 'nearby', 'live_during_activity', 'trusted_circle_live'
        )
      );
  END IF;

  IF v_revoked THEN
    DELETE FROM public.journey_observations
     WHERE user_id = v_user_id;
    IF to_regclass('public.journey_segment_revisions') IS NOT NULL THEN
      DELETE FROM public.journey_segment_revisions
       WHERE user_id = v_user_id;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_journey_observations_on_consent_revocation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_journey_observations_on_consent_revocation() FROM anon;
REVOKE ALL ON FUNCTION public.purge_journey_observations_on_consent_revocation() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_journey_observations_on_consent_revocation() TO service_role;

CREATE TRIGGER user_location_preferences_purge_journey_on_revocation
  AFTER UPDATE OF journey_observation_enabled, sharing_paused, location_mode
     OR DELETE ON public.user_location_preferences
  FOR EACH ROW EXECUTE FUNCTION public.purge_journey_observations_on_consent_revocation();

-- Explicitly ending/deleting a session revokes that session's raw observations.
-- The RPC holds a SHARE lock on the same session row, so session revocation and
-- ingestion are ordered: whichever obtains the row lock second observes or
-- cleans up the first operation before committing.
CREATE FUNCTION public.purge_journey_observations_on_session_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session_id uuid;
  v_revoked boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_session_id := OLD.id;
    v_revoked := true;
  ELSE
    v_session_id := NEW.id;
    v_revoked :=
      (OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL)
      OR (
        NEW.expires_at IS NOT NULL
        AND NEW.expires_at <= clock_timestamp()
        AND (
          OLD.expires_at IS NULL
          OR OLD.expires_at > clock_timestamp()
        )
      );
  END IF;

  IF v_revoked THEN
    DELETE FROM public.journey_observations
     WHERE location_session_id = v_session_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_journey_observations_on_session_revocation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_journey_observations_on_session_revocation() FROM anon;
REVOKE ALL ON FUNCTION public.purge_journey_observations_on_session_revocation() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_journey_observations_on_session_revocation() TO service_role;

CREATE TRIGGER location_sessions_purge_journey_on_revocation
  AFTER UPDATE OF ended_at, expires_at
     OR DELETE ON public.location_sessions
  FOR EACH ROW EXECUTE FUNCTION public.purge_journey_observations_on_session_revocation();

-- Missing rows are disabled by the runtime gate. Seeding makes the default-off
-- state visible to operators without overriding an existing operator choice.
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'COMPASS_JOURNEY_ENGINE_ENABLED',
    false,
    'Master kill switch for all Journey paths; precise ingestion reads this without the Compass flag cache'
  ),
  (
    'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
    false,
    'Accept restricted Journey observations for explicitly opted-in active location sessions'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- Rollback is intentionally separate and destructive:
-- docs/sql/rollback_2119_journey_observation_foundation.sql