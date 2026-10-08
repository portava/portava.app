-- Rollback for 3976_trip_events_private_place_minimised.sql (census-trips §85, lane C).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- THIS ROLLBACK REOPENS A PRIVACY HOLE, and says so: with 2420's
-- `trip_events_crew_select` back, any accepted crew member holding a session
-- token can read every trip event straight through PostgREST, and new plan
-- events again carry a private item's title, notes, location name, place and
-- source ids, city and country.
--
-- IT CANNOT UN-REDACT. Events and snapshots 3976 minimised stay minimised; the
-- keys it removed are gone (they remain on trip_plan_items for the owner, and in
-- trip_command_receipts.result_json, which is service_role only).

BEGIN;

DROP TRIGGER IF EXISTS trg_trip_events_minimise ON public.trip_events;
DROP TRIGGER IF EXISTS trg_trip_plan_items_redact_history ON public.trip_plan_items;

-- 2420's append-only function, verbatim.
CREATE OR REPLACE FUNCTION public.trip_events_refuse_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RAISE EXCEPTION 'trip_events is append-only: UPDATE refused (event_id=%)', OLD.event_id
    USING ERRCODE = 'restrict_violation';
END;
$fn$;

DROP FUNCTION IF EXISTS public.trip_events_minimise_on_insert();
DROP FUNCTION IF EXISTS public.trip_plan_item_redact_history();
DROP FUNCTION IF EXISTS public.trip_event_minimised(text, jsonb, boolean);
DROP FUNCTION IF EXISTS public.trip_event_place_keys_removed(jsonb);

-- 2420's client read, verbatim.
GRANT SELECT ON public.trip_events TO authenticated;
DROP POLICY IF EXISTS trip_events_crew_select ON public.trip_events;
CREATE POLICY trip_events_crew_select ON public.trip_events
  FOR SELECT USING (authz.is_trip_crew(trip_id));

COMMIT;
