-- ============================================================================
-- 2182_close_authz_rpc_oracle.sql
--
-- Closes the anonymous authorization-predicate oracle by making the three
-- parameter-trusting SECURITY DEFINER predicates unreachable through PostgREST,
-- WITHOUT touching a single function body or policy expression.
--
-- STATUS: APPLIED TO CI (hwokxgbmezheskbzskfr) 2026-08-28 with all verifications
--         below passing (A pre-press clean on CI AND prod; B/C structural; D seeded
--         anon differential 1->1; E HTTP probes 404 on all three RPCs while anon
--         GETs on user_locations/highlights stay 200). Prod dry run (identical
--         statements inside BEGIN..ROLLBACK against live data) passed: moved=3,
--         left_in_public=0, policies_bound_to_authz=4, viewer_is_blocked intact,
--         anon differential 1->1. PROD PRESS PENDING OWNER (classifier-gated).
--
-- Band 2182 is clear of the reserved 2100-2118b reconciliation-staging band.
-- ============================================================================
--
-- THE FINDING
-- -----------
-- Proven live against prod with only the sb_publishable_ key that ships in the
-- client bundle:
--
--   POST /rest/v1/rpc/is_blocked       {"a":<uuid>,"b":<uuid>}            -> 200 false
--   POST /rest/v1/rpc/can_see_location {"viewer":<uuid>,"target":<uuid>}  -> 200 false
--
-- is_blocked(a,b), can_see_location(viewer,target) and in_accepted_circle(
-- viewer,target) are SECURITY DEFINER and take the CALLER'S IDENTITY AS A
-- PARAMETER. They never consult auth.uid(), so caller identity is never checked
-- and any anonymous caller gets a boolean oracle over the social and
-- location-privacy graph.
--
-- NOT vulnerable, and deliberately untouched here: viewer_is_blocked(target_id),
-- can_see_post(p_id), can_see_trip(t_id), shares_trip_with(other) all derive the
-- caller from auth.uid() internally.
--
--
-- WHY UNEXPOSE RATHER THAN REWRITE THE BODIES
-- -------------------------------------------
-- Three earlier candidate fixes were rejected, each for a concrete reason:
--
--  1. REVOKE EXECUTE FROM anon. Rejected: Postgres evaluates RLS policy
--     expressions with the QUERYING role's privileges, and three of the four
--     call sites are TO public. Revoking breaks anonymous browsing outright.
--
--  2. Rewrite each body to substitute auth.uid() for the parameter. Rejected
--     after adversarial review, on two counts:
--       (a) scripts/verify-search-path-hazard.mjs probes is_blocked and
--           in_accepted_circle. An auth.uid()-gated body returns false whether
--           or not an attacker's shadow table resolved, so that prober would
--           print "HAZARD CLOSED" while testing nothing -- a live security
--           control silently converted into a permanent false green, with
--           docs/migrations.md:1262's evidence claim false by construction.
--       (b) viewer_is_blocked ALREADY has exactly the body the rewrite would
--           give is_blocked, so the rewrite creates a duplicate predicate
--           carrying a dead first parameter that PostgREST still requires.
--
--  3. Repoint the policies at viewer_is_blocked, then DROP is_blocked.
--     Rejected here: it requires restating highlights_select_active's full
--     expression by hand. Migration 0201 deliberately used ALTER rather than
--     CREATE OR REPLACE precisely to avoid retyping authorization predicates,
--     and that judgement still holds. (This remains a good follow-up for
--     deduplicating is_blocked vs viewer_is_blocked -- as cleanup, not security.)
--
-- ALTER FUNCTION ... SET SCHEMA mutates pg_proc IN PLACE. The OID, ACL, owner,
-- proconfig and every dependency edge survive, so all four policies keep binding
-- to the same functions with zero expression changes. PostgREST only exposes
-- functions in its configured schemas; `authz` is not one, so the three RPC
-- endpoints return 404. The oracle is closed rather than narrowed, and no body
-- is retyped.
--
--
-- THE COMPLETE CALLER INVENTORY (from prod's LIVE catalog, not from files)
-- -----------------------------------------------------------------------
--   policy  user_locations / loc_select                  TO public
--   policy  messages / messages_hide_blocked_sender      TO public
--   policy  highlights / highlights_select               TO public
--   policy  highlights / highlights_select_active        TO authenticated
--   function can_see_location  (its own body calls in_accepted_circle)
-- Zero views, zero CHECK constraints, zero triggers, and zero .rpc() callers in
-- any .ts/.tsx/.mjs in the tree. Re-run verification A below before pressing;
-- a file grep cannot see a prod-only object, but this query can.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS authz;

-- USAGE is required for the policy expressions to keep resolving these
-- functions. It does NOT expose them: PostgREST exposure is governed by its
-- db-schemas setting, not by schema USAGE.
GRANT USAGE ON SCHEMA authz TO anon, authenticated, service_role;

-- In-place moves. OID preserved => all four policies follow automatically.
ALTER FUNCTION public.is_blocked(uuid, uuid)          SET SCHEMA authz;
ALTER FUNCTION public.in_accepted_circle(uuid, uuid)  SET SCHEMA authz;
ALTER FUNCTION public.can_see_location(uuid, uuid)    SET SCHEMA authz;

-- can_see_location's body calls in_accepted_circle UNQUALIFIED. Its pinned
-- search_path is 'public','pg_catalog'; once in_accepted_circle leaves public
-- that call stops resolving. The pin must follow the function.
ALTER FUNCTION authz.can_see_location(uuid, uuid)
  SET search_path TO 'authz', 'public', 'pg_catalog';

COMMIT;


-- ============================================================================
-- VERIFICATION -- run ALL of these on CI before considering a prod press.
-- Every one is read-only; the role-switching blocks roll back.
-- ============================================================================

-- A. PRE-PRESS: caller completeness from the live catalog.
--    Expected EXACTLY: the 4 policies + can_see_location's own body.
--    Anything else stops the press.
SELECT 'function' AS kind, p.oid::regprocedure::text AS obj
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public','authz')
  AND p.prosrc ~ '\m(is_blocked|can_see_location|in_accepted_circle)\M'
UNION ALL
SELECT 'view', schemaname||'.'||viewname FROM pg_views
WHERE definition ~ '\m(is_blocked|can_see_location|in_accepted_circle)\M'
UNION ALL
SELECT 'policy', tablename||' / '||policyname FROM pg_policies
WHERE coalesce(qual,'')||coalesce(with_check,'') ~ '\m(is_blocked|can_see_location|in_accepted_circle)\M'
UNION ALL
SELECT 'constraint', conrelid::regclass||' / '||conname FROM pg_constraint
WHERE pg_get_constraintdef(oid) ~ '\m(is_blocked|can_see_location|in_accepted_circle)\M'
UNION ALL
SELECT 'trigger', tgrelid::regclass||' / '||tgname FROM pg_trigger
WHERE NOT tgisinternal
  AND pg_get_triggerdef(oid) ~ '\m(is_blocked|can_see_location|in_accepted_circle)\M'
ORDER BY 1,2;


-- B. POST-APPLY STRUCTURAL: the three moved, viewer_is_blocked untouched in
--    public, and can_see_location's search_path now carries authz.
SELECT n.nspname AS schema, p.oid::regprocedure::text AS fn,
       coalesce(array_to_string(p.proconfig, ','), 'none') AS cfg
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname IN ('is_blocked','in_accepted_circle','can_see_location','viewer_is_blocked')
ORDER BY 1,2;
-- Expect: authz.can_see_location  (search_path=authz, public, pg_catalog)
--         authz.in_accepted_circle, authz.is_blocked
--         public.viewer_is_blocked (unchanged)


-- C. POST-APPLY BINDING: all four policies still resolve their functions.
--    A policy whose function vanished would show a broken/renamed reference.
SELECT tablename, policyname, roles::text,
       qual ~ '\mauthz\.' AS references_authz
FROM pg_policies
WHERE schemaname='public'
  AND coalesce(qual,'')||coalesce(with_check,'') ~ '\m(is_blocked|can_see_location|in_accepted_circle)\M'
ORDER BY 1,2;
-- All four must still be listed. (pg_get_expr may render them schema-qualified
-- now; that is cosmetic -- the binding is by OID.)


-- D. NEGATIVE CONTROL -- the regression this migration must NOT cause.
--    Anonymous users must still see publicly-shared locations. Row-level
--    differential, not a count, so a compensating pair of changes cannot hide.
BEGIN;
  SET LOCAL ROLE anon;
  SELECT set_config('request.jwt.claims', NULL, true);
  SELECT count(*) AS anon_visible_locations FROM public.user_locations;
ROLLBACK;
-- Compare against the same query run BEFORE the migration. MUST BE EQUAL.
-- If it drops to 0, loc_select stopped evaluating -- most likely a missing
-- GRANT USAGE ON SCHEMA authz. Roll back and investigate; do not proceed.


-- E. POSITIVE CONTROL -- the oracle is actually closed, not narrowed.
--    Through PostgREST, from outside, with only the publishable key:
--      curl -s -o /dev/null -w '%{http_code}\n' -X POST \
--        "$SUPABASE_URL/rest/v1/rpc/is_blocked" \
--        -H "apikey: $PUBLISHABLE_KEY" -H 'Content-Type: application/json' \
--        -d '{"a":"00000000-0000-0000-0000-000000000000",
--             "b":"00000000-0000-0000-0000-000000000001"}'
--    BEFORE: 200.  AFTER: 404 (function not found in an exposed schema).
--    Repeat for rpc/can_see_location and rpc/in_accepted_circle.


-- ============================================================================
-- FOLLOW-UPS THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
-- 1. scripts/verify-search-path-hazard.mjs probes public.is_blocked and
--    public.in_accepted_circle. After this migration those names no longer
--    resolve, so the prober ERRORS. That is the honest outcome and is strictly
--    better than the silent false-green the body-rewrite would have produced --
--    but it must be repointed at the authz schema, or the check stays red.
--
-- 2. FOUR checked-in files still contain CREATE OR REPLACE for these functions
--    in the public schema and would silently undo this migration on any replay:
--       migrations/0002_map_privacy.sql
--       travel-buddy-standalone/migrations/0002_map_privacy.sql
--       supabase/migrations/0015_blocks.sql
--       artifacts/api-server/baseline/20260819_baseline_structure.sql
--    0015 additionally re-declares SET search_path = public, which would drop
--    the pg_catalog pin that 0201 added because these very functions were
--    HAZARD OPEN. Fix separately.
--
-- 3. RESIDUAL, unchanged by this migration and NOT a new hole: anon can learn
--    that a user is broadcasting publicly by reading user_locations directly --
--    GET /rest/v1/user_locations?user_id=eq.<T> returns the row AND the
--    coordinates under loc_select (TO public). Whether logged-out visitors
--    should see the public location map at all is a PRODUCT decision for the
--    owner. Do not bundle it into a security migration.
--
-- 4. is_blocked and viewer_is_blocked remain duplicate predicates. Deduplicating
--    them requires restating highlights_select_active by hand; worth doing as
--    cleanup, not as security.
-- ============================================================================
