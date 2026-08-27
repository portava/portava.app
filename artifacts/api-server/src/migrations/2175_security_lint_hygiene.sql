-- 2175_security_lint_hygiene.sql
-- Two Supabase security-advisor lints introduced by recent migrations. Both are
-- LINT-grade (no exploitable path), fixed for hygiene and a clean advisor board.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- 1. function_search_path_mutable on the 2130 append-only TRIGGER functions.
--    They reference only pg_catalog (RAISE / current_setting) and are not
--    client-executable (2130 revoked EXECUTE), so a mutable search_path is not
--    exploitable — but pinning costs nothing and clears the WARN.
--
-- 2. anon/authenticated EXECUTE on enforce_profile_verification_privileged
--    (created by 2163). Postgres grants EXECUTE to PUBLIC by default on every
--    new function; 2163 did not revoke it. A direct call only raises (TG_OP is
--    null outside a trigger), but a trigger function has no business being
--    callable over REST — the same reasoning, verbatim, as 2130's revokes on
--    intel_append_only. Trigger execution does NOT require the invoking role to
--    hold EXECUTE, so this cannot break the trigger.
--
-- DRIFT-TOLERANT: each statement is guarded on the function existing, because
-- the environments have drifted — production has intel_append_only_stmt, the CI
-- project does not (its 2130 apply predates the _stmt variant). The guards make
-- the migration correct on both rather than encoding one environment's shape.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.intel_append_only()') IS NOT NULL THEN
    ALTER FUNCTION public.intel_append_only() SET search_path = '';
  END IF;
  IF to_regprocedure('public.intel_append_only_stmt()') IS NOT NULL THEN
    ALTER FUNCTION public.intel_append_only_stmt() SET search_path = '';
  END IF;
  IF to_regprocedure('public.enforce_profile_verification_privileged()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.enforce_profile_verification_privileged() FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.enforce_profile_verification_privileged() FROM anon;
    REVOKE ALL ON FUNCTION public.enforce_profile_verification_privileged() FROM authenticated;
  END IF;
END $$;

DO $$
DECLARE cfg text[];
BEGIN
  SELECT proconfig INTO cfg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'intel_append_only';
  IF cfg IS NULL OR NOT ('search_path=""' = ANY(cfg)) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_append_only search_path not pinned';
  END IF;
  IF to_regprocedure('public.enforce_profile_verification_privileged()') IS NOT NULL
     AND has_function_privilege('anon', 'public.enforce_profile_verification_privileged()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon can still execute enforce_profile_verification_privileged';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   ALTER FUNCTION public.intel_append_only() RESET search_path;
--   ALTER FUNCTION public.intel_append_only_stmt() RESET search_path;  -- where it exists
--   GRANT EXECUTE ON FUNCTION public.enforce_profile_verification_privileged() TO authenticated;
