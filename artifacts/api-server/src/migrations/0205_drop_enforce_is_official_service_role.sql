-- Migration 0205: DROP the superseded enforce_is_official_service_role()
--
-- WHY DROP RATHER THAN PIN
-- ------------------------
-- This was the last unpinned SECURITY DEFINER function in public after 0201 and
-- 0204. Pinning it would harden something nothing calls. It is dead code, and
-- the better cleanup is to remove it.
--
-- It was superseded by migration 2079. `enforce_is_official_privileged()` took
-- over `enforce_is_official_trigger` on `public.profiles`, because the old
-- function had two defects:
--
--   1. it tested `current_setting('role')` alone, so on a DIRECT postgres
--      connection — where that GUC is 'none', not 'postgres' — it REJECTED
--      legitimate superuser administration while telling the operator "only the
--      service role may do this", which is false from where they stand;
--   2. it guarded FALSE->TRUE only, leaving TRUE->FALSE unguarded, so an
--      official account holder could clear their own badge and could not
--      restore it.
--
-- 2079 deliberately left the old function in place, unreferenced, rather than
-- dropping it. That was the right call at the time — it kept a rollback target
-- while the replacement was unproven. The replacement has since been verified
-- live (trigger present, both directions guarded, delegating to
-- caller_may_write_profile_role), so the rollback target is no longer worth the
-- dead SECURITY DEFINER function it costs.
--
-- CONFIRMED UNBOUND AND UNREFERENCED BEFORE DROPPING
-- --------------------------------------------------
-- Verified against LIVE immediately before this migration was written, not
-- inferred from the fact that 2079 said it would be unreferenced:
--
--   triggers bound to it                        0   (pg_trigger JOIN pg_proc)
--   event triggers bound to it                  0   (pg_event_trigger)
--   other function bodies referencing it        0   (pg_get_functiondef ILIKE)
--   RLS policies referencing it                 0   (pg_policies qual/with_check)
--   column defaults referencing it              0   (pg_attrdef)
--   pg_depend entries (deptype <> 'n')          0
--
-- Repo side: no .ts/.tsx/.js file calls it. The only source references are prose
-- — a historical note in src/test/isOfficialPrivileged.test.ts, 2079's header,
-- and 0201's inventory comment. `supabase/migrations/0106_profiles_is_official.sql`
-- creates it; that file is history and is not edited.
--
-- The DROP below is deliberately NOT `IF EXISTS`-only-and-silent: it is guarded
-- by a re-check that raises if anything has bound itself to the function between
-- the audit above and this migration actually running. A drop that races a new
-- binding would remove a live guard.
--
-- ROLLBACK
--   The full original definition is preserved in
--   supabase/migrations/0106_profiles_is_official.sql (lines 14-26). Re-running
--   that CREATE OR REPLACE restores the function. Do NOT also re-point
--   enforce_is_official_trigger at it — that would reintroduce both defects 2079
--   fixed. The trigger must keep executing enforce_is_official_privileged().

BEGIN;

-- Fail loudly rather than silently dropping something that acquired a caller.
DO $guard$
DECLARE
  v_triggers int;
BEGIN
  SELECT count(*) INTO v_triggers
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE p.proname = 'enforce_is_official_service_role';

  IF v_triggers > 0 THEN
    RAISE EXCEPTION
      'enforce_is_official_service_role is bound to % trigger(s) — refusing to drop', v_triggers
      USING HINT = 'Something re-bound it after the audit. Re-run the audit before dropping.';
  END IF;
END
$guard$;

DROP FUNCTION IF EXISTS public.enforce_is_official_service_role();

COMMIT;
