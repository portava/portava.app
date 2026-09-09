-- 2534_can_see_trip_status_gate_and_checklist_write_boundary.sql
--
-- public.can_see_trip(uuid) starts meaning what the API means by "on this
-- trip", and the write policies that borrowed it as a write check stop doing
-- so. Seventeen policies on ten tables are downstream; the ones that grant
-- writes are rewritten to the API's own write rules.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2534 (B5).
-- Continuation of 2334 / 2337 / 2530 / 2531. Read 2337 first: it named this
-- defect ("can_see_trip carries the same defect ... relying on it would be
-- relying on one bug to hide another") and left it, because a shared helper is
-- not changed until every dependant is enumerated. They are enumerated below.
--
-- Function-and-policy only: replaces one function body and rewrites eleven
-- policies (two of them split from FOR ALL into per-command policies). It
-- creates no table, column, grant or row. Idempotent (CREATE OR REPLACE; DROP
-- POLICY IF EXISTS then CREATE).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT, MEASURED
-- ══════════════════════════════════════════════════════════════════════════════
-- can_see_trip's body (identical on portava-ci and production, md5
-- 60c90ed059c161b7e233af4f4ba68c73 of pg_get_functiondef):
--
--   t.owner_id = auth.uid()
--   OR EXISTS (trip_members m WHERE m.trip_id = t.id AND m.user_id = auth.uid()
--              AND m.role = ANY (owner, member, co_host, viewer))       -- NO status
--   OR (t.visibility = 'public' AND NOT viewer_is_blocked(t.owner_id))
--
-- and two of its seventeen callers are FOR ALL with no WITH CHECK, so USING
-- doubles as the write check:
--
--   trip_checklists.trip_checklists_members            FOR ALL USING (can_see_trip(trip_id))
--   trip_checklist_items.trip_checklist_items_members  FOR ALL USING (can_see_trip(trip_id))
--
-- Measured on portava-ci 2026-09-07 (fixture trips, rolled back, viewer =
-- authenticated with a real request.jwt.claims sub), a PRIVATE trip P and a
-- PUBLIC trip Q, each with a checklist and an item, BEFORE this migration:
--
--   viewer                    reads P  reads P's  inserts     inserts/updates/deletes
--                                      members    checklist   checklist rows on Q,
--                                                 into P      inserts a note on Q
--   accepted member/co_host   yes      yes        yes         yes
--   pending member, invited   YES      YES (5)    YES         yes
--   REMOVED member            YES      YES (5)    YES         yes
--   stranger (public viewer)  no       no         denied      YES, YES, YES, YES
--
-- The last row is a write-boundary defect: anyone who can SEE a public trip can
-- create, rename and delete its checklists and items and post notes into it.
-- anon and authenticated hold INSERT/UPDATE/DELETE on all of these tables on
-- both databases. The API reads and writes them through the service client;
-- the direct-PostgREST path is the one these policies govern, and the
-- standalone client does use that path for trips and trip_members (see below).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE API MEANS, AND WHAT THIS MIGRATION MAKES RLS MEAN
-- ══════════════════════════════════════════════════════════════════════════════
-- Read from routes/trips-expansion.ts, 2026-09-07:
--
--   GET /trips/:id           accepted member or owner: full view. Otherwise a
--                            PUBLIC trip yields the stripped preview; private /
--                            invite yields 404. A PENDING invitee is "otherwise".
--   checklist create/rename, requireTripMember (accepted crew, viewer included)
--   item create
--   item update/delete       owner, or role IN (owner, co_host, member) -- NOT viewer
--   checklist delete         creator or trip owner
--
-- So, after this migration:
--
--   can_see_trip(t)     := trip owner (unconditionally, as before)
--                          OR authz.is_trip_crew(t)                   -- 2334: role AND status, owner fallback
--                          OR (public AND NOT viewer_is_blocked(owner))
--   READS               keep can_see_trip: trips, trip_members, checklists, items,
--                       notes, documents, saved places, destinations, map pins.
--   trip_members_select gains `OR user_id = auth.uid()`: a person always sees
--                       their OWN membership row, including a pending invite.
--                       travel-buddy-standalone/src/services/trips.ts reads
--                       exactly that row through the anon key to learn its role
--                       ('invited' included); without this branch that read
--                       returns nothing for every pending invitee.
--   WRITES              checklist INSERT / UPDATE, item INSERT, note / document /
--                       saved-place / reminder INSERT: authz.is_trip_crew.
--                       item UPDATE / DELETE: authz.accepted_trip_role(trip_id)
--                       IN (owner, co_host, member) -- the API's rule, viewer
--                       excluded. Checklist DELETE: unchanged (creator or owner,
--                       already the API's rule).
--   The two FOR ALL policies become FOR SELECT; their write half is the
--   explicit per-command policies above, each with WITH CHECK where it writes.
--
-- The owner branch of can_see_trip is kept deliberately, and it is a stated
-- divergence from requireTripMember: an owner whose own membership row says
-- status='removed' is denied by the API helper but keeps seeing their trip
-- here, because trips_update / trips_delete still gate on owner_id and a trip
-- whose owner cannot read it is a worse state than one the app never writes.
--
-- SECOND-ORDER EFFECT, MEASURED RATHER THAN REASONED ABOUT. trip_members_select
-- governs what every SECURITY INVOKER subquery on trip_members can see (2337,
-- "masking, not gating"). After 2337 and 2530 no live policy hand-rolls such a
-- subquery except tri_member_read / trs_member_read, which read the viewer's
-- OWN row and gate on role+status themselves -- the own-row branch keeps that
-- row visible, so their answers do not change. The measured after-state on
-- the local harness (real policies, not predicates) shows a pending invitee
-- seeing exactly one trip_members row on P -- their own -- and nothing else.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ENUMERATION OF DEPENDANTS (both databases, 2026-09-07)
-- ══════════════════════════════════════════════════════════════════════════════
-- pg_depend on can_see_trip(uuid): the seventeen policies named in the
-- precondition below, and nothing else -- no view, no function, no trigger, no
-- default. The precondition refuses if the live dependant set differs from
-- this list, because a new caller is an unmeasured caller.
--
-- DEPENDS ON: 2334 (authz.is_trip_crew), 2337 (authz.accepted_trip_role).
--
-- WHAT THIS DOES NOT TOUCH: trip_reminders.trip_reminders_own is FOR ALL
-- USING (user_id = auth.uid()) with no WITH CHECK, so it lets any user insert
-- a reminder row for ANY trip as long as it is their own -- which makes the
-- crew gate on trip_reminders_insert decorative. Reported; a reminder is the
-- user's own object and whether it must name a trip they are on is a product
-- question this lane does not decide.

BEGIN;

DO $$
DECLARE
  expected text[] := ARRAY[
    'policy pins_select on table map_pins',
    'policy trip_checklist_items_delete on table trip_checklist_items',
    'policy trip_checklist_items_insert on table trip_checklist_items',
    'policy trip_checklist_items_members on table trip_checklist_items',
    'policy trip_checklist_items_update on table trip_checklist_items',
    'policy trip_checklists_insert on table trip_checklists',
    'policy trip_checklists_members on table trip_checklists',
    'policy trip_destinations_select on table trip_destinations',
    'policy trip_documents_insert on table trip_documents',
    'policy trip_documents_members on table trip_documents',
    'policy trip_members_select on table trip_members',
    'policy trip_notes_insert on table trip_notes',
    'policy trip_notes_select on table trip_notes',
    'policy trip_reminders_insert on table trip_reminders',
    'policy trip_saved_places_insert on table trip_saved_places',
    'policy trip_saved_places_members on table trip_saved_places',
    'policy trips_select on table trips'
  ];
  live text[];
  extra text[];
  missing text[];
BEGIN
  -- ── Preconditions ──────────────────────────────────────────────────────────
  IF to_regprocedure('public.can_see_trip(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.can_see_trip(uuid) missing.';
  END IF;
  IF to_regprocedure('authz.is_trip_crew(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: authz.is_trip_crew(uuid) missing -- apply 2334 first.';
  END IF;
  IF to_regprocedure('authz.accepted_trip_role(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: authz.accepted_trip_role(uuid) missing -- apply 2337 first.';
  END IF;
  IF to_regprocedure('public.viewer_is_blocked(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.viewer_is_blocked(uuid) missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='trips' AND column_name='visibility') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trips.visibility missing -- the public-trip branch cannot be expressed.';
  END IF;

  -- Already applied? Then the eight write policies no longer bind to
  -- can_see_trip and the measured dependant set is the nine readers.
  IF pg_get_functiondef('public.can_see_trip(uuid)'::regprocedure) LIKE '%authz.is_trip_crew%'
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('trip_checklists','trip_checklist_items') AND cmd='ALL') THEN
    RAISE NOTICE '2534: already applied (can_see_trip routes through authz.is_trip_crew, no FOR ALL on the checklist tables); re-applying idempotently.';
    expected := ARRAY[
      'policy pins_select on table map_pins',
      'policy trip_checklist_items_members on table trip_checklist_items',
      'policy trip_checklists_members on table trip_checklists',
      'policy trip_destinations_select on table trip_destinations',
      'policy trip_documents_members on table trip_documents',
      'policy trip_members_select on table trip_members',
      'policy trip_notes_select on table trip_notes',
      'policy trip_saved_places_members on table trip_saved_places',
      'policy trips_select on table trips'
    ];
  END IF;

  -- The dependant set must be exactly the one that was measured.
  SELECT array_agg(d ORDER BY d) INTO live
    FROM (SELECT pg_describe_object(classid, objid, objsubid) AS d
            FROM pg_depend
           WHERE refobjid = 'public.can_see_trip(uuid)'::regprocedure AND deptype <> 'i') x;
  SELECT array_agg(d) INTO extra   FROM unnest(coalesce(live, ARRAY[]::text[])) d WHERE d <> ALL (expected);
  SELECT array_agg(d) INTO missing FROM unnest(expected) d WHERE d <> ALL (coalesce(live, ARRAY[]::text[]));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: unmeasured dependants of can_see_trip: %', array_to_string(extra, ', ');
  END IF;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected dependants of can_see_trip are absent (this database is not in the measured state): %', array_to_string(missing, ', ');
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- THE HELPER
-- ══════════════════════════════════════════════════════════════════════════════
-- Signature, schema, volatility, security, search_path and grants unchanged;
-- only the body. Kept in `public` because seventeen policies bind to it by
-- name and the standalone client's reads depend on those policies.
CREATE OR REPLACE FUNCTION public.can_see_trip(t_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT t_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM trips t
     WHERE t.id = t_id
       AND (
         t.owner_id = auth.uid()
         OR authz.is_trip_crew(t.id)
         OR (t.visibility = 'public' AND NOT viewer_is_blocked(t.owner_id))
       )
  );
$function$;

COMMENT ON FUNCTION public.can_see_trip(uuid) IS
  'True when the CURRENT viewer may SEE the trip: its owner, an ACCEPTED member by lib/http.ts requireTripMember''s rule (authz.is_trip_crew: role in (owner, co_host, member, viewer) AND status accepted, owner fallback), or anyone not blocked by the owner when the trip is public. READ predicate only -- a write policy must gate on authz.is_trip_crew / authz.accepted_trip_role, never on this. Until 2534 it read role and never status, so pending invitees and removed members passed, and two FOR ALL policies used it as a write check. See migration 2534.';

-- ══════════════════════════════════════════════════════════════════════════════
-- trip_members: a person always sees their own row
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "trip_members_select" ON public.trip_members;
CREATE POLICY "trip_members_select" ON public.trip_members
  FOR SELECT USING ( user_id = auth.uid() OR can_see_trip(trip_id) );

-- ══════════════════════════════════════════════════════════════════════════════
-- trip_checklists: FOR ALL split into read + per-command writes
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "trip_checklists_members" ON public.trip_checklists;
CREATE POLICY "trip_checklists_members" ON public.trip_checklists
  FOR SELECT USING ( can_see_trip(trip_id) );

DROP POLICY IF EXISTS "trip_checklists_insert" ON public.trip_checklists;
CREATE POLICY "trip_checklists_insert" ON public.trip_checklists
  FOR INSERT WITH CHECK ( created_by = auth.uid() AND authz.is_trip_crew(trip_id) );

-- Rename: any accepted crew member (routes/trips-expansion.ts PATCH gate).
DROP POLICY IF EXISTS "trip_checklists_update" ON public.trip_checklists;
CREATE POLICY "trip_checklists_update" ON public.trip_checklists
  FOR UPDATE
  USING      ( authz.is_trip_crew(trip_id) )
  WITH CHECK ( authz.is_trip_crew(trip_id) );

-- trip_checklists_delete (creator or trip owner) is the API's rule already and
-- is left exactly as it is.

-- ══════════════════════════════════════════════════════════════════════════════
-- trip_checklist_items
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "trip_checklist_items_members" ON public.trip_checklist_items;
CREATE POLICY "trip_checklist_items_members" ON public.trip_checklist_items
  FOR SELECT USING ( can_see_trip(trip_id) );

DROP POLICY IF EXISTS "trip_checklist_items_insert" ON public.trip_checklist_items;
CREATE POLICY "trip_checklist_items_insert" ON public.trip_checklist_items
  FOR INSERT WITH CHECK ( authz.is_trip_crew(trip_id) );

-- Update / delete: owner, co_host or member -- NOT viewer (the API's rule).
DROP POLICY IF EXISTS "trip_checklist_items_update" ON public.trip_checklist_items;
CREATE POLICY "trip_checklist_items_update" ON public.trip_checklist_items
  FOR UPDATE
  USING      ( authz.accepted_trip_role(trip_id) = ANY (ARRAY['owner','co_host','member']::member_role[]) )
  WITH CHECK ( authz.accepted_trip_role(trip_id) = ANY (ARRAY['owner','co_host','member']::member_role[]) );

DROP POLICY IF EXISTS "trip_checklist_items_delete" ON public.trip_checklist_items;
CREATE POLICY "trip_checklist_items_delete" ON public.trip_checklist_items
  FOR DELETE USING ( authz.accepted_trip_role(trip_id) = ANY (ARRAY['owner','co_host','member']::member_role[]) );

-- ══════════════════════════════════════════════════════════════════════════════
-- The four other INSERT policies that borrowed the read predicate as a write gate
-- ══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "trip_notes_insert" ON public.trip_notes;
CREATE POLICY "trip_notes_insert" ON public.trip_notes
  FOR INSERT WITH CHECK ( author_id = auth.uid() AND authz.is_trip_crew(trip_id) );

DROP POLICY IF EXISTS "trip_documents_insert" ON public.trip_documents;
CREATE POLICY "trip_documents_insert" ON public.trip_documents
  FOR INSERT WITH CHECK ( creator_id = auth.uid() AND authz.is_trip_crew(trip_id) );

DROP POLICY IF EXISTS "trip_saved_places_insert" ON public.trip_saved_places;
CREATE POLICY "trip_saved_places_insert" ON public.trip_saved_places
  FOR INSERT WITH CHECK ( user_id = auth.uid() AND authz.is_trip_crew(trip_id) );

DROP POLICY IF EXISTS "trip_reminders_insert" ON public.trip_reminders;
CREATE POLICY "trip_reminders_insert" ON public.trip_reminders
  FOR INSERT WITH CHECK ( user_id = auth.uid() AND authz.is_trip_crew(trip_id) );

-- ══════════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n int;
  offenders text;
  body text;
BEGIN
  body := pg_get_functiondef('public.can_see_trip(uuid)'::regprocedure);
  IF body NOT LIKE '%authz.is_trip_crew(t.id)%' OR body LIKE '%trip_members%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: can_see_trip does not route membership through authz.is_trip_crew.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = 'can_see_trip' AND p.prosecdef
       AND p.proconfig::text LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: can_see_trip is not SECURITY DEFINER with a pinned search_path.';
  END IF;
  IF NOT has_function_privilege('anon', 'public.can_see_trip(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.can_see_trip(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon/authenticated must keep EXECUTE on can_see_trip, or every trip read fails.';
  END IF;

  -- No FOR ALL policy may survive on the two checklist tables.
  SELECT count(*), string_agg(tablename || '.' || policyname, ', ') INTO n, offenders
    FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('trip_checklists','trip_checklist_items') AND cmd = 'ALL';
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: FOR ALL policies remain on the checklist tables: %', offenders;
  END IF;

  -- No write policy on the ten tables may gate on the READ predicate.
  SELECT count(*), string_agg(tablename || '.' || policyname, ', ') INTO n, offenders
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('trips','trip_members','trip_checklists','trip_checklist_items','trip_notes','trip_documents','trip_saved_places','trip_reminders','trip_destinations','map_pins')
     AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
     AND coalesce(qual,'') || coalesce(with_check,'') ~ '\mcan_see_trip\s*\(';
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: write policies still gate on can_see_trip: %', offenders;
  END IF;

  -- Every UPDATE policy this migration wrote carries an explicit WITH CHECK.
  SELECT count(*), string_agg(tablename || '.' || policyname, ', ') INTO n, offenders
    FROM pg_policies
   WHERE schemaname = 'public' AND cmd = 'UPDATE' AND with_check IS NULL
     AND (tablename, policyname) IN (('trip_checklists','trip_checklists_update'), ('trip_checklist_items','trip_checklist_items_update'));
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: UPDATE policies without WITH CHECK: %', offenders;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='trip_members' AND policyname='trip_members_select'
       AND qual LIKE '%user_id = auth.uid()%' AND qual LIKE '%can_see_trip(trip_id)%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trip_members_select lacks the own-row branch.';
  END IF;

  -- Of the seventeen dependants, the eight WRITE policies no longer bind here;
  -- the nine READ policies must still do so.
  SELECT count(*) INTO n FROM pg_depend WHERE refobjid = 'public.can_see_trip(uuid)'::regprocedure AND deptype <> 'i';
  IF n <> 9 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 9 read policies bound to can_see_trip (pins_select, items_members, checklists_members, destinations_select, documents_members, trip_members_select, notes_select, saved_places_members, trips_select), found %', n;
  END IF;

  -- NULL safety.
  IF (SELECT public.can_see_trip(NULL)) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: can_see_trip(NULL) is not false.';
  END IF;
END $$;

COMMIT;
