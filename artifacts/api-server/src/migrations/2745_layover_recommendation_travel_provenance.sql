-- 2745_layover_recommendation_travel_provenance.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2745.
-- Idempotent. Adds ONE nullable column to `layover_recommendations`.
-- Moves no row: no backfill, no default, no flag, no constraint narrowed.
-- Applying it changes NOTHING a traveller sees until a writer chooses to
-- populate the column, and no writer does today.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT
-- ══════════════════════════════════════════════════════════════════════════════
-- `layover_recommendations.travel_time_source TEXT NULL` — where the row's
-- `travel_time_min` came from, recorded on the row by whoever wrote it.
--
--   NULL                  WE DO NOT KNOW. The state of every row that exists
--                         today, and of every row a writer leaves alone. It is
--                         the DEFAULT STATE BY CONSTRUCTION: the column has no
--                         DEFAULT and there is no backfill, so nothing can
--                         acquire a provenance it was not given.
--   'measured'            a routed `TravelTimeProvider` computed this journey
--                         for THIS place from THIS airport.
--   'traveller_stated'    a human gave the figure. Not a measurement, and not
--                         a fabrication either — it has a source with a name.
--   'straight_line_bound' a great-circle LOWER BOUND. Usable to REFUSE a
--                         journey and never to certify one, which is why it is
--                         a distinct value rather than a flavour of 'measured'
--                         (see LayoverTravelTime.ts's header and
--                         straightLineTravelTimeProvider's own argument).
--   'inside_airport'      0 minutes of landside travel, BY CONSTRUCTION.
--   'unmeasured'          there is no figure. The landside 0 that the NOT NULL
--                         DEFAULT 0 column forces an absence to be written as.
--   'category_default'    a per-category constant chosen without a coordinate.
--                         Nothing produces one since census L293; the value is
--                         admitted so a row CAN say it rather than have it
--                         guessed on its behalf.
--
-- The vocabulary is exactly `TRAVEL_TIME_SOURCES` in
-- services/airport/LayoverSafetyEngine.ts, deliberately: the column stores the
-- value the read path returns, so there is no mapping table between the two to
-- drift, and an unrecognised value is refused by the CHECK at write time and
-- ignored by the read path at read time.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY — THE OBLIGATION THIS DISCHARGES, QUOTED
-- ══════════════════════════════════════════════════════════════════════════════
-- services/airport/LayoverTravelTime.ts, on why the travel-time provider is a
-- module constant rather than an environment lookup:
--
--   "wiring a real provider must be a code change that lands on the line below,
--    because it also obliges its author to add a provenance column to
--    `layover_recommendations` before a 'measured' figure may be persisted (see
--    `persistedTravelTimeSource` for why the read path cannot infer one). An
--    env switch would let a routed provider appear in production with the read
--    path still inferring 'category_default' for every row it wrote."
--
-- This file is that prerequisite and NOT the routing provider. There is no
-- routing service on this tree; `LAYOVER_TRAVEL_TIME_PROVIDER` is still
-- `noRoutedProvider` and nothing here changes that.
--
-- WHAT THE READ PATH DID BEFORE. `persistedTravelTimeSource` had no column to
-- read, so it decided a provenance from the sign of an integer: a landside row
-- holding a positive `travel_time_min` was reported `category_default` — a
-- claim about a PRODUCER, made about a row that named none. That inference was
-- exact only while nothing produced a measured figure, and it was the specific
-- failure the module constant existed to prevent. With this column the read
-- path stops guessing: an unrecorded row reads `unknown_provenance`, which is
-- an answer, where `category_default` was a guess wearing one.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED
-- ══════════════════════════════════════════════════════════════════════════════
-- Nothing was read from production for this file and nothing needed to be: an
-- ADD COLUMN of a nullable TEXT with no DEFAULT rewrites no tuple, validates
-- against no existing row, and cannot invalidate a row that exists. Every row
-- in the table, on every database, answers NULL afterwards — which is exactly
-- the "we do not know" this column is for. The CHECK is added as NOT VALID and
-- then VALIDATEd, so it cannot fail on legacy data: every existing row is NULL
-- and NULL satisfies it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- RUNTIME EFFECT: NONE, AND HERE IS WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- READ  `getRecommendations` does `select("*")`, so on a database that has not
--       applied this file the key is simply absent and the read falls back to
--       the row's own facts — the same answer as NULL.
-- WRITE `LayoverRecommendationService` adds `travel_time_source` to the insert
--       payload ONLY for a provenance the row's own columns cannot express
--       (`travelTimeProvenanceColumn` in LayoverTravelTime.ts). On this tree
--       every landside leg is `unmeasured` and every airside one is
--       `inside_airport`, both of which the row already expresses, so NO WRITE
--       CARRIES THIS KEY TODAY and the insert cannot break on a database that
--       lags this migration — the hazard 2410's header documents.
--       The day a routed provider is assigned, the key appears, and this file
--       is what must already have been applied.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
--   ALTER TABLE public.layover_recommendations
--     DROP CONSTRAINT IF EXISTS layover_recommendations_travel_time_source_check;
--   ALTER TABLE public.layover_recommendations
--     DROP COLUMN IF EXISTS travel_time_source;
--
-- Dropping the column loses every recorded provenance and puts the read path
-- back to answering from the row's own facts — which is the state before this
-- file, not a new one. No data outside this column is touched, so the rollback
-- is total. Rollback file:
-- db/rollback/2026-09-15-2745-layover-recommendation-travel-provenance-rollback.sql
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on 0127 (the table) and on nothing else. Independent of 2335 / 2410 /
-- 2411 / 2510 / 2700 / 2740 / 2741, and nothing depends on it.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.layover_recommendations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2745): public.layover_recommendations is missing -- apply 0127 first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'layover_recommendations'
      AND column_name = 'travel_time_min'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2745): layover_recommendations.travel_time_min is missing -- there is no figure for a provenance to be about.';
  END IF;
END $$;

-- ── SNAPSHOT: how many rows already carry a provenance ───────────────────────
-- Taken BEFORE anything is altered and stashed transaction-locally, so the
-- no-backfill postcondition compares after against before rather than against
-- zero. A first run reads 0 (the column does not exist yet); a RE-RUN on a
-- database whose writers have since labelled rows reads their count and still
-- passes, which is what makes this file re-runnable. A backfill statement
-- smuggled into it would make the two differ, on a first run and on every
-- re-run alike.
DO $$
DECLARE
  n BIGINT := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'layover_recommendations'
      AND column_name = 'travel_time_source'
  ) THEN
    EXECUTE 'SELECT count(*) FROM public.layover_recommendations WHERE travel_time_source IS NOT NULL'
      INTO n;
  END IF;
  PERFORM set_config('portava.m2745_labelled_before', n::text, TRUE);
END $$;

-- ── SECTION 1: the column ────────────────────────────────────────────────────
-- Nullable, and with NO DEFAULT on purpose. A DEFAULT — even 'unknown_provenance'
-- — would be a value the database wrote rather than a writer, and the whole
-- point of this column is that only a writer who KNOWS may put something in it.
-- NULL is the absence, and the absence is the honest answer.
ALTER TABLE public.layover_recommendations
  ADD COLUMN IF NOT EXISTS travel_time_source TEXT;

COMMENT ON COLUMN public.layover_recommendations.travel_time_source IS
  'Provenance of travel_time_min. NULL = we do not know (the state of every pre-2745 row and of every row no writer labelled); the read path reports that as ''unknown_provenance'' and NEVER as a measurement. Vocabulary = TRAVEL_TIME_SOURCES in services/airport/LayoverSafetyEngine.ts. Written only for a provenance the row''s own columns cannot express -- see travelTimeProvenanceColumn in services/airport/LayoverTravelTime.ts.';

-- ── SECTION 2: the vocabulary, as a CHECK ────────────────────────────────────
-- Added NOT VALID and then validated, so the two steps are separable on a large
-- table and neither can fail on legacy data: every existing row is NULL and
-- `travel_time_source IS NULL` satisfies the predicate. Guarded by name so a
-- re-run adds nothing and drops nothing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'layover_recommendations'
      AND c.conname = 'layover_recommendations_travel_time_source_check'
  ) THEN
    ALTER TABLE public.layover_recommendations
      ADD CONSTRAINT layover_recommendations_travel_time_source_check
      CHECK (
        travel_time_source IS NULL OR travel_time_source IN (
          'inside_airport',
          'category_default',
          'measured',
          'unmeasured',
          'traveller_stated',
          'straight_line_bound',
          'unknown_provenance'
        )
      ) NOT VALID;

    ALTER TABLE public.layover_recommendations
      VALIDATE CONSTRAINT layover_recommendations_travel_time_source_check;
  END IF;
END $$;

-- ── POSTCONDITIONS ───────────────────────────────────────────────────────────
-- Each one would catch a DIFFERENT partial apply: the column missing (section 1
-- never ran), the column present but NOT NULL or defaulted (a later edit made
-- "we do not know" unrepresentable), the constraint missing or still NOT VALID
-- (section 2 half-ran), the vocabulary short a value (a hand-edited CHECK), a
-- row carrying a provenance (something backfilled), or `travel_time_min` having
-- been altered (this file is additive and must have touched nothing else).
DO $$
DECLARE
  nullable    TEXT;
  coldefault  TEXT;
  con_valid   BOOLEAN;
  con_def     TEXT;
  labelled    BIGINT;
  labelled_before BIGINT;
  fig_nullable TEXT;
  fig_default TEXT;
  v           TEXT;
BEGIN
  SELECT is_nullable, column_default INTO nullable, coldefault
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'layover_recommendations'
    AND column_name = 'travel_time_source';

  IF nullable IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2745): layover_recommendations.travel_time_source is missing';
  END IF;
  IF nullable <> 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2745): travel_time_source is NOT NULL -- "we do not know" must be representable';
  END IF;
  IF coldefault IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2745): travel_time_source has a DEFAULT (%) -- a row nobody labelled would carry a settled claim', coldefault;
  END IF;

  SELECT c.convalidated, pg_get_constraintdef(c.oid) INTO con_valid, con_def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'layover_recommendations'
    AND c.conname = 'layover_recommendations_travel_time_source_check';

  IF con_def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2745): the travel_time_source CHECK is missing';
  END IF;
  IF con_valid IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2745): the travel_time_source CHECK is still NOT VALID -- section 2 half-applied';
  END IF;

  -- Every member of the vocabulary, named one at a time so the failure says
  -- WHICH one a hand-edited constraint dropped.
  FOREACH v IN ARRAY ARRAY[
    'inside_airport','category_default','measured','unmeasured',
    'traveller_stated','straight_line_bound','unknown_provenance'
  ] LOOP
    IF position(('''' || v || '''') IN con_def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2745): the travel_time_source CHECK does not admit ''%''', v;
    END IF;
  END LOOP;
  -- NULL must remain legal, or every existing row becomes unwritable.
  IF position('IS NULL' IN con_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2745): the travel_time_source CHECK no longer admits NULL';
  END IF;

  -- NO BACKFILL. Nothing between the snapshot above and here writes a row, so
  -- any difference means a backfill was added to this file — which would give
  -- rows a provenance nobody recorded, the exact fabrication the column exists
  -- to prevent. On a first apply both sides are 0.
  labelled_before := current_setting('portava.m2745_labelled_before', TRUE)::BIGINT;
  SELECT count(*) INTO labelled
  FROM public.layover_recommendations WHERE travel_time_source IS NOT NULL;
  IF labelled IS DISTINCT FROM labelled_before THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2745): travel_time_source went from % to % labelled row(s) -- this migration must write none', labelled_before, labelled;
  END IF;

  -- ADDITIVE: the figure this column is about must be exactly as 0127 left it.
  SELECT is_nullable, column_default INTO fig_nullable, fig_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'layover_recommendations'
    AND column_name = 'travel_time_min';
  IF fig_nullable <> 'NO' OR fig_default IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2745): travel_time_min changed (nullable=%, default=%) -- this file must alter nothing that exists', fig_nullable, fig_default;
  END IF;
END $$;

COMMIT;
