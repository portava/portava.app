-- 2148_posts_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — live authorization change (posts is the core
--   social-feed table and is enabled in production).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- As `authenticated` with a JWT whose sub owns the row, via direct PostgREST
-- (public anon key), BOTH assertion vectors succeed:
--
--   UPDATE posts SET geotag_verified=true, location_verified=true
--    WHERE id=<own post> AND author_id=auth.uid();     => 1 row. SELF-ASSERT.
--
--   INSERT INTO posts (author_id, ..., geotag_verified, location_verified)
--    VALUES (auth.uid(), ..., true, true);             => 1 row. FORGED-AT-CREATE.
--
-- Also proven client-writable on an owned row: like_count (counter inflation)
-- and post_status='published' (jumps a delayed / pending_safety_review post
-- straight to the published state that mediaAccess + every public feed gate on).
--
-- geotag_verified / location_verified are the platform's assertion that the
-- author's GPS actually matched the tagged place (computed server-side as the
-- geotag `verdict`). They feed passport authenticity and place-day / discovery
-- trust. A user asserting them forges "the platform verified this location"
-- from "I typed a location" — exactly the line this migration must hold.
--
-- ROOT CAUSE (same class as 2144/2145/2146): anon+authenticated hold the full
-- grant set incl. UPDATE and INSERT on every column; the RLS policies
-- (posts_update / posts_insert, predicate author_id=auth.uid()) constrain the
-- ROW (ownership) but NOT the COLUMNS, so an owner may set any column on their
-- own row / at insert time.
--
-- ── LEGITIMATE CLIENT-WRITABLE SET: EMPTY ───────────────────────────────────
-- Every write path to posts was traced across all routes/services. requireUser
-- returns the SERVICE-ROLE client (src/lib/http.ts: `getServiceClient()`), so
-- EVERY server write to posts — create (POST /posts), edit (PATCH /posts/:id),
-- delayed-publish / publish-now / cancel, soft-delete, archive/hide, the
-- save/like/comment counter updates, safety-review + geotag-credit, translation
-- and account-deletion — runs as service-role and BYPASSES grants and RLS. No
-- code path writes posts through the anon/authenticated PostgREST role, and the
-- standalone client creates posts through the API, never by direct table write.
-- So no column is legitimately client-writable: clients get SELECT only.
--
-- The server-computed geotag `verdict` is written at create time BY THE
-- SERVICE-ROLE client, so revoking the client INSERT grant does not touch it —
-- it removes only the forge vector, where a direct PostgREST INSERT supplies
-- its own geotag_verified/location_verified.
--
-- ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────
-- No application code path (all writes service-role). anon+authenticated keep
-- SELECT so the public/own-post read policies (posts_select_policy: status=
-- 'active' AND public/own/followers/trip visibility) still serve direct reads.
-- No column/table/enum/policy/trigger change — generated types untouched.
--
-- SAFE TO RE-RUN.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.posts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.posts does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.posts'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS is not enabled on posts.';
  END IF;
  -- The public/own read surface depends on the client SELECT policy staying put.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='posts' AND cmd='SELECT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: no SELECT policy on posts; client reads would need re-deriving.';
  END IF;
  -- Guard against a rename drifting the columns this migration is about.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='posts'
         AND column_name IN ('geotag_verified','location_verified')) <> 2 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: geotag_verified/location_verified not both present.';
  END IF;
END $$;

-- Clients read only; every write is service-role.
REVOKE ALL ON TABLE public.posts FROM anon;
REVOKE ALL ON TABLE public.posts FROM authenticated;
GRANT SELECT ON TABLE public.posts TO anon;
GRANT SELECT ON TABLE public.posts TO authenticated;

COMMENT ON TABLE public.posts IS
  'Social post. geotag_verified / location_verified (server-computed geotag '
  'verdict), post_status (publication state machine), like/save/comment counts '
  'and all provenance/ownership/system columns are set by the API via the '
  'service-role client and are NOT client-writable (2148): anon+authenticated '
  'hold SELECT only (row visibility via posts_select_policy). A direct PostgREST '
  'write with the public key can neither self-assert verification nor forge it '
  'at create time.';

DO $$
DECLARE anon_privs text; auth_privs text; forbidden text;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='posts' AND grantee='anon';
  IF anon_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected SELECT only', anon_privs; END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='posts' AND grantee='authenticated';
  IF auth_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated holds "%", expected SELECT only', auth_privs; END IF;

  -- No column-level INSERT or UPDATE may survive for either client role
  -- (this is what closes both the self-assert and the forge-at-create vectors).
  SELECT string_agg(DISTINCT grantee||'/'||privilege_type||'/'||column_name, ', ' ORDER BY grantee||'/'||privilege_type||'/'||column_name)
    INTO forbidden FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='posts'
     AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE');
  IF forbidden IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: client column INSERT/UPDATE grants still present: %', forbidden;
  END IF;
END $$;

COMMIT;
