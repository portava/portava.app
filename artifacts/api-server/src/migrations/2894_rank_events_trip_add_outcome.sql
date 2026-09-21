-- 2894_rank_events_trip_add_outcome.sql
--
-- ONE MISSING TOKEN, TWO BLOCKED CENSUS ROWS
-- ==========================================
--
-- WHAT WAS BROKEN
-- ---------------
-- Two rows of census-discovery are stuck on the SAME absence, and neither says
-- so, because each describes it in its own vocabulary:
--
--   DV-79  Phase 9 shadow comparison, 5 of 6 axes. The sixth is ESTIMATED
--          TRAVEL INTENT, and its evidence says it "needs a per-item trip-add /
--          itinerary-add signal".
--
--   DC-09  `04` §8's four behaviour chains, eleven of fourteen steps
--          unrepresentable. The FIRST of the eleven is `trip_add`, in
--          `impression → place_open → save → trip_add`.
--
-- Both need one thing: a way to record that a traveller put a served item into a
-- trip. `rank_events.outcome` is where every other Discovery behaviour token
-- lives, and its CHECK vocabulary is
--
--     impression, tap, save, join, rsvp, attended, analytics   (0153 / 0197)
--     dismiss                                                  (2297)
--
-- There is NO trip-add token. A previous pass considered borrowing `join` and
-- REFUSED, and that refusal was right: `join` is the events/plans rung — it
-- means "joined somebody's plan" — and a place added to an itinerary has joined
-- nothing. Borrowing it would have manufactured the step rather than measured
-- it, and would have made every existing `join` row unreadable at the same time.
-- This file does not undo that refusal; it removes the reason for it.
--
-- WHY THE OUTCOME VOCABULARY AND NOT A RECOMMENDATION OBJECT
-- ---------------------------------------------------------
-- DV-79's evidence points at DV-40 ("needs DV-40's recommendation object"), and
-- DV-40 records that `recommendations` / `recommendation_items` have no CREATE
-- TABLE anywhere in the tree. That route is closed: there is no table to hang a
-- per-item intent signal on, and inventing one would be the parallel behaviour
-- store `04` §2 forbids ("Do not create a new parallel behavior store before
-- fixing `rank_events`"). The open route is the one 2297 already walked for the
-- negative signal — extend the vocabulary of the store that exists.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Exactly one thing: it admits 'trip_add' to `rank_events.outcome`. No column,
-- no table, no function, no grant, no flag, no backfill.
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- --------------------------------
--   * It does not backfill. There is no existing row that "was really a trip
--     add" — a trip add has never been recordable, so there is nothing to
--     reclassify, and any UPDATE here would be a fabrication with a migration's
--     authority behind it. Postcondition 3d asserts zero 'trip_add' rows exist
--     when this file finishes, which is the strongest available statement that
--     it wrote nothing.
--   * It does not flip a flag. It seeds no `feature_flags` row and reads none.
--   * It has NO RUNTIME EFFECT. Widening a CHECK changes the behaviour of
--     exactly one thing: a write that would previously have been rejected 23514.
--     Nothing in this repository issues that write today — see the WRITER note
--     below — so the observable behaviour of every existing path, on every
--     database, is byte-identical before and after.
--
-- THE WRITER DOES NOT EXIST YET, AND THAT IS STATED RATHER THAN HIDDEN
-- -------------------------------------------------------------------
-- The production trip-add site for a Discovery place is
-- `POST /api/places/:placeId/add-to-trip-plan` in `src/routes/plan.ts`, which
-- inserts a `trip_plan_items` row (or issues the ADD_PLAN Trip Command) and
-- reports NO rank-events outcome. Adding that report is a one-call change in a
-- file this lane does not own, so it is NOT in this change. Until it lands:
--
--     every read of outcome='trip_add' returns zero rows, in every environment.
--
-- That is a corpus of zero from a read that RAN — which is a different fact from
-- a read that failed, and `lib/discoveryShadow.ts` / `lib/discoveryDivergenceReport.ts`
-- keep the two apart and label which one production is showing. A signal with no
-- writer is honest only when it is labelled as having none.
--
-- WHERE IT SITS ON THE FUNNEL LADDER (`src/routes/rankEvents.ts`)
-- --------------------------------------------------------------
-- `rank_events` is a MUTABLE-STATE table: an outcome UPDATEs the impression row
-- in place, and `upgradableOutcomesFor` admits only a strictly LOWER rung, so
-- one (user, item, surface) row holds the furthest rung reached. The rungs were
--
--     impression 0 · tap 1 · save/join/rsvp 2 · attended 3
--
-- and are now
--
--     impression 0 · tap 1 · save/join/rsvp 2 · trip_add 3 · attended 4
--
--   ABOVE save, because `04` §8's chain is `… → save → trip_add`. At rung 2 a
--   trip add arriving after a save would find no upgradable row and 404, so the
--   one transition the chain exists to measure would be the one it loses.
--
--   BELOW attended, because `attended` is "I went" and a trip add is "I plan
--   to". A planning signal that could overwrite a confirmed visit would destroy
--   the strongest fact the funnel carries.
--
--   NOT COMPARABLE TO join / rsvp, and therefore narrowed by hand: `trip_add`'s
--   upgradable set is (impression, tap, save) only. A `join` or an `rsvp` is a
--   commitment made TO SOMEBODY ELSE — a host expecting you — and a trip add
--   does not subsume it. `attended` may overwrite an `rsvp` because attending
--   contains it; adding the same event to your own itinerary does not. The
--   refusal is symmetric: a later join/rsvp cannot overwrite a trip_add either.
--
-- ADDITIVE AND IDEMPOTENT
-- -----------------------
--   * The CHECK is widened, never narrowed: every value the post-2297 constraint
--     permitted is still permitted, named individually below and asserted
--     individually in the postconditions, so a partial or mis-edited apply that
--     dropped one cannot commit.
--   * DROP CONSTRAINT IF EXISTS … ADD CONSTRAINT — re-running the file is a
--     no-op that leaves the same constraint definition behind.
--   * No data is written; no privilege is changed; no function is created.
--
-- PRECONDITION: THIS FILE EXTENDS A VOCABULARY, IT DOES NOT DELIVER ONE
-- --------------------------------------------------------------------
-- The ADD below names the full list, so applying it to a database that has not
-- had 2297 would SILENTLY ADD 'dismiss' as a side effect of adding 'trip_add' —
-- 2297's constraint change without 2297's writer, its grants or its function.
-- The precondition refuses that: it requires the post-2297 EIGHT to be present
-- and names 2297 if they are not.
--
-- As of the 2026-09-14 production deployment record, production carries the
-- post-0197 SEVEN (2297 is not applied there) and `portava-ci` carries the
-- post-2297 eight. So on production this file is EXPECTED to refuse until 2297
-- lands, and that refusal is the file working, not the file failing.
--
-- TRANSACTION
-- -----------
-- Required, same reasoning as 0199/0202/2297: ALTER TABLE … ADD CONSTRAINT
-- revalidates every existing row, and without the transaction a failed ADD after
-- a committed DROP would leave `rank_events` with NO outcome constraint at all —
-- every value storable, on the one table the Discovery funnel is made of. The
-- widened list is a strict superset of the old one, so the ADD cannot fail on an
-- existing row; the transaction is the backstop, not the plan.
--
-- ROLLBACK (returns to the post-2297 eight):
--   BEGIN;
--   DELETE FROM rank_events WHERE outcome = 'trip_add';   -- see note below
--   ALTER TABLE rank_events DROP CONSTRAINT IF EXISTS rank_events_outcome_check;
--   ALTER TABLE rank_events ADD CONSTRAINT rank_events_outcome_check
--     CHECK (outcome IN ('impression','tap','save','join','rsvp','attended','analytics','dismiss'));
--   COMMIT;
-- The DELETE is destructive and is NOT optional: the narrowing ADD fails if any
-- trip_add row has landed. Until the writer described above exists the DELETE
-- matches zero rows and the rollback is free; after it exists, reversing this
-- file means discarding recorded travel intent, and whoever runs it should say
-- so out loud first.

BEGIN;

-- ── 1. Precondition ───────────────────────────────────────────────────────────

DO $pre$
DECLARE
  v_def   TEXT;
  v_label TEXT;
BEGIN
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2894): public.rank_events does not exist. Apply 0153_add_rank_events.sql first.';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'rank_events'
     AND c.conname = 'rank_events_outcome_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2894): rank_events_outcome_check is absent. This file EXTENDS an outcome vocabulary it expects to find; it must not be used to create one. Apply 0153/0197 first.';
  END IF;

  -- Every value of the post-2297 EIGHT, named one at a time. A database missing
  -- any of them is not the database this file was written against, and the ADD
  -- below would quietly hand it a vocabulary change it never reviewed.
  FOREACH v_label IN ARRAY ARRAY[
    'impression','tap','save','join','rsvp','attended','analytics','dismiss'
  ] LOOP
    IF v_def NOT LIKE '%' || v_label || '%' THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (2894): rank_events_outcome_check does not permit %, so this database is not on the post-2297 eight. Apply 2297_rank_events_dismiss_outcome.sql first — 2894 extends that vocabulary and must not be used to deliver it. Current definition: %', v_label, v_def;
    END IF;
  END LOOP;
END $pre$;

-- ── 2. Outcome vocabulary: admit 'trip_add' ───────────────────────────────────
--
-- LINEAGE OF THIS CONSTRAINT
--   0153  created it inline and unnamed; Postgres named it
--         rank_events_outcome_check.
--         Values: ('impression','tap','save','join','rsvp','attended')
--   0197  widened to add the server-side 'analytics' sentinel
--   2297  added 'dismiss', the one negative outcome
--   2894  (this file) adds 'trip_add'. No value is removed.

ALTER TABLE rank_events
  DROP CONSTRAINT IF EXISTS rank_events_outcome_check;

ALTER TABLE rank_events
  ADD CONSTRAINT rank_events_outcome_check
    CHECK (outcome IN (
      'impression','tap','save','join','rsvp','attended','analytics',
      'dismiss',
      'trip_add'
    ));

-- ── 3. Postconditions ─────────────────────────────────────────────────────────
--
-- Each one is a REAL question with a reachable answer, and each is written to
-- catch a PARTIAL apply — a file that was edited, truncated or run statement by
-- statement — rather than only to restate what the ADD above says.

DO $post$
DECLARE
  v_def       TEXT;
  v_label     TEXT;
  v_count     INTEGER;
  v_valid     BOOLEAN;
  v_trip_rows BIGINT;
BEGIN
  -- 3a. Exactly ONE constraint of this name on this table, and it is a CHECK.
  --     Two would mean the DROP did not take and the two definitions would be
  --     ANDed — the narrower one silently winning.
  SELECT count(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'rank_events'
     AND c.conname = 'rank_events_outcome_check'
     AND c.contype = 'c';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2894): expected exactly 1 CHECK named rank_events_outcome_check, found %. A DROP that did not take leaves two definitions ANDed together.', v_count;
  END IF;

  SELECT pg_get_constraintdef(c.oid), c.convalidated INTO v_def, v_valid
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'rank_events'
     AND c.conname = 'rank_events_outcome_check';

  -- 3b. It is VALIDATED. A NOT VALID constraint admits every existing row
  --     without checking it, so the vocabulary would be enforced on new rows
  --     only and the file would have half-applied while looking complete.
  IF NOT v_valid THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2894): rank_events_outcome_check is NOT VALID — existing rows were never revalidated.';
  END IF;

  -- 3c. It admits 'trip_add' AND still admits every one of the post-2297 eight,
  --     each named individually so a list that lost a value cannot pass by
  --     having gained one.
  IF v_def NOT LIKE '%trip_add%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2894): outcome CHECK does not admit trip_add: %', v_def;
  END IF;

  FOREACH v_label IN ARRAY ARRAY[
    'impression','tap','save','join','rsvp','attended','analytics','dismiss'
  ] LOOP
    IF v_def NOT LIKE '%' || v_label || '%' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2894): outcome CHECK lost the prior value %. Definition: %', v_label, v_def;
    END IF;
  END LOOP;

  -- 3d. NOTHING WAS WRITTEN. This file backfills nothing, and a trip_add row
  --     could not have existed before the ADD above (the old CHECK rejected it),
  --     so any row here is evidence that this file was edited to write data.
  SELECT count(*) INTO v_trip_rows FROM rank_events WHERE outcome = 'trip_add';
  IF v_trip_rows <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2894): % rank_events row(s) carry outcome=''trip_add''. This migration backfills nothing; those rows were not here before it ran.', v_trip_rows;
  END IF;

  -- 3e. THE NEIGHBOURING VOCABULARY IS UNTOUCHED. This file names one constraint
  --     on a table that carries several; a mis-edited DROP takes the wrong one
  --     and the failure is silent until a writer is rejected 23514 in
  --     production. rank_events_surface_check must still exist and must still
  --     permit 'discovery' — the surface this whole change is about.
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'rank_events'
     AND c.conname = 'rank_events_surface_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2894): rank_events_surface_check is ABSENT. This file must not touch it; every surface would now be storable.';
  END IF;
  IF v_def NOT LIKE '%discovery%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2894): rank_events_surface_check no longer permits ''discovery'': %', v_def;
  END IF;
END $post$;

COMMIT;
