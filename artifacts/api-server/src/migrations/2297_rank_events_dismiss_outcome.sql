-- 2297_rank_events_dismiss_outcome.sql
--
-- THE NEGATIVE-SIGNAL NUMERATOR GETS A WRITER
-- ===========================================
--
-- WHAT WAS BROKEN
-- ---------------
-- `content_distribution_stats.negative_signal_count` is the NUMERATOR of the
-- underexposure classification in 2059:
--
--     IF v_impressions >= p_threshold THEN
--       IF v_negatives::FLOAT / NULLIF(v_impressions,0) >= p_suppression_rate
--         THEN 'normal' ELSE 'boosting' END
--
-- Nothing anywhere incremented it. The RPC's `p_negative_signal` argument had
-- exactly one caller — recordImpressionDistributionStats in
-- services/ranking/DiscoveryRankingService.ts — and that caller passes the
-- literal `false`, because an impression is never a negative signal. There was
-- no second caller and no other writer of the column.
--
-- So v_negatives was 0 for every item in the table, 0/N is never >= 0.3, and
-- EVERY item that crossed 100 eligible impressions classified 'boosting',
-- unconditionally. The classifier was structurally incapable of returning
-- 'normal'. It was not a weak signal, it was a constant wearing the costume of
-- a measurement — and FeedSlotAllocator and DiscoveryRankingService both read
-- `underexposure_status = 'boosting'` and grant a ranking boost off it.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. Admits 'dismiss' to the rank_events.outcome vocabulary — the missing
--    negative outcome. Until now the outcome CHECK held only positives
--    (impression, tap, save, join, rsvp, attended) plus the server-side
--    'analytics' sentinel, so negative user intent was literally unrecordable:
--    a client had nothing to send.
--
-- 2. Creates record_distribution_negative_signal — a NUMERATOR-ONLY writer.
--
--    It deliberately does NOT reuse increment_distribution_stats. That RPC
--    increments eligible_impressions and negative_signal_count in the SAME
--    statement, so calling it from an outcome would re-create the exact defect
--    PR #365 removed: the outcome route was once the only caller of the
--    increment, which made the exposure DENOMINATOR a count of conversions
--    (docs/architecture/00_STATUS.md defect 4). An outcome is a numerator
--    event. It must move the numerator and nothing else.
--
--    After the increment it RE-CLASSIFIES, because a dismiss usually arrives
--    long after the item crossed the threshold and was already written
--    'boosting'. Without the re-classification the status would be frozen at
--    the verdict computed by the last impression and the new signal would
--    change nothing — a writer with no reader, which is the same failure one
--    layer down.
--
-- NOT TOUCHED: increment_distribution_stats
-- -----------------------------------------
-- The 5-argument (text, text, boolean, integer, double precision) signature
-- from 2059 is left exactly as it is. This migration adds a DIFFERENTLY NAMED
-- function, so no overload set is created and `db.rpc("increment_distribution_
-- stats", …)` cannot become ambiguous. Nothing here drops, replaces or
-- re-grants it.
--
-- ADDITIVE AND IDEMPOTENT
-- -----------------------
--   * The outcome CHECK is widened, never narrowed: every value the previous
--     constraint (0197) permitted is still permitted, so all existing rows
--     revalidate and no writer that works today starts failing.
--   * DROP CONSTRAINT IF EXISTS … ADD CONSTRAINT, and CREATE OR REPLACE
--     FUNCTION — re-running the file is a no-op.
--   * No data is written, no flag is flipped. A client that never sends
--     'dismiss' produces exactly the behaviour it produces today.
--
-- TRANSACTION
-- -----------
-- Required, same reasoning as 0199/0202: ALTER TABLE … ADD CONSTRAINT
-- revalidates every existing row, and without the transaction a failed ADD
-- after a committed DROP would leave rank_events with NO outcome constraint at
-- all. The widened list is a strict superset of the old one, so it cannot fail
-- on an existing row — the transaction is the backstop, not the plan.
--
-- ROLLBACK (returns to the 0197 vocabulary):
--   BEGIN;
--   DELETE FROM rank_events WHERE outcome = 'dismiss';   -- see note below
--   ALTER TABLE rank_events DROP CONSTRAINT IF EXISTS rank_events_outcome_check;
--   ALTER TABLE rank_events ADD CONSTRAINT rank_events_outcome_check
--     CHECK (outcome IN ('impression','tap','save','join','rsvp','attended','analytics'));
--   DROP FUNCTION IF EXISTS record_distribution_negative_signal(TEXT, TEXT, INTEGER, FLOAT);
--   COMMIT;
-- The DELETE is not optional and is destructive: the narrowing ADD FAILS if any
-- dismiss row has landed. That is the point of admitting them.

BEGIN;

-- ── 1. Outcome vocabulary: admit 'dismiss' ────────────────────────────────────
--
-- LINEAGE OF THIS CONSTRAINT
--   0153  created it inline and unnamed; Postgres named it
--         rank_events_outcome_check.
--         Values: ('impression','tap','save','join','rsvp','attended')
--   0197  widened to add the server-side 'analytics' sentinel
--   2297  (this file) adds 'dismiss'. No value is removed.

ALTER TABLE rank_events
  DROP CONSTRAINT IF EXISTS rank_events_outcome_check;

ALTER TABLE rank_events
  ADD CONSTRAINT rank_events_outcome_check
    CHECK (outcome IN (
      'impression','tap','save','join','rsvp','attended','analytics',
      'dismiss'
    ));

-- ── 2. record_distribution_negative_signal — numerator-only writer ────────────
--
-- Parameters mirror increment_distribution_stats so the two writers are read
-- side by side, minus p_negative_signal (this function IS the negative signal).
-- p_viewer_id is accepted and unused, exactly as in 2059: it exists so a future
-- per-viewer dedup has a place to stand without changing every call site.
--
-- The INSERT branch records a dismiss for an item with no stats row yet — with
-- eligible_impressions 0, so it never fabricates exposure. 2059 already set
-- defaults on the legacy live table's NOT NULL columns precisely so an
-- item_id-only INSERT succeeds there.

CREATE OR REPLACE FUNCTION record_distribution_negative_signal(
  p_item_id          TEXT,
  p_viewer_id        TEXT,
  p_threshold        INTEGER DEFAULT 100,
  p_suppression_rate FLOAT   DEFAULT 0.3
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_impressions INTEGER;
  v_negatives   INTEGER;
BEGIN
  IF p_item_id IS NULL OR length(p_item_id) = 0 THEN
    RETURN;
  END IF;

  INSERT INTO content_distribution_stats (
    item_id, eligible_impressions, negative_signal_count,
    underexposure_status, last_updated_at
  )
  VALUES (p_item_id, 0, 1, 'pending_evaluation', NOW())
  ON CONFLICT (item_id) DO UPDATE SET
    -- eligible_impressions is DELIBERATELY absent: an outcome must never move
    -- the exposure denominator (00_STATUS defect 4).
    negative_signal_count = content_distribution_stats.negative_signal_count + 1,
    last_updated_at       = NOW()
  RETURNING eligible_impressions, negative_signal_count
  INTO v_impressions, v_negatives;

  -- Re-classify with the SAME rule as 2059, so the two writers can never
  -- disagree about what a given (impressions, negatives) pair means.
  IF v_impressions >= p_threshold THEN
    UPDATE content_distribution_stats
       SET underexposure_status =
             CASE
               WHEN v_negatives::FLOAT / NULLIF(v_impressions, 0) >= p_suppression_rate
               THEN 'normal'
               ELSE 'boosting'
             END,
           first_evaluated_at = COALESCE(first_evaluated_at, NOW())
     WHERE item_id = p_item_id;
  END IF;
END;
$$;

-- Privilege hardening — identical to 2059's treatment of
-- increment_distribution_stats. A SECURITY DEFINER function that writes ranking
-- state must not be callable by anon or authenticated: the default PUBLIC
-- EXECUTE grant would let any signed-in caller suppress any item by calling it
-- in a loop.
REVOKE ALL ON FUNCTION record_distribution_negative_signal(TEXT, TEXT, INTEGER, FLOAT) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_distribution_negative_signal(TEXT, TEXT, INTEGER, FLOAT) FROM anon;
REVOKE ALL ON FUNCTION record_distribution_negative_signal(TEXT, TEXT, INTEGER, FLOAT) FROM authenticated;
GRANT EXECUTE ON FUNCTION record_distribution_negative_signal(TEXT, TEXT, INTEGER, FLOAT) TO service_role;

-- ── 3. Postconditions ─────────────────────────────────────────────────────────
--
-- Each one is a REAL question with a reachable answer. In particular the grant
-- checks FILTER BY GRANTEE. A recent defect in this repo counted grants without
-- one and so counted the table owner's implicit grants, which made the check
-- pass everywhere and mean nothing; and the anon/authenticated check below
-- filters the same way, so it cannot be satisfied by the owner row either.

DO $post$
DECLARE
  v_def         TEXT;
  v_fn_count    INTEGER;
  v_service     INTEGER;
  v_untrusted   INTEGER;
BEGIN
  -- 3a. The CHECK admits 'dismiss' and still admits every prior value.
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'rank_events'
     AND c.conname = 'rank_events_outcome_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: rank_events_outcome_check does not exist';
  END IF;
  IF v_def NOT LIKE '%dismiss%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: outcome CHECK does not admit dismiss: %', v_def;
  END IF;
  IF v_def NOT LIKE '%impression%'
     OR v_def NOT LIKE '%attended%'
     OR v_def NOT LIKE '%analytics%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: outcome CHECK lost a prior value: %', v_def;
  END IF;

  -- 3b. Exactly one function of this name, with the expected 4-arg signature.
  --     More than one would be an overload set, which is the failure mode that
  --     makes PostgREST rpc() resolution ambiguous at runtime.
  SELECT count(*) INTO v_fn_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'record_distribution_negative_signal';

  IF v_fn_count <> 1 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: expected exactly 1 record_distribution_negative_signal, found %',
      v_fn_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'record_distribution_negative_signal'
       AND pg_get_function_identity_arguments(p.oid)
           = 'p_item_id text, p_viewer_id text, p_threshold integer, p_suppression_rate double precision'
       AND p.prosecdef
  ) THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: record_distribution_negative_signal has the wrong signature or is not SECURITY DEFINER';
  END IF;

  -- 3c. service_role CAN execute it. Filtered by grantee — see the note above.
  SELECT count(*) INTO v_service
    FROM information_schema.routine_privileges
   WHERE specific_schema = 'public'
     AND routine_name    = 'record_distribution_negative_signal'
     AND grantee         = 'service_role'
     AND privilege_type  = 'EXECUTE';

  IF v_service < 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role cannot EXECUTE record_distribution_negative_signal';
  END IF;

  -- 3d. anon and authenticated CANNOT. Same grantee filter, opposite verdict.
  SELECT count(*) INTO v_untrusted
    FROM information_schema.routine_privileges
   WHERE specific_schema = 'public'
     AND routine_name    = 'record_distribution_negative_signal'
     AND grantee         IN ('anon', 'authenticated', 'PUBLIC')
     AND privilege_type  = 'EXECUTE';

  IF v_untrusted > 0 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: % untrusted EXECUTE grant(s) remain on record_distribution_negative_signal',
      v_untrusted;
  END IF;
END $post$;

COMMIT;
