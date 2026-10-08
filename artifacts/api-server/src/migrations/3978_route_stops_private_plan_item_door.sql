-- 3978_route_stops_private_plan_item_door.sql
--
-- census-trips §86 (wave 5 item 4), the owner's decision of 2026-10-04
-- (OD-TRIP-3): "Private anchors: Owner-only by default. The owner can share an
-- individual anchor with selected trip members; trip membership or organizer
-- status alone does not grant access." Lead ruling D-65: owner-only covers the
-- name, the place and everything derived from them.
--
-- APPLIED TO NO DATABASE by the lane that wrote it (lane C, 2026-10-06). Needs
-- 2334 (`authz.is_trip_crew` and the two crew policies it replaces) and 3972
-- (`authz.private_anchor_granted`). Its application is the owner's.
--
-- ── THE DOOR ───────────────────────────────────────────────────────────────
-- A route stop made from a plan item (`source_type = 'plan_item'`,
-- `source_id` = the item's id) COPIES the item: `title` and
-- `structured_location` {label, lat, lng, address}. 2334's
-- `route_stops_member_select` lets every accepted crew member read every stop
-- of the trip's routes through PostgREST, so a private item placed on a
-- member's route reached the whole crew with its name and its coordinates,
-- around 3972's door on `trip_plan_items`. `route_legs_member_select` did the
-- same for the legs into and out of it, whose `polyline` draws the way there.
--
-- The API already serves such a stop as a slot (server/trips/privateAnchorShares.ts
-- withheldPlanItemStopIds; routes/routePlan.ts and server/trips/tripMapProjection.ts)
-- and every route reads as service_role, which RLS does not bind. What this closes
-- is the door a holder of any member's session token has to PostgREST.
--
-- ── THE RULE (the API's, exactly) ──────────────────────────────────────────
-- A crew member who does not own the route sees a plan-item stop only when the
-- item exists and the viewer may see its place (privateAnchorAccess.ts
-- canSeePlanItemLocation): the item is not private; or the viewer created it;
-- or it is not removed and the viewer holds a grant that is still true
-- (3972's authz.private_anchor_granted, judged on the route's trip). A
-- `source_id` that is not an item id, or names no item, is withheld: an
-- unreadable answer never opens. A crew member sees a leg only when both of its
-- stops pass. The route's owner keeps every stop and leg through 0058's
-- untouched `route_stops_owner_all` / `route_legs_owner_all`, as the API does.
-- Every other stop (manual, place, meetup, hidden_gem, discovery) is unchanged.
--
-- ── THE TRAPS THIS REPOSITORY HAS HIT ──────────────────────────────────────
--   42P17 — neither function reads a table through RLS: both are SECURITY
--     DEFINER, and the leg check reads `route_stops` as the definer, so a
--     route_legs policy reading route_stops cannot recurse, and a stop the
--     viewer cannot see is NOT mistaken for "no withheld stop".
--   x.c = x.c — every column is qualified with its table, and the functions
--     compare their PARAMETERS to the rows they read.
--   The uuid cast — `source_id` is text; the function casts it only after the
--     shape test, in plpgsql, so a malformed id answers FALSE, never an error
--     that would fail the whole crew read.
--
-- Policy-only plus two functions: no table, column, grant or row changes.
-- Idempotent (CREATE OR REPLACE / DROP IF EXISTS then CREATE).
--
-- Rollback: db/rollback/2026-10-06-3978-route-stops-private-plan-item-door-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.route_stops') IS NULL OR to_regclass('public.route_legs') IS NULL
     OR to_regclass('public.route_plans') IS NULL OR to_regclass('public.trip_plan_items') IS NULL THEN
    RAISE EXCEPTION '3978: route_plans / route_stops / route_legs / trip_plan_items missing (0058)';
  END IF;
  IF to_regprocedure('authz.is_trip_crew(uuid)') IS NULL THEN
    RAISE EXCEPTION '3978: authz.is_trip_crew(uuid) is required (2334)';
  END IF;
  IF to_regprocedure('authz.private_anchor_granted(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '3978: authz.private_anchor_granted(uuid,uuid,uuid) is required (3972)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.route_stops'::regclass AND polname = 'route_stops_member_select')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.route_legs'::regclass AND polname = 'route_legs_member_select') THEN
    RAISE EXCEPTION '3978: 2334''s route_stops_member_select / route_legs_member_select are not present; this file replaces them and will not create a crew policy from nothing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.route_stops'::regclass AND polname = 'route_stops_owner_all')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.route_legs'::regclass AND polname = 'route_legs_owner_all') THEN
    RAISE EXCEPTION '3978: 0058''s owner policies are missing; the route owner would lose their own stops';
  END IF;
END
$pre$;

-- May the CURRENT viewer (auth.uid(), read inside — never a parameter) see the
-- place of the plan item a route stop was made from? canSeePlanItemLocation's
-- rule, on the route's trip.
CREATE OR REPLACE FUNCTION authz.plan_item_stop_visible(p_source_id text, p_trip_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_viewer uuid := auth.uid();
  v_item   uuid;
BEGIN
  IF v_viewer IS NULL OR p_trip_id IS NULL OR p_source_id IS NULL
     OR p_source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  v_item := p_source_id::uuid;
  RETURN EXISTS (
    SELECT 1 FROM public.trip_plan_items i
     WHERE i.id = v_item
       AND (
         i.location_is_private IS FALSE
         OR i.creator_id = v_viewer
         OR (i.removed_at IS NULL AND authz.private_anchor_granted(i.id, i.creator_id, p_trip_id))
       )
  );
END
$fn$;

COMMENT ON FUNCTION authz.plan_item_stop_visible(text, uuid) IS
  'census-trips §86 (OD-TRIP-3, D-65): may the CURRENT viewer see the place of the plan item a route stop was copied from? The item is not private, or the viewer created it, or it is not removed and authz.private_anchor_granted holds on the route''s trip — privateAnchorAccess.ts canSeePlanItemLocation. A source_id that is not an item id, or names no item, answers FALSE. SECURITY DEFINER so it reads trip_plan_items as the definer (no RLS recursion). Lives in authz so PostgREST does not expose it.';

-- May the CURRENT viewer see a leg between these two stops? Both stops pass:
-- neither is a plan-item stop withheld from the viewer. Reads route_stops as
-- the definer, so a stop the viewer cannot see is still counted.
CREATE OR REPLACE FUNCTION authz.route_leg_endpoints_visible(p_from_stop_id uuid, p_to_stop_id uuid, p_trip_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.route_stops s
     WHERE s.id IN (p_from_stop_id, p_to_stop_id)
       AND s.source_type = 'plan_item'
       AND NOT authz.plan_item_stop_visible(s.source_id, p_trip_id)
  );
$fn$;

COMMENT ON FUNCTION authz.route_leg_endpoints_visible(uuid, uuid, uuid) IS
  'census-trips §86: TRUE when neither stop of a route leg is a plan-item stop withheld from the CURRENT viewer (authz.plan_item_stop_visible). SECURITY DEFINER: it reads route_stops as the definer, so a route_legs policy can call it without recursion and a stop the viewer cannot see is still counted, never read as absent.';

-- RLS predicates evaluate with the querying role's privileges: revoking these
-- would break every crew read, not harden anything (2334's rule, from 2199).
GRANT EXECUTE ON FUNCTION authz.plan_item_stop_visible(text, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION authz.route_leg_endpoints_visible(uuid, uuid, uuid) TO anon, authenticated, service_role;

-- ── route_stops: 2334's crew read, plus the plan-item rule ─────────────────
DROP POLICY IF EXISTS "route_stops_member_select" ON public.route_stops;
CREATE POLICY "route_stops_member_select" ON public.route_stops
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.route_plans rp
      WHERE rp.id = route_stops.route_plan_id
        AND rp.trip_id IS NOT NULL
        AND authz.is_trip_crew(rp.trip_id)
        AND (
          route_stops.source_type <> 'plan_item'
          OR authz.plan_item_stop_visible(route_stops.source_id, rp.trip_id)
        )
    )
  );

-- ── route_legs: 2334's crew read, plus both stops passing ──────────────────
DROP POLICY IF EXISTS "route_legs_member_select" ON public.route_legs;
CREATE POLICY "route_legs_member_select" ON public.route_legs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.route_plans rp
      WHERE rp.id = route_legs.route_plan_id
        AND rp.trip_id IS NOT NULL
        AND authz.is_trip_crew(rp.trip_id)
        AND authz.route_leg_endpoints_visible(route_legs.from_stop_id, route_legs.to_stop_id, rp.trip_id)
    )
  );

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE d text; n int;
BEGIN
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO d FROM pg_policy p
   WHERE p.polrelid = 'public.route_stops'::regclass AND p.polname = 'route_stops_member_select';
  IF d IS NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3978): route_stops_member_select is missing'; END IF;
  IF position('is_trip_crew' in d) = 0 OR position('plan_item_stop_visible' in d) = 0 OR position('source_type' in d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3978): route_stops_member_select does not carry the crew and plan-item clauses: %', d;
  END IF;

  SELECT pg_get_expr(p.polqual, p.polrelid) INTO d FROM pg_policy p
   WHERE p.polrelid = 'public.route_legs'::regclass AND p.polname = 'route_legs_member_select';
  IF d IS NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3978): route_legs_member_select is missing'; END IF;
  IF position('is_trip_crew' in d) = 0 OR position('route_leg_endpoints_visible' in d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3978): route_legs_member_select does not carry the crew and endpoint clauses: %', d;
  END IF;

  -- 2334's census of the four route-plan tables still holds: 13 policies, none
  -- reading trip_members directly.
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('route_plans', 'route_stops', 'route_legs', 'route_plan_members');
  IF n <> 13 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3978): expected 13 policies across the four route-plan tables, found %', n; END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('route_stops', 'route_legs')
     AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%trip_members%';
  IF n <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3978): % route stop/leg policies read trip_members directly', n; END IF;

  -- Nobody signed in sees no plan item's place.
  IF authz.plan_item_stop_visible(gen_random_uuid()::text, gen_random_uuid()) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3978): plan_item_stop_visible answered TRUE with no viewer';
  END IF;
  -- Signed in (a claim local to this block's transaction): a malformed id and
  -- an id naming no item both answer FALSE, and the malformed one does not raise.
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  IF authz.plan_item_stop_visible('not-a-uuid', gen_random_uuid()) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3978): plan_item_stop_visible answered TRUE for a malformed id';
  END IF;
  IF authz.plan_item_stop_visible(gen_random_uuid()::text, gen_random_uuid()) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3978): plan_item_stop_visible answered TRUE for an id naming no item';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
END
$post$;
