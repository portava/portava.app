-- 2160_portava_featured_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without owner approval.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- public.portava_featured is the platform "Featured" table (best_video,
-- best_hidden_gem, ...) with a permission+approval workflow: rows start
-- status='pending_permission', a creator grants permission, an admin approves
-- (approved_by). RLS is OFF on this table and anon+authenticated hold
-- TABLE-LEVEL INSERT/UPDATE. So ANY signed-in user (proven as a stranger who is
-- neither the post author nor an admin) can:
--   * INSERT a featured row for any post jumped straight to status='approved'
--     with approved_by=self  → pf.self_insert_approved=ALLOWED(1)
--   * UPDATE a pending row to status='approved', approved_by=self, and stamp
--     creator_permission_granted_at → pf.self_approve=ALLOWED(1)
-- i.e. self-feature arbitrary content on the platform, bypassing both the
-- creator-permission gate and admin approval. Readback: status=approved,
-- approved_by=<stranger>.
--
-- ── FIX ─────────────────────────────────────────────────────────────────────
-- Every legitimate write (feature nomination, permission request/grant, admin
-- approval) runs through the API as service-role. No user-facing feature writes
-- this table directly. REVOKE ALL from anon+authenticated and GRANT SELECT back
-- (Featured is public). With no client write grant, PostgREST denies every
-- client INSERT/UPDATE/DELETE regardless of the (absent) RLS. service_role is
-- untouched. SAFE TO RE-RUN.
--
-- NOTE (defense-in-depth, deferred for owner review): RLS is OFF on this table.
-- The grant removal fully closes the proven exploit, but enabling RLS with an
-- explicit public-SELECT + service_role-ALL policy would add a second layer.
-- Left out of this migration to keep it a pure privilege change; flagged to the
-- owner separately.

BEGIN;
DO $$ BEGIN
  IF to_regclass('public.portava_featured') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED: missing'; END IF;
END $$;
REVOKE ALL ON TABLE public.portava_featured FROM anon;
REVOKE ALL ON TABLE public.portava_featured FROM authenticated;
GRANT SELECT ON TABLE public.portava_featured TO anon;
GRANT SELECT ON TABLE public.portava_featured TO authenticated;
DO $$
DECLARE anon_p text; auth_p text; w int;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO anon_p FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='portava_featured' AND grantee='anon';
  IF anon_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon=%',anon_p; END IF;
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO auth_p FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='portava_featured' AND grantee='authenticated';
  IF auth_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated=%',auth_p; END IF;
  SELECT count(*) INTO w FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='portava_featured' AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE');
  IF w <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: % client write grants remain', w; END IF;
END $$;
COMMIT;
