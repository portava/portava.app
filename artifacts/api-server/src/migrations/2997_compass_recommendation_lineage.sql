-- 2997_compass_recommendation_lineage.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band), compass lane.
--
-- ═══════════════════════════════════════
-- WHAT THIS IS FOR
-- ═══════════════════════════════════════
-- docs/specs/Portava_Compass_Architecture_Upgrade_v2.md:33 (CPV2-11):
-- "Revocation follows lineage." census-compass graded it N: the outcome chain
-- (20260729_compass_outcome_learning) declared `recommendation_id text NOT
-- NULL` with NO foreign key to compass_served_recommendations, the served row
-- had no revocation state, and the ranking nudge each outcome applied
-- (CompassOutcomeEngine.applyRankingNudge, ±1 into
-- compass_user_preferences.category_weights) kept no per-outcome provenance —
-- so there was no lineage to follow and nothing to reverse along it.
--
-- This file states the lineage in the schema:
--   1. the FK  compass_outcome_events.recommendation_id →
--              compass_served_recommendations.recommendation_id ON DELETE CASCADE
--      (the target is already UNIQUE, 0055; production and CI both carry ZERO
--      orphans, measured 2026-09-20, so it is added NOT VALID then VALIDATED);
--   2. revocation state on the served row: revoked_at, revocation_reason;
--   3. per-outcome provenance of the ranking nudge: weight_nudge — the signed
--      step this outcome applied, so a revocation reverses exactly what it did.
--
-- ═══════════════════════════════════════
-- WHAT IT DOES NOT DO
-- ═══════════════════════════════════════
-- It changes no existing row, revokes nothing, and reverses no weight. Every
-- statement is idempotent. The service names the three new columns only when
-- lib/capability's probe finds them (COMPASS_CONVERSATION_PHASE1 now provides
-- 2996 AND 2997 to production), so a build carrying this file runs unchanged
-- against a database that has not applied it.

BEGIN;

ALTER TABLE public.compass_served_recommendations
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NULL;
ALTER TABLE public.compass_served_recommendations
  ADD COLUMN IF NOT EXISTS revocation_reason TEXT NULL;
ALTER TABLE public.compass_served_recommendations
  DROP CONSTRAINT IF EXISTS compass_served_recommendations_revocation_reason_check;
ALTER TABLE public.compass_served_recommendations
  ADD CONSTRAINT compass_served_recommendations_revocation_reason_check
  CHECK (revocation_reason IS NULL OR revocation_reason IN ('user_withdrawn', 'consent_withdrawn', 'place_unavailable', 'operator'));

ALTER TABLE public.compass_outcome_events
  ADD COLUMN IF NOT EXISTS weight_nudge NUMERIC NULL;

DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compass_outcome_events_recommendation_id_fkey') THEN
    ALTER TABLE public.compass_outcome_events
      ADD CONSTRAINT compass_outcome_events_recommendation_id_fkey
      FOREIGN KEY (recommendation_id) REFERENCES public.compass_served_recommendations(recommendation_id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $fk$;
ALTER TABLE public.compass_outcome_events VALIDATE CONSTRAINT compass_outcome_events_recommendation_id_fkey;

COMMENT ON COLUMN public.compass_served_recommendations.revoked_at IS
  'CPV2-11: when this recommendation was revoked; its outcomes are removed and their nudges reversed along the lineage.';
COMMENT ON COLUMN public.compass_outcome_events.weight_nudge IS
  'CPV2-11: the signed category-weight step this outcome applied (null: none), so a revocation can reverse exactly it.';

-- ── Postconditions: the end state, not the path ──────────────────────────────
DO $post$
DECLARE n int; def text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'compass_served_recommendations'
     AND column_name IN ('revoked_at', 'revocation_reason');
  IF n <> 2 THEN RAISE EXCEPTION '2997: revocation columns missing (found %)', n; END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'compass_outcome_events' AND column_name = 'weight_nudge';
  IF n <> 1 THEN RAISE EXCEPTION '2997: weight_nudge missing'; END IF;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'compass_outcome_events_recommendation_id_fkey';
  IF def IS NULL OR position('ON DELETE CASCADE' IN def) = 0 THEN
    RAISE EXCEPTION '2997: lineage FK absent or not cascading (%)', coalesce(def, 'absent');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compass_outcome_events_recommendation_id_fkey' AND NOT convalidated) THEN
    RAISE EXCEPTION '2997: lineage FK not validated';
  END IF;
END $post$;

COMMIT;
