-- 2079_is_official_privileged_both_directions.sql
-- Harden `profiles.is_official` — fix a control that misleads its operator, and
-- close the direction it never guarded.
--
-- WHY THIS IS NOT MERELY UNTIDY
-- -----------------------------
-- The existing guard is:
--
--   IF current_setting('role', true) NOT IN ('service_role','postgres','supabase_admin')
--     THEN RAISE EXCEPTION 'is_official can only be set by the service role';
--
-- On a DIRECT postgres connection — the Supabase SQL editor, psql, the
-- Management API — the `role` GUC is **'none'**, not 'postgres'. So the test
-- fails and the write is rejected. Verified by execution, not by reading:
-- `UPDATE profiles SET is_official = true` run as `postgres` (superuser,
-- RLS-exempt) raised `is_official can only be set by the service role`.
--
-- That matters because there is **no application write path for is_official at
-- all**. Every reference in `src/` is a read or a serializer; no route, service
-- or lib writes it. So the only way to grant official status is direct database
-- access — and direct database access is precisely what this guard rejects. The
-- sanctioned path is a hand-rolled service-role call that no code performs.
-- One official row exists (`@portava`); the hazard only bites on the second.
--
-- The failure mode is the point, and it is worse than a plain block:
--
--   > An operator with full superuser access is told "only the service role may
--   > do this", which is FALSE from where they are standing. Under time
--   > pressure the likely resolution is to drop or edit the trigger — losing the
--   > control entirely. A control that misleads its operator is worse than one
--   > that merely blocks, because it invites its own removal.
--
-- THE SECOND GAP: THE GUARD WAS ONE-DIRECTIONAL
-- ---------------------------------------------
-- It fired only on FALSE→TRUE (`NEW.is_official = TRUE AND (OLD IS NULL OR
-- OLD.is_official = FALSE)`). TRUE→FALSE was unguarded — verified by executing
-- the demotion, which succeeded. Combined with migration 2078, which re-granted
-- `authenticated` column-level UPDATE on all 80 non-`role` columns including
-- `is_official`, and RLS `profiles_update` permitting `id = auth.uid()`, the
-- holder of an official account could **clear their own official badge** — and
-- could not restore it, because the reverse direction *was* guarded. A one-way
-- door out of a state that gates publisher surfaces.
--
-- This was not in the original finding, which is exactly why it is fixed now
-- rather than filed: it was found by probing the control, and an unprobed
-- control is where this class of gap lives.
--
-- WHAT CHANGES
-- ------------
-- The trigger now delegates to `caller_may_write_profile_role()` (added by 2078)
-- and guards **any** change to `is_official`, in either direction, on INSERT and
-- UPDATE. That predicate already accepts a privileged role GUC *or* an unset GUC
-- with a superuser `session_user`, so direct-postgres administration works while
-- PostgREST `authenticated`/`anon` still fail — and it uses `session_user`, which
-- SECURITY DEFINER does not change, so a definer function cannot launder a
-- caller into privilege.
--
-- The predicate is only ADDED as a consumer here; it is not modified. Its two
-- existing consumers (`enforce_profile_role_privileged`, `admin_set_profile_role`)
-- are untouched and their behaviour is unchanged. Its name says "profile_role"
-- but its meaning is "may write privileged profile columns"; it is deliberately
-- NOT renamed, because renaming would require rewriting both existing consumers
-- and the test that calls it as an RPC.
--
-- DRIFT NOTE — CORRECTED 2026-08-10: THERE WAS NO DRIFT
-- ------------------------------------------------------
-- This section previously claimed that `profiles.is_official`,
-- `enforce_is_official_trigger` and `enforce_is_official_service_role()` appear
-- in **no migration file** in this repo, and labelled that "drift — this one is
-- real". That claim was WRONG, and it is corrected here rather than deleted so
-- that anyone who already read it sees the retraction.
--
-- `supabase/migrations/0106_profiles_is_official.sql` creates all of it:
-- `CREATE OR REPLACE FUNCTION enforce_is_official_service_role()` (line 14),
-- `DROP TRIGGER IF EXISTS enforce_is_official_trigger ON profiles` (line 28)
-- and `CREATE TRIGGER enforce_is_official_trigger` (line 30), plus
-- `idx_profiles_is_official`. The original "tree-wide search" evidently did not
-- cover the `supabase/migrations/` root — this repo has FIVE migration roots
-- (artifacts/api-server/src/migrations, artifacts/api-server/migrations,
-- migrations, db, supabase/migrations), and a search of only the first one
-- reports drift that does not exist.
--
-- The second claim was wrong for the same reason. 2078's header cites
-- "`enforce_is_official_trigger` (migration 0106)", and this file previously
-- "corrected" that to say the citation was bogus because
-- `0106_engagement_indexes.sql` creates like/reaction indexes and mentions
-- neither. But 2078 pointed at the right NUMBER in a DIFFERENT DIRECTORY:
-- `supabase/migrations/0106_profiles_is_official.sql`. Two unrelated files
-- share the 0106 prefix across two roots. 2078's citation stands; the
-- "correction" was the error.
--
-- What IS true: this migration is the first time the BOTH-DIRECTIONS guard is
-- captured in the chain. The objects themselves were already recorded by 0106.
--
-- The old function is left in place, unreferenced, rather than dropped — see the
-- rollback note. Nothing calls it once the trigger below is replaced.
--
-- ROLLBACK (restores the previous, misleading behaviour):
--   DROP TRIGGER IF EXISTS enforce_is_official_trigger ON public.profiles;
--   CREATE TRIGGER enforce_is_official_trigger
--     BEFORE INSERT OR UPDATE ON public.profiles
--     FOR EACH ROW EXECUTE FUNCTION public.enforce_is_official_service_role();

CREATE OR REPLACE FUNCTION public.enforce_is_official_privileged()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only a non-default value needs privilege. A normal signup inserting
    -- is_official = false (the column default) must not be blocked.
    IF COALESCE(NEW.is_official, false) IS DISTINCT FROM false
       AND NOT public.caller_may_write_profile_role() THEN
      RAISE EXCEPTION
        'profiles.is_official cannot be set on insert by this caller'
        USING ERRCODE = '42501',
              HINT = 'Use a service-role client, or connect directly as postgres/supabase_admin.';
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    -- BOTH directions. Granting and revoking official status are equally
    -- privileged; the previous guard only covered granting, which left the
    -- badge holder able to clear their own badge irreversibly.
    IF NEW.is_official IS DISTINCT FROM OLD.is_official
       AND NOT public.caller_may_write_profile_role() THEN
      RAISE EXCEPTION
        'profiles.is_official is not self-writable (attempted % -> %)', OLD.is_official, NEW.is_official
        USING ERRCODE = '42501',
              HINT = 'Use a service-role client, or connect directly as postgres/supabase_admin.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_is_official_privileged() IS
  'Guards profiles.is_official in BOTH directions. Replaces '
  'enforce_is_official_service_role(), which rejected direct postgres '
  'connections (role GUC is ''none'', not ''postgres'') and guarded only '
  'false->true.';

DROP TRIGGER IF EXISTS enforce_is_official_trigger ON public.profiles;

CREATE TRIGGER enforce_is_official_trigger
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_is_official_privileged();
