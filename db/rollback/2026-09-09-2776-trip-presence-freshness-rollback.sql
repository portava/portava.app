-- Rollback for 2776_trip_presence_freshness_and_ordering.sql
--
-- Drops the §10.2 freshness view and function.
--
-- ORDER: BEFORE the 2767 rollback. The view reads trip_presence.source, so
-- 2767's DROP COLUMN refuses while it exists — which is Postgres doing the
-- ordering check for us, and is how this file came to be written in the right
-- place.
--
-- WHAT IS LOST: the single definition of live | recent | last_known | offline.
-- After this, every reader computes freshness itself, with its own thresholds,
-- which is how one surface shows a marker as live while another shows the same
-- row as stale — the §10.2 violation this migration exists to prevent.
--
-- DATA: none. The view holds nothing; trip_presence is untouched.
--
-- Rehearsed on db/harness/run.sh.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_presence_current') IS NULL THEN
    RAISE EXCEPTION 'rollback 2776: not applied here';
  END IF;
END
$pre$;

DROP VIEW public.trip_presence_current;
DROP FUNCTION IF EXISTS public.trip_presence_freshness(timestamptz, timestamptz, timestamptz);

DO $post$
DECLARE n int;
BEGIN
  IF to_regclass('public.trip_presence_current') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 2776: the view survived';
  END IF;
  IF to_regprocedure('public.trip_presence_freshness(timestamptz, timestamptz, timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 2776: the function survived';
  END IF;
  -- The table and its 2767 shape are untouched: a DROP that took the column
  -- with it would satisfy both checks above.
  IF to_regclass('public.trip_presence') IS NULL THEN
    RAISE EXCEPTION 'rollback 2776: trip_presence was dropped; that is 2763''s rollback';
  END IF;
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid='public.trip_presence'::regclass AND attname='source' AND NOT attisdropped;
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2776: trip_presence.source was lost'; END IF;
END
$post$;

COMMIT;
