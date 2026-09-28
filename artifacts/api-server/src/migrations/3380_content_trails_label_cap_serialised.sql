-- 3380_content_trails_label_cap_serialised.sql
-- Discovery Trails (census-discovery DC-02, §51): `02_Trails.md` §4's label cap
-- holds under CONCURRENT writers, not only under sequential ones.
--
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- Rehearsed on the local PostgreSQL 16 harness only (scripts/local-db/up.sh).
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
-- 1. `public.content_trails_label_cap()` (2910) is replaced by the same function
--    with ONE statement added before its count: a transaction-scoped advisory
--    lock keyed on the content (`source_type`, `source_id`). The three budgets,
--    the message, the errcode, SECURITY INVOKER, the search_path and the
--    trigger that calls it are unchanged.
-- 2. A partial UNIQUE index `uq_content_trails_one_primary` on
--    (source_type, source_id) WHERE relationship = 'primary' — §4's own number
--    ("Content may have one primary Trail"), enforced by the index as well.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- 2910's trigger counts the labels a content already holds with a plain
-- SELECT. Under READ COMMITTED (PostgREST's level) two sessions attaching a
-- label to the same content each count only COMMITTED rows, so each misses the
-- other's in-flight insert and both commit. Measured on the harness before this
-- file: two racing primary attachments to two Trails landed TWO primaries, and
-- two racing supporting attachments for the last slot landed FOUR supporting
-- labels against a budget of three
-- (src/test/db/trailsConstraints.db.test.ts L1, L2). §4 says "Do not let
-- creators attach unlimited discovery labels"; a cap any two concurrent
-- requests can walk through is not a cap.
--
-- With the lock, the second writer's trigger waits for the first writer's
-- transaction to end and then counts with a fresh statement snapshot (a
-- VOLATILE plpgsql function takes one per statement under READ COMMITTED), so
-- it sees the committed label and refuses 23514. The lock is per CONTENT, so
-- unrelated attachments never wait on each other.
--
-- The lock alone depends on READ COMMITTED: under REPEATABLE READ the count
-- would still read the transaction's first snapshot. The primary budget is 1,
-- which a UNIQUE index can express, so for the one budget the spec itself fixes
-- the refusal holds at every isolation level (23505). Supporting (3) and Signal
-- (5) budgets are counts an index cannot express; they rest on the lock, and the
-- API writes through PostgREST at READ COMMITTED.
--
-- ── `10` §4 — cardinality, index, EXPLAIN ───────────────────────────────────
-- Production holds 0 content_trails rows (2910 applied 2026-09-20, empty), so
-- the index builds instantly and the precondition's duplicate scan reads
-- nothing. The index is also the plan for the trigger's primary-budget count:
--   EXPLAIN SELECT count(*) FROM public.content_trails
--    WHERE source_type = 'post' AND source_id = $1 AND relationship = 'primary';
--   → Index Only Scan using uq_content_trails_one_primary (expected rows ≤ 1)
-- The other two budgets keep 2910's idx_content_trails_source (source_type,
-- source_id): ≤ 9 rows per content by construction.
--
-- Rollback: db/rollback/2026-09-27-3380-content-trails-label-cap-serialised-rollback.sql
-- (restores 2910's function body and drops the index; loses the concurrency
-- guarantee, deletes no row).

BEGIN;

DO $pre$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.content_trails') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3380): public.content_trails does not exist. Apply 2910_discovery_trails.sql first.';
  END IF;
  IF to_regprocedure('public.content_trails_label_cap()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3380): public.content_trails_label_cap() does not exist. Apply 2910_discovery_trails.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.content_trails'::regclass
                    AND tgname = 'content_trails_label_cap_trg' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3380): content_trails_label_cap_trg is absent; this file hardens a trigger it expects to find.';
  END IF;
  -- The index cannot be built over a content that already holds two primaries,
  -- and it must not be: name them instead of failing inside CREATE INDEX.
  SELECT count(*) INTO n FROM (
    SELECT source_type, source_id FROM public.content_trails
     WHERE relationship = 'primary' GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3380): % content item(s) already hold more than one primary Trail (02 §4 allows one). Resolve them by hand before applying.', n;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.content_trails_label_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE held int; cap int;
BEGIN
  cap := CASE NEW.relationship
           WHEN 'primary'    THEN 1
           WHEN 'supporting' THEN 3
           WHEN 'signal'     THEN 5
         END;
  -- 3380: serialise every writer of ONE content's labels, so the count below
  -- sees a concurrent writer's committed label instead of racing past it.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('content_trails_label_cap:' || NEW.source_type || ':' || NEW.source_id::text, 0));
  SELECT count(*) INTO held
    FROM public.content_trails
   WHERE source_type = NEW.source_type
     AND source_id = NEW.source_id
     AND relationship = NEW.relationship
     AND id IS DISTINCT FROM NEW.id;
  IF held >= cap THEN
    RAISE EXCEPTION '02 §4: % label cap of % reached for %:%',
      NEW.relationship, cap, NEW.source_type, NEW.source_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.content_trails_label_cap() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.content_trails_label_cap() IS
  '02_Trails.md §4 "Do not let creators attach unlimited discovery labels": one primary Trail, three supporting, five Signals — three separate budgets per piece of content, counted under a per-content advisory lock (3380) so concurrent writers cannot overshoot. Mirrored by MAX_PRIMARY_TRAILS / MAX_SUPPORTING_TRAILS / MAX_SIGNALS in lib/discoveryTrailObject.ts.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_content_trails_one_primary
  ON public.content_trails (source_type, source_id) WHERE relationship = 'primary';
COMMENT ON INDEX public.uq_content_trails_one_primary IS
  '3380 / 02_Trails.md §4 "Content may have one primary Trail" — the one budget the spec fixes, enforced at every isolation level.';

-- ── Behavioural postcondition, inside the applying transaction ──────────────
-- Two Trails, one content, a second primary: refused (by the trigger, which
-- fires before the index is consulted). Everything is rolled back by the
-- exception block, so nothing persists.
DO $probe$
BEGIN
  BEGIN
    INSERT INTO public.trails (id, slug, title, lifecycle_status)
      VALUES ('00000000-0000-4000-8000-0000000033a0', 'migration-3380-probe-a', 'probe a', 'proposed'),
             ('00000000-0000-4000-8000-0000000033a1', 'migration-3380-probe-b', 'probe b', 'proposed');
    INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship)
      VALUES ('00000000-0000-4000-8000-0000000033a0', 'place', '00000000-0000-4000-8000-0000000033b0', 'primary');
    INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship)
      VALUES ('00000000-0000-4000-8000-0000000033a1', 'place', '00000000-0000-4000-8000-0000000033b0', 'primary');
    RAISE EXCEPTION 'POSTCONDITION FAILED (3380): a second primary Trail was admitted';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM NOT LIKE '02 §4: primary label cap of 1 reached%' THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3380): the probe was refused by something else: %', SQLERRM;
      END IF;
  END;
END
$probe$;

COMMIT;

-- ── Postconditions (read-only: what persisted) ──────────────────────────────
DO $post$
BEGIN
  IF position('pg_advisory_xact_lock' IN pg_get_functiondef('public.content_trails_label_cap()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3380): content_trails_label_cap() does not take the per-content lock.';
  END IF;
  IF to_regclass('public.uq_content_trails_one_primary') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3380): uq_content_trails_one_primary is absent.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.content_trails'::regclass
                    AND tgname = 'content_trails_label_cap_trg' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3380): content_trails_label_cap_trg is gone.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trails WHERE slug LIKE 'migration-3380-probe-%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3380): a probe row persisted.';
  END IF;
END
$post$;
