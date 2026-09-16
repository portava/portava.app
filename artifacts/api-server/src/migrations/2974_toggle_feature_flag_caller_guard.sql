-- 2974_toggle_feature_flag_caller_guard.sql
--
-- `toggle_feature_flag_with_audit` checks its caller.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2974.
--
-- Adds one helper function and replaces one function body. Creates no table,
-- drops nothing, writes no row, flips no flag, changes no privilege and adds no
-- RLS policy. Idempotent (CREATE OR REPLACE both).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY: THE BELT WITHOUT THE BRACES
-- ══════════════════════════════════════════════════════════════════════════════
-- `admin_set_profile_role` (2078) carries this comment above its first line:
--
--   "Belt and braces. EXECUTE is granted to service_role only (below), so a
--    non-privileged caller should never reach this line; if a future migration
--    widens that grant by accident, this check still holds."
--
-- That was not a hypothetical. Measured on portava-ci 2026-09-16, `anon` DID
-- hold EXECUTE on `admin_set_profile_role` -- not because a future migration
-- widened it, but because Supabase's ALTER DEFAULT PRIVILEGES granted it at
-- CREATE time and no migration ever revoked it (see 2973 for the full finding).
-- Probed as `anon`, the call returned:
--
--   42501 :: admin_set_profile_role: caller is not privileged
--
-- The internal check was the only thing standing between an unauthenticated
-- caller and `UPDATE public.profiles SET role = 'admin'`. It held.
--
-- `toggle_feature_flag_with_audit` (0119, extended by 2198) has no such check.
-- Probed as `anon` on portava-ci with a flag name that does not exist:
--
--   P0002 :: Flag not found: __probe_flag_does_not_exist__
--
-- P0002 rather than 42501 means the body was ENTERED and the only thing that
-- stopped it was the argument. With a real flag name, an unauthenticated caller
-- could flip any feature flag in the database AND write a `feature_flag_audit_log`
-- row attributing the change to any user id they chose. The audit log is what
-- this function exists to keep honest, so an unauthenticated writer is not a
-- side issue -- it is the whole control defeated.
--
-- 2973 revokes the grant. This file adds the check that should have made the
-- grant not matter. Either alone would have been enough on the day; the point of
-- belt and braces is that neither has to be.
--
-- ── ON PRODUCTION, TODAY, THIS IS DEFENCE IN DEPTH AND NOT A FIX ─────────────
-- Measured on production 2026-09-16: the function exists, `feature_flag_audit_log`
-- exists, and `has_function_privilege('authenticated', ..., 'EXECUTE')` is FALSE.
-- Production is not exposed through this path and never was. Saying so plainly
-- matters: this migration is not repairing a production breach, it is removing
-- production's dependence on an ACL nobody had written down.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY A NEW HELPER RATHER THAN REUSING caller_may_write_profile_role()
-- ══════════════════════════════════════════════════════════════════════════════
-- `caller_may_write_profile_role()` already computes exactly the predicate
-- needed, and it exists on both databases (measured). It is not reused here, and
-- it is not renamed, for two reasons:
--
--   1. Its name is a claim about profile roles. A feature-flag function calling
--      it would read as a mistake to the next person, and the next person after
--      that would "fix" it.
--   2. Renaming it means editing a live security control that 0205, 2078, 2079
--      and 2163 all depend on, inside a migration whose purpose is something
--      else. A security predicate is the last thing that should be refactored
--      as a side effect.
--
-- So `caller_is_privileged_service()` is a deliberate duplicate of that logic
-- under a general name. The duplication is the cheaper of the two risks, and it
-- is recorded here rather than left for someone to discover.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Not SECURITY DEFINER, deliberately: it must see the CALLER's role, not its
-- own. STABLE because `current_setting`/`session_user` do not change within a
-- statement. Logic is character-for-character the predicate 2078 established.
CREATE OR REPLACE FUNCTION public.caller_is_privileged_service()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT
    -- (a) PostgREST / explicit SET ROLE. 'authenticated' and 'anon' fail here.
    COALESCE(NULLIF(current_setting('role', true), ''), 'none')
      IN ('service_role', 'postgres', 'supabase_admin')
    -- (b) Direct superuser connection with no role GUC set.
    OR (
      COALESCE(NULLIF(current_setting('role', true), ''), 'none') = 'none'
      AND session_user IN ('postgres', 'supabase_admin')
    );
$function$;

COMMENT ON FUNCTION public.caller_is_privileged_service() IS
  'True when the caller is the server itself (service_role/postgres/supabase_admin) rather than a client role. Deliberate duplicate of caller_may_write_profile_role() under a general name; see 2974.';

-- Replaces 0119/2198's body. Everything below the guard is that body unchanged:
-- same FOR UPDATE lock, same P0002 on a missing flag, same audit row, same
-- RETURN QUERY shape. Only the guard is new, so any caller that was legal before
-- observes identical behaviour.
CREATE OR REPLACE FUNCTION public.toggle_feature_flag_with_audit(
  p_flag text,
  p_new_enabled boolean,
  p_changed_by_id uuid
)
 RETURNS TABLE(flag text, enabled boolean, description text, updated_at timestamp with time zone, old_enabled boolean, changed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_enabled BOOLEAN;
  v_now         TIMESTAMPTZ := NOW();
BEGIN
  -- Belt and braces, in the sense 2078 meant it. 2973 revokes EXECUTE from
  -- PUBLIC/anon/authenticated on this function; this check is what holds if that
  -- grant is ever widened again -- by a default privilege, a restore, a
  -- hand-run GRANT, or a future migration that means well.
  IF NOT public.caller_is_privileged_service() THEN
    RAISE EXCEPTION 'toggle_feature_flag_with_audit: caller is not privileged'
      USING ERRCODE = '42501';
  END IF;

  -- Lock the row and read the current value atomically.
  SELECT ff.enabled INTO v_old_enabled
  FROM feature_flags ff
  WHERE ff.flag = p_flag
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flag not found: %', p_flag USING ERRCODE = 'P0002';
  END IF;

  -- Update the flag value.
  UPDATE feature_flags
  SET enabled = p_new_enabled, updated_at = v_now
  WHERE feature_flags.flag = p_flag;

  -- Write the audit log row in the same transaction.
  INSERT INTO feature_flag_audit_log(flag, changed_by_user_id, old_enabled, new_enabled, changed_at)
  VALUES (p_flag, p_changed_by_id, v_old_enabled, p_new_enabled, v_now);

  -- Return the updated flag row plus the audit metadata.
  RETURN QUERY
    SELECT ff.flag, ff.enabled, ff.description, ff.updated_at, v_old_enabled AS old_enabled, v_now AS changed_at
    FROM feature_flags ff
    WHERE ff.flag = p_flag;
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v_guard_reached     boolean;
  v_privileged_passed boolean;
BEGIN
  -- 1. Both functions exist and the toggle kept its shape. A CREATE OR REPLACE
  --    that changed the return type would have failed outright, so this asserts
  --    the cheaper facts: the helper landed, and the toggle is still SECURITY
  --    DEFINER (a replace that silently dropped that would make it run as the
  --    caller and break every legitimate invocation).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'caller_is_privileged_service'
      AND pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION '2974 postcondition 1 FAILED: caller_is_privileged_service() was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'toggle_feature_flag_with_audit'
      AND pronamespace = 'public'::regnamespace AND prosecdef
  ) THEN
    RAISE EXCEPTION '2974 postcondition 1 FAILED: toggle_feature_flag_with_audit is missing or no longer SECURITY DEFINER';
  END IF;

  -- 2. THE GUARD ACTUALLY REFUSES. Asserting that the text contains an IF is
  --    worthless -- the question is whether a client role is turned away. So
  --    this RUNS it: assume `anon`, call with a flag name that cannot exist, and
  --    require 42501 (the guard) rather than P0002 (flag not found, i.e. the
  --    guard was not reached) and rather than success.
  --
  --    Nothing is written on any of the three outcomes: 42501 and P0002 both
  --    raise before the UPDATE, and the flag does not exist so there is no row
  --    to change. The inner block restores the role on every path.
  BEGIN
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM public.toggle_feature_flag_with_audit(
        '__2974_postcondition_flag_that_cannot_exist__', true, NULL);
      v_guard_reached := false;   -- returned at all: the guard did not fire
    EXCEPTION
      WHEN insufficient_privilege THEN v_guard_reached := true;   -- 42501
      WHEN OTHERS THEN v_guard_reached := false;                  -- P0002 etc.
    END;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE;
  END;

  IF NOT v_guard_reached THEN
    RAISE EXCEPTION
      '2974 postcondition 2 FAILED: as `anon`, toggle_feature_flag_with_audit did not raise 42501. The caller guard is not effective, which is the entire point of this migration.';
  END IF;

  -- 3. THE POSITIVE CONTROL, without which postcondition 2 is worth nothing.
  --    A guard that refuses EVERY caller satisfies 2 perfectly and breaks every
  --    admin flag toggle in the product. So the same call is made again as the
  --    migration's own (privileged) role, and this time 42501 is the FAILURE and
  --    P0002 is the pass -- P0002 means the guard let us through and the flag
  --    lookup ran, which is exactly as far as a call with a nonexistent flag
  --    should get. Still writes nothing, for the same reason as above.
  BEGIN
    PERFORM public.toggle_feature_flag_with_audit(
      '__2974_postcondition_flag_that_cannot_exist__', true, NULL);
    v_privileged_passed := false;   -- cannot happen: the flag does not exist
  EXCEPTION
    WHEN insufficient_privilege THEN v_privileged_passed := false;  -- guard refused us
    WHEN OTHERS THEN v_privileged_passed := (SQLSTATE = 'P0002');   -- reached the lookup
  END;

  IF NOT v_privileged_passed THEN
    RAISE EXCEPTION
      '2974 postcondition 3 FAILED: the privileged caller was ALSO refused. A guard that turns everyone away passes postcondition 2 and breaks every administrator flag toggle in the product.';
  END IF;
END $post$;

COMMIT;
