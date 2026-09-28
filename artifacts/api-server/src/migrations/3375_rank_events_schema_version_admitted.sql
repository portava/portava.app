-- 3375_rank_events_schema_version_admitted.sql
-- Discovery telemetry (census-discovery DV-38, §48): the database REFUSES an
-- event-record version this tree cannot read.
--
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
-- One CHECK on one existing column: rank_events.schema_version (2890, smallint
-- NOT NULL DEFAULT 1) may hold only a version the code reads and writes,
-- SUPPORTED_EVENT_SCHEMA_VERSIONS in lib/discoveryRecommendationRecord.ts,
-- which is [1]. No row is written, no column added, no index built, no grant
-- or policy touched.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- `04` §3 requires every event write to be "versioned", and DV-38 is W because
-- 2890 gave the column and nothing wrote it. The writers now write it
-- explicitly (lib/discoveryServeLog.ts, lib/rankLog.ts). A version column that
-- admits any smallint is a label, not a contract: a writer that bumped its
-- constant without a reader would land rows no reader can interpret. With this
-- CHECK, bumping the version is a migration AND a code change, together, and a
-- row written in an unknown shape is refused 23514 at the door.
--
-- ── WHAT PRODUCTION LOOKS LIKE, AND WHY THE PRECONDITION ACCEPTS IT ─────────
-- production-deployment-2026-09-14.md records 2890 applied with every existing
-- row reading schema_version = 1 (234,224 of 234,224), and nothing in the tree
-- has ever written another value. The precondition COUNTS rows outside the set
-- on whatever database it runs against and refuses with the count, so this
-- file cannot apply over a row it would invalidate. It reads no surface, so it
-- is indifferent to whether 2893 is applied (production: not; the harness:
-- yes) — the surface CHECK is asserted unchanged afterwards, since a mis-edited
-- DROP here would be the silent-writer-loss hazard census-discovery §41.1 names.
--
-- ── `10` §4 — cardinality, index, EXPLAIN ───────────────────────────────────
-- No query path is added and no index is built. ADD CONSTRAINT validates every
-- existing row once under ACCESS EXCLUSIVE: one sequential scan of rank_events
-- (≈234k rows on production at the 2026-09-14 count), a sub-second read on a
-- table of that size. EXPLAIN is not meaningful for a CHECK.
--
-- Rollback: db/rollback/2026-09-27-3375-rank-events-schema-version-admitted-rollback.sql
-- (drops the CHECK and deletes this file's ledger row; free, loses nothing).

BEGIN;

DO $$
DECLARE
  n     bigint;
  vtype text;
BEGIN
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3375): public.rank_events does not exist.';
  END IF;
  SELECT data_type INTO vtype FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'rank_events' AND column_name = 'schema_version';
  IF vtype IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3375): rank_events.schema_version is absent. Apply 2890_rank_events_behavior_engine_columns.sql first.';
  END IF;
  IF vtype <> 'smallint' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3375): rank_events.schema_version is %, not smallint; resolve by hand.', vtype;
  END IF;
  SELECT count(*) INTO n FROM public.rank_events WHERE schema_version IS DISTINCT FROM 1;
  IF n > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3375): % rank_events row(s) carry a schema_version other than 1. Admit that version in this file (and in SUPPORTED_EVENT_SCHEMA_VERSIONS) before constraining the column.', n;
  END IF;
  -- A same-named CHECK with a different definition means another lane got here first.
  PERFORM 1 FROM pg_constraint c
   WHERE c.conrelid = 'public.rank_events'::regclass AND c.conname = 'rank_events_schema_version_check'
     AND pg_get_constraintdef(c.oid) <> 'CHECK ((schema_version = 1))';
  IF FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3375): rank_events_schema_version_check exists with another definition; resolve by hand.';
  END IF;
END $$;

ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_schema_version_check;
ALTER TABLE public.rank_events
  ADD CONSTRAINT rank_events_schema_version_check CHECK (schema_version IN (1));

COMMENT ON CONSTRAINT rank_events_schema_version_check ON public.rank_events IS
  '3375 / census-discovery DV-38. The event-record versions this tree reads and '
  'writes: SUPPORTED_EVENT_SCHEMA_VERSIONS in lib/discoveryRecommendationRecord.ts. '
  'Bump both together; a version admitted here with no reader, or written with '
  'no admission, is the defect this constraint exists to refuse.';

-- ── Behavioural postcondition, INSIDE the applying transaction ─────────────
-- It writes (a probe that is always rolled back by its own exception block),
-- so it runs before COMMIT: the applier admits only read-only assertions after
-- the COMMIT, and a probe is not one.
DO $probe$
BEGIN
  -- Version 2 is refused by THIS check. CHECKs run before the user_id foreign
  -- key (an AFTER trigger), so a random user id cannot mask the answer.
  BEGIN
    INSERT INTO public.rank_events (user_id, item_id, features, outcome, served_at, surface, schema_version)
    VALUES (gen_random_uuid(), '3375-probe', '{}'::jsonb, 'impression', now(), 'discovery', 2);
    RAISE EXCEPTION 'POSTCONDITION FAILED (3375): schema_version 2 was accepted.';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM NOT LIKE '%rank_events_schema_version_check%' THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3375): the version-2 probe was refused by another check: %', SQLERRM;
      END IF;
    WHEN foreign_key_violation THEN
      -- Every CHECK passed and only the random user id stopped it: version 2 was ADMITTED.
      RAISE EXCEPTION 'POSTCONDITION FAILED (3375): schema_version 2 passed every CHECK.';
  END;
END $probe$;

COMMIT;

-- ── Postconditions (separate: they assert what persisted) ──────────────────
DO $post$
DECLARE
  def   text;
  n     int;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
   WHERE c.conrelid = 'public.rank_events'::regclass AND c.conname = 'rank_events_schema_version_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3375): rank_events_schema_version_check is absent.';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint c
   WHERE c.conrelid = 'public.rank_events'::regclass AND c.conname = 'rank_events_schema_version_check' AND c.convalidated;
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3375): the schema_version CHECK is not exactly one validated constraint.';
  END IF;

  -- The neighbouring surface CHECK survived: `discovery` and `watch_feed` are
  -- still admitted (2298's guard, restated because a mis-edited DROP above would
  -- take it silently and every fire-and-forget writer would lose its rows).
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
   WHERE c.conrelid = 'public.rank_events'::regclass AND c.conname = 'rank_events_surface_check';
  IF def IS NULL OR def NOT LIKE '%''discovery''%' OR def NOT LIKE '%''watch_feed''%' OR def NOT LIKE '%''living_page''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3375): rank_events_surface_check is not intact: %', coalesce(def, '<absent>');
  END IF;

  SELECT count(*) INTO n FROM public.rank_events WHERE item_id = '3375-probe';
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3375): % probe row(s) persisted.', n;
  END IF;
END $post$;
