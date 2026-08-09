-- Migration 2078: profiles.role is not self-writable (finding 17)
--
-- WHAT THIS IS
-- ------------
-- This migration closes finding 17. Every statement is idempotent, so applying
-- it to a database that already has these objects is a no-op.
--
-- CORRECTED 2026-08-09 — the original header of this file claimed the protection
-- "already exists in the live database but was applied out-of-band and committed
-- to no migration file", i.e. that this migration merely *captured* pre-existing
-- drift. That was wrong, and the same wrong account is in commit 85727c37c's
-- message. What actually happened: a CONCURRENT Claude Code session working the
-- same finding wrote this migration and applied it live through the Supabase
-- Management API at ~10:11 that morning, without yet committing the file. The
-- session that wrote the original header queried the schema at ~11:18, found the
-- objects present and absent from the migration tree, and read peer
-- work-in-progress as history.
--
-- The protection did NOT pre-exist. Before 10:11 the same day: `profiles` had no
-- role trigger, `authenticated` held table-level UPDATE on all 81 columns, and
-- the guard tests run against the unpatched schema SUCCEEDED at escalating —
-- role read back 'admin' through .update(), raw PostgREST PATCH, upsert,
-- merge-duplicates upsert, and self-INSERT.
--
-- So this file is the ORIGIN of the trigger/functions/RPC/grants, not a record of
-- them. Do not cite it as an instance of live-vs-migration drift.
--
-- (There IS real drift adjacent to this: `profiles.role` itself and
-- `profiles_role_check CHECK (role = ANY (ARRAY['user','admin']))` appear in no
-- migration file and genuinely predate this work. See
-- docs/security/admin-authz-audit.md for the full correction and for why two
-- concurrent sessions on one tree produced this confusion.)
--
-- THE FINDING (docs/security/admin-authz-audit.md §2)
-- ---------------------------------------------------
-- All 33 admin guards authorise by reading profiles.role. That column was
-- writable by the user it describes:
--   * RLS `profiles_update` allows `id = auth.uid()` for the whole row, and
--     Postgres RLS CANNOT restrict columns — a row-level policy that permits
--     the update permits it for every column in that row.
--   * `authenticated` held a column-level UPDATE grant on `role`.
--   * No trigger intercepted it.
-- So an authenticated user could set their own role to 'admin' via PostgREST
-- and pass all 33 guards at once.
--
-- WHY THIS SHAPE
-- --------------
-- Two independent barriers, because either alone is insufficient:
--
--   1. Column-level grants. `REVOKE UPDATE (role)` is the narrowest true fix
--      and fails the statement at the boundary. But a single future
--      `GRANT UPDATE ON profiles TO authenticated` — one line in a later
--      migration, or one click in the dashboard — silently re-grants every
--      column including this one. A grant has no memory of intent.
--
--   2. A BEFORE INSERT OR UPDATE trigger. This survives a careless re-grant
--      and is the barrier that actually holds. It mirrors the pattern already
--      established by `enforce_is_official_trigger` (migration 0106) — that
--      trigger proves this risk class was recognised; `role` simply never got
--      the same treatment.
--
-- RLS is deliberately NOT modified. Tightening `profiles_update`'s WITH CHECK
-- to compare role against its previous value is impossible: RLS cannot see OLD.
-- That approach collapses into needing a trigger regardless.

-- ── 1. Who counts as privileged ──────────────────────────────────────────────
-- Deliberately NOT security definer: this must observe the *caller's* role.
--
-- Note on SECURITY DEFINER callers generally: `current_setting('role')` reads
-- the role GUC, which SECURITY DEFINER does NOT change (it changes
-- current_user). So a definer function invoked by an ordinary user still
-- reports 'authenticated' here and is correctly refused. That is intended: a
-- future in-app role-grant feature must go through the service client
-- deliberately, not inherit privilege by being wrapped in a definer function.

CREATE OR REPLACE FUNCTION public.caller_may_write_profile_role()
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

-- ── 2. The enforcing trigger ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_profile_role_privileged()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A user may create their own profile row (policy profiles_insert), so the
    -- INSERT path has to be guarded too: otherwise the first write is a free
    -- role assignment, and an upsert against a not-yet-existing row is an
    -- INSERT, not an UPDATE.
    IF NEW.role IS DISTINCT FROM 'user'
       AND NOT public.caller_may_write_profile_role() THEN
      RAISE EXCEPTION
        'profiles.role cannot be set on insert by this caller (attempted %); use admin_set_profile_role()', NEW.role
        USING ERRCODE = '42501';
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    -- IS DISTINCT FROM, not <>: role is NOT NULL today, but a null-safe
    -- comparison means a no-op write of the same value never trips, and a
    -- future nullable role cannot silently open a hole.
    IF NEW.role IS DISTINCT FROM OLD.role
       AND NOT public.caller_may_write_profile_role() THEN
      RAISE EXCEPTION
        'profiles.role is not self-writable (attempted % -> %); use admin_set_profile_role()', OLD.role, NEW.role
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_profiles_role_privileged ON public.profiles;

CREATE TRIGGER trg_profiles_role_privileged
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_profile_role_privileged();

-- ── 3. The explicit privileged path ──────────────────────────────────────────
-- Before this existed, granting admin meant a human running
--   UPDATE profiles SET role='admin'
-- by hand in the SQL editor, per the production runbook. That is an incidental
-- mechanism, not a designed one: it has no validation, no single call site, and
-- nothing to audit. This function makes the privileged path explicit and named.
--
-- Roles are restricted to ('user','admin') ON PURPOSE. `rentABuddyRollout.ts`
-- accepts `role === 'admin' || role === 'owner'`, but NO 'owner' row exists in
-- production (verified: 55 'user', 1 'admin'). Accepting a role with zero
-- members here would propagate a divergence into a new security boundary. That
-- divergence is recorded for the guard consolidation to reconcile instead.

CREATE OR REPLACE FUNCTION public.admin_set_profile_role(target_user_id uuid, new_role text)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  updated public.profiles;
BEGIN
  -- Belt and braces. EXECUTE is granted to service_role only (below), so a
  -- non-privileged caller should never reach this line; if a future migration
  -- widens that grant by accident, this check still holds.
  IF NOT public.caller_may_write_profile_role() THEN
    RAISE EXCEPTION 'admin_set_profile_role: caller is not privileged'
      USING ERRCODE = '42501';
  END IF;

  IF new_role IS NULL OR new_role NOT IN ('user', 'admin') THEN
    RAISE EXCEPTION 'admin_set_profile_role: unsupported role %', new_role
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.profiles
     SET role = new_role,
         updated_at = now()
   WHERE id = target_user_id
   RETURNING * INTO updated;

  IF updated IS NULL THEN
    RAISE EXCEPTION 'admin_set_profile_role: no profile with id %', target_user_id
      USING ERRCODE = 'P0002';
  END IF;

  RETURN updated;
END;
$function$;

-- The RPC must not be callable by ordinary users. PUBLIC/anon/authenticated are
-- revoked explicitly rather than relying on the default, because Postgres
-- grants EXECUTE to PUBLIC on new functions by default.
REVOKE ALL ON FUNCTION public.admin_set_profile_role(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_profile_role(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_set_profile_role(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_profile_role(uuid, text) TO service_role;

-- ── 4. Column-level grants ───────────────────────────────────────────────────
-- The narrow barrier. Note this revokes UPDATE on `role` ONLY — every other
-- column keeps whatever grant it had, so ordinary profile editing (name, bio,
-- avatar_url, city, …) is untouched. Test 1 exists to prove exactly that.

REVOKE UPDATE (role) ON public.profiles FROM authenticated;
REVOKE UPDATE (role) ON public.profiles FROM anon;
