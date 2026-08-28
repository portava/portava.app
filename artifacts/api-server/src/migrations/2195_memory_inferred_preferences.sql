-- 2195_memory_inferred_preferences.sql
--
-- Memory — §5.2 semantic memory inferred from repeated behaviour.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- §5.2 defines Semantic Preference Memory as "longer-lived patterns INFERRED
-- FROM REPEATED BEHAVIOR, with confidence and evidence" — "often chooses
-- nightlife-heavy neighbourhoods", "frequently saves high-end seafood".
--
-- The projector shipped so far reads only EXPLICIT preferences
-- (compass_user_preferences.interests / travel_styles). That is a stated
-- preference, not an inferred pattern, and it carries a flat hard-coded
-- confidence of 0.90 with no evidence behind it — so §5.2's defining clause was
-- unmet even though the memory_type existed.
--
-- Portava already accumulates the behavioural signal; nothing new is collected:
--   compass_user_preferences.category_weights — observation counts per category,
--     e.g. {"food": 4, "places": 10}. This is behaviour, not a declaration.
--
-- WHAT THIS ADDS, AND THE THREE RULES IT FOLLOWS
--
--  1. INFERRED IS MARKED AS INFERRED. Explicit preferences project with
--     subject_type 'interest'; inferred ones with 'inferred_interest'. They are
--     never merged into one indistinguishable set, because §2.2's separation of
--     observation from inference applies to preferences as much as to location.
--
--  2. CONFIDENCE IS EARNED, NOT ASSUMED. Explicit stays 0.90 — the user said it.
--     Inferred scales with the observation count and is CAPPED BELOW explicit
--     (0.85), so a heavily-inferred pattern never outranks a stated one. One
--     observation yields 0.50: present, but weak.
--
--  3. THE EVIDENCE IS RECORDED. provenance carries the observation count, so
--     §16's "what supports this / how confident / when last observed" is
--     answerable for an inference, which is exactly where it matters most.
--
-- Retention is unchanged: 'derived_preference', so an inference decays and is
-- recomputed rather than hardening into a permanent trait (§18, §24).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memory_projections' AND column_name='source_event_ids') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2192/2193 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='compass_user_preferences' AND column_name='category_weights') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: compass_user_preferences.category_weights missing — it is the behavioural source.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.project_inferred_preferences(
  p_user_id      uuid,
  p_enforce_flag boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_enabled boolean; v_now timestamptz := clock_timestamp();
  v_pref_ttl interval := interval '180 days'; v_count int := 0;
  -- Below this many observations a "pattern" is noise, not a preference. §7's
  -- "distinguish impression from meaningful awareness" applies here too: acting
  -- on a single tap would manufacture a trait the user never expressed.
  v_min_observations int := 3;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag='memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN 0; END IF;
  END IF;

  WITH weights AS (
    SELECT kv.key AS category, (kv.value)::text::numeric AS observations
    FROM public.compass_user_preferences cup
    CROSS JOIN LATERAL jsonb_each(coalesce(cup.category_weights, '{}'::jsonb)) AS kv
    WHERE cup.user_id = p_user_id
      AND jsonb_typeof(kv.value) = 'number'
  ), eligible AS (
    SELECT category, observations
    FROM weights
    WHERE observations >= v_min_observations
      AND btrim(category) <> ''
  ), ins AS (
    INSERT INTO public.memory_projections
      (user_id, memory_type, subject_type, subject_id, content, confidence, provenance,
       retention_class, last_supported_at, valid_to, last_projected_at, visibility)
    SELECT p_user_id, 'semantic', 'inferred_interest', e.category,
           'Often chooses ' || e.category,
           -- capped BELOW the 0.90 explicit preferences carry: an inference never
           -- outranks a statement, however much behaviour supports it.
           least(0.85, 0.45 + 0.05 * e.observations)::real,
           jsonb_build_object(
             'derivation', 'compass_user_preferences.category_weights',
             'inferred', true,
             'support', jsonb_build_object('observations', e.observations,
                                           'min_required', v_min_observations)),
           'derived_preference', v_now, v_now + v_pref_ttl, v_now, 'private'
    FROM eligible e
    ON CONFLICT (user_id, memory_type, subject_type, subject_id) DO UPDATE SET
      content=EXCLUDED.content, confidence=EXCLUDED.confidence, provenance=EXCLUDED.provenance,
      last_supported_at=EXCLUDED.last_supported_at, valid_to=EXCLUDED.valid_to,
      last_projected_at=EXCLUDED.last_projected_at,
      state=CASE WHEN public.memory_projections.state IN ('retracted','decayed')
                 THEN 'active' ELSE public.memory_projections.state END
    RETURNING 1
  ) SELECT count(*) INTO v_count FROM ins;

  RETURN v_count;
END
$fn$;

-- Fold into the per-user pass so retraction covers inferred preferences too:
-- if the behaviour stops, the inference loses support and is retracted like any
-- other derived memory.
CREATE OR REPLACE FUNCTION public.project_user_memory_with_retraction(
  p_user_id uuid, p_enforce_flag boolean DEFAULT true
)
RETURNS TABLE (projected integer, retracted integer)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_run_started timestamptz := clock_timestamp();
  v_projected integer := 0; v_retracted integer := 0; v_enabled boolean;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag='memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN QUERY SELECT 0,0; RETURN; END IF;
  END IF;

  v_projected := public.project_user_memory(p_user_id, false)
               + public.project_inferred_preferences(p_user_id, false);

  WITH r AS (
    UPDATE public.memory_projections
    SET state = 'retracted'
    WHERE user_id = p_user_id AND state = 'active'
      AND memory_type IN ('episodic','semantic','social','place')
      AND last_projected_at < v_run_started
    RETURNING 1
  ) SELECT count(*)::int INTO v_retracted FROM r;

  RETURN QUERY SELECT v_projected, v_retracted;
END
$fn$;

REVOKE ALL ON FUNCTION public.project_inferred_preferences(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_user_memory_with_retraction(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_inferred_preferences(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_user_memory_with_retraction(uuid, boolean) TO service_role;

COMMENT ON FUNCTION public.project_inferred_preferences(uuid, boolean) IS
  '§5.2: semantic memory inferred from repeated behaviour (compass_user_preferences.category_weights), with confidence earned from the observation count and the count recorded as evidence. Marked subject_type=inferred_interest so an inference is never indistinguishable from a stated preference, and capped below the explicit 0.90 so it never outranks one.';

DO $$
BEGIN
  IF to_regprocedure('public.project_inferred_preferences(uuid, boolean)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: project_inferred_preferences missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'memory\_%' OR p.proname LIKE 'project\_%')
      AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a memory/projector function is anon/authenticated executable';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.project_inferred_preferences(uuid, boolean);
--   (and re-apply 2190's project_user_memory_with_retraction body)
