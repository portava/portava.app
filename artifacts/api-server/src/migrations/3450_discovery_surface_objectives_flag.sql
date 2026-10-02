-- 3450_discovery_surface_objectives_flag.sql
-- Discovery DV-09 (census-discovery §78): ONE capability flag, seeded OFF, for
-- 01 §9's per-surface objectives expressed over 06 §3's feature families.
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
-- FALSE and absent read the same. Reader: lib/discoveryRankFlags.ts →
-- lib/discoveryRankDesigns.ts (RankOptions.objective = objectiveForSurface).
-- metadata.surfaces is all null: a TRUE flag with this metadata uses the code's
-- family weights (decision D-W10-R2-1), which census §78.2 states in full.
--
-- Rollback: db/rollback/2026-09-28-3450-discovery-surface-objectives-flag-rollback.sql
-- (deletes the row(s) while still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3450): public.feature_flags does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'feature_flags' AND column_name = 'metadata') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3450): public.feature_flags.metadata (2198) does not exist; this flag carries its values there.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description, metadata) VALUES
  ('discovery_surface_objectives_enabled', false,
   'Discovery surface objectives (census-discovery DV-09, §78): 01 §9''s five surfaces as weights over 06 §3''s eleven feature families (lib/discoveryRankObjectives.ts). ON: the Discovery ranking call carries the discovery objective (relevance, novelty, exploration value and travel intent up); metadata.surfaces.<surface> may override any family multiplier in [0,3], null = the code default. The Pulse, Trail, Trip Planning and Trending objectives are applied by their consumers (census-discovery §78.9 hunks). OFF / absent / unreadable (the seed): no objective; the ranker is exactly as before. Owner-ruled caps (local momentum, Trail affinity) hold under every objective. Enabling in production is an owner decision.',
   '{"surfaces": {"pulse": null, "discovery": null, "trail": null, "trip_planning": null, "trending": null}}'::jsonb)
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'discovery_surface_objectives_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3450): expected discovery_surface_objectives_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag = 'discovery_surface_objectives_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3450): discovery_surface_objectives_enabled is ON. This file seeds it FALSE and never flips it; turning it on in production is an owner decision (D-W10-R2-A1), and this must ship OFF.';
  END IF;
END $post$;
