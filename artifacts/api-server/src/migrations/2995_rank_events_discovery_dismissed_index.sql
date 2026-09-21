-- 2995_rank_events_discovery_dismissed_index.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band), discovery lane.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS FOR
-- ══════════════════════════════════════════════════════════════════════════════
-- "Not interested" on a Discovery card now SUPPRESSES that place for the person
-- who dismissed it. The suppression is a read, issued on every serve path of
-- GET /discovery:
--
--   lib/discoveryDismissed.ts  loadDismissedPlaceIds()
--     SELECT item_id FROM rank_events
--      WHERE user_id = $1 AND surface = 'discovery' AND outcome = 'dismiss'
--      ORDER BY served_at DESC
--      LIMIT 1000
--
-- Migration 2297 admitted 'dismiss' to the outcome CHECK and created the
-- negative-signal writer. It added no index, because at that time nothing read
-- the rows back — census-discovery §12.6 recorded the writer as existing and
-- "unexercised". This file is the index that read needs.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THE EXISTING INDEXES DO NOT SERVE IT
-- ══════════════════════════════════════════════════════════════════════════════
-- 0153 created three, and the query above can use none of them well:
--
--   rank_events_features_gin        GIN (features)                — wrong column
--   rank_events_user_served_at      (user_id, served_at DESC)     — leading column
--       matches, but it spans EVERY row this user has ever been served on EVERY
--       surface. A person with a long history has tens of thousands of
--       impression rows and, typically, a handful of dismissals; this index
--       walks the former to find the latter, on every Discovery request.
--   rank_events_user_item           (user_id, item_id, served_at) — built for the
--       outcome-upsert lookup, which knows the item_id. This read does not: it
--       is asking WHICH items, so there is no second-column predicate to give.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS ADDS
-- ══════════════════════════════════════════════════════════════════════════════
-- One PARTIAL index whose predicate is the read's own WHERE clause. Partial is
-- the point rather than a refinement: dismissals are a small and deliberate
-- subset of rank_events — one per explicit tap — so the index covers a tiny
-- fraction of the table and stays small no matter how large the impression
-- history grows. The ordering column is included so the LIMIT is satisfied from
-- the index rather than by sorting the matched set.
--
-- COST ON WRITES. Every rank_events INSERT and UPDATE must consider one more
-- index, but the partial predicate means only rows that ARE dismissals are
-- actually indexed. An impression insert — which is the overwhelming majority of
-- writes to this table — evaluates the predicate, fails it, and writes nothing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ADDITIVE, IDEMPOTENT, AND REVERSIBLE
-- ══════════════════════════════════════════════════════════════════════════════
--   * CREATE INDEX IF NOT EXISTS — re-running the file is a no-op.
--   * No column is added, no constraint is changed, no data is written, no grant
--     is altered and no flag is flipped. Nothing that works today behaves
--     differently afterwards; the same rows are returned by the same queries,
--     faster.
--   * The index depends on `outcome = 'dismiss'` being a legal value, which
--     migration 2297 established. The precondition below checks that rather than
--     assuming it, because CREATE INDEX with a predicate naming a value the
--     CHECK forbids would succeed and index nothing — a silent no-op that looks
--     exactly like a working index.
--
-- TRANSACTION
-- -----------
-- Used. A plain CREATE INDEX (non-concurrent) is transactional, and this file
-- performs one DDL statement plus assertions; wrapping them means a failed
-- postcondition leaves nothing behind. CONCURRENTLY is deliberately NOT used —
-- it may not run inside a transaction block, and the partial index is small
-- enough that the SHARE lock it takes is brief. If this is ever applied to a
-- rank_events large enough for that to matter, split it out and run it
-- concurrently outside a transaction; the postcondition block below is written
-- so it can be re-run standalone either way.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.rank_events_discovery_dismissed;

BEGIN;

-- ── 0. Precondition: 'dismiss' must be a legal outcome ────────────────────────
--
-- Fails LOUDLY rather than creating an index over a predicate that can never
-- match. If this raises, 2297 has not been applied to this database and this
-- file must not be applied either.

DO $pre$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'rank_events'
     AND c.conname = 'rank_events_outcome_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: rank_events_outcome_check does not exist — is rank_events present?';
  END IF;
  IF v_def NOT LIKE '%dismiss%' THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: rank_events.outcome does not admit ''dismiss'' — apply 2297 first. Constraint: %',
      v_def;
  END IF;
END $pre$;

-- ── 1. The index ──────────────────────────────────────────────────────────────
--
-- Column order mirrors the read: `user_id` is the equality predicate that
-- selects the viewer, `served_at DESC` satisfies the ORDER BY + LIMIT, and
-- `item_id` is carried so the query is answered from the index alone. `surface`
-- and `outcome` are in the PREDICATE rather than the key, because every row the
-- index contains has the same value for both — putting them in the key would
-- store the same two constants on every entry and sort by nothing.

CREATE INDEX IF NOT EXISTS rank_events_discovery_dismissed
  ON public.rank_events (user_id, served_at DESC, item_id)
  WHERE outcome = 'dismiss' AND surface = 'discovery';

-- ── 2. Postconditions ─────────────────────────────────────────────────────────
--
-- ABSOLUTE and RE-RUNNABLE: every question below is answered from the catalog
-- as it stands, with no temp tables and no before/after comparison, so
-- certify:migrations can execute this block standalone at any later time and get
-- the same verdict.

DO $post$
DECLARE
  v_def       TEXT;
  v_count     INTEGER;
BEGIN
  -- 2a. The index exists, on the right table, in the right schema.
  SELECT count(*) INTO v_count
    FROM pg_class i
    JOIN pg_namespace n ON n.oid = i.relnamespace
    JOIN pg_index x     ON x.indexrelid = i.oid
    JOIN pg_class t     ON t.oid = x.indrelid
   WHERE n.nspname = 'public'
     AND t.relname = 'rank_events'
     AND i.relname = 'rank_events_discovery_dismissed';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: expected exactly 1 rank_events_discovery_dismissed on public.rank_events, found %',
      v_count;
  END IF;

  -- 2b. It is PARTIAL, and partial on the right predicate. An index created
  --     without the WHERE clause would satisfy 2a and defeat the entire purpose
  --     of the file — it would span every rank_events row rather than the
  --     dismissals.
  SELECT pg_get_indexdef(i.oid) INTO v_def
    FROM pg_class i
    JOIN pg_namespace n ON n.oid = i.relnamespace
   WHERE n.nspname = 'public'
     AND i.relname = 'rank_events_discovery_dismissed';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: could not read the definition of rank_events_discovery_dismissed';
  END IF;
  IF v_def NOT LIKE '%WHERE%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: rank_events_discovery_dismissed is not partial — it would span the whole table: %',
      v_def;
  END IF;
  IF v_def NOT LIKE '%dismiss%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: the index predicate does not name the dismiss outcome: %', v_def;
  END IF;
  IF v_def NOT LIKE '%discovery%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: the index predicate does not name the discovery surface: %', v_def;
  END IF;

  -- 2c. It carries the columns the read projects and orders by. Checked against
  --     the definition text because that is what a later reader can compare to
  --     the query in lib/discoveryDismissed.ts by eye.
  IF v_def NOT LIKE '%user_id%' OR v_def NOT LIKE '%served_at%' OR v_def NOT LIKE '%item_id%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: rank_events_discovery_dismissed lost a key column: %', v_def;
  END IF;

  -- 2d. The 0153 indexes are all still present. This file adds; it must never be
  --     the reason one of them went missing.
  SELECT count(*) INTO v_count
    FROM pg_class i
    JOIN pg_namespace n ON n.oid = i.relnamespace
   WHERE n.nspname = 'public'
     AND i.relname IN ('rank_events_features_gin', 'rank_events_user_served_at', 'rank_events_user_item');

  IF v_count <> 3 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: expected the 3 indexes from 0153 to still exist, found %', v_count;
  END IF;

  -- 2e. The outcome vocabulary is UNCHANGED by this file — it is an index
  --     migration and must not have widened or narrowed anything.
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'rank_events'
     AND c.conname = 'rank_events_outcome_check';

  IF v_def IS NULL
     OR v_def NOT LIKE '%impression%'
     OR v_def NOT LIKE '%attended%'
     OR v_def NOT LIKE '%analytics%'
     OR v_def NOT LIKE '%dismiss%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: the outcome CHECK is not what 2297 left: %', COALESCE(v_def, '<missing>');
  END IF;
END $post$;

COMMIT;
