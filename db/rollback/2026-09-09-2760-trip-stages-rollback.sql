-- Rollback for 2760_trip_stages.sql
--
-- Drops public.trip_stages. Safe while nothing writes it — which is the state
-- 2760 deliberately ships in (no client grants, no kernel command family yet).
-- Once trip_legs and trip_commitments reference it, THIS FILE IS NO LONGER
-- SUFFICIENT ON ITS OWN: those tables must be dropped first, or the drop fails
-- on their foreign keys. That is stated rather than papered over with CASCADE —
-- a CASCADE here would silently take referencing data with it.
--
-- Rehearsed on portava-ci 2026-09-09: dropped, re-created, probes re-run.

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE c.confrelid = 'public.trip_stages'::regclass AND c.contype = 'f';
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollback 2760: % table(s) still reference trip_stages — drop them first', n;
  END IF;
END
$pre$;

DROP TABLE IF EXISTS public.trip_stages;

DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_stages';
  IF n <> 0 THEN RAISE EXCEPTION 'rollback 2760: table survived the drop'; END IF;
END
$post$;

COMMIT;
