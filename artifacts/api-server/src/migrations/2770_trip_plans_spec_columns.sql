-- 2770_trip_plans_spec_columns.sql
--
-- Closes census-trips TR82 by giving `public.trip_plan_items` the columns §5.1
-- specifies for `trip_plans`, plus the §9.1 plan scope. It does NOT create a
-- table called trip_plans, and that is the whole point of the file.
--
-- THERE IS ONE PLAN AGGREGATE, AND IT IS ALREADY HERE
-- ===================================================
-- §5.1 names the row `trip_plans`:
--   id, trip_id, stage_id, status, starts_at, ends_at, place_id,
--   privacy_scope, source_type, version
-- The deployed table is `trip_plan_items` (0010) and it already carries id,
-- trip_id, status, starts_at, ends_at and source_type. Every kernel command in
-- the plan family (ADD_PLAN, UPDATE_PLAN, MOVE_PLAN, CONFIRM_PLAN, CANCEL_PLAN,
-- REMOVE_PLAN, REORDER_PLAN, LINK_PLAN_ROUTE_STOP, COMPLETE_ACTIVITY) writes
-- it, every §4.2 plan event (`trip.plan_added`, `trip.plan_moved`, …) describes
-- it, and `trip_outcomes.plan_id` (2763) points at it.
--
-- census-trips TR82 already recorded this reading — it marks `trip_plans` W and
-- names `trip_plan_items` as the artifact, listing exactly the columns missing.
-- This is the same pattern §5.1 has for participants, where the spec says
-- `trip_participants` and the deployed table is `trip_members` (TR80, also W).
--
-- Creating a second table would create a SECOND AGGREGATE ROOT for one concept:
-- two id spaces for "a plan", with `trip_outcomes.plan_id`, the kernel's plan
-- family and the whole §4.2 event vocabulary pointing at the old one. That is
-- the divergence §1 exists to prevent, and it is not made better by giving the
-- new table the spec's name.
--
-- (census-trips §27 said TR83 was "blocked on trip_plans not existing". That
-- contradicted TR82 in the same document and was wrong; §29 corrects it.
-- `trip_plan_participants` is keyed on this table, and 2771 builds it.)
--
-- WHAT IS ADDED, AND WHY EACH ONE IS NOT A CONVENIENCE
-- ====================================================
--   stage_id       §5.1. Without it a plan cannot be attached to the stage it
--                  happens in, and §7.4's stage-locality check (TR136) has no
--                  subject. ON DELETE SET NULL, matching trip_commitments
--                  (2761): a plan outlives the stage it was filed under.
--   place_id       §5.1. No foreign key, exactly like trip_stages.place_id
--                  (2760) and trip_commitments.place_id (2761) — §5.2 says
--                  cross-domain references are explicit *_id plus source_ref,
--                  resolved through the canonical place bridge, and the three
--                  must not disagree about that.
--   privacy_scope  §6.3's six values. The deployed `visibility` is two
--                  ('members','public'), which TR82 records as "not the §6.3
--                  six-value privacy scope".
--   plan_scope     §9.1's PlanScope: ALL_CREW | OPTIONAL | SUBGROUP | SOLO.
--                  Not in §5.1's column list — §5.1 and §9.1 split the same row
--                  the way §5.1 and §9.3 split trip_proposals — and 2771's
--                  attendance relation is meaningless without it: "Group Trips
--                  should not assume every plan applies to every participant"
--                  is a statement about this column.
--   version        §5.1. Plan-level optimistic concurrency. The kernel's
--                  existing version is the TRIP's; two crew editing two
--                  different plans in one trip conflict on it today, and
--                  neither is editing what the other changed.
--
-- TWO COLUMNS FOR VISIBILITY, AND WHY THEY CANNOT DRIFT
-- =====================================================
-- `visibility` stays. It is read by deployed code and dropping it would be a
-- breaking change dressed as a spec fix. But two columns describing one
-- property is precisely how a schema starts lying, so they are tied together by
-- a CHECK rather than by convention:
--
--   CHECK ((visibility = 'public') = (privacy_scope = 'public'))
--
-- That is the one invariant every legacy reader depends on — a plan is
-- publicly visible if and only if its scope is PUBLIC — and it is enforced, so
-- a writer that sets one and forgets the other is refused rather than believed.
-- The backfill below derives privacy_scope from visibility, so the constraint
-- holds from the first instant and no row is born inconsistent.
--
-- DATA: every existing row is backfilled. 'public' -> 'public', everything else
-- -> 'crew', which is what 'members' means in the deployed vocabulary. No row
-- is deleted and no existing column is altered in place.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2770 (Trips).

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  IF to_regclass('public.trip_plan_items') IS NULL THEN
    RAISE EXCEPTION '2770: requires public.trip_plan_items (0010)';
  END IF;
  IF to_regclass('public.trip_stages') IS NULL THEN
    RAISE EXCEPTION '2770: requires public.trip_stages (2760) for the stage_id reference';
  END IF;
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid = 'public.trip_plan_items'::regclass
     AND attname IN ('stage_id','place_id','privacy_scope','plan_scope','version')
     AND NOT attisdropped;
  IF n <> 0 THEN RAISE EXCEPTION '2770: % of the 5 columns already exist; this migration has run', n; END IF;
  -- The backfill maps `visibility`. If it has grown a third value, the mapping
  -- below is a guess and this file must not run.
  SELECT count(*) INTO n FROM public.trip_plan_items
   WHERE visibility IS NOT NULL AND visibility NOT IN ('members','public');
  IF n <> 0 THEN
    RAISE EXCEPTION '2770: % row(s) carry a visibility outside (members, public); the privacy_scope backfill has no mapping for them', n;
  END IF;
END
$pre$;

ALTER TABLE public.trip_plan_items
  ADD COLUMN stage_id      uuid   NULL REFERENCES public.trip_stages(id) ON DELETE SET NULL,
  ADD COLUMN place_id      uuid   NULL,
  ADD COLUMN privacy_scope text   NULL,
  ADD COLUMN plan_scope    text   NOT NULL DEFAULT 'all_crew',
  ADD COLUMN version       bigint NOT NULL DEFAULT 0;

-- Backfill BEFORE the NOT NULL and the tie, so no row is ever inconsistent.
UPDATE public.trip_plan_items
   SET privacy_scope = CASE WHEN visibility = 'public' THEN 'public' ELSE 'crew' END;

ALTER TABLE public.trip_plan_items
  ALTER COLUMN privacy_scope SET NOT NULL,
  ALTER COLUMN privacy_scope SET DEFAULT 'crew';

ALTER TABLE public.trip_plan_items
  ADD CONSTRAINT trip_plan_items_privacy_scope_known
    CHECK (privacy_scope IN ('private','selected_participants','crew','friends_nearby','trip','public')),
  ADD CONSTRAINT trip_plan_items_plan_scope_known
    CHECK (plan_scope IN ('all_crew','optional','subgroup','solo')),
  ADD CONSTRAINT trip_plan_items_version_nonnegative CHECK (version >= 0),
  -- The tie. A writer that sets one and forgets the other is refused.
  ADD CONSTRAINT trip_plan_items_visibility_agrees_with_scope
    CHECK ((visibility = 'public') = (privacy_scope = 'public'));

CREATE INDEX idx_trip_plan_items_stage ON public.trip_plan_items (stage_id) WHERE stage_id IS NOT NULL;

COMMENT ON COLUMN public.trip_plan_items.stage_id IS
  'Trips spec §5.1 trip_plans.stage_id — the stage this plan happens in. ON DELETE SET NULL: a plan outlives the stage it was filed under, exactly as trip_commitments.stage_id (2761) does. Required before §7.4 stage-locality (TR136) has a subject.';
COMMENT ON COLUMN public.trip_plan_items.place_id IS
  'Trips spec §5.1 trip_plans.place_id. NO foreign key, matching trip_stages.place_id (2760) and trip_commitments.place_id (2761): §5.2 makes cross-domain references an explicit *_id resolved through the canonical place bridge, and an unresolved external place stays typed as unresolved rather than falsely canonical.';
COMMENT ON COLUMN public.trip_plan_items.privacy_scope IS
  'Trips spec §6.3: private | selected_participants | crew | friends_nearby | trip | public. Lowercased to match every other vocabulary in this schema. Tied to the legacy two-value `visibility` by trip_plan_items_visibility_agrees_with_scope, so the two cannot drift; `visibility` is what deployed readers still use.';
COMMENT ON COLUMN public.trip_plan_items.plan_scope IS
  'Trips spec §9.1 PlanScope: all_crew | optional | subgroup | solo. "Group Trips should not assume every plan applies to every participant" — this column is that assumption made explicit, and trip_plan_participants (2771) is the relation it licenses.';
COMMENT ON COLUMN public.trip_plan_items.version IS
  'Trips spec §5.1 trip_plans.version — PLAN-level optimistic concurrency, distinct from trips.version. Two crew editing two different plans of one trip do not conflict on the trip aggregate; they would on trips.version alone.';

DO $post$
DECLARE n int; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stage_id','place_id','privacy_scope','plan_scope','version'] LOOP
    SELECT count(*) INTO n FROM pg_attribute
     WHERE attrelid='public.trip_plan_items'::regclass AND attname=t AND NOT attisdropped;
    IF n <> 1 THEN RAISE EXCEPTION '2770: column % absent after add', t; END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['trip_plan_items_privacy_scope_known','trip_plan_items_plan_scope_known',
                           'trip_plan_items_version_nonnegative','trip_plan_items_visibility_agrees_with_scope'] LOOP
    SELECT count(*) INTO n FROM pg_constraint
     WHERE conrelid='public.trip_plan_items'::regclass AND conname=t AND convalidated;
    IF n <> 1 THEN RAISE EXCEPTION '2770: constraint % is absent or NOT VALID', t; END IF;
  END LOOP;

  -- The six §6.3 values, each by name. A count would pass on six wrong strings.
  FOREACH t IN ARRAY ARRAY['private','selected_participants','crew','friends_nearby','trip','public'] LOOP
    SELECT count(*) INTO n FROM pg_constraint
     WHERE conrelid='public.trip_plan_items'::regclass AND conname='trip_plan_items_privacy_scope_known'
       AND position('''' || t || '''' in pg_get_constraintdef(oid)) > 0;
    IF n <> 1 THEN RAISE EXCEPTION '2770: §6.3 scope % is not accepted', t; END IF;
  END LOOP;

  -- stage_id must SET NULL, not CASCADE: 'c' here would delete plans when a
  -- stage is removed, which is the opposite of what the comment promises.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid='public.trip_plan_items'::regclass AND contype='f'
     AND confrelid='public.trip_stages'::regclass AND confdeltype='n';
  IF n <> 1 THEN RAISE EXCEPTION '2770: the stage_id foreign key is missing or is not ON DELETE SET NULL'; END IF;

  -- No row was left inconsistent by the backfill.
  SELECT count(*) INTO n FROM public.trip_plan_items WHERE privacy_scope IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION '2770: % row(s) have no privacy_scope', n; END IF;
  SELECT count(*) INTO n FROM public.trip_plan_items
   WHERE (visibility = 'public') <> (privacy_scope = 'public');
  IF n <> 0 THEN RAISE EXCEPTION '2770: % row(s) disagree between visibility and privacy_scope', n; END IF;

  -- NO SECOND AGGREGATE. If a table named trip_plans ever appears, one of the
  -- two is wrong and this assertion is where that gets noticed.
  IF to_regclass('public.trip_plans') IS NOT NULL THEN
    RAISE EXCEPTION '2770: a table named public.trip_plans exists. There is one plan aggregate and it is trip_plan_items; two id spaces for one concept is the divergence §1 forbids.';
  END IF;
END
$post$;

COMMIT;
