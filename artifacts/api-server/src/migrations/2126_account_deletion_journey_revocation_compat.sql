-- 2126_account_deletion_journey_revocation_compat.sql
--
-- Deletion-only compatibility for the controlled Journey privacy foundation.
-- Production has 2119/2124 but intentionally does not have the optional 2103
-- shadow-segmentation tables. The 2124 revocation trigger and the centralized
-- account-deletion service must therefore tolerate journey_segment_revisions
-- being absent. This migration does not create that table, enable either
-- Journey flag, add a collector, or add a product consumer.

BEGIN;

DO $$
DECLARE
  v_flag_count integer;
  v_enabled_count integer;
BEGIN
  IF to_regclass('public.user_location_preferences') IS NULL
     OR to_regclass('public.location_sessions') IS NULL
     OR to_regclass('public.journey_observations') IS NULL
     OR to_regclass('public.journey_revocation_jobs') IS NULL THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: controlled Journey privacy foundation is incomplete';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE enabled)
    INTO v_flag_count, v_enabled_count
    FROM public.feature_flags
   WHERE flag IN (
     'COMPASS_JOURNEY_ENGINE_ENABLED',
     'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED'
   );

  IF v_flag_count <> 2 OR v_enabled_count <> 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: both Journey capability flags must exist and remain disabled';
  END IF;
END $$;

-- Preserve 2124's same-transaction observation purge and durable retry record,
-- but make the optional future segment table genuinely optional.
CREATE OR REPLACE FUNCTION public.purge_journey_observations_on_consent_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_reason text;
  v_revoked boolean := false;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
    v_reason := 'preference_deleted';
    v_revoked := true;
  ELSE
    v_user_id := NEW.user_id;
    IF OLD.sharing_paused IS DISTINCT FROM true
       AND NEW.sharing_paused IS TRUE THEN
      v_reason := 'sharing_paused';
      v_revoked := true;
    ELSIF OLD.location_mode IN (
        'live_during_activity', 'trusted_circle_live'
      )
      AND NEW.location_mode NOT IN (
        'live_during_activity', 'trusted_circle_live'
      ) THEN
      v_reason := CASE
        WHEN NEW.location_mode = 'off' THEN 'location_mode_off'
        ELSE 'location_mode_non_authorizing'
      END;
      v_revoked := true;
    ELSIF OLD.journey_observation_enabled = true
       AND NEW.journey_observation_enabled IS DISTINCT FROM true THEN
      v_reason := 'consent_revoked';
      v_revoked := true;
    END IF;
  END IF;

  IF v_revoked THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.journey_observation_enabled := false;
      IF NEW.journey_consent_granted_at IS NOT NULL THEN
        NEW.journey_consent_revoked_at :=
          COALESCE(NEW.journey_consent_revoked_at, v_now);
      END IF;
    END IF;

    UPDATE public.location_sessions
       SET ended_at = COALESCE(ended_at, v_now)
     WHERE user_id = v_user_id
       AND journey_purpose = 'journey_observation_v1'
       AND ended_at IS NULL;

    DELETE FROM public.journey_observations
     WHERE user_id = v_user_id;

    IF to_regclass('public.journey_segment_revisions') IS NOT NULL THEN
      EXECUTE
        'DELETE FROM public.journey_segment_revisions WHERE user_id = $1'
        USING v_user_id;
    END IF;

    INSERT INTO public.journey_revocation_jobs (
      user_id,
      reason,
      idempotency_key,
      requested_at,
      available_at,
      updated_at
    ) VALUES (
      v_user_id,
      v_reason,
      format('user:%s:%s', v_user_id, txid_current()),
      v_now,
      v_now,
      v_now
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_journey_observations_on_consent_revocation()
  FROM PUBLIC, anon, authenticated;

-- Atomic account-deletion boundary. The same advisory lock used by the
-- optional future segment appender ensures an append cannot survive revocation.
CREATE OR REPLACE FUNCTION public.revoke_journey_consent_and_delete_segments(
  p_user_id uuid,
  p_preferences jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_count integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_preferences IS NULL OR jsonb_typeof(p_preferences) <> 'object' THEN
    RAISE EXCEPTION 'p_preferences must be a JSON object';
  END IF;
  IF (
    p_preferences - ARRAY[
      'location_mode',
      'sharing_paused',
      'pulse_visibility',
      'discovery_visibility',
      'safe_return_enabled',
      'trusted_circle_share',
      'hotel_blur_enabled',
      'journey_observation_enabled'
    ]::text[]
  ) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unsupported location preference field';
  END IF;

  IF p_preferences ? 'location_mode' AND (
    jsonb_typeof(p_preferences->'location_mode') <> 'string'
    OR p_preferences->>'location_mode' NOT IN (
      'off', 'city_only', 'nearby', 'live_during_activity', 'trusted_circle_live'
    )
  ) THEN
    RAISE EXCEPTION 'invalid location_mode';
  END IF;
  IF p_preferences ? 'sharing_paused'
     AND jsonb_typeof(p_preferences->'sharing_paused') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid sharing_paused';
  END IF;
  IF p_preferences ? 'safe_return_enabled'
     AND jsonb_typeof(p_preferences->'safe_return_enabled') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid safe_return_enabled';
  END IF;
  IF p_preferences ? 'trusted_circle_share'
     AND jsonb_typeof(p_preferences->'trusted_circle_share') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid trusted_circle_share';
  END IF;
  IF p_preferences ? 'hotel_blur_enabled'
     AND jsonb_typeof(p_preferences->'hotel_blur_enabled') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid hotel_blur_enabled';
  END IF;
  IF p_preferences ? 'journey_observation_enabled'
     AND jsonb_typeof(p_preferences->'journey_observation_enabled') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid journey_observation_enabled';
  END IF;

  IF p_preferences ? 'pulse_visibility'
     AND p_preferences->'pulse_visibility' <> 'null'::jsonb
     AND (
       jsonb_typeof(p_preferences->'pulse_visibility') <> 'string'
       OR p_preferences->>'pulse_visibility' NOT IN (
         'city_only', 'neighborhood', 'venue_tagged', 'exact_hidden', 'no_location'
       )
     ) THEN
    RAISE EXCEPTION 'invalid pulse_visibility';
  END IF;
  IF p_preferences ? 'discovery_visibility'
     AND p_preferences->'discovery_visibility' <> 'null'::jsonb
     AND (
       jsonb_typeof(p_preferences->'discovery_visibility') <> 'string'
       OR p_preferences->>'discovery_visibility' NOT IN (
         'city_only', 'neighborhood', 'venue_tagged', 'exact_hidden', 'no_location'
       )
     ) THEN
    RAISE EXCEPTION 'invalid discovery_visibility';
  END IF;

  IF COALESCE(p_preferences->>'location_mode', '') NOT IN ('off', 'city_only', 'nearby')
     AND COALESCE((p_preferences->>'sharing_paused')::boolean, false) = false
     AND COALESCE(
       (p_preferences->>'journey_observation_enabled')::boolean,
       true
     ) = true THEN
    RAISE EXCEPTION 'preference patch must revoke Journey consent'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('journey-segments:' || p_user_id::text, 0)
  );

  IF to_regclass('public.journey_segment_revisions') IS NOT NULL THEN
    EXECUTE
      'DELETE FROM public.journey_segment_revisions WHERE user_id = $1'
      USING p_user_id;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
  END IF;

  INSERT INTO public.user_location_preferences AS current_preferences (
    user_id,
    location_mode,
    sharing_paused,
    pulse_visibility,
    discovery_visibility,
    safe_return_enabled,
    trusted_circle_share,
    hotel_blur_enabled,
    journey_observation_enabled,
    updated_at
  )
  VALUES (
    p_user_id,
    COALESCE(p_preferences->>'location_mode', 'city_only'),
    COALESCE((p_preferences->>'sharing_paused')::boolean, false),
    CASE
      WHEN p_preferences ? 'pulse_visibility' THEN p_preferences->>'pulse_visibility'
      ELSE NULL
    END,
    CASE
      WHEN p_preferences ? 'discovery_visibility' THEN p_preferences->>'discovery_visibility'
      ELSE NULL
    END,
    COALESCE((p_preferences->>'safe_return_enabled')::boolean, true),
    COALESCE((p_preferences->>'trusted_circle_share')::boolean, false),
    COALESCE((p_preferences->>'hotel_blur_enabled')::boolean, true),
    COALESCE((p_preferences->>'journey_observation_enabled')::boolean, false),
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    location_mode = CASE
      WHEN p_preferences ? 'location_mode' THEN EXCLUDED.location_mode
      ELSE current_preferences.location_mode
    END,
    sharing_paused = CASE
      WHEN p_preferences ? 'sharing_paused' THEN EXCLUDED.sharing_paused
      ELSE current_preferences.sharing_paused
    END,
    pulse_visibility = CASE
      WHEN p_preferences ? 'pulse_visibility' THEN EXCLUDED.pulse_visibility
      ELSE current_preferences.pulse_visibility
    END,
    discovery_visibility = CASE
      WHEN p_preferences ? 'discovery_visibility' THEN EXCLUDED.discovery_visibility
      ELSE current_preferences.discovery_visibility
    END,
    safe_return_enabled = CASE
      WHEN p_preferences ? 'safe_return_enabled' THEN EXCLUDED.safe_return_enabled
      ELSE current_preferences.safe_return_enabled
    END,
    trusted_circle_share = CASE
      WHEN p_preferences ? 'trusted_circle_share' THEN EXCLUDED.trusted_circle_share
      ELSE current_preferences.trusted_circle_share
    END,
    hotel_blur_enabled = CASE
      WHEN p_preferences ? 'hotel_blur_enabled' THEN EXCLUDED.hotel_blur_enabled
      ELSE current_preferences.hotel_blur_enabled
    END,
    journey_observation_enabled = CASE
      WHEN p_preferences ? 'journey_observation_enabled'
        THEN EXCLUDED.journey_observation_enabled
      ELSE current_preferences.journey_observation_enabled
    END,
    updated_at = now();

  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_journey_consent_and_delete_segments(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_journey_consent_and_delete_segments(uuid, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.revoke_journey_consent_and_delete_segments(uuid, jsonb) IS
  'Deletion/revocation-only atomic boundary. Does not enable Journey or require optional shadow-segmentation tables.';

COMMIT;