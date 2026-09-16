-- 2974_toggle_feature_flag_caller_guard.sql
--
-- `toggle_feature_flag_with_audit` checks its caller.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2974.
--
-- Adds one helper function, grants EXECUTE on that ONE new function, and
-- replaces one function body. Creates no table, drops nothing, writes no row,
-- flips no flag, revokes nothing, and adds no RLS policy. The single GRANT is
-- on the new STABLE predicate only and is explained where it is written.
-- Idempotent (CREATE OR REPLACE both; GRANT is a no-op when already held).
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
--
-- ══════════════════════════════════════════════════════════════════════════════
-- POSTCONDITION 2 WAS VACUOUS UNDER THE ONLY ORDER THESE TWO EVER APPLY IN
-- ══════════════════════════════════════════════════════════════════════════════
-- MEASURED on portava-ci 2026-09-16, in a transaction that was rolled back.
-- The first version of postcondition 2 assumed `anon`, called the toggle with a
-- flag name that cannot exist, and passed on SQLSTATE 42501. Two DIFFERENT
-- events produce 42501 on that call:
--
--   42501 :: toggle_feature_flag_with_audit: caller is not privileged
--                                              <- THIS file's guard fired
--   42501 :: permission denied for function toggle_feature_flag_with_audit
--                                              <- 2973's REVOKE fired
--
-- 2973 applies first — it has the lower number, and its header calls itself a
-- PREREQUISITE — so by the time this file's postcondition runs, `anon` no
-- longer holds EXECUTE and the second message is the one that comes back. The
-- probe, run with 2973 applied and this file's guard DELIBERATELY NOT
-- installed, reported:
--
--   ORDERING-PROBE-ROLLBACK :: body_actually_has_guard=f ;
--     2974_postcondition2_verdict=t ; sqlstate=42501 ;
--     msg=permission denied for function toggle_feature_flag_with_audit
--
-- A postcondition that says "the guard is effective" when the guard is not
-- there. That is worse than no postcondition, and it is permanent rather than
-- an apply-day quirk: certify STAGE 4 re-runs this block against the COMMITTED
-- database, where 2973 is always already applied, so the vacuity is the steady
-- state. The day someone CREATE OR REPLACEs this body and drops the guard,
-- STAGE 4 would have gone on reporting green.
--
-- What replaces it, below, distinguishes the two 42501s by MESSAGE and then
-- says honestly which evidence it had. In the world where the end-to-end call
-- can no longer reach the guard, two further checks carry the claim: the
-- predicate is exercised live as `anon` (2b), and the body is required to
-- consult it BEFORE its first write (2c). 2c is textual and is labelled as
-- such — it is the only evidence available once EXECUTE is gone, and naming
-- that limit is the point of this section.
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

-- Stated rather than inherited. Supabase's ALTER DEFAULT PRIVILEGES would grant
-- this anyway, and 2973 does not touch it (its sweep predicate requires
-- prosecdef AND provolatile='v'; this function is neither) -- but postcondition
-- 2b below RUNS this predicate as `anon`, and a postcondition that depends on a
-- default nobody wrote down is a postcondition that breaks on the day the
-- default changes. Granting EXECUTE on it discloses nothing: it reads
-- `current_setting('role')` and `session_user` and returns a boolean the caller
-- already knows about itself.
GRANT EXECUTE ON FUNCTION public.caller_is_privileged_service()
  TO PUBLIC, anon, authenticated, service_role;

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
  v_anon_state        text;
  v_anon_msg          text;
  v_evidence          text;
  v_privileged_passed boolean;
  v_priv_state        text;
  v_anon_predicate    boolean;
  v_priv_predicate    boolean;
  v_src               text;
  v_gate_at           int;
  v_update_at         int;
  v_insert_at         int;
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

  -- 2. A CLIENT ROLE IS TURNED AWAY, AND THE REASON IS RECORDED RATHER THAN
  --    ASSUMED. Assume `anon`, call with a flag name that cannot exist, and
  --    require a refusal. Two different mechanisms can refuse, they are
  --    distinguished HERE by message, and the distinction is the whole repair:
  --
  --      'caller is not privileged'     -> this file's guard fired. End to end.
  --      'permission denied for function' -> 2973's REVOKE fired FIRST, so the
  --                                        guard was never reached and this
  --                                        call proves nothing about it. 2b and
  --                                        2c below carry the claim instead.
  --      P0002 / a returned row         -> the body was ENTERED by `anon` with
  --                                        no guard in front of it. FAIL.
  --
  --    Nothing is written on any path: both refusals raise before the UPDATE,
  --    and the flag does not exist so there is no row to change. The inner
  --    block restores the role on every path.
  BEGIN
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM public.toggle_feature_flag_with_audit(
        '__2974_postcondition_flag_that_cannot_exist__', true, NULL);
      v_anon_state := 'RETURNED';
      v_anon_msg   := '(the call returned)';
    EXCEPTION WHEN OTHERS THEN
      v_anon_state := SQLSTATE;
      v_anon_msg   := SQLERRM;
    END;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE;
  END;

  IF v_anon_state = '42501' AND position('caller is not privileged' in v_anon_msg) > 0 THEN
    v_evidence := 'end-to-end: the guard itself refused anon';
  ELSIF v_anon_state = '42501' THEN
    v_evidence := 'indirect: EXECUTE is revoked (2973), so the guard could not be exercised end to end; 2b and 2c below are the evidence';
  ELSE
    RAISE EXCEPTION
      '2974 postcondition 2 FAILED: as `anon`, toggle_feature_flag_with_audit answered % :: %. Neither the caller guard nor the EXECUTE boundary refused it, which means an unauthenticated caller reaches the body.',
      v_anon_state, v_anon_msg;
  END IF;

  -- 2b. THE PREDICATE, RUN LIVE, BOTH WAYS. This is what stops 2 from being
  --     vacuous in the `indirect` world: it does not matter that the toggle is
  --     unreachable, because the thing the toggle consults is reachable and is
  --     exercised here. A predicate that answered true for `anon` would be a
  --     guard that admits everyone, and a predicate that answered false for the
  --     server would be a guard that admits no one.
  BEGIN
    SET LOCAL ROLE anon;
    SELECT public.caller_is_privileged_service() INTO v_anon_predicate;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE;
  END;
  SELECT public.caller_is_privileged_service() INTO v_priv_predicate;

  IF v_anon_predicate IS DISTINCT FROM false THEN
    RAISE EXCEPTION
      '2974 postcondition 2b FAILED: caller_is_privileged_service() answered % for `anon`; the guard built on it admits an unauthenticated caller.',
      coalesce(v_anon_predicate::text, 'NULL');
  END IF;
  IF v_priv_predicate IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      '2974 postcondition 2b FAILED: caller_is_privileged_service() answered % for this migration''s own (privileged) role; the guard built on it would refuse the server and break every administrator flag toggle.',
      coalesce(v_priv_predicate::text, 'NULL');
  END IF;

  -- 2c. THE BODY CONSULTS IT, AND DOES SO BEFORE IT WRITES. Textual, and said
  --     to be textual: once EXECUTE is revoked there is no client role left
  --     that can reach the guard, so no runtime probe can observe the ORDER of
  --     the two. What this catches is the realistic regression — a future
  --     CREATE OR REPLACE that keeps the function and loses the gate, which 2
  --     alone could not see. `prosrc` is the body as the database holds it, not
  --     a file on disk, so this is still a fact about the live schema.
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'toggle_feature_flag_with_audit'
     AND pronamespace = 'public'::regnamespace;

  v_gate_at   := strpos(v_src, 'caller_is_privileged_service');
  v_update_at := strpos(v_src, 'UPDATE feature_flags');
  v_insert_at := strpos(v_src, 'INSERT INTO feature_flag_audit_log');

  IF v_gate_at = 0 THEN
    RAISE EXCEPTION
      '2974 postcondition 2c FAILED: the body of toggle_feature_flag_with_audit does not consult caller_is_privileged_service(). Something replaced it and dropped the guard.';
  END IF;
  IF v_update_at = 0 OR v_insert_at = 0 THEN
    RAISE EXCEPTION
      '2974 postcondition 2c FAILED: the body no longer contains the flag update and the audit insert this migration preserved (update at %, insert at %). The shape this postcondition reads has changed, so it cannot answer, and it refuses rather than passing.',
      v_update_at, v_insert_at;
  END IF;
  IF v_gate_at > v_update_at OR v_gate_at > v_insert_at THEN
    RAISE EXCEPTION
      '2974 postcondition 2c FAILED: the caller guard appears AFTER a write (guard at %, update at %, audit insert at %). A guard that runs after the row has changed is not a guard.',
      v_gate_at, v_update_at, v_insert_at;
  END IF;

  -- 3. THE POSITIVE CONTROL, without which everything above is worth nothing.
  --    A guard that refuses EVERY caller satisfies 2, 2b's first half and 2c
  --    perfectly and breaks every admin flag toggle in the product. So the same
  --    call is made again as the migration's own (privileged) role, and this
  --    time 42501 is the FAILURE and P0002 is the pass -- P0002 means the guard
  --    let us through and the flag lookup ran, which is exactly as far as a
  --    call with a nonexistent flag should get. Still writes nothing, for the
  --    same reason as above.
  BEGIN
    PERFORM public.toggle_feature_flag_with_audit(
      '__2974_postcondition_flag_that_cannot_exist__', true, NULL);
    v_privileged_passed := false;   -- cannot happen: the flag does not exist
    v_priv_state := 'RETURNED';
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_privileged_passed := false;  -- guard refused us
      v_priv_state := SQLSTATE;
    WHEN OTHERS THEN
      v_privileged_passed := (SQLSTATE = 'P0002');   -- reached the lookup
      v_priv_state := SQLSTATE;
  END;

  IF NOT v_privileged_passed THEN
    RAISE EXCEPTION
      '2974 postcondition 3 FAILED: the privileged caller was ALSO refused (%). A guard that turns everyone away passes postcondition 2 and breaks every administrator flag toggle in the product.',
      v_priv_state;
  END IF;

  RAISE NOTICE '2974: caller guard asserted. anon refusal = % :: % (%).', v_anon_state, v_anon_msg, v_evidence;
END $post$;

COMMIT;
