-- Rollback for 2773_trip_snapshot_fold_and_replay.sql
--
-- Drops the six snapshot functions. trip_snapshots ROWS ARE LEFT ALONE — the
-- writer is what is removed, not the data, and a stored snapshot remains
-- readable as jsonb by anything that wants it.
--
-- What is lost is the ability to VERIFY one. After this file runs, a snapshot in
-- trip_snapshots is an assertion nobody can check against the event log, which
-- is worth knowing before running it.
--
-- ORDER: independent of the kernel chain. 2773 adds no branch and no dispatch;
-- nothing in trip_kernel_execute calls these functions.
--
-- Rehearsed on db/harness/run.sh.

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  IF to_regprocedure('public.trip_snapshot_fold(jsonb, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'rollback 2773: trip_snapshot_fold is absent; 2773 was never applied here';
  END IF;
  SELECT count(*) INTO n FROM public.trip_snapshots;
  IF n > 0 THEN
    RAISE WARNING 'rollback 2773: % stored snapshot(s) will remain, and nothing will be able to verify them against the event log.', n;
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.trip_snapshot_verify_replay(uuid, bigint);
DROP FUNCTION IF EXISTS public.trip_snapshot_write(uuid, bigint);
DROP FUNCTION IF EXISTS public.trip_snapshot_replay(uuid, jsonb, bigint, bigint);
DROP FUNCTION IF EXISTS public.trip_snapshot_fold_all(jsonb, jsonb[]);
DROP FUNCTION IF EXISTS public.trip_snapshot_fold(jsonb, jsonb);
DROP FUNCTION IF EXISTS public.trip_snapshot_seed(uuid);

DO $post$
DECLARE t text; n int;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_snapshot_seed','trip_snapshot_fold','trip_snapshot_fold_all',
                           'trip_snapshot_replay','trip_snapshot_write','trip_snapshot_verify_replay'] LOOP
    SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
     WHERE ns.nspname='public' AND p.proname=t;
    IF n <> 0 THEN RAISE EXCEPTION 'rollback 2773: % survived', t; END IF;
  END LOOP;

  -- The table and the kernel are untouched.
  IF to_regclass('public.trip_snapshots') IS NULL THEN
    RAISE EXCEPTION 'rollback 2773: trip_snapshots was dropped; that is 2763''s rollback, not this one';
  END IF;
  IF to_regprocedure('public.trip_kernel_execute(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'rollback 2773: trip_kernel_execute was dropped';
  END IF;
END
$post$;

COMMIT;
