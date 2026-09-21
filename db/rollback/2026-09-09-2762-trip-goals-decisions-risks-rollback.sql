-- Rollback for 2762_trip_goals_decisions_risks.sql
--
-- Drops trip_goals, trip_decision_tasks and trip_risks. Safe while nothing
-- writes them, which is the state 2762 ships in. None is referenced by another
-- table, so no ordering constraint applies and no CASCADE is used.
--
-- Rehearsed on portava-ci 2026-09-09.

BEGIN;

DROP TABLE IF EXISTS public.trip_risks;
DROP TABLE IF EXISTS public.trip_decision_tasks;
DROP TABLE IF EXISTS public.trip_goals;

DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public'
     AND table_name IN ('trip_goals','trip_decision_tasks','trip_risks');
  IF n <> 0 THEN RAISE EXCEPTION 'rollback 2762: % table(s) survived', n; END IF;
END
$post$;

COMMIT;
