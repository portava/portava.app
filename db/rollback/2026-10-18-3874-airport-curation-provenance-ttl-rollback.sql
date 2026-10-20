-- Rollback for 3874_airport_curation_provenance_ttl.sql (census-layover L14/L79/L80/L223; Layover 165, lane B2-CURATE).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- ORDER: roll back 3880 FIRST (db/rollback/2026-10-18-3880-airport-time-band-calibration-rollback.sql). 3880 follows
-- 3874's projection discipline; this file refuses while 3880's table exists.
--
-- WHAT 3874 DID (one transaction):
--   * created public.airport_curated_facts (FK airport_id -> airport_profiles ON DELETE CASCADE, four actor FKs ->
--     profiles ON DELETE SET NULL, a self FK superseded_by_fact_id, its CHECKs, UNIQUE (airport_id, fact_kind,
--     version), indexes airport_curated_facts_one_published and airport_curated_facts_history_idx), RLS on, every
--     privilege revoked from PUBLIC, anon, authenticated and service_role, then SELECT, INSERT, UPDATE granted to
--     service_role, a table comment, and trigger airport_curated_facts_guard (function of the same name);
--   * added to airport_profiles: legacy_verified, curated_timing_fact_id / _expires_at, curated_topology_fact_id /
--     _expires_at, curated_transport_fact_id / _expires_at (the three ids FK -> airport_curated_facts ON DELETE SET
--     NULL), topology_version, topology_changed_at, the GENERATED facts_provenance; and trigger
--     airport_profiles_curation_guard (function of the same name);
--   * created public.airport_curation_publish(uuid, uuid) and public.airport_curation_retract(uuid, uuid, text)
--     (SECURITY INVOKER, service_role EXECUTE only), each commented;
--   * EXISTING ROWS: copied `verified` into legacy_verified for rows where it was TRUE, then set `verified` FALSE on
--     those rows (none in production at writing: 0 of 3,206 verified).
--
-- WHAT THIS DOES: restores airport_profiles.verified from legacy_verified (the bare value a writer last supplied —
-- exactly what the column held before 3874 for every row 3874 changed, and what a writer asserted after it), then
-- drops the trigger, the functions, the eleven columns and the table, deletes 3874's ledger row, and asks PostgREST to
-- reload its schema cache (delivered at the COMMIT). The catalog is then the one before 3874. No buffer, terminal_info
-- or other airport value is touched. AirportProfileService then finds no curated reference and reads every airport
-- as uncurated (L0) — the fail-closed direction.
--
-- DATA: IT REFUSES WHILE ANY CURATED FACT EXISTS (a row in airport_curated_facts: proposals, validations, publications
-- and their history are curator work that exists nowhere else), and while any airport row carries a curated
-- reference. Export them and remove them deliberately first (as the table owner, with SET LOCAL
-- portava.airport_curation_projection = 'on' for the airport_profiles columns), then re-run this file.
-- topology_version and topology_changed_at are a derived counter and are dropped with the columns.
--
-- Refuses, changing nothing, unless the installed state is exactly 3874's (all objects present together), or none of
-- them is (then it clears only the already-absent ledger row: a second run is a no-op).
--
-- LOCK: ACCESS EXCLUSIVE on public.airport_profiles and public.airport_curated_facts, held until the COMMIT;
-- lock_timeout = 5s. Airport reads (search, session creation, every layover read) wait while it runs. Run it in its
-- own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_table int; v_cols int; v_trg int; v_fns int; v_n bigint; v_dep text;
BEGIN
  IF to_regclass('public.airport_profiles') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3874 rollback): public.airport_profiles and public.schema_migration_ledger must exist.';
  END IF;
  IF to_regclass('public.airport_time_band_calibrations') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3874): 3880 is applied (public.airport_time_band_calibrations exists). Roll back 3880 first. Nothing was changed.';
  END IF;
  SELECT count(*) INTO v_table FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'airport_curated_facts';
  SELECT count(*) INTO v_cols FROM pg_attribute WHERE attrelid = 'public.airport_profiles'::regclass AND NOT attisdropped
     AND attname IN ('legacy_verified', 'curated_timing_fact_id', 'curated_timing_expires_at', 'curated_topology_fact_id',
                     'curated_topology_expires_at', 'curated_transport_fact_id', 'curated_transport_expires_at',
                     'topology_version', 'topology_changed_at', 'facts_provenance');
  SELECT count(*) INTO v_trg FROM pg_trigger WHERE NOT tgisinternal
     AND tgname IN ('airport_profiles_curation_guard', 'airport_curated_facts_guard');
  SELECT count(*) INTO v_fns FROM pg_proc WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('airport_curation_publish', 'airport_curation_retract', 'airport_profiles_curation_guard', 'airport_curated_facts_guard');
  IF v_table = 0 AND v_cols = 0 AND v_trg = 0 AND v_fns = 0 THEN
    RAISE NOTICE '3874 rollback: none of 3874''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_table <> 1 OR v_cols <> 10 OR v_trg <> 2 OR v_fns <> 4 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3874): 3874''s objects are not each present exactly once (% of 1 table, % of 10 columns, % of 2 triggers, % of 4 functions). 3874 creates them all in one transaction, so this state was made by hand. Nothing was changed.', v_table, v_cols, v_trg, v_fns;
  END IF;
  SELECT string_agg(x, ', ') INTO v_dep FROM (
    SELECT DISTINCT r.ev_class::regclass::text AS x FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
     WHERE d.classid = 'pg_rewrite'::regclass AND d.refobjid = 'public.airport_curated_facts'::regclass
    UNION
    SELECT DISTINCT conrelid::regclass::text FROM pg_constraint
     WHERE confrelid = 'public.airport_curated_facts'::regclass AND conrelid NOT IN ('public.airport_curated_facts'::regclass, 'public.airport_profiles'::regclass)) s;
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3874): % depend(s) on airport_curated_facts and was not made by 3874. Nothing was changed.', v_dep;
  END IF;
  SELECT count(*) INTO v_n FROM public.airport_curated_facts;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3874): public.airport_curated_facts holds % curated fact row(s) — curator work and its history, which exist nowhere else. Export and remove them deliberately first (see the header). Nothing was changed.', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.airport_profiles
   WHERE curated_timing_fact_id IS NOT NULL OR curated_topology_fact_id IS NOT NULL OR curated_transport_fact_id IS NOT NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3874): % airport row(s) carry a curated reference. Nothing was changed.', v_n;
  END IF;
END $pre$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3874_airport_curation_provenance_ttl.sql';
NOTIFY pgrst, 'reload schema';

DO $rb$
BEGIN
  IF to_regclass('public.airport_curated_facts') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE public.airport_curated_facts IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE public.airport_profiles IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.airport_curated_facts) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3874): a curated fact was proposed while this file ran; nothing is dropped. Nothing was changed.';
  END IF;
  -- The trigger goes first, so restoring the bare value is not re-derived.
  DROP TRIGGER airport_profiles_curation_guard ON public.airport_profiles;
  DROP FUNCTION public.airport_profiles_curation_guard();
  UPDATE public.airport_profiles SET verified = legacy_verified WHERE verified IS DISTINCT FROM legacy_verified;
  ALTER TABLE public.airport_profiles
    DROP COLUMN facts_provenance,
    DROP COLUMN legacy_verified,
    DROP COLUMN curated_timing_fact_id,
    DROP COLUMN curated_timing_expires_at,
    DROP COLUMN curated_topology_fact_id,
    DROP COLUMN curated_topology_expires_at,
    DROP COLUMN curated_transport_fact_id,
    DROP COLUMN curated_transport_expires_at,
    DROP COLUMN topology_version,
    DROP COLUMN topology_changed_at;
  DROP FUNCTION public.airport_curation_publish(uuid, uuid);
  DROP FUNCTION public.airport_curation_retract(uuid, uuid, text);
  DROP TABLE public.airport_curated_facts;
  DROP FUNCTION public.airport_curated_facts_guard();
END $rb$;

COMMIT;

DO $post$
DECLARE v_left text;
BEGIN
  IF to_regclass('public.airport_curated_facts') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3874): public.airport_curated_facts still exists.';
  END IF;
  SELECT string_agg(attname, ', ') INTO v_left FROM pg_attribute WHERE attrelid = 'public.airport_profiles'::regclass AND NOT attisdropped
     AND attname IN ('legacy_verified', 'curated_timing_fact_id', 'curated_timing_expires_at', 'curated_topology_fact_id',
                     'curated_topology_expires_at', 'curated_transport_fact_id', 'curated_transport_expires_at',
                     'topology_version', 'topology_changed_at', 'facts_provenance');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3874): airport_profiles still has column(s) %.', v_left;
  END IF;
  SELECT string_agg(proname, ', ') INTO v_left FROM pg_proc WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('airport_curation_publish', 'airport_curation_retract', 'airport_profiles_curation_guard', 'airport_curated_facts_guard');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3874): function(s) % still exist.', v_left;
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3874_airport_curation_provenance_ttl.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3874): the ledger still records 3874 as applied.';
  END IF;
END $post$;
