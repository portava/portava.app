-- Rollback for 3979_trip_kernel_admin_restore_participant_reissue.sql (census-trips §83; hotfix of 3974).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- SUPERSEDES db/rollback/2026-10-05-3974-trip-kernel-admin-restore-participant-rollback.sql wherever 3979
-- is recorded: the installed command is the same text whichever of 3974 (portava-ci) or 3979 (everywhere
-- else) installed it, so the inverse transform below is 3974's rollback verbatim; only the ledger row it
-- deletes differs.
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
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 3979: trip_kernel_execute not found'; END IF;
  IF position('ADMIN_RESTORE_PARTICIPANT' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 3979: ADMIN_RESTORE_PARTICIPANT is not present; neither 3974 nor 3979 installed it here';
  END IF;
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  d := regexp_replace(d, $a$      WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN.*?      WHEN 'ADMIN_HIDE_TRIP' THEN$a$, $a$      WHEN 'ADMIN_HIDE_TRIP' THEN$a$, '');
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 1 THEN RAISE EXCEPTION 'rollback 3979: the excision overran — it removed % command branches, expected exactly 1', branches_before - n; END IF;

  d := replace(d, $a$ WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN 'admin'$a$, '');
  d := replace(d, '  v_rec_day    date;' || E'\n' || '  v_rst_event  uuid;' || E'\n' || '  v_rst_seq    bigint;' || E'\n' || '  v_rst_access text;', '  v_rec_day    date;');
  IF position('ADMIN_RESTORE_PARTICIPANT' in d) > 0 OR position('v_rst_' in d) > 0 THEN
    RAISE EXCEPTION 'rollback 3979: a trace of 3974/3979 survived the inverse transform';
  END IF;
  EXECUTE d;
END
$rb$;

-- 3979's row goes, so the applier offers 3979 again (it would take its fresh-database path). 3974's row,
-- where it exists, is left: ORDER_OVERRIDES.json skips 3974, so nothing ever reads it as pending.
DELETE FROM public.schema_migration_ledger WHERE filename = '3979_trip_kernel_admin_restore_participant_reissue.sql';

COMMIT;
