-- 2985_layover_events_crew_vocabulary.sql
--
-- THREE MORE LEGAL `layover_events.event_type`: 'crew_created', 'crew_joined',
-- 'crew_left'.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2985 (layover).
-- Creates no table, adds no column, seeds no flag, changes no grant or policy.
-- Widens exactly one CHECK. Moves no row.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- §14 Layover Crew (migration 2984, `POST /api/airport/sessions/:id/crew`,
-- `…/crew/:crewId/join`, `…/crew/leave`) emits an audit row for each of the
-- three consequential crew actions, as every other consequential layover action
-- in routes/airport.ts does.
--
-- `layover_events.event_type` is a CHECK over a closed vocabulary (0127:198-207)
-- and none of the three is in it, so without this file each insert is rejected
-- by the constraint.
--
-- AND REJECTED SILENTLY, which is the hazard rather than the inconvenience.
-- `emitEvent` (services/airport/LayoverSessionService.ts) ends:
--
--   if (error) logger.warn({ err: error, sessionId, eventType }, "layover event write failed (non-fatal)");
--
-- Non-fatal is correct — a lost audit row must not fail a traveller's join —
-- but it means a missing vocabulary entry produces a warning in a log and a
-- feature that looks built and audits nothing. `check:enum-literals` cannot see
-- it either: the literal is an ARGUMENT to `emitLayoverEvent`, not a key in an
-- `.insert({ event_type: … })` object, so the scanner never sees it sit on the
-- column. This is the same finding migration 2983's header records.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS REBUILDS THE LIST FROM THE CATALOG INSTEAD OF RESTATING IT
-- ══════════════════════════════════════════════════════════════════════════════
-- READ THIS BEFORE "SIMPLIFYING" THE DO BLOCK INTO A LITERAL LIST.
--
-- The obvious form — DROP and re-ADD with the eighteen 0127 values plus the new
-- ones — is what 2741_layover_session_returning_status.sql does, and by now
-- FOUR files in this repository want to widen this one CHECK:
--
--   0127  declares it with eighteen values
--   2741  written, NOT applied — adds 'safe_return_aborted'
--   2983  adds 'airport_observation_reported'
--   2985  this file — adds the three crew values
--
-- Any two of those that each restate a hard-coded copy of the vocabulary are
-- order-dependent: whichever applies LAST silently deletes the others' values,
-- and the deletion surfaces only as the swallowed warning described above.
--
-- So this file holds no copy. It reads the vocabulary that is ACTUALLY on the
-- table, adds its three members, and writes the union back. Applied before
-- 2741, after it, before or after 2983, or twice, the result is the same set,
-- and no file has to know about any other.
--
-- The cost is a dynamic EXECUTE, which is why the postcondition asserts
-- membership of both the NEW values and values that were there BEFORE: a
-- rebuild that dropped everything and kept only the new members would otherwise
-- pass.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WIDENING ONLY
-- ══════════════════════════════════════════════════════════════════════════════
-- A CHECK that accepts more values cannot reject a row it used to accept, so no
-- existing row is invalidated and no writer breaks. The constraint is validated
-- against existing rows on ADD; since the set only grows, that cannot fail.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends only on 0127. Order-independent with respect to 2741 and 2983 — see
-- above. It does NOT depend on 2984 even though it exists for 2984's routes:
-- the vocabulary can be in place before the crew tables are, and a migration
-- that made an audit vocabulary wait on a feature's storage would be one more
-- ordering constraint for nothing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
-- Re-running the same rebuild with the three values removed. There is no
-- one-line reversal precisely because there is no hard-coded list to revert to,
-- and a hand-written DROP/ADD would reintroduce the ordering hazard this file
-- exists to remove. The honest reversal is:
--   DELETE FROM public.layover_events
--    WHERE event_type IN ('crew_created','crew_joined','crew_left');
-- and then re-add the constraint from the catalog minus those members.
-- Narrowing a CHECK is validated against existing rows, so the DELETE is first.

BEGIN;

DO $$
DECLARE
  conname_found TEXT;
  def TEXT;
  vals TEXT;
BEGIN
  -- Located by DEFINITION, not by name: 0127 declares the CHECK inline and
  -- unnamed, so its generated name differs between databases.
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
    RAISE EXCEPTION 'PRECONDITION FAILED (2985): no event_type CHECK containing session_created found on public.layover_events. Either 0127 has not been applied, or the vocabulary has been restructured and this file must be rewritten against whatever replaced it -- it will NOT create an unconstrained column by falling through.';
  END IF;

  -- Idempotent. All three or none: a partial state would mean an earlier run
  -- half-applied, which is not something this file can produce, so if it is
  -- ever seen the right answer is to rebuild the union rather than return.
  IF def LIKE '%crew_created%' AND def LIKE '%crew_joined%' AND def LIKE '%crew_left%' THEN
    RETURN;
  END IF;

  -- Postgres renders this CHECK as
  --   CHECK ((event_type = ANY (ARRAY['session_created'::text, ...])))
  -- so every single-quoted lower-snake token is a member and nothing else in
  -- the definition is single-quoted.
  SELECT string_agg(quote_literal(v), ', ' ORDER BY v)
    INTO vals
    FROM (
      SELECT DISTINCT (regexp_matches(def, '''([a-z_]+)''', 'g'))[1] AS v
      UNION SELECT 'crew_created'
      UNION SELECT 'crew_joined'
      UNION SELECT 'crew_left'
    ) s;

  IF vals IS NULL OR length(vals) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2985): extracted an EMPTY vocabulary from the existing CHECK (%). Refusing to replace a closed vocabulary with nothing.', def;
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
  v TEXT;
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
    RAISE EXCEPTION 'POSTCONDITION FAILED (2985): layover_events has % CHECK constraints on event_type, expected exactly 1. Two CHECKs are ANDed, so a second one can only NARROW the vocabulary.', check_count;
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

  -- The three values this file exists for.
  FOREACH v IN ARRAY ARRAY['crew_created','crew_joined','crew_left'] LOOP
    IF def NOT LIKE '%' || v || '%' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2985): % is not in the event_type vocabulary (%)', v, def;
    END IF;
  END LOOP;

  -- AND values that were there before. Asserted separately and deliberately: a
  -- rebuild that extracted nothing and wrote back only the new members would
  -- satisfy the loop above while having destroyed the vocabulary.
  FOREACH v IN ARRAY ARRAY['session_created','telegraph_suggestion_sent','plan_stop_added'] LOOP
    IF def NOT LIKE '%' || v || '%' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2985): % is GONE from the event_type vocabulary (%). The rebuild dropped the existing members instead of adding to them.', v, def;
    END IF;
  END LOOP;

  -- Other files' members, IF rows carrying them exist. Conditional on purpose:
  -- this file must pass whether or not 2741 and 2983 are in, and must fail
  -- loudly if one was in and this rebuild dropped its value.
  FOREACH v IN ARRAY ARRAY['safe_return_aborted','airport_observation_reported'] LOOP
    IF EXISTS (SELECT 1 FROM public.layover_events WHERE event_type = v)
       AND def NOT LIKE '%' || v || '%' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2985): rows carrying % exist but the value is no longer in the vocabulary (%)', v, def;
    END IF;
  END LOOP;
END $$;

COMMIT;
