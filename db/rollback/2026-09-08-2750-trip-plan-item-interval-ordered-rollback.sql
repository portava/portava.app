-- Rollback for 2750_trip_plan_item_interval_ordered.sql
--
-- Drops the ordering CHECK on trip_plan_items(starts_at, ends_at). Nothing else
-- is touched: 2750 adds exactly one constraint and creates no column, index,
-- policy or function.
--
-- Rehearsed on portava-ci 2026-09-08 — dropped, re-probed (an inverted interval
-- is accepted again, which is the point of rehearsing a rollback), re-applied.
--
-- Note what rolling back RESTORES: the ability to store a plan item that ends
-- before it starts. That is the pre-2750 state and is why the constraint exists.

BEGIN;

ALTER TABLE public.trip_plan_items
  DROP CONSTRAINT IF EXISTS trip_plan_items_interval_ordered;

DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint WHERE conname='trip_plan_items_interval_ordered';
  IF n <> 0 THEN RAISE EXCEPTION 'rollback 2750: constraint survived the drop (found %)', n; END IF;
END
$post$;

COMMIT;
