-- Rollback for 2761_trip_legs_and_commitments.sql
--
-- Drops public.trip_legs and public.trip_commitments. Safe while nothing writes
-- them, which is the state 2761 ships in (no client write grants, no kernel
-- command family yet).
--
-- ORDER MATTERS AND IS NOT CASCADE. Both reference trip_stages; dropping them
-- here is what makes the 2760 rollback's precondition pass. No DROP ... CASCADE
-- anywhere in this file: a CASCADE would take referencing data with it silently,
-- and the point of a rollback is that you can see what it removes.
--
-- Rehearsed on portava-ci 2026-09-09.

BEGIN;

DROP TABLE IF EXISTS public.trip_commitments;
DROP TABLE IF EXISTS public.trip_legs;

DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name IN ('trip_legs','trip_commitments');
  IF n <> 0 THEN RAISE EXCEPTION 'rollback 2761: % table(s) survived the drop', n; END IF;

  -- trip_stages must be untouched: this rollback is 2761's, not 2760's.
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_stages';
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2761: trip_stages was removed; that is 2760''s rollback'; END IF;
END
$post$;

COMMIT;
