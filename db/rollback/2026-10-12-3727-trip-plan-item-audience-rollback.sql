-- Rollback for 3727_trip_plan_item_audience.sql
-- NOT applied to portava-ci at the time of writing.
-- NOT applied to production.
--
-- WHAT 3727 DID: created trip_plan_item_audience (the explicit selection behind
-- selected_participants), its one writer trip_plan_item_audience_replace, two
-- lifecycle triggers, the client never-widen trigger on trip_plan_items, the
-- authz.plan_item_audience_admits helper, and recreated 3720's RESTRICTIVE
-- plan_items_privacy_scope_select with a selection arm.
--
-- WHAT THIS DOES: restores 3720's policy text EXACTLY (creator or crew-wide
-- scope), then drops every 3727 object. The selection rows are DELETED with the
-- table: after this, a selected_participants plan is its creator's alone again
-- (the API answers so as well — planItemAccessFor reads an absent table as "no
-- selection", and the write doors refuse the scope with 422 again).
--
-- ⚠ It also removes the client never-widen guard: an organizer's PostgREST
-- session can again set another member's crew plan to a wider scope or take over
-- creator_id (the pre-3727 state). Re-apply 3727 as soon as the cause is fixed.
--
-- It changes no row outside 3727's own table except 3727's ledger row.

BEGIN;

DROP POLICY IF EXISTS "plan_items_privacy_scope_select" ON public.trip_plan_items;
CREATE POLICY "plan_items_privacy_scope_select" ON public.trip_plan_items
  AS RESTRICTIVE
  FOR SELECT
  USING (
    trip_plan_items.privacy_scope IN ('crew', 'trip', 'friends_nearby', 'public')
    OR trip_plan_items.creator_id = auth.uid()
  );
COMMENT ON POLICY "plan_items_privacy_scope_select" ON public.trip_plan_items IS
  'census-trips §90 (TR116, Trips spec §6.3): RESTRICTIVE. A plan whose privacy_scope is not the crew''s (private, selected_participants, or unknown) is readable through RLS by its creator only — privateAnchorAccess.ts canSeePlanItemLocation, the API''s rule. ANDs with plan_items_select (3972).';

DROP TRIGGER IF EXISTS trip_plan_items_client_never_widens ON public.trip_plan_items;
DROP TRIGGER IF EXISTS trip_plan_items_clear_audience ON public.trip_plan_items;
DROP TRIGGER IF EXISTS trip_members_clear_plan_audience ON public.trip_members;
DROP FUNCTION IF EXISTS public.trip_plan_items_client_never_widens();
DROP FUNCTION IF EXISTS public.trip_plan_item_audience_clear_on_item();
DROP FUNCTION IF EXISTS public.trip_plan_item_audience_clear_on_membership();
DROP FUNCTION IF EXISTS public.trip_plan_item_audience_replace(uuid, uuid, uuid[]);
DROP FUNCTION IF EXISTS authz.plan_item_audience_admits(uuid, uuid);
DROP TABLE IF EXISTS public.trip_plan_item_audience;
DELETE FROM public.schema_migration_ledger WHERE filename = '3727_trip_plan_item_audience.sql';

COMMIT;

DO $post$
DECLARE d text;
BEGIN
  IF to_regclass('public.trip_plan_item_audience') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727 rollback): trip_plan_item_audience is still present.';
  END IF;
  IF to_regprocedure('authz.plan_item_audience_admits(uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public.trip_plan_item_audience_replace(uuid, uuid, uuid[])') IS NOT NULL
     OR to_regprocedure('public.trip_plan_items_client_never_widens()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727 rollback): a 3727 function is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('trip_plan_items_clear_audience', 'trip_members_clear_plan_audience', 'trip_plan_items_client_never_widens') AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727 rollback): a 3727 trigger is still present.';
  END IF;
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO d FROM pg_policy p
   WHERE p.polrelid = 'public.trip_plan_items'::regclass AND p.polname = 'plan_items_privacy_scope_select' AND NOT p.polpermissive;
  IF d IS NULL OR position('plan_item_audience_admits' in d) <> 0 OR position('creator_id' in d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727 rollback): plan_items_privacy_scope_select is not 3720''s restrictive policy: %', d;
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3727_trip_plan_item_audience.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727 rollback): the ledger still records 3727 as applied.';
  END IF;
END $post$;
