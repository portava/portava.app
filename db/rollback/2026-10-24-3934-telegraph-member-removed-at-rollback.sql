-- Rollback for 3934_telegraph_member_removed_at.sql (census-telegraph T389; lane TELEGRAPH, census drive
-- 2026-10-23, PR #786).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3934 DID (one transaction, additive): added the nullable column message_thread_members.removed_at, the CHECK
-- message_thread_members_removed_is_a_departure, the trigger function public.telegraph_member_interval_bounds() and
-- its BEFORE UPDATE OF left_at trigger (which writes 2810's visible_until_sequence when an interval ends and clears it
-- with removed_at on a rejoin). It wrote no row.
--
-- WHAT THIS DOES: drops the trigger, the function, the CHECK and the column, then deletes 3934's ledger row so the
-- runner re-applies 3934 later. The removal route (routes/telegraphGroups.ts) already handles a database without the
-- column: it answers 42703/PGRST204 for removed_at and the route removes with left_at alone (removalRecorded: false).
--
-- DATA. IT REFUSES WHILE ANY ROW CARRIES removed_at: dropping the column would erase which departures were removals
-- by the conversation, and that history cannot be rebuilt. Export those rows deliberately first (and decide what to
-- keep), clear the column, then re-run. visible_until_sequence values the trigger wrote stay: the column is 2810's,
-- and a later interval end will write it again only once 3934 is back.
-- ORDER: roll back 3940 first (reverse order). 3940's column-level client grant names removed_at; re-applying 3934
-- after this would leave removed_at unreadable to clients until 3940 is re-applied too.
-- If 3934's objects are already absent it changes nothing and clears only the ledger row: a second run is a no-op.
-- Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  v_removed bigint;
BEGIN
  IF to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3934 rollback): public.message_thread_members does not exist.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.message_thread_members'::regclass AND attname = 'removed_at' AND NOT attisdropped) THEN
    EXECUTE 'SELECT count(*) FROM public.message_thread_members WHERE removed_at IS NOT NULL' INTO v_removed;
    IF v_removed > 0 THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3934 rollback): % membership row(s) record a removal in removed_at. Dropping the column would erase that history; export and clear it deliberately first.', v_removed;
    END IF;
  END IF;
END $pre$;

DROP TRIGGER IF EXISTS telegraph_member_interval_bounds ON public.message_thread_members;
DROP FUNCTION IF EXISTS public.telegraph_member_interval_bounds();
ALTER TABLE public.message_thread_members DROP CONSTRAINT IF EXISTS message_thread_members_removed_is_a_departure;
ALTER TABLE public.message_thread_members DROP COLUMN IF EXISTS removed_at;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.message_thread_members'::regclass AND attname = 'removed_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3934 rollback): message_thread_members.removed_at still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.message_thread_members'::regclass AND tgname = 'telegraph_member_interval_bounds') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3934 rollback): trigger telegraph_member_interval_bounds still exists.';
  END IF;
  IF to_regprocedure('public.telegraph_member_interval_bounds()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3934 rollback): function telegraph_member_interval_bounds() still exists.';
  END IF;
END $post$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3934_telegraph_member_removed_at.sql';

COMMIT;
