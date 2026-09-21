-- Rollback for 2460_meetup_invites_self_invite_latent_disclosure.sql
-- NOT applied anywhere by the author (2026-09-07). The owner runs all SQL.
--
-- WHAT 2460 DID
-- =============
--   1. CREATE FUNCTION authz.is_meetup_invitee(uuid), SECURITY DEFINER, owned by
--      postgres, EXECUTE granted to anon/authenticated/service_role.
--   2. Recreated meetup_invites.mi_own (FOR ALL) with
--        WITH CHECK (auth.uid() = user_id AND authz.is_meetup_invitee(meetup_id))
--      so an invitee can answer or remove their own row but not mint one.
-- No column, no table, no grant on a table, no flag.
--
-- WHAT THIS RESTORES
-- ==================
-- mi_own's measured pre-2460 shape, WITH CHECK (auth.uid() = user_id), and
-- drops the helper.
--
-- ⚠ REFUSES IF 2461 IS APPLIED. Once meetups_invitee_select and
-- mto_invitee_select route through authz.is_meetup_invitee, the cycle is gone
-- and meetup_invites is writable: a WITH CHECK that binds only user_id is then
-- a LIVE self-service invitation to any meetup. Roll 2461 back first, then
-- this. (Dropping the function while a policy still calls it would also fail
-- with 2BP01, but the refusal below says WHY.)
--
-- Idempotent.

BEGIN;

DO $$
DECLARE offenders text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO offenders
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('meetups', 'meetup_time_options')
     AND coalesce(qual, '') LIKE '%authz.is_meetup_invitee%';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'REFUSING: 2461 is applied (% route through authz.is_meetup_invitee). Restoring a self-insertable mi_own while the recursion no longer blocks writes lets any authenticated caller invite themselves to any meetup. Roll back 2461 first.', offenders;
  END IF;
END $$;

DROP POLICY IF EXISTS mi_own ON public.meetup_invites;
CREATE POLICY mi_own ON public.meetup_invites
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP FUNCTION IF EXISTS authz.is_meetup_invitee(uuid);

-- The ledger exists on CI (2254) and not on production; guard the bookkeeping.
DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '2460_meetup_invites_self_invite_latent_disclosure.sql';
  END IF;
END $$;

COMMIT;
