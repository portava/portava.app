-- Rollback for 2410_layover_recommendation_identity.sql
-- Applied to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07. NOT applied to
-- production (ajrurzioarfkagpuxfnb) — an owner decision. Production was READ
-- ONLY during this work.
--
-- WHAT 2410 DID
--   1. ADD COLUMN layover_recommendations.rec_key TEXT (nullable)
--   2. CREATE UNIQUE INDEX layover_recs_session_key_uidx (session_id, rec_key)
--   3. INSERT feature_flags row 'layover_stable_recommendation_ids_enabled' = FALSE
--
-- ORDER MATTERS. Switch the flag OFF (or delete its row — an absent row reads
-- as OFF through lib/featureFlags.isFlagEnabled) BEFORE dropping the column:
-- with the flag ON, LayoverRecommendationService upserts `rec_key`, and once
-- the column is gone every regeneration logs "recommendation upsert failed"
-- and persists nothing (cards are still returned, without ids). Nothing else
-- reads rec_key. Dropping it loses only regenerable data.

BEGIN;

DELETE FROM public.feature_flags WHERE flag = 'layover_stable_recommendation_ids_enabled';

DROP INDEX IF EXISTS public.layover_recs_session_key_uidx;

ALTER TABLE public.layover_recommendations DROP COLUMN IF EXISTS rec_key;

COMMIT;

-- VERIFY (reads only)
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'layover_recommendations' AND column_name = 'rec_key';   -- expect 0 rows
-- SELECT flag, enabled FROM public.feature_flags
--  WHERE flag = 'layover_stable_recommendation_ids_enabled';                          -- expect 0 rows
