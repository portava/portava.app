-- 3720_trip_plan_privacy_scope_rls.sql
--
-- census-trips TR116 / §90. Trips spec §6.3: PRIVATE | SELECTED_PARTICIPANTS |
-- CREW | FRIENDS_NEARBY | TRIP | PUBLIC.
--
-- APPLIED TO NO DATABASE by the lane that wrote it (wave W, 2026-10-11). Needs
-- 2770 (`trip_plan_items.privacy_scope`). Its application is the owner's.
--
-- ── THE DOOR ───────────────────────────────────────────────────────────────
-- 2770 stores a plan's §6.3 scope and the API accepts `private`; until §90 no
-- reader enforced it. The API now does (domain/trips/policies/privateAnchorAccess.ts
-- canSeePlanItemLocation: a plan whose scope is not the crew's — or was not
-- read — is its creator's alone). Every API route reads as service_role, which
-- RLS does not bind. What this file closes is the OTHER door: a crew member
-- holding their own session token reads `trip_plan_items` through PostgREST
-- (and Realtime, which applies the same policies), where `plan_items_select`
-- (2337, replaced by 3972) admits every live row of the trip to the crew —
-- a plan its creator marked private included.
--
-- ── THE RULE (the API's, exactly) ──────────────────────────────────────────
-- A row is readable through RLS only when its scope admits the crew
-- (`crew`, `trip`, `friends_nearby`, `public`) or the reader created it.
-- `private` and `selected_participants` (no selection is stored anywhere; the
-- API refuses to write it) are the creator's. An unknown scope admits nobody
-- but the creator. privacy_scope is NOT NULL since 2770, so there is no
-- "unread" row here; `IN (...)` is still false for a NULL, so one would close.
--
-- AS RESTRICTIVE, as its own policy: it ANDs with whatever permissive SELECT
-- policy the table carries (3972's plan_items_select today) and is untouched
-- when 3972 — numbered after this file — drops and recreates that policy. It
-- also binds the organizer's PostgREST UPDATE (2337's plan_items_update): a
-- filtered PATCH must see the row, so another member's private plan cannot be
-- flipped to `crew` and read back (3972's R7 shape).
--
-- ── THE TRAPS THIS REPOSITORY HAS HIT ──────────────────────────────────────
--   42P17 — the predicate reads no table at all: its own row's columns and
--     auth.uid(). Nothing can recurse.
--   x.c = x.c — every column is qualified with the table name.
--
-- ── WHAT THIS FILE DOES NOT CLOSE (recorded in census-trips §90.5) ─────────
-- A route stop COPIED from a private plan (`route_stops.source_type =
-- 'plan_item'`) carries its title and coordinates; 3978's
-- route_stops_member_select decides it by `location_is_private` alone. A
-- restrictive policy on route_stops / route_legs would break 3978's own
-- postcondition (exactly 13 policies on the four route-plan tables), and this
-- band (3720-3724) replays BEFORE 3978. That door needs a file numbered after
-- 3978, or 3978 amended before it is applied — the lead's call. The API path
-- (withheldPlanItemStopIds) already applies the scope.
--
-- Policy-only: no table, column, grant, function or row changes. Idempotent.
--
-- Rollback: db/rollback/2026-10-11-3720-trip-plan-privacy-scope-rls-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_plan_items') IS NULL THEN
    RAISE EXCEPTION '3720: public.trip_plan_items is missing (0010)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.trip_plan_items'::regclass AND attname = 'privacy_scope' AND NOT attisdropped) THEN
    RAISE EXCEPTION '3720: trip_plan_items.privacy_scope is missing — apply 2770 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.trip_plan_items'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '3720: RLS is not enabled on trip_plan_items; a policy would decide nothing';
  END IF;
END
$pre$;

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

COMMIT;

-- ── Postconditions (separate transaction: they recompute from the catalog) ──
DO $post$
DECLARE d text; perm text;
BEGIN
  SELECT pg_get_expr(p.polqual, p.polrelid), CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END
    INTO d, perm
    FROM pg_policy p
   WHERE p.polrelid = 'public.trip_plan_items'::regclass AND p.polname = 'plan_items_privacy_scope_select';
  IF d IS NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3720): plan_items_privacy_scope_select is missing'; END IF;
  IF perm <> 'RESTRICTIVE' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3720): plan_items_privacy_scope_select is %, not RESTRICTIVE — it would WIDEN the crew read', perm;
  END IF;
  IF position('privacy_scope' in d) = 0 OR position('creator_id' in d) = 0 OR position('auth.uid()' in d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3720): plan_items_privacy_scope_select lost its scope or creator clause: %', d;
  END IF;
  IF position('private' in replace(d, 'privacy_scope', '')) <> 0 OR position('selected_participants' in d) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3720): plan_items_privacy_scope_select names a narrow scope as admitting the crew: %', d;
  END IF;
END
$post$;
