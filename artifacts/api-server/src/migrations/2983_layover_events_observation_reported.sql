-- 2983_layover_events_observation_reported.sql
--
-- ONE MORE LEGAL `layover_events.event_type`: 'airport_observation_reported'.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2983 (layover).
-- Creates no table, adds no column, seeds no flag, changes no grant or policy.
-- Widens exactly one CHECK. Moves no row.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- The §10 traveller observation surface (census-layover L82, migration 2982,
-- `POST /api/airport/sessions/:id/observations`) emits an audit row for each
-- accepted report, exactly as every other consequential layover action in
-- routes/airport.ts does.
--
-- `layover_events.event_type` is a CHECK over a closed vocabulary — 0127:198-207
-- lists eighteen values — and 'airport_observation_reported' is not one of them.
-- Without this file the insert is rejected by the constraint.
--
-- IT WOULD BE REJECTED SILENTLY, WHICH IS THE ACTUAL HAZARD. `emitEvent`
-- (services/airport/LayoverSessionService.ts) ends:
--
--   if (error) logger.warn({ err: error, sessionId, eventType }, "layover event write failed (non-fatal)");
--
-- Non-fatal is right — a lost audit row must not fail a traveller's report —
-- but it means the missing vocabulary entry produces a WARNING IN A LOG and a
-- feature that looks built and audits nothing. `check:enum-literals` does not
-- catch it either: the literal is passed as an ARGUMENT to `emitLayoverEvent`
-- rather than written into an `.insert({ event_type: … })` object, so the
-- scanner never sees it sit on the column. Verified by running that check with
-- the route in place — it reports "✓ No undeclared literals off the ratchets".
--
-- So the constraint is the only thing that would ever have said no, and it
-- would have said it into a log nobody reads. That is why this is its own file
-- with its own postcondition rather than a line inside 2982.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS REBUILDS THE LIST FROM THE CATALOG INSTEAD OF RESTATING IT
-- ══════════════════════════════════════════════════════════════════════════════
-- READ THIS BEFORE "SIMPLIFYING" THE DO BLOCK INTO A LITERAL LIST.
--
-- The obvious form — DROP the constraint and ADD it back with the eighteen
-- values plus one — is what 2741_layover_session_returning_status.sql does, and
-- copying it here would create an ORDER-DEPENDENT PAIR OF MIGRATIONS:
--
--   * 2741 is written and NOT APPLIED (absent from
--     src/lib/capability/production-applied-migrations.json). It widens this
--     same CHECK with 'safe_return_aborted', restating the eighteen values.
--   * If this file restated the eighteen plus its own and were applied FIRST,
--     2741 applied afterwards would DROP the constraint and re-add it from its
--     own hard-coded list — silently deleting 'airport_observation_reported'
--     and breaking the observation audit trail with no error anywhere, because
--     the failure surfaces only as the same swallowed warning described above.
--
-- Two migrations in the same band that each rewrite one vocabulary from a
-- hard-coded copy of it cannot both be right unless someone remembers the
-- order. So this file does not hold a copy. It reads the vocabulary that is
-- ACTUALLY on the table, adds one member, and writes the union back. Applied
-- before 2741, after 2741, or twice, the result is the same set, and neither
-- file has to know about the other.
--
-- The cost is a dynamic EXECUTE, which is why the postcondition below asserts
-- membership of BOTH the new value and a value that was there before, rather
-- than asserting a count: a rebuild that dropped everything and kept only the
-- new member would otherwise pass.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WIDENING ONLY
-- ══════════════════════════════════════════════════════════════════════════════
-- A CHECK that accepts more values cannot reject a row it used to accept, so no
-- existing row can be invalidated and no writer can break. The constraint is
-- validated against existing rows on ADD; since the set only grows, that
-- validation cannot fail.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends only on 0127 (the table and its CHECK). INDEPENDENT of 2860 and 2982
-- — deliberately, so the audit vocabulary can be in place whether or not the
-- observation store has been applied yet. Order-independent with respect to
-- 2741; see above.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
-- Re-running the same rebuild with the value removed. There is no one-line
-- reversal precisely because there is no hard-coded list to revert to, and a
-- hand-written DROP/ADD would reintroduce the order dependency this file
-- exists to remove. The honest reversal is: delete any rows carrying the value
-- (`DELETE FROM public.layover_events WHERE event_type = 'airport_observation_reported';`)
-- and then re-add the constraint from the catalog minus that member. Narrowing
-- a CHECK is validated against existing rows, so the DELETE must come first.

BEGIN;

DO $$
DECLARE
  conname_found TEXT;
  def TEXT;
  vals TEXT;
BEGIN
  -- Located by DEFINITION, not by name: 0127 declares the CHECK inline and
  -- unnamed, so its generated name differs between databases. The two LIKEs
  -- together identify it — the column it constrains, and a value only this
  -- vocabulary has.
  SELECT c.conname, pg_get_constraintdef(c.oid)
    INTO conname_found, def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'layover_events'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%event_type%'
     AND pg_get_constraintdef(c.oid) LIKE '%session_created%'
   LIMIT 1;

  IF conname_found IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2983): no event_type CHECK containing session_created found on public.layover_events. Either 0127 has not been applied, or the vocabulary has been restructured and this file must be rewritten against whatever replaced it -- it will NOT create an unconstrained column by falling through.';
  END IF;

  -- Idempotent: already widened, nothing to do. Checked against the definition
  -- rather than against a marker table so a re-run after a manual edit still
  -- reads the truth.
  IF def LIKE '%airport_observation_reported%' THEN
    RETURN;
  END IF;

  -- The existing vocabulary, read out of the rendered definition. Postgres
  -- renders this CHECK as
  --   CHECK ((event_type = ANY (ARRAY['session_created'::text, ...])))
  -- so every single-quoted lower-snake token is a member and nothing else in
  -- the definition is single-quoted (`event_type`, `ANY`, `ARRAY` and `text`
  -- are all bare).
  SELECT string_agg(quote_literal(v), ', ' ORDER BY v)
    INTO vals
    FROM (
      SELECT DISTINCT (regexp_matches(def, '''([a-z_]+)''', 'g'))[1] AS v
      UNION
      SELECT 'airport_observation_reported'
    ) s;

  IF vals IS NULL OR length(vals) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2983): extracted an EMPTY vocabulary from the existing CHECK (%). Refusing to replace a closed vocabulary with nothing.', def;
  END IF;

  EXECUTE format('ALTER TABLE public.layover_events DROP CONSTRAINT %I', conname_found);
  EXECUTE format(
    'ALTER TABLE public.layover_events ADD CONSTRAINT layover_events_event_type_check CHECK (event_type IN (%s))',
    vals
  );
END $$;

-- ── Postconditions ───────────────────────────────────────────────────────────
-- Absolute and re-runnable: catalog state only, no temp table, no before/after
-- comparison, so `certify:migrations` can re-run this block standalone.
DO $$
DECLARE
  def TEXT;
  check_count INTEGER;
BEGIN
  SELECT count(*) INTO check_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'layover_events'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%event_type%';
  IF check_count <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2983): layover_events has % CHECK constraints on event_type, expected exactly 1. Two CHECKs are ANDed, so a second one can only NARROW the vocabulary -- which is the opposite of what this file does.', check_count;
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'layover_events'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%event_type%'
   LIMIT 1;

  -- The value this file exists for.
  IF def NOT LIKE '%airport_observation_reported%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2983): airport_observation_reported is not in the event_type vocabulary (%)', def;
  END IF;

  -- AND a value that was there before. Asserted separately and deliberately: a
  -- rebuild that extracted nothing and wrote back only the new member would
  -- satisfy the check above while having destroyed the vocabulary. This is the
  -- assertion the dynamic EXECUTE above buys its flexibility with.
  IF def NOT LIKE '%session_created%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2983): session_created is GONE from the event_type vocabulary (%). The rebuild dropped the existing members instead of adding to them.', def;
  END IF;
  IF def NOT LIKE '%telegraph_suggestion_sent%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2983): telegraph_suggestion_sent is GONE from the event_type vocabulary (%). The rebuild dropped the existing members instead of adding to them.', def;
  END IF;

  -- 2741's member, IF 2741 has been applied. Conditional on purpose: this file
  -- must pass whether or not 2741 is in, and must fail loudly if it was in and
  -- this rebuild dropped it.
  IF EXISTS (
    SELECT 1 FROM public.layover_events WHERE event_type = 'safe_return_aborted'
  ) AND def NOT LIKE '%safe_return_aborted%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2983): rows carrying safe_return_aborted exist but the value is no longer in the vocabulary (%)', def;
  END IF;
END $$;

COMMIT;
