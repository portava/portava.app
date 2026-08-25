-- 2161_compass_memories_client_revoke.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without owner approval.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- public.compass_memories has RLS OFF (0 policies) and anon+authenticated hold
-- the full GRANT ALL bundle (SELECT/INSERT/UPDATE/DELETE/...) on every column.
-- With no row filter, ANY anon or authenticated PostgREST caller can:
--   * READ every user's private Compass memories (long_term preferences, trip
--     insights, scope='circle' group facts) — cross-user data exposure;
--   * UPDATE another user's memory confidence, INSERT rows carrying a VICTIM's
--     user_id (impersonation) with attacker-chosen `content` that
--     buildMemoryPromptBlock later loads into the victim's Compass LLM prompt
--     (stored prompt-injection / preference poisoning), and DELETE their rows.
-- Proven: UPDATE_confidence=ALLOWED(1), INSERT_row=ALLOWED(1, forged user_id),
-- cross-user read ALLOWED — all with valid enum values (authorization pass).
--
-- ── FIX ─────────────────────────────────────────────────────────────────────
-- Every legitimate read AND write is service-role: routes/compass.ts obtains
-- getServiceClient() for createMemory/updateMemory/forgetMemory/teachMemory/
-- listMemories/compress; the user-facing GET /compass/me/memories is service-role
-- filtered by auth.user.id in app code; recommendation/prompt reads run on the
-- service client via CompassPipeline/CompassTools. NO anon/authenticated client
-- reads or writes this table directly. REVOKE ALL from anon+authenticated —
-- behavior-preserving, and it closes the cross-user read exposure too (so no
-- SELECT is re-granted). service_role is untouched. SAFE TO RE-RUN.

BEGIN;
DO $$ BEGIN
  IF to_regclass('public.compass_memories') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED: missing'; END IF;
END $$;
REVOKE ALL ON TABLE public.compass_memories FROM anon;
REVOKE ALL ON TABLE public.compass_memories FROM authenticated;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='compass_memories' AND grantee IN ('anon','authenticated');
  IF n <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: % client table grant(s) remain', n; END IF;
  SELECT count(*) INTO n FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='compass_memories' AND grantee IN ('anon','authenticated');
  IF n <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: % client column grant(s) remain', n; END IF;
END $$;
COMMIT;
