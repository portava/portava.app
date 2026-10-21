-- Rollback for 3880_airport_time_band_calibration.sql (census-layover L83/L247; Layover 165, lane B2-CURATE).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3880 DID (one transaction, additive):
--   * created public.airport_time_band_calibrations (FK airport_id -> airport_profiles ON DELETE CASCADE, its CHECKs,
--     UNIQUE (airport_id, fact_type, local_hour, calibration_version), the partial unique index airport_tbc_one_current),
--     RLS on, every privilege revoked from PUBLIC, anon, authenticated and service_role, then SELECT, INSERT, UPDATE granted to
--     service_role, a table comment, and trigger airport_time_band_calibrations_guard (function of the same name);
--   * added airport_profiles.calibrated_checkpoint_extra, calibration_expires_at, calibration_version, and trigger
--     airport_profiles_calibration_guard (function of the same name);
--   * created public.airport_calibration_apply(uuid, jsonb) (SECURITY INVOKER, service_role EXECUTE only).
-- It wrote no existing row (the three columns arrive NULL / NULL / 0). The only other row its apply wrote is the
-- applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: drops the two triggers, the three functions, the three columns and the table, deletes 3880's ledger
-- row (so the runner re-applies 3880 later), and asks PostgREST to reload its schema cache (delivered at the COMMIT).
-- The catalog is then the one before 3880. The engine then reads no calibrated band (AirportProfileService finds the
-- column absent and answers `calibratedCheckpointExtra: null`) and every deadline is the generic band's again.
--
-- DATA: IT REFUSES WHILE A CALIBRATION EXISTS — a row in airport_time_band_calibrations, or an airport_profiles row
-- carrying a calibrated band or a calibration_version above 0. A calibration is measured evidence (counts, error, the
-- step applied) that exists nowhere else; erasing it is a deliberate step, not a rollback's. To roll back anyway:
-- export the rows, then (as the table owner) DELETE FROM public.airport_time_band_calibrations; and, with
-- SET LOCAL portava.airport_curation_projection = 'on', UPDATE public.airport_profiles SET
-- calibrated_checkpoint_extra = NULL, calibration_expires_at = NULL, calibration_version = 0; then re-run this file.
--
-- Refuses, changing nothing, unless the installed state is exactly 3880's: the table, the three columns, both
-- triggers and all three functions present together (3880 makes them in one transaction), and nothing else depending
-- on the table. If none of them exists it changes nothing and clears only the (already absent) ledger row: a second
-- run is a no-op.
--
-- LOCK: ACCESS EXCLUSIVE on public.airport_profiles (DROP TRIGGER, DROP COLUMN) and on the table it drops, held until
-- the COMMIT; lock_timeout = 5s so it fails instead of queueing behind a long transaction. Run it in its own session:
-- psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_table int; v_cols int; v_trg int; v_fns int; v_n bigint; v_dep text;
BEGIN
  IF to_regclass('public.airport_profiles') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3880 rollback): public.airport_profiles and public.schema_migration_ledger must exist.';
  END IF;
  SELECT count(*) INTO v_table FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'airport_time_band_calibrations';
  SELECT count(*) INTO v_cols FROM pg_attribute WHERE attrelid = 'public.airport_profiles'::regclass AND NOT attisdropped
     AND attname IN ('calibrated_checkpoint_extra', 'calibration_expires_at', 'calibration_version');
  SELECT count(*) INTO v_trg FROM pg_trigger WHERE NOT tgisinternal
     AND tgname IN ('airport_profiles_calibration_guard', 'airport_time_band_calibrations_guard');
  SELECT count(*) INTO v_fns FROM pg_proc WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('airport_calibration_apply', 'airport_profiles_calibration_guard', 'airport_time_band_calibrations_guard');
  IF v_table = 0 AND v_cols = 0 AND v_trg = 0 AND v_fns = 0 THEN
    RAISE NOTICE '3880 rollback: none of 3880''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_table <> 1 OR v_cols <> 3 OR v_trg <> 2 OR v_fns <> 3 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3880): 3880''s objects are not each present exactly once (% of 1 table, % of 3 columns, % of 2 triggers, % of 3 functions). 3880 creates them all in one transaction, so this state was made by hand. Nothing was changed.', v_table, v_cols, v_trg, v_fns;
  END IF;
  SELECT string_agg(x, ', ') INTO v_dep FROM (
    SELECT DISTINCT r.ev_class::regclass::text AS x FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
     WHERE d.classid = 'pg_rewrite'::regclass AND d.refobjid = 'public.airport_time_band_calibrations'::regclass
    UNION
    SELECT DISTINCT conrelid::regclass::text FROM pg_constraint
     WHERE confrelid = 'public.airport_time_band_calibrations'::regclass AND conrelid <> confrelid) s;
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3880): % depend(s) on airport_time_band_calibrations and was not made by 3880. Nothing was changed.', v_dep;
  END IF;
  SELECT count(*) INTO v_n FROM public.airport_time_band_calibrations;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3880): public.airport_time_band_calibrations holds % calibration row(s) — measured evidence that exists nowhere else. Export and delete them deliberately first (see the header). Nothing was changed.', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.airport_profiles WHERE calibrated_checkpoint_extra IS NOT NULL OR calibration_version <> 0 OR calibration_expires_at IS NOT NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3880): % airport row(s) carry a calibrated band or a calibration version. Clear them deliberately first (see the header). Nothing was changed.', v_n;
  END IF;
END $pre$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3880_airport_time_band_calibration.sql';
NOTIFY pgrst, 'reload schema';

DO $rb$
BEGIN
  IF to_regclass('public.airport_time_band_calibrations') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE public.airport_time_band_calibrations IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.airport_time_band_calibrations) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3880): a calibration was written while this file ran; nothing is dropped. Nothing was changed.';
  END IF;
  LOCK TABLE public.airport_profiles IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.airport_profiles WHERE calibrated_checkpoint_extra IS NOT NULL OR calibration_version <> 0) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3880): an airport row gained a calibration while this file ran. Nothing was changed.';
  END IF;
  DROP TRIGGER airport_profiles_calibration_guard ON public.airport_profiles;
  DROP FUNCTION public.airport_profiles_calibration_guard();
  ALTER TABLE public.airport_profiles
    DROP COLUMN calibrated_checkpoint_extra,
    DROP COLUMN calibration_expires_at,
    DROP COLUMN calibration_version;
  DROP FUNCTION public.airport_calibration_apply(uuid, jsonb);
  DROP TABLE public.airport_time_band_calibrations;
  DROP FUNCTION public.airport_time_band_calibrations_guard();
END $rb$;

COMMIT;

DO $post$
DECLARE v_left text;
BEGIN
  IF to_regclass('public.airport_time_band_calibrations') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3880): public.airport_time_band_calibrations still exists.';
  END IF;
  SELECT string_agg(attname, ', ') INTO v_left FROM pg_attribute WHERE attrelid = 'public.airport_profiles'::regclass AND NOT attisdropped
     AND attname IN ('calibrated_checkpoint_extra', 'calibration_expires_at', 'calibration_version');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3880): airport_profiles still has column(s) %.', v_left;
  END IF;
  SELECT string_agg(proname, ', ') INTO v_left FROM pg_proc WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('airport_calibration_apply', 'airport_profiles_calibration_guard', 'airport_time_band_calibrations_guard');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3880): function(s) % still exist.', v_left;
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3880_airport_time_band_calibration.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3880): the ledger still records 3880 as applied.';
  END IF;
END $post$;
