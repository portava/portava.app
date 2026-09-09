-- Rollback for 2462_meetup_time_votes_write_boundary.sql
-- NOT applied anywhere by the author (2026-09-07). The owner runs all SQL.
--
-- WHAT 2462 DID
-- =============
-- Recreated meetup_time_votes.mtv_own (FOR ALL) with a WITH CHECK that also
-- requires the vote's option to be one the caller is admitted to (an EXISTS
-- over meetup_time_options, evaluated under that table's own policies).
-- No column, no table, no grant, no flag, no function.
--
-- ⚠ WHAT THIS RESTORES: VOTE STUFFING. Once 2461 is in effect (writes no
-- longer raise 42P17), the measured pre-2462 shape below lets ANY
-- authenticated caller INSERT a vote on ANY meetup_time_options row, and the
-- confirm-time tally (routes/meetups.ts, service role) counts it. Reads stay
-- gated, so this is integrity, not disclosure — but it is a live defect the
-- moment this file runs on a database carrying 2461. If 2461 is not applied
-- (or has been rolled back), the restored policy is unreachable and inert.
--
-- Idempotent.

BEGIN;

DROP POLICY IF EXISTS mtv_own ON public.meetup_time_votes;
CREATE POLICY mtv_own ON public.meetup_time_votes
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- The ledger exists on CI (2254) and not on production; guard the bookkeeping.
DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '2462_meetup_time_votes_write_boundary.sql';
  END IF;
END $$;

COMMIT;
