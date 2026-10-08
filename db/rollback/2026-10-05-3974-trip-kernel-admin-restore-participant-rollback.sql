-- Rollback for 3974_trip_kernel_admin_restore_participant.sql (census-trips §83, lane C).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- The INVERSE TRANSFORM (2798's rollback method): the one branch, the dispatch
-- entry and the three declarations are removed by anchor; re-CREATEing the body
-- would discard any later migration that touched the function.
--
-- DATA: none. A trip_members row a restore inserted stays — it is the person's
-- membership now, not this file's state. After this rollback the appeal path
-- refuses again with ADMIN_RESTORE_COMMAND_ABSENT (lane B's executor).

BEGIN;

DO $rb$
DECLARE d text; n int; branches_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 3974: trip_kernel_execute not found'; END IF;
  IF position('ADMIN_RESTORE_PARTICIPANT' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 3974: ADMIN_RESTORE_PARTICIPANT is not present; 3974 was never applied here';
  END IF;
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  d := regexp_replace(d, $a$      WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN.*?      WHEN 'ADMIN_HIDE_TRIP' THEN$a$, $a$      WHEN 'ADMIN_HIDE_TRIP' THEN$a$, '');
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 1 THEN RAISE EXCEPTION 'rollback 3974: the excision overran — it removed % command branches, expected exactly 1', branches_before - n; END IF;

  d := replace(d, $a$ WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN 'admin'$a$, '');
  d := replace(d, '  v_rec_day    date;' || E'\n' || '  v_rst_event  uuid;' || E'\n' || '  v_rst_seq    bigint;' || E'\n' || '  v_rst_access text;', '  v_rec_day    date;');
  IF position('ADMIN_RESTORE_PARTICIPANT' in d) > 0 OR position('v_rst_' in d) > 0 THEN
    RAISE EXCEPTION 'rollback 3974: a trace of 3974 survived the inverse transform';
  END IF;
  EXECUTE d;
END
$rb$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3974_trip_kernel_admin_restore_participant.sql';

COMMIT;
