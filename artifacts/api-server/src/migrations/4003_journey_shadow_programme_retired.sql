-- 4003_journey_shadow_programme_retired.sql
--
-- Written 2026-11-05 on the owner's decision over the 50 production objects
-- check:undeclared-production-objects still carried as owner-pending after
-- 4001/4002 ("approve all calls on 50 journey shadow objects", 00:29 UTC,
-- delegating the call to the recommendation on record: retire). Retires the
-- dormant journey-shadow programme from production: nine tables, six columns
-- on location_sessions and user_location_preferences, the 35 functions the
-- ratchet names, 2976's global_journey_shadow_stop_v1 (the one function of the
-- programme a file in this tree describes), every trigger that calls a
-- programme function wherever it sits, and the three COMPASS_JOURNEY_* feature
-- flag rows that only the programme read.
--
-- WHERE IT CAME FROM. Migration 2127 on branch fix/rls-hardening-signin-flake,
-- never merged to main, applied to production anyway (2976's header establishes
-- this; docs/architecture/census-media.md, "Note (2026-10-24, capability
-- refresh, PR #788)", item 3, records every object with its definition digest).
-- Its callers (routes/adminJourney.ts, services/journey/*) live on that branch
-- and nowhere in this tree: nothing in main reads or writes any of it, and no
-- other artifact in this repository names any of it. Measured dormant on
-- production 2026-09-21 and again at the 2026-11-04 capture: every
-- observation, segment, cohort, stage, issuance, ground-truth and revocation
-- table empty, one row in journey_retention_health (job-health counters, no
-- user column), no location session with journey_purpose =
-- 'journey_observation_v1', no preference row with journey_observation_enabled,
-- every COMPASS_JOURNEY_* flag disabled, and no code on main reading those
-- flags (the 2026-11-05 flag census).
--
-- WHAT IT REFUSES, AND WHY THAT IS THE DESIGN. This file was written without a
-- production read (none is permitted from the session that wrote it), so it
-- does not assume the programme is still dormant: it checks, and it stops
-- rather than erase. The $pre$ block raises when any programme table other than
-- journey_retention_health holds a row, when any location session carries the
-- programme's purpose, when any preference row has the observation switch on,
-- when a COMPASS_JOURNEY_* flag is enabled or is one this file does not know,
-- when a function outside the programme names a programme object in its body,
-- or when a view or a foreign key outside the programme depends on a programme
-- table or column. Every DROP below is without CASCADE for the same reason: a
-- dependency this file did not foresee aborts the apply instead of being taken
-- down with the programme. A refusal leaves production exactly as it was (the
-- body is one transaction) and names what it found; the owner decides, and this
-- file is edited, not forced.
--
-- WHAT IT DOES, BY STARTING SHAPE
--   production     drops the programme: 9 tables, 6 columns (their CHECKs
--                  location_sessions_journey_purpose_check and
--                  user_location_preferences_journey_con go with them), 36
--                  functions, their triggers, 3 flag rows, and the one row of
--                  journey_retention_health, whose content the $pre$ block
--                  prints as a NOTICE first so the apply log keeps it.
--   portava-ci,    none of it exists (the chain never created it; 2976 refuses
--   local chain    to create its stop from nothing): every statement is
--                  IF EXISTS or finds nothing, and the file is a strict no-op
--                  apart from the ledger row. The postconditions read only.
--
-- WHAT IT DOES NOT TOUCH. lib/locationPurposes.ts's journey_observation purpose
-- and 3753's purpose CHECK on trip_crew_location_sessions (an application
-- purpose id, not a column of this programme); lib/d6Classifications.ts and
-- lib/deletionDispositions.ts's journey_* rows; and the 50 ratchet entries
-- themselves (now decision "drop"), which are struck the day a production
-- capture no longer holds them, together with those rows. 2976 stays in the
-- chain unchanged: it is gated on the stop's presence and no-ops once the stop
-- is gone, and its SECURITY_DEFINER_ORACLES.json entry goes with this file.
--
-- The body runs inside BEGIN/COMMIT; the postconditions follow the COMMIT as
-- read-only DO blocks, the shape scripts/src/apply-migrations.ts applies and
-- certify:migrations stage 4 re-runs. The $pre$ block is a precondition in the
-- house sense (held back by stage 4) and tolerates the post-state anyway: on a
-- second apply, and on any database without the programme, it finds nothing
-- and says so.

BEGIN;

-- ── Premises: still dormant, and nothing outside the programme depends on it ─
DO $pre$
DECLARE
  programme_tables constant text[] := ARRAY[
    'journey_observations', 'journey_retention_health', 'journey_revocation_jobs',
    'journey_segment_revisions', 'journey_shadow_cohort_assignments', 'journey_shadow_ground_truth',
    'journey_shadow_qa_reports', 'journey_shadow_session_issuances', 'journey_shadow_stages'];
  known_flags constant text[] := ARRAY[
    'COMPASS_JOURNEY_ENGINE_ENABLED', 'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
    'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED'];
  t text;
  n bigint;
  health text;
  names text[];
  found text[] := ARRAY[]::text[];
BEGIN
  -- Rows. The job-health counters are reported, not refused: they describe
  -- the retention job, not a person, and the NOTICE keeps them in the apply log.
  FOREACH t IN ARRAY programme_tables LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    IF t = 'journey_retention_health' THEN
      EXECUTE format('SELECT string_agg(row_to_json(h)::text, '' | '') FROM public.%I h', t) INTO health;
      RAISE NOTICE '4003: journey_retention_health holds % row(s), kept here and nowhere else: %', n, coalesce(health, '(none)');
    ELSIF n > 0 THEN
      found := found || format('%s holds %s row(s)', t, n);
    END IF;
  END LOOP;

  -- An open programme session, or a preference row that consents.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'location_sessions' AND column_name = 'journey_purpose') THEN
    EXECUTE 'SELECT count(*) FROM public.location_sessions WHERE journey_purpose = ''journey_observation_v1''' INTO n;
    IF n > 0 THEN found := found || format('%s location session(s) carry journey_purpose = journey_observation_v1', n); END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'user_location_preferences' AND column_name = 'journey_observation_enabled') THEN
    EXECUTE 'SELECT count(*) FROM public.user_location_preferences WHERE journey_observation_enabled' INTO n;
    IF n > 0 THEN found := found || format('%s preference row(s) have journey_observation_enabled on', n); END IF;
  END IF;

  -- A programme flag that is on, or one this file does not know.
  SELECT coalesce(array_agg(flag ORDER BY flag), ARRAY[]::text[]) INTO names
    FROM public.feature_flags WHERE flag ~ '^COMPASS_JOURNEY_' AND (enabled OR NOT (flag = ANY (known_flags)));
  IF array_length(names, 1) IS NOT NULL THEN
    found := found || format('COMPASS_JOURNEY flag(s) enabled or unknown to this file: %s', array_to_string(names, ', '));
  END IF;

  -- A function outside the programme whose body names a programme object.
  SELECT coalesce(array_agg(p.proname::text ORDER BY p.proname), ARRAY[]::text[]) INTO names
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname NOT LIKE '%journey%'
     AND p.prosrc ~ 'journey_(observations|retention_health|revocation_jobs|segment_revisions|shadow_|purpose|observation_enabled|consent_)';
  IF array_length(names, 1) IS NOT NULL THEN
    found := found || format('function(s) outside the programme name a programme object: %s', array_to_string(names, ', '));
  END IF;

  -- A view, anywhere, that depends on a programme table or a programme column.
  SELECT coalesce(array_agg(DISTINCT v.relname::text ORDER BY v.relname::text), ARRAY[]::text[]) INTO names
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
    JOIN pg_class v ON v.oid = r.ev_class
    JOIN pg_class ref ON ref.oid = d.refobjid AND d.refclassid = 'pg_class'::regclass
    LEFT JOIN pg_attribute a ON a.attrelid = ref.oid AND a.attnum = d.refobjsubid AND d.refobjsubid > 0
   WHERE v.oid <> ref.oid
     AND ref.relnamespace = 'public'::regnamespace
     AND ((ref.relname = ANY (programme_tables))
          OR (ref.relname IN ('location_sessions', 'user_location_preferences') AND a.attname LIKE 'journey%'));
  IF array_length(names, 1) IS NOT NULL THEN
    found := found || format('view(s) depend on the programme: %s', array_to_string(names, ', '));
  END IF;

  -- A foreign key from outside the programme into it.
  SELECT coalesce(array_agg(k.conname::text ORDER BY k.conname::text), ARRAY[]::text[]) INTO names
    FROM pg_constraint k
    JOIN pg_class child ON child.oid = k.conrelid
    JOIN pg_class parent ON parent.oid = k.confrelid
   WHERE k.contype = 'f'
     AND parent.relnamespace = 'public'::regnamespace AND parent.relname = ANY (programme_tables)
     AND NOT (child.relnamespace = 'public'::regnamespace AND child.relname = ANY (programme_tables));
  IF array_length(names, 1) IS NOT NULL THEN
    found := found || format('foreign key(s) from outside the programme into it: %s', array_to_string(names, ', '));
  END IF;

  IF array_length(found, 1) IS NOT NULL THEN
    RAISE EXCEPTION '4003: the journey-shadow programme is not dormant or not isolated, so this file refuses to retire it and changes nothing. Found: %. The owner decides; edit this file, do not force it.',
      array_to_string(found, '; ');
  END IF;
  RAISE NOTICE '4003: premises hold (no programme rows but the health counters, no programme session, no consenting preference, no enabled flag, no outside dependant); retiring.';
END
$pre$;

-- ── Triggers that call a programme function, wherever they sit ───────────────
-- The programme's purge triggers sit on location_sessions and
-- user_location_preferences, which stay; a trigger on a programme table would
-- go with the table. Found by the function they call, not by a name this tree
-- never recorded.
DO $mig$
DECLARE
  programme_functions constant text[] := ARRAY[
    '_journey_shadow_jsonb_has_forbidden_keys', '_journey_shadow_jsonb_has_forbidden_keys_deep',
    '_journey_shadow_require_admin_actor', 'aggregate_journey_shadow_observations_v1',
    'aggregate_journey_shadow_segment_revisions_v1', 'append_journey_segment_revisions',
    'append_journey_segment_revisions_v2', 'assign_journey_shadow_cohort_v1', 'begin_journey_retention_cycle_v1',
    'claim_journey_revocation_jobs_v1', 'complete_journey_revocation_job_v1', 'configure_journey_shadow_stage_v1',
    'delete_journey_observations_for_user_v1', 'delete_journey_segments_for_user', 'delete_journey_shadow_rows_v1',
    'fail_journey_revocation_job_v1', 'finish_journey_retention_cycle_v1', 'finish_journey_retention_cycle_v2',
    'global_journey_shadow_stop_v1', 'ingest_journey_observation_v1', 'ingest_journey_observation_v2',
    'is_valid_journey_world_ref', 'issue_journey_shadow_session_v1', 'journey_shadow_authorize_v1',
    'persist_journey_shadow_qa_report_v1', 'prevent_journey_observation_update',
    'purge_expired_journey_shadow_table_v1', 'purge_journey_observations_on_consent_revocation',
    'purge_journey_observations_on_session_revocation', 'read_journey_shadow_observations_v1',
    'read_journey_shadow_qa_observations_v1', 'read_journey_shadow_qa_segment_revisions_v1',
    'record_journey_shadow_ground_truth_v1', 'revoke_journey_consent_and_delete_segments',
    'revoke_journey_shadow_cohort_v1', 'set_journey_observation_consent_v1'];
  r record;
BEGIN
  FOR r IN
    SELECT tg.tgname, ns.nspname, c.relname
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = tg.tgfoid
      JOIN pg_namespace pns ON pns.oid = p.pronamespace
     WHERE NOT tg.tgisinternal AND pns.nspname = 'public' AND p.proname = ANY (programme_functions)
     ORDER BY c.relname, tg.tgname
  LOOP
    RAISE NOTICE '4003: removing trigger % on %.%', r.tgname, r.nspname, r.relname;
    EXECUTE format('DROP TRIGGER %I ON %I.%I', r.tgname, r.nspname, r.relname);
  END LOOP;
END
$mig$;

-- ── The nine tables, in one statement so their own foreign keys do not matter ─
DROP TABLE IF EXISTS
  public.journey_observations,
  public.journey_retention_health,
  public.journey_revocation_jobs,
  public.journey_segment_revisions,
  public.journey_shadow_cohort_assignments,
  public.journey_shadow_ground_truth,
  public.journey_shadow_qa_reports,
  public.journey_shadow_session_issuances,
  public.journey_shadow_stages;

-- ── The six columns; their CHECKs and any index on them go with them ─────────
ALTER TABLE public.location_sessions DROP COLUMN IF EXISTS journey_purpose;
ALTER TABLE public.user_location_preferences
  DROP COLUMN IF EXISTS journey_observation_enabled,
  DROP COLUMN IF EXISTS journey_consent_scope,
  DROP COLUMN IF EXISTS journey_consent_version,
  DROP COLUMN IF EXISTS journey_consent_granted_at,
  DROP COLUMN IF EXISTS journey_consent_revoked_at;

-- ── The functions ────────────────────────────────────────────────────────────
-- The stop is named at top level so the text readers that know it from 2976
-- (check:security-definer-oracles) see it leave. Every programme function,
-- the stop included, is then found by name in the catalogue and dropped with
-- its own identity arguments, so an overload this tree never recorded cannot
-- survive on a signature mismatch.
DROP FUNCTION IF EXISTS public.global_journey_shadow_stop_v1(uuid);

DO $mig$
DECLARE
  programme_functions constant text[] := ARRAY[
    '_journey_shadow_jsonb_has_forbidden_keys', '_journey_shadow_jsonb_has_forbidden_keys_deep',
    '_journey_shadow_require_admin_actor', 'aggregate_journey_shadow_observations_v1',
    'aggregate_journey_shadow_segment_revisions_v1', 'append_journey_segment_revisions',
    'append_journey_segment_revisions_v2', 'assign_journey_shadow_cohort_v1', 'begin_journey_retention_cycle_v1',
    'claim_journey_revocation_jobs_v1', 'complete_journey_revocation_job_v1', 'configure_journey_shadow_stage_v1',
    'delete_journey_observations_for_user_v1', 'delete_journey_segments_for_user', 'delete_journey_shadow_rows_v1',
    'fail_journey_revocation_job_v1', 'finish_journey_retention_cycle_v1', 'finish_journey_retention_cycle_v2',
    'global_journey_shadow_stop_v1', 'ingest_journey_observation_v1', 'ingest_journey_observation_v2',
    'is_valid_journey_world_ref', 'issue_journey_shadow_session_v1', 'journey_shadow_authorize_v1',
    'persist_journey_shadow_qa_report_v1', 'prevent_journey_observation_update',
    'purge_expired_journey_shadow_table_v1', 'purge_journey_observations_on_consent_revocation',
    'purge_journey_observations_on_session_revocation', 'read_journey_shadow_observations_v1',
    'read_journey_shadow_qa_observations_v1', 'read_journey_shadow_qa_segment_revisions_v1',
    'record_journey_shadow_ground_truth_v1', 'revoke_journey_consent_and_delete_segments',
    'revoke_journey_shadow_cohort_v1', 'set_journey_observation_consent_v1'];
  r record;
BEGIN
  FOR r IN
    SELECT ns.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = ANY (programme_functions)
     ORDER BY p.proname, 3
  LOOP
    RAISE NOTICE '4003: removing function %.%(%)', r.nspname, r.proname, r.args;
    EXECUTE format('DROP FUNCTION %I.%I(%s)', r.nspname, r.proname, r.args);
  END LOOP;
END
$mig$;

-- ── The three flag rows only the programme read (all disabled, per the premises) ─
DELETE FROM public.feature_flags
 WHERE flag IN ('COMPASS_JOURNEY_ENGINE_ENABLED', 'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
                'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED')
   AND enabled = false;

COMMIT;

-- ── Postconditions: read only ───────────────────────────────────────────────
DO $do$
DECLARE
  t text;
  n int;
  remaining text[] := ARRAY[]::text[];
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'journey_observations', 'journey_retention_health', 'journey_revocation_jobs',
    'journey_segment_revisions', 'journey_shadow_cohort_assignments', 'journey_shadow_ground_truth',
    'journey_shadow_qa_reports', 'journey_shadow_session_issuances', 'journey_shadow_stages'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN remaining := remaining || ('table ' || t); END IF;
  END LOOP;
  FOR t IN
    SELECT table_name || '.' || column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN ('location_sessions', 'user_location_preferences')
       AND column_name LIKE 'journey%' ORDER BY 1
  LOOP
    remaining := remaining || ('column ' || t);
  END LOOP;
  FOR t IN
    SELECT conname::text FROM pg_constraint
     WHERE conname IN ('location_sessions_journey_purpose_check', 'user_location_preferences_journey_con') ORDER BY 1
  LOOP
    remaining := remaining || ('constraint ' || t);
  END LOOP;
  FOR t IN
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = ANY (ARRAY[
       '_journey_shadow_jsonb_has_forbidden_keys', '_journey_shadow_jsonb_has_forbidden_keys_deep',
       '_journey_shadow_require_admin_actor', 'aggregate_journey_shadow_observations_v1',
       'aggregate_journey_shadow_segment_revisions_v1', 'append_journey_segment_revisions',
       'append_journey_segment_revisions_v2', 'assign_journey_shadow_cohort_v1', 'begin_journey_retention_cycle_v1',
       'claim_journey_revocation_jobs_v1', 'complete_journey_revocation_job_v1', 'configure_journey_shadow_stage_v1',
       'delete_journey_observations_for_user_v1', 'delete_journey_segments_for_user', 'delete_journey_shadow_rows_v1',
       'fail_journey_revocation_job_v1', 'finish_journey_retention_cycle_v1', 'finish_journey_retention_cycle_v2',
       'global_journey_shadow_stop_v1', 'ingest_journey_observation_v1', 'ingest_journey_observation_v2',
       'is_valid_journey_world_ref', 'issue_journey_shadow_session_v1', 'journey_shadow_authorize_v1',
       'persist_journey_shadow_qa_report_v1', 'prevent_journey_observation_update',
       'purge_expired_journey_shadow_table_v1', 'purge_journey_observations_on_consent_revocation',
       'purge_journey_observations_on_session_revocation', 'read_journey_shadow_observations_v1',
       'read_journey_shadow_qa_observations_v1', 'read_journey_shadow_qa_segment_revisions_v1',
       'record_journey_shadow_ground_truth_v1', 'revoke_journey_consent_and_delete_segments',
       'revoke_journey_shadow_cohort_v1', 'set_journey_observation_consent_v1'])
     ORDER BY 1
  LOOP
    remaining := remaining || ('function ' || t);
  END LOOP;
  FOR t IN
    SELECT tg.tgname || ' on ' || c.relname
      FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_proc p ON p.oid = tg.tgfoid
     WHERE NOT tg.tgisinternal AND p.proname LIKE '%journey%' ORDER BY 1
  LOOP
    remaining := remaining || ('trigger ' || t);
  END LOOP;
  SELECT count(*) INTO n FROM public.feature_flags
   WHERE flag IN ('COMPASS_JOURNEY_ENGINE_ENABLED', 'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
                  'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED');
  IF n > 0 THEN remaining := remaining || format('%s COMPASS_JOURNEY flag row(s)', n); END IF;
  IF array_length(remaining, 1) IS NOT NULL THEN
    RAISE EXCEPTION '4003: postcondition failed, the programme is still partly installed: %', array_to_string(remaining, ', ');
  END IF;
END $do$;

-- The two host tables and the flag table are intact: the file removed columns,
-- not tables, and nothing else.
DO $do$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'location_sessions' AND column_name = 'expires_at') THEN missing := missing || 'location_sessions.expires_at'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'location_sessions' AND column_name = 'session_type') THEN missing := missing || 'location_sessions.session_type'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_location_preferences' AND column_name = 'location_mode') THEN missing := missing || 'user_location_preferences.location_mode'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_location_preferences' AND column_name = 'sharing_paused') THEN missing := missing || 'user_location_preferences.sharing_paused'; END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN missing := missing || 'feature_flags'; END IF;
  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION '4003: postcondition failed, a host object is missing: %', array_to_string(missing, ', ');
  END IF;
END $do$;
