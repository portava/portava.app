-- 2197_memory_reset_category_scope.sql
--
-- Memory — a CATEGORY reset must not delete the whole ledger.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- THE DEFECT
-- ----------
-- 2194's memory_reset_for_user(p_user_id, p_memory_types) implements §17
-- "reset personalization OR SELECTED CATEGORIES". The projection delete honours
-- the category filter:
--
--     DELETE FROM memory_projections
--      WHERE user_id = p_user_id
--        AND (p_memory_types IS NULL OR memory_type = ANY (p_memory_types))
--
-- The event delete does not:
--
--     DELETE FROM memory_events
--      WHERE user_id = p_user_id
--        AND (p_memory_types IS NULL OR subject_type = ANY (p_memory_types) OR true)
--                                                                        ^^^^^^^^^
-- `OR true` makes the whole predicate unconditionally true, so EVERY event for
-- the user is deleted no matter which categories were asked for. A user who
-- resets only their social memory loses their entire L2 ledger — visits, saves,
-- follows, all of it.
--
-- WHY THE `OR true` WAS THERE (and why removing it alone would be wrong)
-- ---------------------------------------------------------------------
-- The two columns speak DIFFERENT VOCABULARIES:
--
--     memory_projections.memory_type  ∈ episodic | semantic | social | place | intent
--     memory_events.subject_type      ∈ city | user | place | interest | ...
--
-- So `subject_type = ANY (p_memory_types)` can only ever match by coincidence —
-- 'place' is the single value the two vocabularies share. Someone noticed the
-- filter did not work and disabled it with `OR true` instead of fixing it, which
-- converted a broken filter into silent over-deletion. Simply deleting the
-- `OR true` would swing it the other way: a category reset would then delete
-- almost NO events, because the comparison still cannot match.
--
-- THE FIX: translate between the vocabularies explicitly.
--     episodic -> city        (project_user_memory writes 'visited' city events)
--     place    -> place       (saved_place events)
--     social   -> user        (followed events)
--     semantic -> (none)      derived from compass_user_preferences, not events
--     intent   -> (none)      record_intent_memory writes no ledger row
--
-- A full reset (p_memory_types IS NULL) still clears every event, which is what
-- "reset personalization" means. A category reset now clears exactly the events
-- that support the categories named, and nothing else.
--
-- Found 2026-08-28 while replaying the memory migrations onto production: the
-- CI database carried a hand-simplified body without the dead clause, so the
-- committed file and the live CI schema had quietly diverged. This migration
-- makes the FILE the source of truth again, and makes the behaviour correct on
-- both databases.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.memory_reset_for_user(uuid, text[])') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2194 first.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.memory_reset_for_user(
  p_user_id      uuid,
  p_memory_types text[] DEFAULT NULL
)
RETURNS TABLE (projections_cleared integer, events_cleared integer, feedback_kept integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  p_del int := 0;
  e_del int := 0;
  f_kept int := 0;
  v_subject_types text[];
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT 0,0,0; RETURN;
  END IF;

  -- Translate requested memory categories into the ledger's subject vocabulary.
  -- NULL stays NULL and means "everything".
  IF p_memory_types IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT s), '{}'::text[]) INTO v_subject_types
    FROM unnest(p_memory_types) AS t(mt)
    CROSS JOIN LATERAL (
      SELECT CASE t.mt
               WHEN 'episodic' THEN 'city'
               WHEN 'place'    THEN 'place'
               WHEN 'social'   THEN 'user'
               ELSE NULL           -- semantic/intent have no ledger events
             END
    ) AS m(s)
    WHERE s IS NOT NULL;
  END IF;

  WITH d AS (
    DELETE FROM public.memory_projections
    WHERE user_id = p_user_id
      AND (p_memory_types IS NULL OR memory_type = ANY (p_memory_types))
    RETURNING 1
  ) SELECT count(*)::int INTO p_del FROM d;

  WITH d AS (
    DELETE FROM public.memory_events
    WHERE user_id = p_user_id
      AND (p_memory_types IS NULL OR subject_type = ANY (v_subject_types))
    RETURNING 1
  ) SELECT count(*)::int INTO e_del FROM d;

  -- Deliberately NOT deleted (2194): a reset is not a withdrawal of a previous
  -- forget. Clearing suppressions here would resurrect, on the next projector
  -- pass, exactly the memory the user asked us to forget.
  SELECT count(*)::int INTO f_kept FROM public.memory_feedback WHERE user_id = p_user_id;

  RETURN QUERY SELECT p_del, e_del, f_kept;
END
$fn$;

REVOKE ALL ON FUNCTION public.memory_reset_for_user(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_reset_for_user(uuid, text[]) TO service_role;

COMMENT ON FUNCTION public.memory_reset_for_user(uuid, text[]) IS
  '§17 "reset personalization or selected categories". A full reset (p_memory_types NULL) clears all projections and all ledger events. A CATEGORY reset clears only the projections of those categories and only the ledger events that support them, translating memory_type (episodic/semantic/social/place/intent) into memory_events.subject_type (city/place/user) — the two columns use different vocabularies, and comparing them directly never matches. memory_feedback is always KEPT: a reset is not a withdrawal of a previous forget.';

DO $$
DECLARE v_src text;
BEGIN
  v_src := (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname='public' AND p.proname='memory_reset_for_user');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_reset_for_user missing';
  END IF;
  -- The dead clause must be gone. `OR true` in a delete predicate is not a
  -- style issue: it silently widens a scoped delete to everything.
  IF v_src ~* 'OR\s+true' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_reset_for_user still contains an unconditional OR true in a DELETE predicate';
  END IF;
  IF v_src NOT LIKE '%v_subject_types%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_reset_for_user does not translate memory_type -> subject_type';
  END IF;
  IF has_function_privilege('anon','public.memory_reset_for_user(uuid, text[])','EXECUTE')
     OR has_function_privilege('authenticated','public.memory_reset_for_user(uuid, text[])','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_reset_for_user reachable by anon/authenticated';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   Re-apply 2194's memory_reset_for_user body (which deletes ALL events for the
--   user regardless of p_memory_types). Note that doing so restores the
--   over-deletion defect described above.
