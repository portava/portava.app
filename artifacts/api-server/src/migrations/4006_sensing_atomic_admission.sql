-- Generated with `supabase migration new sensing_atomic_admission`; stored in
-- the repository's numbered migration ledger. No flag or policy is enabled.
-- Locking the credential, replay key and write in one transaction prevents
-- parallel requests from storing observations after their budget is exhausted.
BEGIN;

CREATE OR REPLACE FUNCTION public.sensing_admit_contribution(
  p_credential_hash text, p_policy_version integer,
  p_purpose_scopes text[], p_contribution jsonb
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.sensing_contribution_sessions%ROWTYPE;
  c public.sensing_anon_contributions%ROWTYPE;
  enabled boolean;
  inserted integer;
  admitted_at timestamptz;
BEGIN
  SELECT * INTO s FROM public.sensing_contribution_sessions
    WHERE credential_hash = p_credential_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  -- Clock is read AFTER acquiring the lock; queued calls cannot reuse an old
  -- timestamp to bypass expiry. The caller cannot supply the admission clock.
  admitted_at := clock_timestamp();
  IF s.revoked_at IS NOT NULL THEN RETURN 'revoked'; END IF;
  IF admitted_at < s.starts_at THEN RETURN 'not_started'; END IF;
  IF admitted_at >= s.expires_at THEN RETURN 'expired'; END IF;
  SELECT f.enabled INTO enabled FROM public.feature_flags f
    WHERE f.flag = 'sensing_consent_split_enabled' FOR SHARE;
  IF enabled IS DISTINCT FROM true THEN RETURN 'disabled'; END IF;
  IF p_contribution IS NULL OR jsonb_typeof(p_contribution) <> 'object' THEN
    RAISE EXCEPTION 'sensing_admit_contribution: invalid contribution';
  END IF;
  c := jsonb_populate_record(NULL::public.sensing_anon_contributions, p_contribution);
  IF p_policy_version IS DISTINCT FROM s.policy_version
     OR c.reduction_version IS DISTINCT FROM s.reduction_version
     OR p_purpose_scopes IS NULL OR NOT (p_purpose_scopes <@ s.purpose_scopes)
     OR NOT (ARRAY['collect','retain','aggregate']::text[] <@ p_purpose_scopes)
     OR (c.surface_permitted IS TRUE AND NOT ('surface' = ANY(p_purpose_scopes))) THEN
    RETURN 'policy_changed';
  END IF;
  -- A retry of the last admitted reading remains successful at zero budget.
  IF EXISTS (SELECT 1 FROM public.sensing_anon_contributions
      WHERE cohort_key = c.cohort_key AND contributor_token = c.contributor_token) THEN
    RETURN 'duplicate';
  END IF;
  IF s.budget_cohorts_remaining <= 0 THEN RETURN 'budget_exhausted'; END IF;
  -- Explicit allowlist: no session hash, identity, raw reading or unknown JSON
  -- key can be persisted, including if a future migration adds a column.
  INSERT INTO public.sensing_anon_contributions (
    contributor_token, rotation_epoch, group_token, zone_id, time_bucket,
    cohort_key, signal_bucket, reduction_version, created_at, expires_at,
    zone_precision, place_candidate, movement_class, motion_energy_centi,
    periodicity_centi, dwell_bucket, transition_kind, transport_mode,
    transport_mode_centi, density_bucket, bounded_movement, sensor_health_centi,
    acoustic_energy_bucket, acoustic_rhythm, acoustic_health_centi, surface_permitted
  ) VALUES (
    c.contributor_token, c.rotation_epoch, c.group_token, c.zone_id, c.time_bucket,
    c.cohort_key, c.signal_bucket, c.reduction_version, c.created_at, c.expires_at,
    c.zone_precision, c.place_candidate, c.movement_class, c.motion_energy_centi,
    c.periodicity_centi, c.dwell_bucket, c.transition_kind, c.transport_mode,
    c.transport_mode_centi, c.density_bucket, c.bounded_movement, c.sensor_health_centi,
    c.acoustic_energy_bucket, c.acoustic_rhythm, c.acoustic_health_centi, coalesce(c.surface_permitted, false)
  ) ON CONFLICT (cohort_key, contributor_token) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN 'duplicate'; END IF;
  UPDATE public.sensing_contribution_sessions
    SET budget_cohorts_remaining = budget_cohorts_remaining - 1 WHERE id = s.id;
  RETURN 'stored';
END;
$$;

-- Session UPDATE is deliberately not table-granted; this bounded function needs
-- definer rights like 2480's consume/revoke functions. Only the server executes.
REVOKE ALL ON FUNCTION public.sensing_admit_contribution(text, integer, text[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sensing_admit_contribution(text, integer, text[], jsonb) TO service_role;

-- Only preimage-derived rotating tokens reach SQL. No account join and no
-- retained epoch secret; an interrupted request can safely repeat this command.
CREATE OR REPLACE FUNCTION public.sensing_revoke_recent(
  p_credential_hash text, p_epochs jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE proof jsonb;
BEGIN
  IF p_epochs IS NULL OR jsonb_typeof(p_epochs) <> 'array' OR jsonb_array_length(p_epochs) > 74 THEN
    RAISE EXCEPTION 'sensing_revoke_recent: invalid proofs';
  END IF;
  -- Same session lock order as admission: an already-running insert finishes
  -- before erasure; an insert queued behind erasure sees the revoked session.
  IF p_credential_hash IS NOT NULL THEN
    PERFORM public.revoke_sensing_session(p_credential_hash, clock_timestamp());
  END IF;
  FOR proof IN SELECT value FROM jsonb_array_elements(p_epochs) LOOP
    IF (proof->>'rotationEpoch') IS NULL OR (proof->>'contributorToken') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'sensing_revoke_recent: invalid proof';
    END IF;
    PERFORM public.revoke_sensing_contributions((proof->>'rotationEpoch')::bigint, proof->>'contributorToken');
  END LOOP;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.sensing_revoke_recent(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sensing_revoke_recent(text, jsonb) TO service_role;
-- Serializes publications from separate replicas. The TypeScript policy owns
-- the differencing rule; SQL binds that decision to exactly the history read.
CREATE OR REPLACE FUNCTION public.sensing_publish_if_current(p_expected_id uuid, p_publication jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c public.sensing_published_aggregates%ROWTYPE;
  latest uuid;
  enabled boolean;
  admitted_at timestamptz;
BEGIN
  IF p_publication IS NULL OR jsonb_typeof(p_publication) <> 'object' THEN
    RAISE EXCEPTION 'sensing_publish_if_current: invalid publication';
  END IF;
  c := jsonb_populate_record(NULL::public.sensing_published_aggregates,p_publication);
  IF c.cohort_key IS NULL THEN RAISE EXCEPTION 'sensing_publish_if_current: missing cohort'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sensing-publication:' || c.cohort_key, 0));
  admitted_at := clock_timestamp();
  SELECT f.enabled INTO enabled FROM public.feature_flags f WHERE f.flag='sensing_publication_enabled' FOR SHARE;
  IF enabled IS DISTINCT FROM true THEN RETURN 'disabled'; END IF;
  SELECT id INTO latest FROM public.sensing_published_aggregates
    WHERE cohort_key=c.cohort_key AND expires_at > admitted_at
    ORDER BY published_at DESC, id DESC LIMIT 1;
  IF latest IS DISTINCT FROM p_expected_id THEN RETURN 'conflict'; END IF;
  IF c.expires_at <= admitted_at THEN RETURN 'expired'; END IF;
  INSERT INTO public.sensing_published_aggregates(
    cohort_key,zone_id,time_bucket,reduction_version,distinct_contributors,distinct_groups,
    max_group_share,contribution_count,median_signal_bucket,observed_at,published_at,expires_at
  ) VALUES (c.cohort_key,c.zone_id,c.time_bucket,c.reduction_version,c.distinct_contributors,c.distinct_groups,
    c.max_group_share,c.contribution_count,c.median_signal_bucket,c.observed_at,admitted_at,c.expires_at);
  RETURN 'stored';
END;
$$;
REVOKE ALL ON FUNCTION public.sensing_publish_if_current(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sensing_publish_if_current(uuid, jsonb) TO service_role;
DO $post$
DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.sensing_admit_contribution(text,integer,text[],jsonb)',
    'public.sensing_revoke_recent(text,jsonb)',
    'public.sensing_publish_if_current(uuid,jsonb)'
  ] LOOP
    IF to_regprocedure(signature) IS NULL
      OR has_function_privilege('anon',signature,'EXECUTE')
      OR has_function_privilege('authenticated',signature,'EXECUTE')
      OR NOT has_function_privilege('service_role',signature,'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: sensing privacy command must be service-role-only: %', signature;
    END IF;
  END LOOP;
END;
$post$;
COMMIT;
