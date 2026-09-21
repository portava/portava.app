-- 2750_trip_plan_item_interval_ordered.sql
--
-- Trips v4 §4.4 "the command validates temporal consistency" (census-trips
-- TR54), the plan-item half.
--
-- WHAT IS ALREADY TRUE. The kernel checks this rule for the TRIP: CREATE_TRIP
-- and UPDATE_TRIP both refuse start_date > end_date with
-- TRIP_TEMPORAL_RANGE_INVERTED, and the UPDATE branch compares the MERGED value
-- rather than the patch's (2590, both sites).
--
-- WHAT IS NOT. A plan item's interval is never checked, by anything. ADD_PLAN
-- and every member of the UPDATE family write whatever starts_at / ends_at the
-- payload carried, and trip_plan_items has no CHECK on the pair — so the kernel
-- will persist a plan item that ENDS BEFORE IT STARTS. Measured read-only
-- against production 2026-09-08: 8 plan items, 0 with both timestamps set,
-- therefore 0 violating. Zero violations is not the same fact as forbidden.
--
-- WHY THIS FILE IS ONLY THE CONSTRAINT
-- ===================================
-- The typed refusal belongs in the kernel, and every kernel change in this repo
-- replaces trip_kernel_execute in full (2450, 2500, 2590 — the current
-- definition is 700 lines). Shipping a 700-line regenerated function I could not
-- rehearse end to end would be worse than shipping the guarantee and saying
-- where the rest lives. So:
--
--   HERE            the CHECK — the guarantee, for any writer that ever exists.
--                   "Only the kernel writes this table" is a property of today's
--                   callers, not of the schema.
--   lib/tripKernel  the typed TRIP_TEMPORAL_RANGE_INVERTED refusal, at the
--                   kernel's only entry point, so a caller gets a modelled
--                   rejection instead of a raw 23514 surfacing as a 500.
--
-- That split is real and is recorded rather than glossed: a service_role caller
-- invoking the RPC directly bypasses the typed refusal and meets the constraint
-- instead. It gets a correct outcome with a worse error. Folding the check into
-- the function is a follow-up that should ride along with the next migration
-- that replaces it for its own reasons — noted in census-trips TR54.
--
-- NOT VALID, deliberately. Production has zero violating rows so a validated
-- constraint would succeed there too, but this file must be correct on
-- databases nobody has measured, and a NOT VALID CHECK still refuses every
-- FUTURE write — convalidated = false does not mean unenforced. VALIDATE
-- CONSTRAINT is a separate cheap statement for whoever has measured them all.
--
-- ends_at = starts_at is ALLOWED. A zero-length item is a real thing (a
-- checkpoint, a border crossing, a booking that records only its moment);
-- forbidding it would be inventing a product rule under cover of a data rule.
-- Only ends_at < starts_at is refused.

BEGIN;

-- Precondition: the column pair exists and nothing already owns the name.
DO $pre$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='trip_plan_items'
     AND column_name IN ('starts_at','ends_at');
  IF n <> 2 THEN RAISE EXCEPTION '2750: trip_plan_items must carry starts_at and ends_at (found %)', n; END IF;

  SELECT count(*) INTO n FROM pg_constraint WHERE conname='trip_plan_items_interval_ordered';
  IF n <> 0 THEN RAISE EXCEPTION '2750: constraint name already taken (found %)', n; END IF;
END
$pre$;

ALTER TABLE public.trip_plan_items
  ADD CONSTRAINT trip_plan_items_interval_ordered
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at)
  NOT VALID;

-- Postcondition: it exists, it is a CHECK, and it is genuinely NOT VALID.
DO $post$
DECLARE c record;
BEGIN
  SELECT contype, convalidated INTO c FROM pg_constraint
   WHERE conname='trip_plan_items_interval_ordered'
     AND conrelid='public.trip_plan_items'::regclass;
  IF NOT FOUND        THEN RAISE EXCEPTION '2750: constraint absent after ADD'; END IF;
  IF c.contype <> 'c' THEN RAISE EXCEPTION '2750: constraint is % not a CHECK', c.contype; END IF;
  IF c.convalidated   THEN RAISE EXCEPTION '2750: constraint reports validated; this file adds it NOT VALID'; END IF;
END
$post$;

COMMIT;
