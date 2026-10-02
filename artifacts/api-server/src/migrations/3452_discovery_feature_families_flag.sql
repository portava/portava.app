-- 3452_discovery_feature_families_flag.sql
-- Discovery DC-13 (census-discovery §78): ONE capability flag, seeded OFF, for
-- the negative_feedback and exploration_value families and DRS's real
-- negative-feedback inputs on the discovery surface.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; census-discovery
-- §78, lane W10-R2 scoring designs, range 3450-3454). APPLIED TO NO DATABASE by
-- the lane that wrote it other than the local PostgreSQL 16 harness.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed through the shared getFlagRow (lib/discoveryRankFlags.ts),
-- so an absent row, a resolved error and a thrown client all read OFF.
--
-- The 2026-08-15 ranker hold was lifted by the owner on 2026-09-28 for BUILDING
-- behind flags seeded FALSE (docs/architecture/discovery-decision-register.md).
-- Turning any §78 flag on in production is PRODUCTION ACTIVATION and is NOT
-- delegated: it is register entry D-W10-R2-A1 (APPROVAL REQUIRED).
--
-- ── RUNTIME EFFECT OF SEEDING: NONE ────────────────────────────────────────
-- FALSE and absent read the same. Readers: lib/discoveryRankFlags.ts →
-- lib/discoveryRankDesigns.ts, and services/ranking/DiscoveryRankingService.ts
-- withDiscoveryNegativeFeedback (discovery surface only).
--
-- Rollback: db/rollback/2026-09-28-3452-discovery-feature-families-flag-rollback.sql
-- (deletes the row(s) while still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3452): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('discovery_feature_families_enabled', false,
   'Discovery feature families (census-discovery DC-13, §78): 06 §3''s negative_feedback and exploration_value families get their terms. ON: the viewer''s own Not-interested dismissals penalise other candidates in the same category (max -0.4, saturating at three), a small novelty term (max +0.1) rewards unseen, outside-taste, low-exposure candidates, and DiscoveryRankingService on the discovery surface reads the viewer''s dismissals into viewerHasHiddenItem instead of a constant false. A dismissed place itself is still REMOVED by lib/discoveryDismissed.ts, never merely down-weighted. OFF / absent / unreadable (the seed): nothing is read; ranking and DRS are exactly as before. Enabling in production is an owner decision.')
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'discovery_feature_families_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3452): expected discovery_feature_families_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag = 'discovery_feature_families_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3452): discovery_feature_families_enabled is ON. This file seeds it FALSE and never flips it; turning it on in production is an owner decision (D-W10-R2-A1), and this must ship OFF.';
  END IF;
END $post$;
