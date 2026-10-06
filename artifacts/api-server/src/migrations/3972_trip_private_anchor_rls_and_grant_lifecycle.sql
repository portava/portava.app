-- 3972_trip_private_anchor_rls_and_grant_lifecycle.sql
--
-- census-trips TR256 / §81, and the owner's decision of 2026-10-04 (OD-TRIP-3,
-- verbatim): "Private anchors: Owner-only by default. The owner can share an
-- individual anchor with selected trip members; trip membership or organizer
-- status alone does not grant access."
--
-- APPLIED TO NO DATABASE by the lane that wrote it (lane C, 2026-10-05). Needs
-- 3970 (`trip_private_anchor_shares`). Its application is the owner's.
--
-- ── 1. THE CLIENT DOOR: plan_items_select ─────────────────────────────────
-- 2337 left `plan_items_select = removed_at IS NULL AND authz.is_trip_crew(trip_id)`,
-- so any accepted member could read `lat, lng, location_name, title, notes` of
-- every other member's private item straight through PostgREST. The API now
-- serves such an item as a slot (domain/trips/policies/privateAnchorAccess.ts);
-- this closes the direct read. A crew member sees a private row only when they
-- created it, or hold a grant that is still true (sharing ON, the grant made by
-- the row's own creator, that creator still an accepted member of the trip).
--
-- Measured before writing it: the mobile app reads NO `trip_plan_items` row
-- directly (no `.from('trip_plan_items')`, no realtime subscription on it), and
-- every API route reads it as service_role (lib/http.ts requireUser hands the
-- route the SERVICE client), which RLS does not bind. So no screen's data and
-- no route's answer changes; what closes is the door a holder of any user's
-- session token has to PostgREST, which is exactly the door the API rule
-- cannot guard.
--
-- The two RLS traps this repository has hit are avoided by construction:
--   42P17 — the policy reads no table through RLS: the grant check is a
--     SECURITY DEFINER function that reads `trip_private_anchor_shares`,
--     `feature_flags`, `trip_members` and `trips`, never `trip_plan_items`.
--   x.c = x.c — every column is qualified with its table name, and the
--     function compares its PARAMETERS to the grant row's columns.
--
-- ── 2. GRANT LIFECYCLE (verifier finding 3) ───────────────────────────────
-- A grant row that stopped being true is DELETED where the change happens, by
-- triggers, so it cannot revive later and no writer can forget it:
--   * a member leaves, is removed, or stops being accepted → every grant TO
--     them and every grant BY them on that trip;
--   * a membership begins (insert, or a move INTO accepted) → the same rows,
--     which can only be left over from an earlier membership and would
--     otherwise revive on rejoining or on an admin restore;
--   * an item stops being private, or is soft-removed → every grant on it.
-- The API also clears them (routes/trips.ts, server/trips/commandRoute.ts) so a
-- database without this file behaves the same; the read-time rule denies a
-- stale grant on either.
--
-- Rollback: db/rollback/2026-10-05-3972-trip-private-anchor-rls-and-grant-lifecycle-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_private_anchor_shares') IS NULL THEN
    RAISE EXCEPTION '3972: requires 3970 (trip_private_anchor_shares)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'authz' AND p.proname = 'is_trip_crew') THEN
    RAISE EXCEPTION '3972: authz.is_trip_crew is required (2334/2337)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.trip_plan_items'::regclass AND polname = 'plan_items_select') THEN
    RAISE EXCEPTION '3972: plan_items_select is not present; this file replaces it and will not create a policy from nothing';
  END IF;
END
$pre$;

-- The grant check, for the CURRENT viewer (auth.uid(), read inside — never a
-- parameter, so it cannot be used as an oracle for someone else).
CREATE OR REPLACE FUNCTION authz.private_anchor_granted(p_item_id uuid, p_owner_id uuid, p_trip_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT auth.uid() IS NOT NULL
     AND p_item_id IS NOT NULL AND p_owner_id IS NOT NULL AND p_trip_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.feature_flags f
                  WHERE f.flag = 'trip_private_anchor_sharing_enabled' AND f.enabled = TRUE)
     AND EXISTS (SELECT 1 FROM public.trip_private_anchor_shares g
                  WHERE g.plan_item_id = p_item_id
                    AND g.owner_id = p_owner_id
                    AND g.member_id = auth.uid()
                    AND g.trip_id = p_trip_id)
     AND (
       EXISTS (SELECT 1 FROM public.trip_members m
                WHERE m.trip_id = p_trip_id AND m.user_id = p_owner_id
                  AND m.role IN ('owner', 'co_host', 'member', 'viewer')
                  AND coalesce(m.status, 'accepted') = 'accepted')
       OR (NOT EXISTS (SELECT 1 FROM public.trip_members m2 WHERE m2.trip_id = p_trip_id AND m2.user_id = p_owner_id)
           AND EXISTS (SELECT 1 FROM public.trips t WHERE t.id = p_trip_id AND t.owner_id = p_owner_id))
     );
$fn$;

COMMENT ON FUNCTION authz.private_anchor_granted(uuid, uuid, uuid) IS
  'census-trips §81 (OD-TRIP-3): does the CURRENT viewer hold a grant, still true, on this private plan item? Sharing ON, a grant row made by the item''s own creator to auth.uid(), that creator still an accepted member (requireTripMember''s rule, owner fallback included). Reads no trip_plan_items row, so a policy on that table can call it without recursion.';

GRANT EXECUTE ON FUNCTION authz.private_anchor_granted(uuid, uuid, uuid) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "plan_items_select" ON public.trip_plan_items;
CREATE POLICY "plan_items_select" ON public.trip_plan_items
  FOR SELECT USING (
    trip_plan_items.removed_at IS NULL
    AND authz.is_trip_crew(trip_plan_items.trip_id)
    AND (
      trip_plan_items.location_is_private IS NOT TRUE
      OR trip_plan_items.creator_id = auth.uid()
      OR authz.private_anchor_granted(trip_plan_items.id, trip_plan_items.creator_id, trip_plan_items.trip_id)
    )
  );

-- ── grant lifecycle triggers ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trip_anchor_grants_clear_on_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE was_accepted boolean; is_accepted boolean;
BEGIN
  -- A membership that BEGINS holds no grant and has given none: any row that
  -- names this person on this trip is left over from an earlier membership,
  -- and would otherwise revive the moment they rejoin or are restored.
  IF TG_OP = 'INSERT' THEN
    DELETE FROM public.trip_private_anchor_shares g
     WHERE g.trip_id = NEW.trip_id AND (g.member_id = NEW.user_id OR g.owner_id = NEW.user_id);
    RETURN NULL;
  END IF;
  -- A membership that ENDS takes every grant to and by that person with it.
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.trip_private_anchor_shares g
     WHERE g.trip_id = OLD.trip_id AND (g.member_id = OLD.user_id OR g.owner_id = OLD.user_id);
    RETURN NULL;
  END IF;
  -- An UPDATE that moves the person into or out of accepted membership
  -- (requireTripMember's rule) clears the same rows; a role change between two
  -- accepted roles clears nothing.
  was_accepted := coalesce(OLD.role, '') IN ('owner', 'co_host', 'member', 'viewer') AND coalesce(OLD.status, 'accepted') = 'accepted';
  is_accepted  := coalesce(NEW.role, '') IN ('owner', 'co_host', 'member', 'viewer') AND coalesce(NEW.status, 'accepted') = 'accepted';
  IF was_accepted IS DISTINCT FROM is_accepted OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.trip_id IS DISTINCT FROM NEW.trip_id THEN
    DELETE FROM public.trip_private_anchor_shares g
     WHERE (g.trip_id = OLD.trip_id AND (g.member_id = OLD.user_id OR g.owner_id = OLD.user_id))
        OR (g.trip_id = NEW.trip_id AND (g.member_id = NEW.user_id OR g.owner_id = NEW.user_id));
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trip_members_clear_anchor_grants ON public.trip_members;
CREATE TRIGGER trip_members_clear_anchor_grants
  AFTER INSERT OR DELETE OR UPDATE OF role, status, user_id, trip_id ON public.trip_members
  FOR EACH ROW EXECUTE FUNCTION public.trip_anchor_grants_clear_on_membership();

CREATE OR REPLACE FUNCTION public.trip_anchor_grants_clear_on_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF NEW.location_is_private IS NOT TRUE OR NEW.removed_at IS NOT NULL THEN
    DELETE FROM public.trip_private_anchor_shares g WHERE g.plan_item_id = NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trip_plan_items_clear_anchor_grants ON public.trip_plan_items;
CREATE TRIGGER trip_plan_items_clear_anchor_grants
  AFTER UPDATE OF location_is_private, removed_at ON public.trip_plan_items
  FOR EACH ROW EXECUTE FUNCTION public.trip_anchor_grants_clear_on_item();

REVOKE ALL ON FUNCTION public.trip_anchor_grants_clear_on_membership() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_anchor_grants_clear_on_item() FROM PUBLIC, anon, authenticated;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE d text; n int;
BEGIN
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO d FROM pg_policy p
   WHERE p.polrelid = 'public.trip_plan_items'::regclass AND p.polname = 'plan_items_select';
  IF d IS NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3972): plan_items_select is missing'; END IF;
  IF position('private_anchor_granted' in d) = 0 OR position('location_is_private' in d) = 0 OR position('creator_id' in d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3972): plan_items_select does not carry the owner-only clause: %', d;
  END IF;
  IF position('is_trip_crew' in d) = 0 OR position('removed_at' in d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3972): plan_items_select lost the crew or removed_at clause: %', d;
  END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgname IN ('trip_members_clear_anchor_grants', 'trip_plan_items_clear_anchor_grants') AND NOT tgisinternal;
  IF n <> 2 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3972): expected 2 grant-clearing triggers, found %', n; END IF;

  -- A caller with no session holds no grant: the function cannot answer TRUE for nobody.
  IF authz.private_anchor_granted(gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3972): private_anchor_granted answered TRUE with no viewer';
  END IF;
END
$post$;
