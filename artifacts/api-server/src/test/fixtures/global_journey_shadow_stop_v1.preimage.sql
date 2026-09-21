CREATE OR REPLACE FUNCTION public.global_journey_shadow_stop_v1(p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_now                 timestamptz := clock_timestamp();
  v_flags_disabled      integer := 0;
  v_stages_stopped      integer := 0;
  v_assignments_revoked integer := 0;
  v_sessions_ended      integer := 0;
  v_observations_deleted integer := 0;
  v_segments_deleted    integer := 0;
  v_ground_truth_deleted integer := 0;
BEGIN
  PERFORM public._journey_shadow_require_admin_actor(p_actor);

  -- Disable all Journey feature flags
  UPDATE public.feature_flags
     SET enabled = false
   WHERE flag IN (
     'COMPASS_JOURNEY_ENGINE_ENABLED',
     'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
     'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED'
   )
     AND enabled = true;
  GET DIAGNOSTICS v_flags_disabled = ROW_COUNT;

  -- Deactivate all active stages
  UPDATE public.journey_shadow_stages
     SET is_active = false
   WHERE is_active = true;
  GET DIAGNOSTICS v_stages_stopped = ROW_COUNT;

  -- Revoke all active cohort assignments (actor = admin for audit)
  UPDATE public.journey_shadow_cohort_assignments
     SET revoked_at = v_now,
         revoked_by = p_actor
   WHERE revoked_at IS NULL;
  GET DIAGNOSTICS v_assignments_revoked = ROW_COUNT;

  -- Revoke all active session issuances
  UPDATE public.journey_shadow_session_issuances
     SET revoked_at = v_now
   WHERE revoked_at IS NULL;

  -- Delete all ground-truth rows associated with the revoked assignments.
  -- (Assignment history rows remain revoked; truth references them but is erased.)
  DELETE FROM public.journey_shadow_ground_truth;
  GET DIAGNOSTICS v_ground_truth_deleted = ROW_COUNT;

  -- Delete all journey observations
  DELETE FROM public.journey_observations;
  GET DIAGNOSTICS v_observations_deleted = ROW_COUNT;

  -- Delete all shadow segment revisions
  DELETE FROM public.journey_segment_revisions;
  GET DIAGNOSTICS v_segments_deleted = ROW_COUNT;

  -- End sessions only after counting synchronous erasure above. The normal
  -- session-end trigger also erases raw/derived rows; doing that first would
  -- make this emergency-stop audit incorrectly report zero deletions.
  UPDATE public.location_sessions
     SET ended_at = COALESCE(ended_at, v_now)
   WHERE journey_purpose = 'journey_observation_v1'
     AND ended_at IS NULL;
  GET DIAGNOSTICS v_sessions_ended = ROW_COUNT;

  RETURN jsonb_build_object(
    'flags_disabled',        v_flags_disabled,
    'stages_stopped',        v_stages_stopped,
    'assignments_revoked',   v_assignments_revoked,
    'sessions_ended',        v_sessions_ended,
    'observations_deleted',  v_observations_deleted,
    'segments_deleted',      v_segments_deleted,
    'ground_truth_deleted',  v_ground_truth_deleted,
    'stopped_at',            v_now
  );
END;
$function$
