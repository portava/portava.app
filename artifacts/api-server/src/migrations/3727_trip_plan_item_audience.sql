-- 3727_trip_plan_item_audience.sql
--
-- census-trips TR116 / §95. Owner ruling OD-1012-PRIV-5 (2026-10-12, verbatim):
--   "Organizers may narrow a plan's visibility, but organizer status alone
--    grants no access to someone else's private plan. Private access is limited
--    to its author and explicitly selected people. Time slots inherit plan
--    privacy. Never widen visibility automatically."
-- and OD-TRIP-3: "...trip membership or organizer status alone does not grant
-- access."
--
-- APPLIED TO NO DATABASE by the lane that wrote it (wave W, 2026-10-12). Needs
-- 2770 (`trip_plan_items.privacy_scope`) and 3720 (the restrictive scope
-- policy this file replaces). Its application is the owner's.
--
-- ── WHAT THIS ADDS ─────────────────────────────────────────────────────────
-- 1. `trip_plan_item_audience`: the EXPLICIT selection behind §6.3's
--    SELECTED_PARTICIPANTS — one row per (plan item, selected person). Written
--    only by `trip_plan_item_audience_replace` below, which the API calls as
--    service_role for the plan's AUTHOR. No client role holds any privilege on
--    the table (rule 4) and it carries no policy. It is NOT
--    `trip_plan_participants` (2771): that is self-service attendance.
-- 2. `trip_plan_item_audience_replace(item, actor, members[])`: replaces the
--    selection in ONE transaction, the item row locked. It refuses unless the
--    actor is the item's creator, the item is live and ALREADY scoped
--    `selected_participants`, and every selected person is an accepted member
--    of the item's trip (requireTripMember's rule, owner fallback included) and
--    not the author. SECURITY INVOKER; EXECUTE for service_role only.
-- 3. Lifecycle triggers, so nothing can revive a selection later ("never widen
--    automatically"):
--      - any change of an item's privacy_scope, or its removal, deletes its
--        selection (a scope ENTERING selected_participants therefore starts
--        EMPTY = creator only, and the author's selection is written after);
--      - a membership that begins, ends, or leaves accepted status deletes the
--        rows that select that person on that trip.
-- 4. The client-door guard (BEFORE UPDATE on trip_plan_items): a PostgREST
--    session (auth.uid() set) that is NOT the item's creator — in practice the
--    organizer, whom 2337's plan_items_update admits — may only NARROW
--    privacy_scope, may not turn a private place public, and may not take over
--    creator_id. The service role (the API, the kernel) has no auth.uid() and is
--    governed by the API's own rule (routes/trips.ts + tripPlanPrivacy.ts).
-- 5. `plan_items_privacy_scope_select` (3720, RESTRICTIVE) is recreated with one
--    added arm: a `selected_participants` row is also readable by a person the
--    author selected (authz.plan_item_audience_admits, auth.uid() read inside —
--    never a parameter, so it is no oracle for anyone else). Everything 3720
--    closed stays closed: crew-wide scopes, or the creator; nothing else.
--
-- ── THE SCOPE ORDER (the API's, tripPlanPrivacy.ts PRIVACY_SCOPE_BREADTH) ───
--   private 0 < selected_participants 1 < crew 2 < {friends_nearby, trip} 3 < public 4
-- friends_nearby and trip share a rank and are NOT comparable: moving between
-- them is not narrowing. An unknown current scope is the most private: nothing
-- is narrower than it.
--
-- ── THE TRAPS THIS REPOSITORY HAS HIT ──────────────────────────────────────
--   42P17 — the policy reads no RLS-bound table directly: the audience lookup
--     is a SECURITY DEFINER function over a table with no policy.
--   x.c = x.c — every column is qualified.
--   member_role ENUM — compared as text (3972's 22P02 lesson).
--   Postconditions recompute from the catalog (no session state).
--
-- Rollback: db/rollback/2026-10-12-3727-trip-plan-item-audience-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_plan_items') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3727): public.trip_plan_items is missing (0010)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.trip_plan_items'::regclass AND attname = 'privacy_scope' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3727): trip_plan_items.privacy_scope is missing — apply 2770 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.trip_plan_items'::regclass AND polname = 'plan_items_privacy_scope_select') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3727): plan_items_privacy_scope_select is missing — apply 3720 first';
  END IF;
  IF to_regprocedure('authz.is_trip_crew(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3727): authz.is_trip_crew(uuid) is missing (2334)';
  END IF;
  IF to_regclass('public.trip_plan_item_audience') IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3727): public.trip_plan_item_audience already exists; read it before re-running.';
  END IF;
END
$pre$;

-- ── 1. the selection ───────────────────────────────────────────────────────
CREATE TABLE public.trip_plan_item_audience (
  plan_item_id uuid        NOT NULL REFERENCES public.trip_plan_items(id) ON DELETE CASCADE,
  trip_id      uuid        NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  member_id    uuid        NOT NULL,
  added_by     uuid        NOT NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_item_id, member_id),
  CONSTRAINT trip_plan_item_audience_not_author CHECK (member_id <> added_by)
);

CREATE INDEX trip_plan_item_audience_viewer_idx ON public.trip_plan_item_audience (trip_id, member_id);

COMMENT ON TABLE public.trip_plan_item_audience IS
  'census-trips §95 (TR116, OD-1012-PRIV-5): the people a plan''s AUTHOR explicitly selected for a selected_participants plan. Written only through trip_plan_item_audience_replace (service_role, author only, accepted crew only). Cleared when the plan''s scope changes or it is removed, and when a selected person''s membership begins or ends. Not trip_plan_participants (self-service attendance).';

ALTER TABLE public.trip_plan_item_audience ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trip_plan_item_audience FROM PUBLIC;
REVOKE ALL ON public.trip_plan_item_audience FROM anon;
REVOKE ALL ON public.trip_plan_item_audience FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.trip_plan_item_audience TO service_role;

-- ── 2. the one writer ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trip_plan_item_audience_replace(p_item_id uuid, p_actor_id uuid, p_member_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_trip uuid; v_creator uuid; v_scope text; v_removed timestamptz;
  v_members uuid[] := coalesce(p_member_ids, ARRAY[]::uuid[]);
  v_bad uuid; v_n integer;
BEGIN
  SELECT i.trip_id, i.creator_id, i.privacy_scope, i.removed_at
    INTO v_trip, v_creator, v_scope, v_removed
    FROM public.trip_plan_items i
   WHERE i.id = p_item_id
   FOR UPDATE;
  IF NOT FOUND OR v_removed IS NOT NULL THEN
    RAISE EXCEPTION 'TRIP_PLAN_AUDIENCE_ITEM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_actor_id IS NULL OR v_creator IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'TRIP_PLAN_AUDIENCE_NOT_AUTHOR' USING ERRCODE = '42501';
  END IF;
  IF v_scope IS DISTINCT FROM 'selected_participants' THEN
    RAISE EXCEPTION 'TRIP_PLAN_AUDIENCE_SCOPE_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_members) > 50 THEN
    RAISE EXCEPTION 'TRIP_PLAN_AUDIENCE_TOO_LARGE' USING ERRCODE = '22023';
  END IF;
  SELECT m INTO v_bad
    FROM unnest(v_members) AS u(m)
   WHERE u.m IS NULL
      OR u.m = v_creator
      OR NOT (
        EXISTS (SELECT 1 FROM public.trip_members tm
                 WHERE tm.trip_id = v_trip AND tm.user_id = u.m
                   AND tm.role::text IN ('owner', 'co_host', 'member', 'viewer')
                   AND coalesce(tm.status, 'accepted') = 'accepted')
        OR (NOT EXISTS (SELECT 1 FROM public.trip_members tm2 WHERE tm2.trip_id = v_trip AND tm2.user_id = u.m)
            AND EXISTS (SELECT 1 FROM public.trips t WHERE t.id = v_trip AND t.owner_id = u.m))
      )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'TRIP_PLAN_AUDIENCE_NOT_CREW' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.trip_plan_item_audience a WHERE a.plan_item_id = p_item_id;
  INSERT INTO public.trip_plan_item_audience (plan_item_id, trip_id, member_id, added_by)
  SELECT DISTINCT p_item_id, v_trip, u.m, p_actor_id FROM unnest(v_members) AS u(m);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

COMMENT ON FUNCTION public.trip_plan_item_audience_replace(uuid, uuid, uuid[]) IS
  'census-trips §95 (OD-1012-PRIV-5): replace a selected_participants plan''s selection atomically. Author only; item live and already scoped selected_participants; every member an accepted member of the trip and not the author; at most 50. service_role only.';

REVOKE ALL ON FUNCTION public.trip_plan_item_audience_replace(uuid, uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trip_plan_item_audience_replace(uuid, uuid, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.trip_plan_item_audience_replace(uuid, uuid, uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.trip_plan_item_audience_replace(uuid, uuid, uuid[]) TO service_role;

-- ── 3. lifecycle: nothing revives ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trip_plan_item_audience_clear_on_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF NEW.privacy_scope IS DISTINCT FROM OLD.privacy_scope OR NEW.removed_at IS NOT NULL THEN
    DELETE FROM public.trip_plan_item_audience a WHERE a.plan_item_id = NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trip_plan_items_clear_audience ON public.trip_plan_items;
CREATE TRIGGER trip_plan_items_clear_audience
  AFTER UPDATE OF privacy_scope, removed_at ON public.trip_plan_items
  FOR EACH ROW EXECUTE FUNCTION public.trip_plan_item_audience_clear_on_item();

CREATE OR REPLACE FUNCTION public.trip_plan_item_audience_clear_on_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE was_accepted boolean; is_accepted boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    DELETE FROM public.trip_plan_item_audience a WHERE a.trip_id = NEW.trip_id AND a.member_id = NEW.user_id;
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.trip_plan_item_audience a WHERE a.trip_id = OLD.trip_id AND a.member_id = OLD.user_id;
    RETURN NULL;
  END IF;
  was_accepted := coalesce(OLD.role::text, '') IN ('owner', 'co_host', 'member', 'viewer') AND coalesce(OLD.status, 'accepted') = 'accepted';
  is_accepted  := coalesce(NEW.role::text, '') IN ('owner', 'co_host', 'member', 'viewer') AND coalesce(NEW.status, 'accepted') = 'accepted';
  IF was_accepted IS DISTINCT FROM is_accepted OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.trip_id IS DISTINCT FROM NEW.trip_id THEN
    DELETE FROM public.trip_plan_item_audience a
     WHERE (a.trip_id = OLD.trip_id AND a.member_id = OLD.user_id)
        OR (a.trip_id = NEW.trip_id AND a.member_id = NEW.user_id);
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trip_members_clear_plan_audience ON public.trip_members;
CREATE TRIGGER trip_members_clear_plan_audience
  AFTER INSERT OR DELETE OR UPDATE OF role, status, user_id, trip_id ON public.trip_members
  FOR EACH ROW EXECUTE FUNCTION public.trip_plan_item_audience_clear_on_membership();

REVOKE ALL ON FUNCTION public.trip_plan_item_audience_clear_on_item() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_plan_item_audience_clear_on_membership() FROM PUBLIC, anon, authenticated;

-- ── 4. the client door: a non-author session never widens ─────────────────
CREATE OR REPLACE FUNCTION public.trip_plan_items_client_never_widens()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE v_uid uuid := auth.uid(); v_old int; v_new int;
BEGIN
  IF v_uid IS NULL OR v_uid = OLD.creator_id THEN
    RETURN NEW;
  END IF;
  IF NEW.creator_id IS DISTINCT FROM OLD.creator_id THEN
    RAISE EXCEPTION 'TRIP_PLAN_CREATOR_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF OLD.location_is_private IS NOT FALSE AND NEW.location_is_private IS FALSE THEN
    RAISE EXCEPTION 'TRIP_PLAN_SCOPE_WIDENING_REFUSED' USING ERRCODE = '42501';
  END IF;
  IF NEW.privacy_scope IS DISTINCT FROM OLD.privacy_scope THEN
    v_old := CASE OLD.privacy_scope WHEN 'private' THEN 0 WHEN 'selected_participants' THEN 1 WHEN 'crew' THEN 2
                                    WHEN 'friends_nearby' THEN 3 WHEN 'trip' THEN 3 WHEN 'public' THEN 4 END;
    v_new := CASE NEW.privacy_scope WHEN 'private' THEN 0 WHEN 'selected_participants' THEN 1 WHEN 'crew' THEN 2
                                    WHEN 'friends_nearby' THEN 3 WHEN 'trip' THEN 3 WHEN 'public' THEN 4 END;
    IF v_old IS NULL OR v_new IS NULL OR v_new >= v_old THEN
      RAISE EXCEPTION 'TRIP_PLAN_SCOPE_WIDENING_REFUSED' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trip_plan_items_client_never_widens ON public.trip_plan_items;
CREATE TRIGGER trip_plan_items_client_never_widens
  BEFORE UPDATE OF privacy_scope, location_is_private, creator_id ON public.trip_plan_items
  FOR EACH ROW EXECUTE FUNCTION public.trip_plan_items_client_never_widens();

REVOKE ALL ON FUNCTION public.trip_plan_items_client_never_widens() FROM PUBLIC, anon, authenticated;

-- ── 5. the selected person's read, through RLS ─────────────────────────────
CREATE OR REPLACE FUNCTION authz.plan_item_audience_admits(p_item_id uuid, p_trip_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT auth.uid() IS NOT NULL
     AND p_item_id IS NOT NULL AND p_trip_id IS NOT NULL
     AND authz.is_trip_crew(p_trip_id)
     AND EXISTS (SELECT 1 FROM public.trip_plan_item_audience a
                  WHERE a.plan_item_id = p_item_id
                    AND a.trip_id = p_trip_id
                    AND a.member_id = auth.uid());
$fn$;

COMMENT ON FUNCTION authz.plan_item_audience_admits(uuid, uuid) IS
  'census-trips §95 (OD-1012-PRIV-5): did this plan''s author select the CURRENT viewer (auth.uid(), read inside — never a parameter), who is still accepted crew? Reads no trip_plan_items row, so the trip_plan_items policy can call it without recursion. EXECUTE stays with the client roles: an RLS predicate evaluates with the querying role''s privileges (see checkSecurityDefinerOracles.ts).';

GRANT EXECUTE ON FUNCTION authz.plan_item_audience_admits(uuid, uuid) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "plan_items_privacy_scope_select" ON public.trip_plan_items;
CREATE POLICY "plan_items_privacy_scope_select" ON public.trip_plan_items
  AS RESTRICTIVE
  FOR SELECT
  USING (
    trip_plan_items.privacy_scope IN ('crew', 'trip', 'friends_nearby', 'public')
    OR trip_plan_items.creator_id = auth.uid()
    OR (trip_plan_items.privacy_scope = 'selected_participants'
        AND authz.plan_item_audience_admits(trip_plan_items.id, trip_plan_items.trip_id))
  );

COMMENT ON POLICY "plan_items_privacy_scope_select" ON public.trip_plan_items IS
  'census-trips §90/§95 (TR116, OD-1012-PRIV-5): RESTRICTIVE. A plan whose privacy_scope is not the crew''s is readable through RLS by its creator, and — for selected_participants only — by the people its author selected (trip_plan_item_audience, still accepted crew). Unknown scopes: creator only. ANDs with plan_items_select (3972).';

COMMIT;

-- ── Postconditions (separate request: they recompute from the catalog) ─────
DO $post$
DECLARE d text; perm text; bad text; n int;
BEGIN
  IF to_regclass('public.trip_plan_item_audience') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727): trip_plan_item_audience was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trip_plan_item_audience'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727): RLS is not enabled on trip_plan_item_audience';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.trip_plan_item_audience'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727): trip_plan_item_audience has a policy; it must be service-role only';
  END IF;
  SELECT string_agg(format('%s:%s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type), ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.trip_plan_item_audience'::regclass
     AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727): a client role holds privileges on trip_plan_item_audience: %', bad;
  END IF;
  IF has_function_privilege('authenticated', 'public.trip_plan_item_audience_replace(uuid, uuid, uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.trip_plan_item_audience_replace(uuid, uuid, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727): a client role can execute trip_plan_item_audience_replace';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.trip_plan_item_audience_replace(uuid, uuid, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727): service_role cannot execute trip_plan_item_audience_replace';
  END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgname IN ('trip_plan_items_clear_audience', 'trip_members_clear_plan_audience', 'trip_plan_items_client_never_widens') AND NOT tgisinternal;
  IF n <> 3 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3727): expected 3 triggers, found %', n; END IF;

  SELECT pg_get_expr(p.polqual, p.polrelid), CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END
    INTO d, perm
    FROM pg_policy p
   WHERE p.polrelid = 'public.trip_plan_items'::regclass AND p.polname = 'plan_items_privacy_scope_select';
  IF d IS NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3727): plan_items_privacy_scope_select is missing'; END IF;
  IF perm <> 'RESTRICTIVE' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727): plan_items_privacy_scope_select is %, not RESTRICTIVE — it would WIDEN the crew read', perm;
  END IF;
  IF position('creator_id' in d) = 0 OR position('auth.uid()' in d) = 0 OR position('plan_item_audience_admits' in d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727): plan_items_privacy_scope_select lost its creator or selection clause: %', d;
  END IF;
  IF position('selected_participants' in d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727): the selection arm is not bound to selected_participants: %', d;
  END IF;
  -- `private` must never appear as an admitting scope; selected_participants only beside the selection check.
  IF position('''private''' in d) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727): plan_items_privacy_scope_select names private as admitting: %', d;
  END IF;

  -- A caller with no session is selected for nothing.
  IF authz.plan_item_audience_admits(gen_random_uuid(), gen_random_uuid()) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3727): plan_item_audience_admits answered TRUE with no viewer';
  END IF;
  RAISE NOTICE '3727 postcondition: trip_plan_item_audience is service-role only; the selection arm, the lifecycle and the client never-widen guard are in place.';
END
$post$;
