-- Rollback for 3972_trip_private_anchor_rls_and_grant_lifecycle.sql (census-trips §81, lane C).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- THIS ROLLBACK REOPENS A PRIVACY HOLE, and says so rather than restoring it
-- quietly: with 2337's `plan_items_select` back, any accepted crew member who
-- holds a session token can read every other member's PRIVATE plan item —
-- `lat, lng, location_name, title, notes` — straight through PostgREST. The
-- API keeps withholding them (its readers run as service_role and apply
-- domain/trips/policies/privateAnchorAccess.ts themselves); the direct door is
-- what reopens.
--
-- It also removes the two grant-clearing triggers. The API's own clearings
-- (routes/trips.ts member removal and item edits, server/trips/commandRoute.ts)
-- and the read-time validity rule (server/trips/privateAnchorShares.ts
-- planItemAccessFor) continue to hold; only a writer that bypasses the API
-- would then leave a stale grant row behind.
--
-- Refuses while the sharing flag is TRUE: grants are live, and the direct door
-- would then be the ONLY thing between them and every crew member.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trip_private_anchor_sharing_enabled' AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3972): trip_private_anchor_sharing_enabled is TRUE. Turn it off deliberately first.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trip_members_clear_anchor_grants ON public.trip_members;
DROP TRIGGER IF EXISTS trip_plan_items_clear_anchor_grants ON public.trip_plan_items;
DROP FUNCTION IF EXISTS public.trip_anchor_grants_clear_on_membership();
DROP FUNCTION IF EXISTS public.trip_anchor_grants_clear_on_item();

-- 2337's definition, verbatim (2337_trip_crew_rls_membership_convergence.sql).
DROP POLICY IF EXISTS "plan_items_select" ON public.trip_plan_items;
CREATE POLICY "plan_items_select" ON public.trip_plan_items
  FOR SELECT USING ( removed_at IS NULL AND authz.is_trip_crew(trip_id) );

DROP FUNCTION IF EXISTS authz.private_anchor_granted(uuid, uuid, uuid);

DELETE FROM public.schema_migration_ledger WHERE filename = '3972_trip_private_anchor_rls_and_grant_lifecycle.sql';

COMMIT;

DO $post$
DECLARE d text;
BEGIN
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO d FROM pg_policy p
   WHERE p.polrelid = 'public.trip_plan_items'::regclass AND p.polname = 'plan_items_select';
  IF d IS NULL OR position('private_anchor_granted' in d) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3972 rollback): plan_items_select is missing or still carries 3972''s clause: %', d;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('trip_members_clear_anchor_grants', 'trip_plan_items_clear_anchor_grants')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3972 rollback): a grant-clearing trigger is still present.';
  END IF;
END $post$;
