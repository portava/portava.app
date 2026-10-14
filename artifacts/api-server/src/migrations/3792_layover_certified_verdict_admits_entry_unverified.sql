-- 3792_layover_certified_verdict_admits_entry_unverified.sql
--
-- Widen 2700's `layover_certified_computations.verdict` CHECK to the engine's
-- full verdict vocabulary, which means admitting `entry_unverified`.
--
-- Lane B58 LAY-2700 (layover band). It alters ONE constraint on the ONE table
-- 2700 creates. It creates nothing, deletes and updates no row, and changes no
-- column, index, policy, grant, trigger or flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT
-- ══════════════════════════════════════════════════════════════════════════════
-- 2700 (written 2026-09-08) declares, at
-- 2700_layover_certified_feasibility.sql:135,
--
--     verdict TEXT NOT NULL CHECK (verdict IN ('yes','tight','no','stay_airside'))
--
-- The engine's union gained a fifth member on 2026-09-22, with the entry gate:
--
--     verdict: "yes" | "tight" | "no" | "entry_unverified" | "stay_airside";
--
-- (services/airport/LayoverSafetyEngine.ts:1204). It is returned at :1397 for
-- every session with 90 or more usable minutes whose entry corridor is not
-- confirmed. `entry_requirements` is uncurated, so today that is EVERY roomy
-- layover.
--
-- The table's one writer sends the verdict unmapped. `ledgerRowFor`
-- (services/airport/layoverLedger.ts:513) builds it, `certifiedComputationRowFor`
-- (services/layover/LayoverDecisionStore.ts) spreads it, and `persistDecision`
-- inserts it. With 2700 and 2992 applied and `layover_decision_persistence_enabled`
-- ON, that INSERT fails with 23514 (check_violation). `persistDecision` then
-- returns `write_failed`, and no decision row, time budget or return plan is
-- stored for exactly the sessions a traveller is most likely to act on. Every
-- reader of those rows is left with nothing: L64's card stamp, L209-L213's
-- metrics, L217's replay, L190's diff and L25's snapshot.
--
-- Nothing caught it. `fakeLayoverDb` models no CHECK, and no database suite
-- wrote this table. Both gaps are closed with this file (see TESTS).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES
-- ══════════════════════════════════════════════════════════════════════════════
-- It drops every single-column CHECK on `verdict`, found in the catalog rather
-- than by an assumed name (2700's CHECK is inline, so PostgreSQL named it). It
-- then adds `layover_certified_computations_verdict_check`, which admits the
-- five members of the engine's union.
--
-- The new set is a strict SUPERSET of 2700's. Every row 2700 admitted still
-- satisfies it, so the ADD validates without touching data.
--
-- The vocabulary is not a copy somebody has to remember to update.
-- src/test/layoverStoredVocabulary.test.ts reads the writer's verdict type with
-- the TypeScript checker and fails when the NEWEST migration that states this
-- CHECK does not admit every member. A sixth verdict in the engine is therefore
-- red until a migration admits it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PRESS ORDER: WITH 2700 AND 2992, BEFORE THE FLIP
-- ══════════════════════════════════════════════════════════════════════════════
-- 2700 is applied to portava-ci (2026-09-08) and NOT to production. 2992 is the
-- same (portava-ci 2026-09-26, not production). This file alters 2700's table:
--
--   * On a database WITH 2700 (portava-ci, or any full-chain replay), it widens
--     the CHECK. Its normal place is after 2992. Before 2992 it is harmless.
--   * On a database WITHOUT 2700 (production today), the precondition REFUSES
--     and names 2700. It never creates the table: recreating 2700's table here
--     would fork the definition of the one object the decision record turns on.
--
-- Production must press 2700, 2992 and THIS FILE together, in that order. Only
-- then may `layover_decision_persistence_enabled` be flipped (2992's step 5).
-- Flipping after 2700 and 2992 but before this file stores nothing for every
-- roomy layover with an unconfirmed corridor.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ══════════════════════════════════════════════════════════════════════════════
-- db/rollback/2026-10-14-3792-layover-certified-verdict-admits-entry-unverified-rollback.sql
-- restores 2700's four-value CHECK. It REFUSES while any stored row carries a
-- verdict outside those four, and while the persistence flag is ON.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- TESTS
-- ══════════════════════════════════════════════════════════════════════════════
--   src/test/layoverStoredVocabulary.test.ts: the static pin above, plus the
--     sweep of every other enumerated CHECK on the 2700 and 2992 tables against
--     what each table's writer sends.
--   src/test/db/layoverCertifiedVerdict.db.test.ts: on the replayed chain
--     (2700, 2992, 3623, then this file), `persistDecision` stores a decision for
--     each of the engine's five verdicts. `entry_unverified` is refused without
--     this file.
--
-- NOT APPLIED BY ITS AUTHOR. Application follows the repository's reviewed
-- PR/CI path; see docs/migrations.md.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_certified_computations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3792): public.layover_certified_computations does not exist, so 2700_layover_certified_feasibility.sql has not been applied to this database. 3792 widens 2700''s verdict CHECK and must be pressed WITH 2700 and 2992 (2700, then 2992, then 3792), before layover_decision_persistence_enabled is turned on. Apply 2700 first; this migration will not create the table.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'layover_certified_computations'
       AND column_name = 'verdict'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3792): public.layover_certified_computations has no verdict column, so it is not the table 2700 creates. Refusing rather than guessing.';
  END IF;
END $pre$;

-- Every single-column CHECK on `verdict`, whatever it is called. A narrower
-- CHECK left beside the new one would still refuse `entry_unverified`.
DO $drop$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
     WHERE con.conrelid = 'public.layover_certified_computations'::regclass
       AND con.contype = 'c'
       AND att.attname = 'verdict'
       AND cardinality(con.conkey) = 1
  LOOP
    EXECUTE format('ALTER TABLE public.layover_certified_computations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $drop$;

ALTER TABLE public.layover_certified_computations
  ADD CONSTRAINT layover_certified_computations_verdict_check
  CHECK (verdict IN ('yes', 'tight', 'no', 'entry_unverified', 'stay_airside'));

COMMIT;

-- Recomputed from the catalog alone: the live applier runs this block as its
-- own request, so it reads nothing the body left in the session.
DO $post$
DECLARE
  n       integer;
  def     text;
  members text[];
  v       text;
BEGIN
  IF to_regclass('public.layover_certified_computations') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3792): public.layover_certified_computations is missing';
  END IF;

  -- Exactly one single-column CHECK on verdict. A second one would be
  -- intersected with it, and the narrower would win.
  SELECT count(*) INTO n
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
   WHERE con.conrelid = 'public.layover_certified_computations'::regclass
     AND con.contype = 'c'
     AND att.attname = 'verdict'
     AND cardinality(con.conkey) = 1;
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3792): % single-column CHECK constraint(s) on layover_certified_computations.verdict, expected exactly 1', n;
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(con.oid) INTO def
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
   WHERE con.conrelid = 'public.layover_certified_computations'::regclass
     AND con.contype = 'c'
     AND att.attname = 'verdict'
     AND cardinality(con.conkey) = 1;

  -- An enumerated list and nothing else: `IN (...) OR true` would admit the five
  -- and refuse nothing.
  IF def !~ '^CHECK \(\(verdict = ANY \(ARRAY\[[^]]*\]\)\)\)$' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3792): the verdict CHECK is not a plain enumerated list: %', def;
  END IF;

  SELECT array_agg(m[1]) INTO members
    FROM regexp_matches(def, '''([a-z_]+)''::text', 'g') AS x(m);

  FOREACH v IN ARRAY ARRAY['yes', 'tight', 'no', 'entry_unverified', 'stay_airside'] LOOP
    IF members IS NULL OR NOT (v = ANY (members)) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3792): the verdict CHECK does not admit %; it admits %', v, members;
    END IF;
  END LOOP;
END $post$;
