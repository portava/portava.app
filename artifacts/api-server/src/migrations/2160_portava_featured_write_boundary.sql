-- 2160_portava_featured_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without owner approval.
--
-- ⚠ SUPERSEDED BY 2332_money_grant_boundary.sql. DO NOT APPLY, AND NEVER AFTER 2332.
-- Recorded 2026-10-03 by the 2490/3503/3504 client-privilege lane, on the
-- rollout thread's reading. This file is left in place rather than deleted
-- because both databases carry a ledger row for it and the chain is the record
-- of what was written, not only of what runs.
--
-- WHY IT MUST NOT RUN. This migration ends with anon and authenticated holding
-- SELECT. 2332 ends with them holding NOTHING on this table, having pressed the
-- same boundary further for a reason it argues at :312-322: no client reaches
-- portava_featured over PostgREST at all, so the SELECT granted back below is a
-- privilege nothing uses. Applied in prefix order, 2160 then 2332, the result is
-- 2332's. Applied the other way round -- which only a hand-apply can do -- 2160
-- RE-GRANTS exactly the SELECT 2332 revoked, and the postcondition below would
-- still report PASSED, because `anon=SELECT` is what it was written to demand.
-- A postcondition can only check the claim its author made.
--
-- WHY RETIREMENT IS ALREADY THE FACT. Measured read-only 2026-10-03.
--   * portava-ci: 2332 is applied by object (`service_role=arwd`, no client
--     grant), ledger row applied_by='ci' 2026-09-09. This file has a ledger row
--     too, applied_by='backfill'.
--   * travel-buddy (the testing database): all four of 2332's tables still show
--     `anon=arwd, authenticated=arwd, service_role=arwdDxtm`, so neither file
--     has run there -- yet the ledger carries a 'backfill' row for THIS file,
--     which 2254:65-91 says asserts only that the filename existed when the
--     ledger was seeded.
-- So the applier will never run this file on either database: it is already
-- marked applied on both. The only way it can execute is a deliberate
-- hand-apply, which is the case this note exists to stop.
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
