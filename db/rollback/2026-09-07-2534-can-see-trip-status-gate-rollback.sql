-- Rollback for 2534_can_see_trip_status_gate_and_checklist_write_boundary.sql
--
-- ⚠ REOPENS TWO SECURITY HOLES.
--   1. can_see_trip goes back to gating on role and never on status, so a
--      PENDING invitee (role='member', status='invited') and a REMOVED member
--      read the trip, all of its membership rows, its checklists, notes,
--      documents, saved places, destinations and map pins again.
--   2. The two FOR ALL policies come back without WITH CHECK, so anyone who
--      can SEE a public trip can again INSERT, UPDATE and DELETE its checklists
--      and items, and the four INSERT policies again admit public-trip viewers.
-- Both measured on portava-ci 2026-09-07. Run it only to reverse 2534
-- deliberately, never as routine cleanup.
--
-- Restores the function body and all eleven policies exactly as they stood on
-- BOTH databases before 2534 (pg_policies text, md5-identical on each). The
-- one policy 2534 created that did not exist before, trip_checklists_update,
-- is dropped.

BEGIN;

CREATE OR REPLACE FUNCTION public.can_see_trip(t_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
    SELECT EXISTS (
      SELECT 1 FROM trips t WHERE t.id = t_id AND (
        t.owner_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM trip_members m
           WHERE m.trip_id = t.id
             AND m.user_id  = auth.uid()
             AND m.role = ANY (
               ARRAY['owner'::member_role, 'member'::member_role,
                     'co_host'::member_role, 'viewer'::member_role]
             )
        )
        OR (
          t.visibility = 'public'
          AND NOT viewer_is_blocked(t.owner_id)
        )
      )
    );
    $function$;

DROP POLICY IF EXISTS "trip_members_select" ON public.trip_members;
CREATE POLICY "trip_members_select" ON public.trip_members FOR SELECT USING (can_see_trip(trip_id));

DROP POLICY IF EXISTS "trip_checklists_update" ON public.trip_checklists;
DROP POLICY IF EXISTS "trip_checklists_members" ON public.trip_checklists;
CREATE POLICY "trip_checklists_members" ON public.trip_checklists FOR ALL USING (can_see_trip(trip_id));
DROP POLICY IF EXISTS "trip_checklists_insert" ON public.trip_checklists;
CREATE POLICY "trip_checklists_insert" ON public.trip_checklists FOR INSERT WITH CHECK (((created_by = auth.uid()) AND can_see_trip(trip_id)));

DROP POLICY IF EXISTS "trip_checklist_items_members" ON public.trip_checklist_items;
CREATE POLICY "trip_checklist_items_members" ON public.trip_checklist_items FOR ALL USING (can_see_trip(trip_id));
DROP POLICY IF EXISTS "trip_checklist_items_insert" ON public.trip_checklist_items;
CREATE POLICY "trip_checklist_items_insert" ON public.trip_checklist_items FOR INSERT WITH CHECK (can_see_trip(trip_id));
DROP POLICY IF EXISTS "trip_checklist_items_update" ON public.trip_checklist_items;
CREATE POLICY "trip_checklist_items_update" ON public.trip_checklist_items FOR UPDATE USING (can_see_trip(trip_id));
DROP POLICY IF EXISTS "trip_checklist_items_delete" ON public.trip_checklist_items;
CREATE POLICY "trip_checklist_items_delete" ON public.trip_checklist_items FOR DELETE USING (can_see_trip(trip_id));

DROP POLICY IF EXISTS "trip_notes_insert" ON public.trip_notes;
CREATE POLICY "trip_notes_insert" ON public.trip_notes FOR INSERT WITH CHECK (((author_id = auth.uid()) AND can_see_trip(trip_id)));
DROP POLICY IF EXISTS "trip_documents_insert" ON public.trip_documents;
CREATE POLICY "trip_documents_insert" ON public.trip_documents FOR INSERT WITH CHECK (((creator_id = auth.uid()) AND can_see_trip(trip_id)));
DROP POLICY IF EXISTS "trip_saved_places_insert" ON public.trip_saved_places;
CREATE POLICY "trip_saved_places_insert" ON public.trip_saved_places FOR INSERT WITH CHECK (((user_id = auth.uid()) AND can_see_trip(trip_id)));
DROP POLICY IF EXISTS "trip_reminders_insert" ON public.trip_reminders;
CREATE POLICY "trip_reminders_insert" ON public.trip_reminders FOR INSERT WITH CHECK (((user_id = auth.uid()) AND can_see_trip(trip_id)));

DO $$
BEGIN
  IF pg_get_functiondef('public.can_see_trip(uuid)'::regprocedure) LIKE '%authz.is_trip_crew%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: can_see_trip body not restored.';
  END IF;
  IF (SELECT count(*) FROM pg_depend WHERE refobjid = 'public.can_see_trip(uuid)'::regprocedure AND deptype <> 'i') <> 17 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 17 policies bound to can_see_trip after rollback.';
  END IF;
END $$;

COMMIT;
