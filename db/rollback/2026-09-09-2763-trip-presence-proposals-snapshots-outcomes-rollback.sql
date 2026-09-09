-- Rollback for 2763_trip_presence_proposals_snapshots_outcomes.sql
--
-- Drops trip_presence, trip_proposals, trip_snapshots and trip_outcomes. Safe
-- while nothing writes them, which is the state 2763 ships in.
--
-- trip_outcomes references trip_stages, so dropping it here is part of what
-- makes the 2760 rollback's precondition pass. No CASCADE.
--
-- Rehearsed on portava-ci 2026-09-09.

BEGIN;

DROP TABLE IF EXISTS public.trip_outcomes;
DROP TABLE IF EXISTS public.trip_snapshots;
DROP TABLE IF EXISTS public.trip_proposals;
DROP TABLE IF EXISTS public.trip_presence;

DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public'
     AND table_name IN ('trip_presence','trip_proposals','trip_snapshots','trip_outcomes');
  IF n <> 0 THEN RAISE EXCEPTION 'rollback 2763: % table(s) survived', n; END IF;

  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_stages';
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2763: trip_stages was removed; that is 2760''s rollback'; END IF;
END
$post$;

COMMIT;
