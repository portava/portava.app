-- Rollback for 3110_sensing_published_aggregates.sql
--
-- WHAT THIS UNDOES
--
-- 3110 creates one table, two indexes, one policy and one function, and grants
-- nothing to anon or authenticated. It touches no existing object: no column is
-- added anywhere else, no function is replaced, no row outside this table is
-- written. So the rollback is a clean DROP, and there is nothing to restore.
--
-- WHAT IS LOST, STATED PLAINLY
--
-- The table holds the anti-differencing gate's memory of what it last published
-- per cohort. Dropping it makes every cohort read as `no_previous`, which
-- PUBLISHES — the unsafe direction. That is acceptable ONLY because nothing can
-- be published while lib/sensingDifferencingGate has no caller that serves an
-- aggregate; if that stops being true, this rollback stops being safe and the
-- supported recovery is to stop the publisher, not to drop its memory.
--
-- Rows lost are de-identified aggregate values with a 72-hour structural TTL.
-- No contributor token, no group token, no epoch and no identity was ever
-- stored here (3110's postconditions refuse those column names), so nothing
-- about any person is destroyed or exposed by this file.
--
-- IDEMPOTENT. Every statement is IF EXISTS; running it twice, or against a
-- database where 3110 never ran, is a no-op.

BEGIN;

DROP POLICY IF EXISTS sensing_published_aggregates_service ON public.sensing_published_aggregates;

DROP FUNCTION IF EXISTS public.purge_expired_sensing_publications(timestamptz);

DROP INDEX IF EXISTS public.sensing_published_aggregates_cohort_idx;
DROP INDEX IF EXISTS public.sensing_published_aggregates_expiry_idx;

DROP TABLE IF EXISTS public.sensing_published_aggregates;

-- ── POSTCONDITION ────────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regclass('public.sensing_published_aggregates') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.sensing_published_aggregates still exists after the rollback.';
  END IF;
  IF to_regprocedure('public.purge_expired_sensing_publications(timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: purge_expired_sensing_publications still exists after the rollback.';
  END IF;
END $post$;

COMMIT;
