-- Rollback for 3768_trips_current_stage_and_home_timezone.sql (census-trips TR77, §92).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- INVERSE TRANSFORM (2798's / 3979's method): the five insertions are removed by
-- anchor, each asserted to occur exactly once. Re-CREATEing the body would
-- discard any later migration that touched the function.
--
-- DATA: the two columns are DROPPED, together with every value written to them.
-- That loses each trip's stated home zone and its current-stage pointer. Nothing
-- else in the schema reads them, and the server treats an absent column as
-- "not available" (domain/trips/services/tripStageAnchors.ts), so the routes keep
-- working. Export the two columns first if they hold anything an owner wants.

BEGIN;

DO $rb$
DECLARE d text; n int; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 3768: trip_kernel_execute not found'; END IF;
  IF position('home_timezone' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 3768: the kernel does not name home_timezone; 3768 is not installed here';
  END IF;

  -- 1. the allow-list
  t := $a$'plan_edit_permission','progress','show_header_publicly','home_timezone'];$a$;
  IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 3768: allow-list anchor missing'; END IF;
  d := replace(d, t, $a$'plan_edit_permission','progress','show_header_publicly'];$a$);

  -- 2. the zone check (from its comment to the visibility check it was put in front of)
  IF d !~ $a$        -- 3768 \(census-trips TR77\): a home zone is.*?        IF v_patch \? 'visibility'$a$ THEN
    RAISE EXCEPTION 'rollback 3768: zone-check block not found';
  END IF;
  d := regexp_replace(d, $a$        -- 3768 \(census-trips TR77\): a home zone is.*?(        IF v_patch \? 'visibility')$a$, '\1', '');

  -- 3. the column write
  t := $a$          home_timezone            = CASE WHEN v_patch ? 'home_timezone'            THEN v_patch->>'home_timezone'                          ELSE home_timezone END,
$a$;
  IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 3768: column-write anchor missing'; END IF;
  d := replace(d, t, '');

  -- 4. START_STAGE / COMPLETE_STAGE
  t := $a$        -- 3768 (census-trips TR77): the trip's current-stage pointer is the stage the crew started last.
        IF v_type = 'START_STAGE' THEN
          UPDATE public.trips SET current_stage_id = v_stage_id WHERE id = v_trip_id;
        ELSE
          UPDATE public.trips SET current_stage_id = NULL WHERE id = v_trip_id AND current_stage_id = v_stage_id;
        END IF;
$a$;
  IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 3768: START/COMPLETE_STAGE block missing'; END IF;
  d := replace(d, t, '');

  -- 5. UPDATE_STAGE
  t := $a$        -- 3768 (census-trips TR77): a state patch moves the current-stage pointer as START/COMPLETE_STAGE do.
        IF v_patch ? 'state' THEN
          IF v_patch->>'state' = 'active' THEN
            UPDATE public.trips SET current_stage_id = v_stage_id WHERE id = v_trip_id;
          ELSE
            UPDATE public.trips SET current_stage_id = NULL WHERE id = v_trip_id AND current_stage_id = v_stage_id;
          END IF;
        END IF;
$a$;
  IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 3768: UPDATE_STAGE block missing'; END IF;
  d := replace(d, t, '');

  IF position('home_timezone' in d) > 0 OR position('current_stage_id' in d) > 0 OR position('3768' in d) > 0 THEN
    RAISE EXCEPTION 'rollback 3768: a trace of 3768 survived the inverse transform';
  END IF;
  EXECUTE d;
END
$rb$;

ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_current_stage_same_trip;
ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_home_timezone_shaped;
ALTER TABLE public.trip_stages DROP CONSTRAINT IF EXISTS trip_stages_id_trip_unique;
ALTER TABLE public.trips DROP COLUMN IF EXISTS current_stage_id;
ALTER TABLE public.trips DROP COLUMN IF EXISTS home_timezone;

DELETE FROM public.schema_migration_ledger WHERE filename = '3768_trips_current_stage_and_home_timezone.sql';

COMMIT;
