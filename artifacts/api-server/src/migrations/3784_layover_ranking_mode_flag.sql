-- 3784_layover_ranking_mode_flag.sql
-- census-layover L242 (spec §21: "Shadow mode in real environments before
-- high-confidence rollout") and L78 (spec §9.1: the candidate-ranking objective).
-- B58 lane LAY-4, layover band 3784-3799 (PLAN-layover: 3784 = LAY-4).
-- APPLIED TO NO DATABASE by the lane that wrote it.
--
-- Additive + idempotent. ONE INSERT: a feature_flags row with ON CONFLICT DO
-- NOTHING, so an operator's later setting is never overwritten. No schema object
-- is created or changed; no table, column, policy or grant is touched.
--
-- `layover_ranking_mode` — lib/layoverRolloutMode.ts (the resolver) and
--   services/airport/layoverRankingMode.ts (its one consumer). ONE row, ruling
--   D2=A's shape (lib/discoveryEngineMode.ts, 2091): `enabled` is the master,
--   `metadata.mode` selects legacy | shadow | on, and `metadata.cohort` says WHO
--   a non-legacy mode applies to (lib/discoveryCohort.ts; absent = nobody).
--     legacy  generateRecommendations serves rankActivities' order, byte for byte.
--     shadow  the spec §9.1 objective (services/airport/layoverObjective.ts)
--             orders the same cards BESIDE the live order; the two are compared
--             and counted (`layover_ranking_divergence` log line, a counts-only
--             `ranking` tally in the recommendation_generated event, reported by
--             GET /api/admin/layover/metrics). Nothing it produced is served.
--     on      the objective's order is served — the same cards, the same
--             ratings, re-ordered only WITHIN a safety rating.
--   Every failure (no row, enabled = false, no mode, an unknown mode, an
--   unreadable row, an unusable cohort) resolves to legacy.
--
-- BOTH `enabled = false` AND `mode = 'legacy'` are seeded, redundant on purpose
-- (2091's reason): either alone yields legacy, so the row is inert twice over.
--
-- To shadow a tester cohort (the OQ-7 default path; nothing here decides it):
--   UPDATE public.feature_flags
--      SET enabled = true,
--          metadata = metadata || '{"mode":"shadow","cohort":{"kind":"users","userIds":["<uuid>"]}}'::jsonb
--    WHERE flag = 'layover_ranking_mode';
-- ⚠ `on` CHANGES THE ORDER TRAVELLERS ARE SERVED and is the owner's call.
--
-- RUNTIME EFFECT OF SEEDING: NONE. Before: no row → legacy (flag_absent).
-- After: legacy (flag_disabled). The postcondition refuses a row found ON.
--
-- Rollback: db/rollback/2026-10-14-3784-layover-ranking-mode-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3784): public.feature_flags does not exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'feature_flags' AND column_name = 'metadata'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3784): public.feature_flags has no metadata column — the mode cannot be carried.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description, metadata) VALUES
  (
    'layover_ranking_mode',
    false,
    'Layover ranking rollout mode (census-layover L242 shadow mode, L78 spec 9.1 objective). enabled = master; metadata.mode = legacy | shadow | on; metadata.cohort = who a non-legacy mode applies to (absent = nobody). legacy: rankActivities order unchanged. shadow: the objective orders the same cards beside it, divergence counted, nothing served. on: the objective order is served, within each safety rating only. Any failure resolves to legacy. Read via lib/featureFlags.ts getFlagRow.',
    '{"mode":"legacy","rollout":"b58-lay-4","modes":["legacy","shadow","on"],"on_changes_traveller_order":true}'::jsonb
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'layover_ranking_mode';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3784): expected layover_ranking_mode present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag = 'layover_ranking_mode' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3784): layover_ranking_mode is ON — it must ship OFF (legacy)';
  END IF;
END $post$;
