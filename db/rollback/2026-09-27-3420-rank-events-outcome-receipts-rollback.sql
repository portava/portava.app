-- Rollback for 3420_rank_events_outcome_receipts.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3420 DID
-- =============
--   * ALTER TABLE rank_events ADD COLUMN outcome_client_event_id uuid (nullable);
--   * CREATE TABLE rank_event_outcome_receipts (PRIMARY KEY (user_id,
--     client_event_id)), RLS on, four restrictive client-deny policies, client
--     privileges revoked, service_role SELECT/INSERT/DELETE;
--   * CREATE FUNCTION rank_events_record_outcome_receipt() and the AFTER UPDATE
--     OF outcome_client_event_id trigger rank_events_outcome_receipt.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops the trigger, the function, the receipts table (with its policies) and
-- the column, in that order, and deletes 3420's schema_migration_ledger row.
--
-- WHAT IT LOSES, SAID PLAINLY: every receipt, and every key on a rank_events
-- row. Those are the idempotency memory of keyed outcomes; no outcome itself is
-- lost (the rows keep their outcome and outcome_at). The count of receipts
-- dropped is reported.
--
-- ⚠ IT RE-OPENS THE DEFECT 3420 CLOSED for keyed clients: a keyed outcome
-- retried after a second serve of the same item moves a second exposure again.
-- The route does not break: the next keyed outcome's UPDATE is refused 42703 /
-- PGRST204 on the missing column, the route latches "3420 absent", says so once,
-- and records the outcome keyless (routes/rankEvents.ts, census-discovery §62).

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  IF to_regclass('public.rank_event_outcome_receipts') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'rank_events' AND column_name = 'outcome_client_event_id') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3420 rollback): the receipts table or the rank_events column is absent; this is not the state 3420 left.';
  END IF;
  SELECT count(*) INTO n FROM public.rank_event_outcome_receipts;
  RAISE NOTICE '3420 rollback: dropping % receipt(s).', n;
END $$;

DROP TRIGGER rank_events_outcome_receipt ON public.rank_events;
DROP FUNCTION public.rank_events_record_outcome_receipt();
DROP TABLE public.rank_event_outcome_receipts;
ALTER TABLE public.rank_events DROP COLUMN outcome_client_event_id;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '3420_rank_events_outcome_receipts.sql';

COMMIT;

-- ── Postconditions ─────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regclass('public.rank_event_outcome_receipts') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420 rollback): rank_event_outcome_receipts still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'rank_events' AND column_name = 'outcome_client_event_id') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420 rollback): rank_events.outcome_client_event_id still exists.';
  END IF;
  IF to_regprocedure('public.rank_events_record_outcome_receipt()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rank_events_outcome_receipt') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420 rollback): the receipt trigger or its function still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3420_rank_events_outcome_receipts.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3420 rollback): the ledger still records 3420 as applied.';
  END IF;
END $post$;
