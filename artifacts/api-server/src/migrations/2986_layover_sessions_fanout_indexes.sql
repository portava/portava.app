-- 2986_layover_sessions_fanout_indexes.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band), layover lane.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS FOR
-- ══════════════════════════════════════════════════════════════════════════════
-- census-layover L259 is "Replan fanout — index active sessions by
-- airport/route/flight subjects; recompute impacted sessions only", and its
-- verdict reads:
--
--   "Indexes exist but on the wrong axes: (user_id, status) and
--    (departure_time) (0127:91-92). There is no airport, route or flight
--    subject index and no fanout to serve."
--
-- The second clause has stopped being true. There IS a fanout now, and it runs
-- exactly the two reads this file indexes:
--
--   services/airport/LayoverExternalReplanPort.ts
--     SELECT * FROM layover_sessions
--      WHERE airport_id = ANY($1) AND status = 'active' LIMIT $2      (:234)
--     SELECT * FROM layover_sessions
--      WHERE manual_iata = $1     AND status = 'active' LIMIT $2      (:250)
--
-- They are two reads rather than one `.or()` because the airport identity a
-- session carries is either a profile row (`airport_id`) or a bare code
-- (`manual_iata`), and those are different columns. Two predicates, two indexes.
--
-- The consumer that issues them is driven by lib/layoverExternalEventScheduler.ts
-- on a two-minute period, once per pending external event. Without these indexes
-- each event is a sequential scan of every layover session ever created, and the
-- cost grows with the table rather than with the number of active sessions at
-- one airport — which is the quantity the work is actually proportional to.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THE EXISTING THREE DO NOT SERVE IT
-- ══════════════════════════════════════════════════════════════════════════════
-- 0127 created all three that exist today:
--
--   layover_sessions_user_status_idx  (user_id, status)
--       Leading column is the traveller. The fanout is asking "who is at this
--       airport", which names no user, so there is no leading-column predicate
--       to give and the index cannot be used at all.
--   layover_sessions_departure_idx    (departure_time)
--       Wrong axis. The window bound the replanner applies is in code, after the
--       rows are read; the read itself does not filter on departure_time.
--   layover_sessions_share_idx        (status, share_city_status)
--                                       WHERE share_city_status = TRUE
--       Built for presence. Its predicate excludes every session that has not
--       opted into city-level social visibility, and the replan fanout must
--       reach sessions whether or not they share — so this index is not merely
--       unhelpful here, it is WRONG for the question, and a planner that chose
--       it would silently drop the sessions that matter most.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS ADDS
-- ══════════════════════════════════════════════════════════════════════════════
-- Two PARTIAL indexes, each whose predicate is its read's own WHERE clause.
--
-- Partial rather than full for the reason that decides it: a layover session is
-- 'active' for hours and then 'completed', 'cancelled' or 'expired' forever.
-- The active set is a small and BOUNDED slice of a table that only grows, so a
-- partial index stays roughly constant in size while the table does not. A full
-- (airport_id, status) index would carry every historical session at that
-- airport and grow without limit.
--
-- `status` is in the PREDICATE and not in the key, because every row the index
-- contains has the same value for it — putting it in the key would store the
-- same constant on every entry and sort by nothing. This mirrors 2995's
-- reasoning about `outcome` and `surface`.
--
-- The `IS NOT NULL` term is not decoration. Both columns are nullable and most
-- rows populate exactly one of them: a session created from an airport profile
-- has `manual_iata` NULL, and a manual-fallback session has `airport_id` NULL.
-- Excluding the NULLs keeps each index to the rows it can ever answer for. The
-- planner can still use them, because `x = c` and `x = ANY(...)` with a strict
-- operator both imply `x IS NOT NULL`.
--
-- COST ON WRITES. Every layover_sessions INSERT and UPDATE must consider two
-- more indexes. A session's INSERT writes one entry (it has one identity, not
-- both), and the UPDATE that ends a session — `status` leaving 'active' — is the
-- one that removes it, which is precisely the behaviour that keeps the indexes
-- small.
--
-- WHAT THIS DOES NOT DO. It does not close L259. The row asks for airport,
-- ROUTE and FLIGHT subjects; this file indexes the airport axis, because the
-- airport axis is the only one the fanout currently queries. `layover_sessions`
-- has no route or flight column to index, and inventing one to satisfy a census
-- row would be the wrong order of work.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ADDITIVE, IDEMPOTENT, AND REVERSIBLE
-- ══════════════════════════════════════════════════════════════════════════════
--   * CREATE INDEX IF NOT EXISTS — re-running the file is a no-op.
--   * No column is added, no constraint is changed, no data is written, no grant
--     is altered and no flag is flipped. The same rows are returned by the same
--     queries, faster.
--   * The indexes depend on 'active' being a legal status and on both columns
--     existing. The preconditions check all three rather than assuming them: an
--     index whose predicate names a value the CHECK forbids would be created
--     successfully and index nothing, which looks exactly like a working index.
--
-- TRANSACTION
-- -----------
-- Used. Plain (non-CONCURRENT) CREATE INDEX is transactional, so a failed
-- postcondition leaves nothing behind. CONCURRENTLY is deliberately not used —
-- it cannot run inside a transaction block, and these indexes cover only the
-- active slice. If this is ever applied to a layover_sessions large enough for
-- the brief SHARE lock to matter, split the two statements out and run them
-- concurrently; the postcondition block is written so it can be re-run
-- standalone either way.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.layover_sessions_airport_active_idx;
--   DROP INDEX IF EXISTS public.layover_sessions_manual_iata_active_idx;

BEGIN;

-- ── 0. Preconditions ─────────────────────────────────────────────────────────
--
-- Fails LOUDLY rather than creating indexes over predicates that can never
-- match, or on columns that are not there.

DO $pre$
DECLARE
  v_def   TEXT;
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'layover_sessions'
     AND column_name IN ('airport_id', 'manual_iata', 'status');

  IF v_count <> 3 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: public.layover_sessions must carry airport_id, manual_iata and status; found % of 3. Apply 0127 first.',
      v_count;
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'layover_sessions'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%status%';

  IF v_def IS NULL THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: no CHECK constraint on layover_sessions.status — the partial predicate below would be unverifiable.';
  END IF;
  IF v_def NOT LIKE '%active%' THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: layover_sessions.status does not admit ''active'', so an index predicated on it would match nothing. Constraint: %',
      v_def;
  END IF;
END $pre$;

-- ── 1. The indexes ───────────────────────────────────────────────────────────
--
-- One per read in LayoverExternalReplanPort. Key column = the equality/ANY
-- predicate that selects the airport; everything constant lives in the WHERE.

CREATE INDEX IF NOT EXISTS layover_sessions_airport_active_idx
  ON public.layover_sessions (airport_id)
  WHERE status = 'active' AND airport_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS layover_sessions_manual_iata_active_idx
  ON public.layover_sessions (manual_iata)
  WHERE status = 'active' AND manual_iata IS NOT NULL;

-- ── 2. Postconditions ────────────────────────────────────────────────────────
--
-- ABSOLUTE and RE-RUNNABLE: every question is answered from the catalog as it
-- stands, with no temp tables and no before/after comparison, so
-- certify:migrations can execute this block standalone at any later time and
-- get the same verdict.

DO $post$
DECLARE
  v_def   TEXT;
  v_count INTEGER;
  v_name  TEXT;
BEGIN
  -- 2a. Both exist, on the right table, in the right schema.
  SELECT count(*) INTO v_count
    FROM pg_class i
    JOIN pg_namespace n ON n.oid = i.relnamespace
    JOIN pg_index x     ON x.indexrelid = i.oid
    JOIN pg_class t     ON t.oid = x.indrelid
   WHERE n.nspname = 'public'
     AND t.relname = 'layover_sessions'
     AND i.relname IN ('layover_sessions_airport_active_idx',
                       'layover_sessions_manual_iata_active_idx');

  IF v_count <> 2 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: expected both fanout indexes on public.layover_sessions, found %', v_count;
  END IF;

  -- 2b. Each is PARTIAL, and partial on the right predicate. An index created
  --     without the WHERE clause would satisfy 2a and defeat the whole file:
  --     it would span every session ever created rather than the active ones.
  FOREACH v_name IN ARRAY ARRAY['layover_sessions_airport_active_idx',
                                'layover_sessions_manual_iata_active_idx'] LOOP
    SELECT pg_get_indexdef(i.oid) INTO v_def
      FROM pg_class i
      JOIN pg_namespace n ON n.oid = i.relnamespace
     WHERE n.nspname = 'public' AND i.relname = v_name;

    IF v_def IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: could not read the definition of %', v_name;
    END IF;
    IF v_def NOT LIKE '%WHERE%' THEN
      RAISE EXCEPTION
        'POSTCONDITION FAILED: % is not partial — it would span the whole table: %', v_name, v_def;
    END IF;
    IF v_def NOT LIKE '%active%' THEN
      RAISE EXCEPTION
        'POSTCONDITION FAILED: %''s predicate does not name the active status: %', v_name, v_def;
    END IF;
    IF v_def NOT LIKE '%IS NOT NULL%' THEN
      RAISE EXCEPTION
        'POSTCONDITION FAILED: %''s predicate does not exclude NULLs, so it carries rows it can never answer for: %',
        v_name, v_def;
    END IF;
  END LOOP;

  -- 2c. Each keys the column its read filters on, and they are not the same
  --     column. A copy-paste that created two indexes on airport_id would pass
  --     2a and 2b and leave the manual-fallback read on a sequential scan.
  SELECT pg_get_indexdef(i.oid) INTO v_def
    FROM pg_class i JOIN pg_namespace n ON n.oid = i.relnamespace
   WHERE n.nspname = 'public' AND i.relname = 'layover_sessions_airport_active_idx';
  IF v_def NOT LIKE '%(airport_id)%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: layover_sessions_airport_active_idx is not keyed on airport_id: %', v_def;
  END IF;

  SELECT pg_get_indexdef(i.oid) INTO v_def
    FROM pg_class i JOIN pg_namespace n ON n.oid = i.relnamespace
   WHERE n.nspname = 'public' AND i.relname = 'layover_sessions_manual_iata_active_idx';
  IF v_def NOT LIKE '%(manual_iata)%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: layover_sessions_manual_iata_active_idx is not keyed on manual_iata: %', v_def;
  END IF;

  -- 2d. The three indexes from 0127 are all still present. This file adds; it
  --     must never be the reason one of them went missing.
  SELECT count(*) INTO v_count
    FROM pg_class i
    JOIN pg_namespace n ON n.oid = i.relnamespace
   WHERE n.nspname = 'public'
     AND i.relname IN ('layover_sessions_user_status_idx',
                       'layover_sessions_departure_idx',
                       'layover_sessions_share_idx');

  IF v_count <> 3 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: expected the 3 indexes from 0127 to still exist, found %', v_count;
  END IF;

  -- 2e. The status vocabulary is UNCHANGED by this file — it is an index
  --     migration and must not have widened or narrowed anything.
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'layover_sessions'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%status%';

  IF v_def IS NULL
     OR v_def NOT LIKE '%active%'
     OR v_def NOT LIKE '%completed%'
     OR v_def NOT LIKE '%cancelled%'
     OR v_def NOT LIKE '%expired%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: the status CHECK is not what 0127 left: %', COALESCE(v_def, '<missing>');
  END IF;
END $post$;

COMMIT;
