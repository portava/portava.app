-- 2134_rls_predicate_functions_private_schema.sql
--
-- DRAFT — NOT YET APPLIED ANYWHERE. Prepared 2026-08-23 for staging on
-- portava-ci first; do not run against production until CI verification
-- (see the checklist at the bottom of this file) has actually been done and
-- its results recorded in docs/migrations.md.
--
-- WHY. 16 SECURITY DEFINER functions are RLS policy predicates
-- (is_blocked, in_accepted_circle, can_see_location — the only two-arg,
-- answers-for-arbitrary-pairs ones — plus can_see_post, can_see_postcard,
-- can_see_trip, can_post_to_trip, viewer_is_blocked, shares_trip_with,
-- is_accepted_trip_member, the auth_uid_has_event_{role,rsvp}/
-- auth_uid_is_event_{cohost,host} family, event_is_in_state, and
-- user_is_event_participant) that live in `public`, which PostgREST exposes
-- as directly-callable RPC endpoints
-- (POST /rest/v1/rpc/<function_name>) to any anon or authenticated caller.
-- is_blocked, in_accepted_circle and can_see_location take BOTH user ids as
-- parameters, so calling them directly answers "does A block B" / "is A in
-- B's accepted circle" / "can A see B's location" for ARBITRARY pairs — a
-- live enumeration oracle, independent of any RLS policy that also happens
-- to use the same function internally.
--
-- They cannot simply have EXECUTE revoked from anon/authenticated: RLS
-- policies on highlights, messages, user_locations and others call these
-- functions from inside their USING/WITH CHECK expressions, and Postgres
-- requires the QUERYING role (anon or authenticated, not the function
-- owner) to hold EXECUTE on a SECURITY DEFINER function referenced that way.
-- Revoking EXECUTE would turn an information leak into an outage — every
-- ordinary anon/authenticated SELECT against those tables would start
-- erroring instead of returning filtered rows.
--
-- THE FIX: move the functions out of `public` into a `private` schema that
-- Supabase's PostgREST layer does not expose (its db-schemas setting lists
-- `public` — and whatever else is explicitly configured — never a schema
-- created here for the first time). PostgREST can then no longer route
-- POST /rest/v1/rpc/is_blocked to it at all — a 404, not a 403 — while RLS
-- policies keep working unmodified.
--
-- WHY POLICIES DO NOT NEED TO BE REWRITTEN. `ALTER FUNCTION ... SET SCHEMA`
-- changes which schema a function is *listed* under; it does not change the
-- function's OID. Every existing RLS policy's USING/WITH CHECK clause is
-- stored as a parsed expression tree that references this function BY OID,
-- not by schema-qualified name — so moving the schema does not invalidate
-- or require editing a single policy.
--
-- VERIFIED EMPIRICALLY (2026-08-23), not just asserted from documentation:
-- a disposable local PostgreSQL 16 instance with a two-arg SECURITY DEFINER
-- is_blocked(uuid,uuid), a policy-protected `messages` table whose SELECT
-- policy calls it, and one blocked and one unblocked message row. Before the
-- move: anon sees only the unblocked message (policy enforced). After
-- `ALTER FUNCTION public.is_blocked(uuid,uuid) SET SCHEMA private` +
-- re-granting USAGE/EXECUTE exactly as this migration does: pg_proc's oid
-- for is_blocked is byte-identical (16394 before and after, only
-- pronamespace changed public -> private); `to_regprocedure('public.is_blocked
-- (uuid,uuid)')` returns NULL (PostgREST would 404, confirming the oracle is
-- closed); the policy's stored expression AUTOMATICALLY re-displays as
-- `private.is_blocked(...)` via pg_get_expr with no edit; and anon still
-- sees only the unblocked message, identical to before the move. A second,
-- guarded run of the same ALTER (mirroring this file's idempotency check)
-- was also confirmed to no-op cleanly rather than error. This proves the
-- general Postgres mechanism this migration relies on; it does not replace
-- running the checklist below against the real, full schema on portava-ci —
-- these 16 functions, their actual policies, and this codebase's specific
-- RLS test suites were not part of this local reproduction.
--
-- WHAT THIS MIGRATION DOES NOT TOUCH: the 3 PostGIS st_estimatedextent
-- functions mentioned alongside these 16 in the original audit are
-- deliberately left alone — they are PostGIS-owned, not application RLS
-- predicates, and moving them is out of scope here.
--
-- EXECUTE grants to anon/authenticated/service_role are preserved across the
-- move (Postgres does not drop grants on ALTER FUNCTION ... SET SCHEMA) and
-- are also explicitly re-stated below for auditability — this migration
-- does not change WHO can execute these functions, only WHERE PostgREST can
-- find them.

BEGIN;

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  fn text;
  fns text[] := ARRAY[
    'is_blocked(uuid, uuid)',
    'in_accepted_circle(uuid, uuid)',
    'can_see_location(uuid, uuid)',
    'can_see_post(uuid)',
    'can_see_postcard(uuid)',
    'can_see_trip(uuid)',
    'can_post_to_trip(uuid)',
    'viewer_is_blocked(uuid)',
    'shares_trip_with(uuid)',
    'is_accepted_trip_member(uuid)',
    'auth_uid_has_event_role(uuid, public.event_role_type[])',
    'auth_uid_has_event_rsvp(uuid, public.event_rsvp_status[])',
    'auth_uid_is_event_cohost(uuid)',
    'auth_uid_is_event_host(uuid)',
    'event_is_in_state(uuid, public.event_state[])',
    'user_is_event_participant(uuid)'
  ];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    IF to_regprocedure('public.' || fn) IS NULL
       AND to_regprocedure('private.' || fn) IS NULL THEN
      missing := missing || fn;
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: missing from both public and private: %', missing;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS private;
COMMENT ON SCHEMA private IS
  'Application-internal functions that must remain callable from RLS policies '
  '(via SECURITY DEFINER + EXECUTE grant) but must NOT be reachable as a '
  'PostgREST RPC endpoint. Not listed in PostgREST db-schemas — verify that '
  'remains true after any Supabase API-settings change (see 2134''s bottom '
  'checklist). Nothing here is meant to be called directly by client code.';

-- Callers need USAGE on the schema in addition to EXECUTE on the function —
-- this is the grant that is easy to forget and would silently break every
-- RLS policy using these functions if omitted (schema-level permission
-- denied, not a function-level one, so it fails in a way this migration's
-- own author would not see without testing an actual anon/authenticated
-- query against a policy-protected table).
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;

DO $$
DECLARE
  fn text;
  fns text[] := ARRAY[
    'is_blocked(uuid, uuid)',
    'in_accepted_circle(uuid, uuid)',
    'can_see_location(uuid, uuid)',
    'can_see_post(uuid)',
    'can_see_postcard(uuid)',
    'can_see_trip(uuid)',
    'can_post_to_trip(uuid)',
    'viewer_is_blocked(uuid)',
    'shares_trip_with(uuid)',
    'is_accepted_trip_member(uuid)',
    'auth_uid_has_event_role(uuid, public.event_role_type[])',
    'auth_uid_has_event_rsvp(uuid, public.event_rsvp_status[])',
    'auth_uid_is_event_cohost(uuid)',
    'auth_uid_is_event_host(uuid)',
    'event_is_in_state(uuid, public.event_state[])',
    'user_is_event_participant(uuid)'
  ];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    -- Idempotent: only move if still in public. A prior partial run (or a
    -- replay after this migration already succeeded) leaves this a no-op.
    IF to_regprocedure('public.' || fn) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION public.%s SET SCHEMA private', fn);
    END IF;

    -- Re-state grants explicitly regardless of move state, rather than
    -- relying on them having survived the ALTER — matches the earlier
    -- lesson from today's hardening pass: a REVOKE/GRANT that *looks* right
    -- can be a silent no-op (e.g. anon still inheriting EXECUTE through a
    -- PUBLIC grant this migration never touched). REVOKE FROM PUBLIC first,
    -- then GRANT to the three roles that actually need it.
    EXECUTE format('REVOKE ALL ON FUNCTION private.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION private.%s TO anon, authenticated, service_role', fn);
  END LOOP;
END $$;

COMMIT;

-- ============================================================================
-- CI VERIFICATION CHECKLIST — run every item below on portava-ci BEFORE
-- proposing this for production, and record the results in docs/migrations.md
-- the same way every other applied migration in this repo is recorded.
-- Nothing in this file should be considered done until this checklist has
-- actually been run against a live database; it was drafted without one.
-- ============================================================================
--
-- 1. Confirm PostgREST does not expose `private`:
--      select current_setting('pgrst.db_schemas', true);
--    (or check the Supabase project's API settings "Exposed schemas" list)
--    — `private` must not appear.
--
-- 2. Confirm the enumeration oracle is closed — as the anon key, attempt:
--      POST /rest/v1/rpc/is_blocked  {"a": "<uuid>", "b": "<uuid>"}
--    Expect 404 (function not found), not a result and not a 403.
--
-- 3. Confirm RLS still evaluates correctly for both anon and authenticated
--    sessions against every table whose policy references one of the 16
--    moved functions — at minimum: highlights, messages, user_locations,
--    posts (can_see_post), postcards (can_see_postcard), trips
--    (can_see_trip / can_post_to_trip / is_accepted_trip_member /
--    shares_trip_with), events (auth_uid_has_event_role/_rsvp,
--    auth_uid_is_event_cohost/_host, event_is_in_state,
--    user_is_event_participant). A query that should return rows must still
--    return them; a query that should return zero rows (blocked user,
--    non-member, etc.) must still return zero, not error.
--
-- 4. Run the project's existing RLS/policy test suites
--    (rlsPrivacy.test.ts, rlsPrivacyBaseline.test.ts, rlsDispositions.test.ts,
--    rlsHardening.test.ts, blockExclusion.test.ts, eventsCirclesOwner.test.ts,
--    circleLocations.test.ts, tripMembers.test.ts, tripPlan.test.ts) against
--    CI with this migration applied — all must still pass.
--
-- 5. Confirm the function OIDs did not change (proves policies are still
--    the same compiled reference, not silently broken and coincidentally
--    still passing):
--      select proname, oid, pronamespace::regnamespace
--        from pg_proc where proname in (
--          'is_blocked','in_accepted_circle','can_see_location','can_see_post',
--          'can_see_postcard','can_see_trip','can_post_to_trip',
--          'viewer_is_blocked','shares_trip_with','is_accepted_trip_member',
--          'auth_uid_has_event_role','auth_uid_has_event_rsvp',
--          'auth_uid_is_event_cohost','auth_uid_is_event_host',
--          'event_is_in_state','user_is_event_participant');
--    Compare oid values against a pre-migration snapshot of the same query.
--
-- 6. Only after 1-5 pass on CI: propose applying to production as a
--    separate, explicitly reviewed step — do not apply to production as
--    part of the same operation that verified CI.
