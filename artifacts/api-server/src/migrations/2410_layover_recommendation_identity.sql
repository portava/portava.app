-- 2410_layover_recommendation_identity.sql
--
-- A recommendation card gets an identity that survives regeneration.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2410.
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
-- ON CONFLICT DO NOTHING). Drops nothing, rewrites no row, flips no flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT, MEASURED ON THE LIVE PATH
-- ══════════════════════════════════════════════════════════════════════════════
-- `GET /api/airport/sessions/:id/recommendations` regenerates the card set on
-- every call while `layover_safety_engine_enabled` is TRUE (it is, in
-- production). Regeneration was DELETE every row for the session, INSERT fresh
-- rows (LayoverRecommendationService.generateRecommendations). Two consequences:
--
--   1. The inserted rows' ids were never read back, so every card the client
--      received carried NO id. The client renders its "Add to plan" control
--      only when `rec.id` is present (LayoverRecsSection.tsx). Production has
--      0 rows in layover_plan_stops — the control has never rendered.
--   2. `layover_plan_stops.recommendation_id` REFERENCES layover_recommendations
--      ON DELETE SET NULL, so even a stop that did reach the table lost its
--      link on the next dashboard load, and the "already in your plan" guard
--      (which compares recommendation ids) went blind.
--
-- The fix is to give a card a key that is stable across generations and to
-- upsert on it instead of deleting. That needs a unique target, which is what
-- this migration adds. The service path that USES it is behind
-- `layover_stable_recommendation_ids_enabled`, seeded FALSE here: until an owner flips
-- it, the legacy delete+insert path runs exactly as before and nothing a
-- traveller sees changes.
--
-- The unique index is NOT partial. PostgREST's `on_conflict=` cannot express a
-- partial-index predicate, so a partial index would make the upsert fail with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
-- NULLs are distinct in a unique index, so legacy rows (rec_key NULL) never
-- collide with each other or with keyed rows.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.layover_recommendations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.layover_recommendations missing -- apply 0127 first.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags missing.';
  END IF;
END $$;

-- ── SECTION 1: stable identity column + unique target ────────────────────────
ALTER TABLE public.layover_recommendations
  ADD COLUMN IF NOT EXISTS rec_key TEXT;

COMMENT ON COLUMN public.layover_recommendations.rec_key IS
  'Stable identity of the card within its session (LayoverRecommendationService.recommendationKey). NULL on rows written by the legacy delete+insert path.';

CREATE UNIQUE INDEX IF NOT EXISTS layover_recs_session_key_uidx
  ON public.layover_recommendations (session_id, rec_key);

-- ── SECTION 2: the capability flag, seeded OFF ───────────────────────────────
-- DO NOTHING, not DO UPDATE: a re-run must never overturn an owner's flip.
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_stable_recommendation_ids_enabled',
    FALSE,
    'CAPABILITY. Layover: regenerate recommendation cards by upsert on (session_id, rec_key) so ids survive regeneration and are returned to the client (which renders "Add to plan" only for cards with an id). OFF = legacy delete+insert, cards returned without ids. Requires 2410. SEEDED FALSE.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── POSTCONDITIONS ───────────────────────────────────────────────────────────
DO $$
DECLARE
  idx_unique BOOLEAN;
  flag_present INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'layover_recommendations' AND column_name = 'rec_key'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_recommendations.rec_key missing';
  END IF;

  SELECT i.indisunique INTO idx_unique
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relname = 'layover_recs_session_key_uidx';
  IF idx_unique IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_recs_session_key_uidx missing or not UNIQUE';
  END IF;
  -- Must be a full index: a partial one cannot serve PostgREST on_conflict.
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'layover_recs_session_key_uidx' AND i.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_recs_session_key_uidx is partial -- the upsert target would be unusable';
  END IF;

  SELECT count(*) INTO flag_present FROM public.feature_flags
    WHERE flag = 'layover_stable_recommendation_ids_enabled';
  IF flag_present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_stable_recommendation_ids_enabled flag row missing';
  END IF;
  -- Not asserted: enabled = FALSE. The seed is FALSE; a later owner flip is an
  -- owner decision this migration must survive being re-run over.
END $$;

COMMIT;
