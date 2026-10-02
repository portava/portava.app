-- 3475_discovery_trend_v2_flags.sql
-- Discovery trending, the held designs built (census-discovery §84, lane W10-R1:
-- DV-28..DV-34, DV-80, DC-06, DC-07, DC-21). FIVE capability flags, all seeded
-- OFF. The owner lifted the 2026-08-15 ranker hold on 2026-09-28 for building
-- and testing behind flags seeded FALSE; turning any of these on in production
-- is NOT delegated (docs/architecture/discovery-decision-register.md, W10-R1's
-- APPROVAL REQUIRED entries).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane range 3475-3479).
-- APPLIED TO NO DATABASE by the lane that wrote it other than the local
-- PostgreSQL 16 harness. NOT applied to portava-ci (hwokxgbmezheskbzskfr).
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Additive + idempotent. `*_enabled` ⇒ CAPABILITY convention: read fail-closed
-- (isFlagEnabled in TypeScript; an absent row reads FALSE in 3477's SQL too).
--
-- ── WHAT EACH GATES ─────────────────────────────────────────────────────────
--   discovery_trend_normalised_enabled
--     ON:  the exposure-normalised trend model (`discovery-trend-state-v2`):
--          lib/discoveryLocalMomentum.loadLocalMomentum computes the momentum
--          scalar and the trend states with it, and 3477's
--          rebuild_place_momentum stores v2 rows in place_momentum and Local
--          Pulse rows in area_momentum.
--     OFF (the seed): every value is the v1 value, byte for byte
--          (src/test/discoveryDerivedProvenanceGolden.test.ts G1–G10).
--   discovery_trend_rebuild_scheduler_enabled
--     ON:  lib/discoveryTrendRebuildScheduler calls rebuild_place_momentum every
--          five minutes (DC-07, D-W10-R1-11). OFF: a tick reads this row and
--          writes nothing.
--   discovery_trend_snapshot_retention_enabled
--     ON:  the same scheduler deletes place_momentum / area_momentum runs older
--          than metadata.keep_days (seeded NULL, which deletes nothing even
--          when ON). Retention policy is the owner's; see APPROVAL REQUIRED.
--   discovery_trend_lists_enabled
--     ON:  routes/discoveryTrending.ts serves `11` §4's three list actions
--          (by location, personalised, emerging places and Trails) and Local
--          Pulse, under discovery_trending_api_enabled as well. OFF: 404.
--   discovery_trend_rediscovery_retest_enabled
--     ON:  lib/discoveryTrendRediscovery offers cooled places for a bounded
--          periodic re-exposure (DV-31). OFF: it offers nothing.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds any of them ON.
--
-- Rollback: db/rollback/2026-09-28-3475-discovery-trend-v2-flags-rollback.sql
-- (deletes the rows while they are still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3475): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description, metadata) VALUES
  (
    'discovery_trend_normalised_enabled',
    false,
    'Discovery trending v2 (census-discovery §84, DC-06/DV-30): trend velocity normalised by exposure (a served impression is the denominator, not activity), with independence-capped activity, a diversity-of-evidence floor, time-of-day, content-age and creator/Trail/location baselines, the 03 §4 content lifecycle and Local Pulse. ON: loadLocalMomentum and rebuild_place_momentum compute v2. OFF / absent / unreadable (the seed): v1, byte for byte. Turning it on changes computed momentum and trend states (under discovery_ranking_modifiers_enabled, what the ranker reads): an owner decision.',
    NULL
  ),
  (
    'discovery_trend_rebuild_scheduler_enabled',
    false,
    'Discovery trending (census-discovery §84, DC-07): ON: the API server calls rebuild_place_momentum every 5 minutes, on the 5-minute boundary, so the stored snapshot the trend API serves is fresh. OFF / absent / unreadable (the seed): a tick reads this row and writes nothing.',
    NULL
  ),
  (
    'discovery_trend_snapshot_retention_enabled',
    false,
    'Discovery trending (census-discovery §84, DC-07): ON: the rebuild scheduler deletes place_momentum and area_momentum runs older than metadata.keep_days. keep_days is seeded NULL, which deletes nothing even when ON. How long snapshots are kept is a retention decision for the owner (APPROVAL REQUIRED in the decision register).',
    '{"keep_days": null}'::jsonb
  ),
  (
    'discovery_trend_lists_enabled',
    false,
    'Discovery trending (census-discovery §84, DC-21, DV-29): ON (with discovery_trending_api_enabled): GET /v1/discovery/trending/{places,for-you,emerging,areas} serve trending by location, personalised trending, emerging places and Trails, and Local Pulse, each disclosed only above the k-anonymity floor. OFF / absent / unreadable (the seed): 404 feature_disabled.',
    NULL
  ),
  (
    'discovery_trend_rediscovery_retest_enabled',
    false,
    'Discovery trending (census-discovery §84, DV-31): ON: cooled places are offered for a bounded, periodic re-exposure (02 §9.5 "periodically retest promising items"), at most one per page, never the top slot. OFF / absent / unreadable (the seed): nothing is offered and no page changes.',
    NULL
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag IN ('discovery_trend_normalised_enabled', 'discovery_trend_rebuild_scheduler_enabled',
                   'discovery_trend_snapshot_retention_enabled', 'discovery_trend_lists_enabled',
                   'discovery_trend_rediscovery_retest_enabled');
  IF present <> 5 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3475): expected 5 trending flags present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('discovery_trend_normalised_enabled', 'discovery_trend_rebuild_scheduler_enabled',
                   'discovery_trend_snapshot_retention_enabled', 'discovery_trend_lists_enabled',
                   'discovery_trend_rediscovery_retest_enabled')
      AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3475): a trending flag is ON — each changes computed values, served lists or retained data, and turning it on in any deployment is an owner decision; this file must ship them OFF';
  END IF;
END $post$;
