-- 3880_airport_time_band_calibration.sql
-- §10 "Historical model — time-of-day distributions … RECALIBRATED" and §22 L4
-- "Calibrated — prediction errors measured, model calibrated by airport/time
-- band" (census-layover L83, L247). Layover 165 program, lane B2-CURATE.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band, gap number 3880).
-- WRITTEN, NOT APPLIED. Additive: one table, three airport_profiles columns,
-- one function, two triggers. No flag.
--
-- THE DEFECT: `LayoverAirportTruth.measureCalibration` MEASURES prediction error
-- and adjusts nothing; no calibrated band is stored anywhere, and the engine's
-- time-of-day band (`LayoverSafetyEngine.timeOfDayBand`) is one generic table
-- for every airport on earth.
--
-- WHAT THIS CREATES
--   public.airport_time_band_calibrations — one row per (airport, fact type,
--     local hour, calibration version): the calibrated p90 of the re-entry
--     checkpoint time at that airport-local hour, the PRIOR it was moved from,
--     the bounded STEP applied (|step| <= its bound; the arithmetic is a CHECK),
--     the evidence behind it (de-identified observation counts and the
--     observed p90; outcome counts: compliant returns and missed boardings),
--     the measured error (prior − observed, and outcome coverage), the
--     minimum-sample rule in force, the policy and truth versions, the window
--     the evidence came from, and a TTL (at most 90 days: "longer-lived but
--     recalibrated"). NO IDENTIFIER of a traveller, an observer, an observation
--     row or a session is stored — counts and percentiles only (§19.1 L204).
--     A recalibration SUPERSEDES the current row of its hour (history kept;
--     the API's service_role holds no DELETE; its INSERT/UPDATE are usable only
--     through the function — the guard trigger refuses any other write).
--   airport_profiles.calibrated_checkpoint_extra (jsonb: local hour → minutes)
--     — the EXTRA minutes, above what the engine already budgets at that hour,
--     that the current unexpired calibration adds; never negative, so a
--     calibration can tighten a deadline and can never relax one.
--     calibration_expires_at, calibration_version beside it.
--   public.airport_calibration_apply(p_airport_id uuid, p_bands jsonb) → jsonb
--     — the one writer: locks the airport row, supersedes and inserts per band,
--     rebuilds the projection from the current unexpired rows. SECURITY
--     INVOKER, search_path = pg_catalog, service_role only.
--   triggers: airport_time_band_calibrations_guard (rows are immutable except
--     superseded_at, set once; inserts only through the function) and
--     airport_profiles_calibration_guard (the projection columns are written
--     only by the function).
--
-- ORDER INDEPENDENCE: depends on public.airport_profiles (0127) and on 3874's
-- projection mode setting name (`portava.airport_curation_projection`), both
-- below 3880. Nothing numbered above 3880 names airport_profiles or any object
-- here (grep evidence in the lane handback).
--
-- ROLLBACK: db/rollback/2026-10-18-3880-airport-time-band-calibration-rollback.sql
-- (refuses while a calibration row exists; drops what this file made; deletes
-- this file's ledger row).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.airport_profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3880): public.airport_profiles (0127) must exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'airport_profiles_curation_guard' AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3880): apply 3874_airport_curation_provenance_ttl.sql first (its projection discipline is the one this file follows).';
  END IF;
END $pre$;

CREATE TABLE IF NOT EXISTS public.airport_time_band_calibrations (
  id                               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id                       uuid         NOT NULL REFERENCES public.airport_profiles(id) ON DELETE CASCADE,
  fact_type                        text         NOT NULL CHECK (fact_type IN ('checkpoint_timing_minutes')),
  local_hour                       smallint     NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
  calibration_version              integer      NOT NULL CHECK (calibration_version >= 1),

  prior_p90_minutes                numeric(6,2) NOT NULL CHECK (prior_p90_minutes BETWEEN 0 AND 240),
  target_p90_minutes               numeric(6,2) NOT NULL CHECK (target_p90_minutes BETWEEN 0 AND 240),
  step_applied_minutes             numeric(6,2) NOT NULL,
  step_bound_up_minutes            numeric(6,2) NOT NULL CHECK (step_bound_up_minutes > 0),
  step_bound_down_minutes          numeric(6,2) NOT NULL CHECK (step_bound_down_minutes > 0),
  calibrated_p90_minutes           numeric(6,2) NOT NULL CHECK (calibrated_p90_minutes BETWEEN 0 AND 240),
  engine_budget_minutes            numeric(6,2) NOT NULL CHECK (engine_budget_minutes BETWEEN 0 AND 240),
  extra_minutes                    numeric(6,2) NOT NULL CHECK (extra_minutes BETWEEN 0 AND 240),

  observation_samples              integer      NOT NULL CHECK (observation_samples >= 0),
  observation_distinct_observers   integer      NOT NULL CHECK (observation_distinct_observers >= 0),
  observed_p90_minutes             numeric(6,2) CHECK (observed_p90_minutes IS NULL OR observed_p90_minutes BETWEEN 0 AND 240),
  outcome_compliant_returns        integer      NOT NULL CHECK (outcome_compliant_returns >= 0),
  outcome_missed                   integer      NOT NULL CHECK (outcome_missed >= 0),
  mean_signed_error_minutes        numeric(7,2),
  outcome_coverage_rate            numeric(4,3) CHECK (outcome_coverage_rate IS NULL OR outcome_coverage_rate BETWEEN 0 AND 1),
  evidence                         text         NOT NULL CHECK (evidence IN ('observations','outcomes','observations_and_outcomes')),

  min_observation_samples          integer      NOT NULL CHECK (min_observation_samples >= 1),
  min_distinct_observers           integer      NOT NULL CHECK (min_distinct_observers >= 1),
  min_outcome_returns              integer      NOT NULL CHECK (min_outcome_returns >= 1),
  policy_version                   text         NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 40),
  truth_version                    text         NOT NULL CHECK (length(truth_version) BETWEEN 1 AND 40),

  window_start                     timestamptz  NOT NULL,
  window_end                       timestamptz  NOT NULL,
  computed_at                      timestamptz  NOT NULL DEFAULT now(),
  expires_at                       timestamptz  NOT NULL,
  superseded_at                    timestamptz,

  CONSTRAINT airport_tbc_step_bounded CHECK (
    step_applied_minutes <= step_bound_up_minutes AND step_applied_minutes >= -step_bound_down_minutes),
  CONSTRAINT airport_tbc_step_arithmetic CHECK (calibrated_p90_minutes = prior_p90_minutes + step_applied_minutes),
  CONSTRAINT airport_tbc_extra_arithmetic CHECK (extra_minutes = GREATEST(0, calibrated_p90_minutes - engine_budget_minutes)),
  CONSTRAINT airport_tbc_missed_le_returns CHECK (outcome_missed <= outcome_compliant_returns),
  CONSTRAINT airport_tbc_window CHECK (window_end > window_start AND window_end <= computed_at + interval '1 minute'),
  CONSTRAINT airport_tbc_ttl CHECK (expires_at > computed_at AND expires_at <= computed_at + interval '90 days'),
  CONSTRAINT airport_tbc_evidence_meets_rule CHECK (
    (evidence IN ('observations','observations_and_outcomes')
       AND observation_samples >= min_observation_samples AND observation_distinct_observers >= min_distinct_observers
       AND observed_p90_minutes IS NOT NULL)
    OR (evidence = 'outcomes' AND outcome_compliant_returns >= min_outcome_returns)),
  CONSTRAINT airport_tbc_both_evidence CHECK (
    evidence <> 'observations_and_outcomes' OR outcome_compliant_returns >= min_outcome_returns),
  CONSTRAINT airport_tbc_version_unique UNIQUE (airport_id, fact_type, local_hour, calibration_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS airport_tbc_one_current
  ON public.airport_time_band_calibrations(airport_id, fact_type, local_hour) WHERE superseded_at IS NULL;

ALTER TABLE public.airport_time_band_calibrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.airport_time_band_calibrations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.airport_time_band_calibrations FROM service_role;
-- INSERT/UPDATE for the SECURITY INVOKER writer below; the guard trigger refuses any write outside it.
GRANT SELECT, INSERT, UPDATE ON TABLE public.airport_time_band_calibrations TO service_role;

COMMENT ON TABLE public.airport_time_band_calibrations IS
  '3880: recalibrated time-of-day bands per airport and local hour (census L83/L247). Bounded step, minimum-sample rule, evidence counts and measured error; no identifiers. Written only by airport_calibration_apply(); superseded, never deleted, by the API.';

ALTER TABLE public.airport_profiles
  ADD COLUMN IF NOT EXISTS calibrated_checkpoint_extra jsonb CHECK (calibrated_checkpoint_extra IS NULL OR jsonb_typeof(calibrated_checkpoint_extra) = 'object'),
  ADD COLUMN IF NOT EXISTS calibration_expires_at      timestamptz,
  ADD COLUMN IF NOT EXISTS calibration_version         integer NOT NULL DEFAULT 0 CHECK (calibration_version >= 0);

CREATE OR REPLACE FUNCTION public.airport_time_band_calibrations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF coalesce(current_setting('portava.airport_curation_projection', true), '') <> 'on' THEN
    RAISE EXCEPTION 'airport_time_band_calibrations: written only by airport_calibration_apply()' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
       OR (to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at') THEN
      RAISE EXCEPTION 'airport_time_band_calibrations: a calibration is immutable; it is only superseded, once' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'airport_time_band_calibrations: a calibration is inserted current' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS airport_time_band_calibrations_guard ON public.airport_time_band_calibrations;
CREATE TRIGGER airport_time_band_calibrations_guard
  BEFORE INSERT OR UPDATE ON public.airport_time_band_calibrations
  FOR EACH ROW EXECUTE FUNCTION public.airport_time_band_calibrations_guard();

CREATE OR REPLACE FUNCTION public.airport_profiles_calibration_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF coalesce(current_setting('portava.airport_curation_projection', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.calibrated_checkpoint_extra := NULL; NEW.calibration_expires_at := NULL; NEW.calibration_version := 0;
    RETURN NEW;
  END IF;
  IF (NEW.calibrated_checkpoint_extra, NEW.calibration_expires_at, NEW.calibration_version)
     IS DISTINCT FROM (OLD.calibrated_checkpoint_extra, OLD.calibration_expires_at, OLD.calibration_version) THEN
    RAISE EXCEPTION 'airport_profiles: the calibrated bands are written only by airport_calibration_apply()' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS airport_profiles_calibration_guard ON public.airport_profiles;
CREATE TRIGGER airport_profiles_calibration_guard
  BEFORE INSERT OR UPDATE ON public.airport_profiles
  FOR EACH ROW EXECUTE FUNCTION public.airport_profiles_calibration_guard();

CREATE OR REPLACE FUNCTION public.airport_calibration_apply(p_airport_id uuid, p_bands jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  b        jsonb;
  v_ver    integer;
  v_hours  integer := 0;
  v_extra  jsonb;
  v_exp    timestamptz;
  v_cv     integer;
BEGIN
  IF p_bands IS NULL OR jsonb_typeof(p_bands) <> 'array' THEN
    RETURN jsonb_build_object('outcome', 'bad_bands');
  END IF;
  PERFORM 1 FROM public.airport_profiles WHERE id = p_airport_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'no_airport');
  END IF;
  PERFORM set_config('portava.airport_curation_projection', 'on', true);
  FOR b IN SELECT * FROM jsonb_array_elements(p_bands) LOOP
    SELECT coalesce(max(calibration_version), 0) + 1 INTO v_ver
      FROM public.airport_time_band_calibrations
     WHERE airport_id = p_airport_id AND fact_type = b->>'factType' AND local_hour = (b->>'localHour')::smallint;
    UPDATE public.airport_time_band_calibrations SET superseded_at = now()
     WHERE airport_id = p_airport_id AND fact_type = b->>'factType' AND local_hour = (b->>'localHour')::smallint
       AND superseded_at IS NULL;
    INSERT INTO public.airport_time_band_calibrations (
      airport_id, fact_type, local_hour, calibration_version,
      prior_p90_minutes, target_p90_minutes, step_applied_minutes, step_bound_up_minutes, step_bound_down_minutes,
      calibrated_p90_minutes, engine_budget_minutes, extra_minutes,
      observation_samples, observation_distinct_observers, observed_p90_minutes,
      outcome_compliant_returns, outcome_missed, mean_signed_error_minutes, outcome_coverage_rate, evidence,
      min_observation_samples, min_distinct_observers, min_outcome_returns, policy_version, truth_version,
      window_start, window_end, expires_at)
    VALUES (
      p_airport_id, b->>'factType', (b->>'localHour')::smallint, v_ver,
      (b->>'priorP90')::numeric, (b->>'targetP90')::numeric, (b->>'stepApplied')::numeric, (b->>'stepBoundUp')::numeric, (b->>'stepBoundDown')::numeric,
      (b->>'calibratedP90')::numeric, (b->>'engineBudget')::numeric, (b->>'extraMinutes')::numeric,
      (b->>'observationSamples')::integer, (b->>'observationDistinctObservers')::integer, (b->>'observedP90')::numeric,
      (b->>'outcomeCompliantReturns')::integer, (b->>'outcomeMissed')::integer, (b->>'meanSignedError')::numeric, (b->>'outcomeCoverageRate')::numeric, b->>'evidence',
      (b->>'minObservationSamples')::integer, (b->>'minDistinctObservers')::integer, (b->>'minOutcomeReturns')::integer, b->>'policyVersion', b->>'truthVersion',
      (b->>'windowStart')::timestamptz, (b->>'windowEnd')::timestamptz, (b->>'expiresAt')::timestamptz);
    v_hours := v_hours + 1;
  END LOOP;

  SELECT jsonb_object_agg(local_hour::text, extra_minutes ORDER BY local_hour), min(expires_at)
    INTO v_extra, v_exp
    FROM public.airport_time_band_calibrations
   WHERE airport_id = p_airport_id AND fact_type = 'checkpoint_timing_minutes'
     AND superseded_at IS NULL AND expires_at > now() AND extra_minutes > 0;
  UPDATE public.airport_profiles
     SET calibrated_checkpoint_extra = v_extra, calibration_expires_at = v_exp,
         calibration_version = calibration_version + 1, updated_at = now()
   WHERE id = p_airport_id
  RETURNING calibration_version INTO v_cv;
  PERFORM set_config('portava.airport_curation_projection', 'off', true);
  RETURN jsonb_build_object('outcome', 'applied', 'airportId', p_airport_id, 'bands', v_hours,
                            'calibrationVersion', v_cv, 'extra', coalesce(v_extra, '{}'::jsonb), 'expiresAt', v_exp);
END $fn$;

COMMENT ON FUNCTION public.airport_calibration_apply(uuid, jsonb) IS
  '3880: store recalibrated time-of-day bands for one airport (supersede + insert per hour) and rebuild airport_profiles.calibrated_checkpoint_extra from the current unexpired rows. service_role only.';
REVOKE ALL ON FUNCTION public.airport_calibration_apply(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.airport_time_band_calibrations_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.airport_profiles_calibration_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.airport_calibration_apply(uuid, jsonb) TO service_role;

COMMIT;

DO $post$
DECLARE v text;
BEGIN
  IF to_regclass('public.airport_time_band_calibrations') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3880): public.airport_time_band_calibrations was not created';
  END IF;
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.airport_time_band_calibrations'::regclass) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3880): RLS is not enabled on airport_time_band_calibrations';
  END IF;
  FOREACH v IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
    IF has_table_privilege('anon', 'public.airport_time_band_calibrations', v) OR has_table_privilege('authenticated', 'public.airport_time_band_calibrations', v) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3880): a client role holds % on airport_time_band_calibrations', v;
    END IF;
  END LOOP;
  IF has_table_privilege('service_role', 'public.airport_time_band_calibrations', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3880): service_role can delete calibrations -- the history would not be kept';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.airport_calibration_apply(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.airport_calibration_apply(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.airport_calibration_apply(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3880): airport_calibration_apply must be executable by service_role only';
  END IF;
  IF EXISTS (SELECT 1 FROM public.airport_profiles WHERE calibrated_checkpoint_extra IS NOT NULL OR calibration_version <> 0) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3880): an airport carries a calibration before any was applied';
  END IF;
  IF (public.airport_calibration_apply('00000000-0000-0000-0000-000000000000'::uuid, '[]'::jsonb)->>'outcome') <> 'no_airport' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3880): airport_calibration_apply did not answer no_airport for an unknown airport';
  END IF;
END $post$;
