-- Rollback for 2770_trip_plans_spec_columns.sql
--
-- Drops the five §5.1/§9.1 columns from trip_plan_items and the four
-- constraints that came with them.
--
-- DATA LOSS, AND IT IS NOT RECOVERABLE FROM WHAT REMAINS:
--   * privacy_scope collapses six §6.3 values into `visibility`'s two. A plan
--     scoped SELECTED_PARTICIPANTS, FRIENDS_NEARBY or TRIP is stored as
--     'members' and cannot be told from a CREW plan afterwards.
--   * stage_id, place_id, plan_scope and version are dropped outright.
-- `visibility` itself is untouched and every legacy reader keeps working, which
-- is the only reason this rollback is safe to run at all.
--
-- ORDER: after 2771's rollback if trip_plan_participants exists, because that
-- table references trip_plan_items — though not any of these columns, so the
-- order only matters if a later migration ties them together.
--
-- Rehearsed on db/harness/run.sh.

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid='public.trip_plan_items'::regclass AND attname='privacy_scope' AND NOT attisdropped;
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2770: privacy_scope is absent; 2770 was never applied here'; END IF;

  -- Say how much is about to be lost, by count, before losing it.
  SELECT count(*) INTO n FROM public.trip_plan_items
   WHERE privacy_scope NOT IN ('crew','public');
  IF n > 0 THEN
    RAISE WARNING 'rollback 2770: % row(s) carry a privacy_scope outside (crew, public). Their scope is about to be collapsed into visibility and cannot be recovered.', n;
  END IF;
  SELECT count(*) INTO n FROM public.trip_plan_items WHERE stage_id IS NOT NULL;
  IF n > 0 THEN
    RAISE WARNING 'rollback 2770: % row(s) are attached to a stage. That attachment is about to be dropped.', n;
  END IF;
END
$pre$;

ALTER TABLE public.trip_plan_items
  DROP CONSTRAINT trip_plan_items_visibility_agrees_with_scope,
  DROP CONSTRAINT trip_plan_items_version_nonnegative,
  DROP CONSTRAINT trip_plan_items_plan_scope_known,
  DROP CONSTRAINT trip_plan_items_privacy_scope_known;

DROP INDEX IF EXISTS public.idx_trip_plan_items_stage;

ALTER TABLE public.trip_plan_items
  DROP COLUMN version,
  DROP COLUMN plan_scope,
  DROP COLUMN privacy_scope,
  DROP COLUMN place_id,
  DROP COLUMN stage_id;

DO $post$
DECLARE n int; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stage_id','place_id','privacy_scope','plan_scope','version'] LOOP
    SELECT count(*) INTO n FROM pg_attribute
     WHERE attrelid='public.trip_plan_items'::regclass AND attname=t AND NOT attisdropped;
    IF n <> 0 THEN RAISE EXCEPTION 'rollback 2770: column % survived', t; END IF;
  END LOOP;

  -- 0010's own columns must be intact. A DROP COLUMN that took a neighbour
  -- would satisfy every check above.
  FOREACH t IN ARRAY ARRAY['id','trip_id','title','status','starts_at','ends_at',
                           'visibility','removed_at','sort_order','source_type','added_by'] LOOP
    SELECT count(*) INTO n FROM pg_attribute
     WHERE attrelid='public.trip_plan_items'::regclass AND attname=t AND NOT attisdropped;
    IF n <> 1 THEN RAISE EXCEPTION 'rollback 2770: 0010 column % was lost', t; END IF;
  END LOOP;
END
$post$;

COMMIT;
