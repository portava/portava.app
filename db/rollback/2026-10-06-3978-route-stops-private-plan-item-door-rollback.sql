-- Rollback for 3978_route_stops_private_plan_item_door.sql (census-trips §86, lane C).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- THIS ROLLBACK REOPENS A PRIVACY HOLE, and says so: with 2334's crew policies
-- back, any accepted crew member holding a session token can read, straight
-- through PostgREST, the title and coordinates of a private plan item another
-- member placed on a route, and the legs (polyline included) into and out of it.
-- The API keeps serving such a stop as a slot; only the direct door reopens.
--
-- Restores 2334's two crew policies verbatim, then drops 3978's two functions
-- (the policies that call them are gone first).

BEGIN;

DROP POLICY IF EXISTS "route_stops_member_select" ON public.route_stops;
CREATE POLICY "route_stops_member_select" ON public.route_stops
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.route_plans rp
      WHERE rp.id = route_stops.route_plan_id
        AND rp.trip_id IS NOT NULL
        AND authz.is_trip_crew(rp.trip_id)
    )
  );

DROP POLICY IF EXISTS "route_legs_member_select" ON public.route_legs;
CREATE POLICY "route_legs_member_select" ON public.route_legs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.route_plans rp
      WHERE rp.id = route_legs.route_plan_id
        AND rp.trip_id IS NOT NULL
        AND authz.is_trip_crew(rp.trip_id)
    )
  );

DROP FUNCTION IF EXISTS authz.route_leg_endpoints_visible(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS authz.plan_item_stop_visible(text, uuid);

COMMIT;

DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('route_plans', 'route_stops', 'route_legs', 'route_plan_members');
  IF n <> 13 THEN RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3978): expected 13 route-plan policies, found %', n; END IF;
  IF to_regprocedure('authz.plan_item_stop_visible(text,uuid)') IS NOT NULL
     OR to_regprocedure('authz.route_leg_endpoints_visible(uuid,uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3978): a 3978 function survived';
  END IF;
END
$post$;
