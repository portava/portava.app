-- Rollback for 2461_meetup_rls_recursion.sql
-- NOT applied anywhere by the author (2026-09-07). The owner runs all SQL.
--
-- WHAT 2461 DID
-- =============
-- Rewrote two SELECT policies to use authz.is_meetup_invitee (created by 2460):
--   meetups.meetups_invitee_select              USING (authz.is_meetup_invitee(id))
--   meetup_time_options.mto_invitee_select      USING (authz.is_meetup_invitee(meetup_id))
-- No column, no table, no grant, no flag, no function.
--
-- ⚠ WHAT THIS RESTORES: THE 42P17 CYCLE. READ BEFORE RUNNING.
-- ==========================================================
-- Both policies go back to their measured pre-2461 text verbatim: a correlated
-- EXISTS over meetup_invites. That text is what made every non-service read
-- and write of meetups, meetup_invites, meetup_time_options and
-- meetup_time_votes raise "infinite recursion detected in policy" on both
-- databases — so after this file those four tables are, once again, unreadable
-- and unwritable through PostgREST for anon AND authenticated.
--
-- That is deliberate, and it is the opposite choice from the 2402 rollback,
-- which restored a NARROWER non-recursive predicate instead. There, five
-- client screens read the table directly and a working-but-narrower policy
-- kept them alive. Here nothing in the product reads these tables except the
-- service-role API, which RLS does not touch, so the only thing a "narrower
-- working" rollback could buy is a policy nobody asked for. Restoring the
-- exact prior state — closed by error — is the honest rollback, and it is
-- strictly fail-closed: nothing that this file restores admits a row.
--
-- 2460 (the helper and the hardened mi_own) is left in place; it is inert
-- under the cycle and its own rollback refuses while 2461 is applied, so roll
-- THIS back first if you need both gone.
--
-- Idempotent.

BEGIN;

DROP POLICY IF EXISTS meetups_invitee_select ON public.meetups;
CREATE POLICY meetups_invitee_select ON public.meetups
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM public.meetup_invites
       WHERE meetup_invites.meetup_id = meetups.id
         AND meetup_invites.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS mto_invitee_select ON public.meetup_time_options;
CREATE POLICY mto_invitee_select ON public.meetup_time_options
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM public.meetup_invites
       WHERE meetup_invites.meetup_id = meetup_time_options.meetup_id
         AND meetup_invites.user_id = auth.uid()
    )
  );

-- The ledger exists on CI (2254) and not on production; guard the bookkeeping.
DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '2461_meetup_rls_recursion.sql';
  END IF;
END $$;

COMMIT;
