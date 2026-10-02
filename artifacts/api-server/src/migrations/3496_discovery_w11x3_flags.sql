-- 3496_discovery_w11x3_flags.sql
-- Two capability flags, seeded OFF (census-discovery §95, lane W11-X3;
-- register D-W11X3-1, D-W11X3-2).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W11-X3,
-- 3495-3499). APPLIED TO NO SHARED DATABASE; rehearsed on the local
-- PostgreSQL 16 harness only.
--
-- ── WHAT THEY GATE ──────────────────────────────────────────────────────────
-- `discovery_place_cooccurrence_enabled` — lib/discoveryPlaceCooccurrence.ts.
--   ON: the hourly tick calls rebuild_place_cooccurrence (3495) and
--   readPlaceCooccurrence reads place_cooccurrence. OFF / absent / unreadable
--   (the seed): the tick reads this one row and writes nothing, and the reader
--   answers `disabled` without touching the table. DV-72, W11A-B10.
-- `discovery_trend_post_convergence_enabled` —
--   lib/discoveryTrendPostConvergence.ts, read by lib/discoveryLocalMomentum.ts
--   only while discovery_trend_normalised_enabled (3475) is also ON. ON: the v2
--   trend classifier's convergence input also counts travellers who published
--   a PUBLIC Memory at the place after their own positive outcome there,
--   aggregated, with at least two distinct authors. OFF / absent / unreadable
--   (the seed): no Memory is read and every reading is byte-identical to §84.
--   DV-34, W11A-B9.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
--
-- Rollback: db/rollback/2026-09-28-3496-discovery-w11x3-flags-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3496): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_place_cooccurrence_enabled',
    false,
    'Trail-derived place co-occurrence (census-discovery DV-72, §95, D-W11X3-1): the hourly rebuild of place_cooccurrence (3495) and its reader. Built only from places sharing a non-archived Trail — no personal data. OFF (the seed): nothing is rebuilt or read. Turning it ON in production is an owner decision.'
  ),
  (
    'discovery_trend_post_convergence_enabled',
    false,
    'Visitors post afterward (census-discovery DV-34, §95, D-W11X3-2): with discovery_trend_normalised_enabled also ON, the v2 trend classifier counts travellers who published a PUBLIC Memory at a place after their own positive outcome there as independent convergence — aggregated, at least 2 distinct authors, never naming anyone. OFF (the seed): no Memory is read. Turning it ON in production is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF (SELECT count(*) FROM public.feature_flags
       WHERE flag IN ('discovery_place_cooccurrence_enabled', 'discovery_trend_post_convergence_enabled')) <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3496): a flag is absent.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('discovery_place_cooccurrence_enabled', 'discovery_trend_post_convergence_enabled') AND enabled = TRUE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3496): a flag seeded by 3496 is ON — it must ship OFF';
  END IF;
END $post$;
