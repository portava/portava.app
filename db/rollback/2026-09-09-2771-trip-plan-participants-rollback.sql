-- Rollback for 2771_trip_plan_participants.sql
--
-- Drops trip_plan_participants. Safe while nothing writes it, which is the
-- state 2771 ships in; once 2772 lands, the 2772 rollback must run FIRST or the
-- kernel will dispatch JOIN_PLAN at a table that is not there.
--
-- DATA: every attendance row. There is no other record of who was going to a
-- plan — the trip_events ledger carries the transitions, but the current state
-- lives only here, so this is not recoverable from the schema that remains.
--
-- Rehearsed on db/harness/run.sh.

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  IF to_regclass('public.trip_plan_participants') IS NULL THEN
    RAISE EXCEPTION 'rollback 2771: trip_plan_participants does not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
              WHERE ns.nspname='public' AND p.proname='trip_kernel_execute'
                AND position('trip_plan_participants' in p.prosrc) > 0) THEN
    RAISE EXCEPTION 'rollback 2771: the kernel still dispatches at this table. Run the 2772 rollback first, or JOIN_PLAN will hit a missing relation at runtime.';
  END IF;
  SELECT count(*) INTO n FROM public.trip_plan_participants;
  IF n > 0 THEN
    RAISE WARNING 'rollback 2771: % attendance row(s) are about to be dropped. The trip_events ledger keeps the transitions; the current state exists only here.', n;
  END IF;
END
$pre$;

DROP TABLE public.trip_plan_participants;

DO $post$
DECLARE n int; t text;
BEGIN
  IF to_regclass('public.trip_plan_participants') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 2771: the table survived';
  END IF;
  -- The plan aggregate must be untouched. A CASCADE would have taken it.
  IF to_regclass('public.trip_plan_items') IS NULL THEN
    RAISE EXCEPTION 'rollback 2771: trip_plan_items was removed; that is 0010, not this migration';
  END IF;
  FOREACH t IN ARRAY ARRAY['id','trip_id','title','status','privacy_scope','plan_scope','version'] LOOP
    SELECT count(*) INTO n FROM pg_attribute
     WHERE attrelid='public.trip_plan_items'::regclass AND attname=t AND NOT attisdropped;
    IF n <> 1 THEN RAISE EXCEPTION 'rollback 2771: trip_plan_items column % was lost', t; END IF;
  END LOOP;
END
$post$;

COMMIT;
