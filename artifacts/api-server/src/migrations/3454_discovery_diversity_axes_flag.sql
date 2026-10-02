-- 3454_discovery_diversity_axes_flag.sql
-- Discovery DV-54 (census-discovery §78): ONE capability flag, seeded OFF,
-- whose METADATA carries the four diversity magnitudes (ranker-hold-designs §2:
-- read from the flag row, never a code constant).
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
-- lib/discoveryRankDesigns.ts → lib/discoveryRankDiversity.ts. The seeded
-- magnitudes are decision D-W10-R2-7 (census-discovery §78.2): place = the
-- creator axis 0.35, geography = the content-type axis 0.15, Trail = their
-- midpoint 0.25, history = 0.15 per prior serve up to 3 over 7 days. They are
-- read only while the flag is TRUE, and the owner can change them in the row.
--
-- Rollback: db/rollback/2026-09-28-3454-discovery-diversity-axes-flag-rollback.sql
-- (deletes the row(s) while still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3454): public.feature_flags does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'feature_flags' AND column_name = 'metadata') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3454): public.feature_flags.metadata (2198) does not exist; this flag carries its values there.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description, metadata) VALUES
  ('discovery_diversity_axes_enabled', false,
   'Discovery diversity axes (census-discovery DV-54, §78): 06 §6 across creator, place, Trail, content type, geography and repeated-recommendation history. ON: the magnitudes in metadata (placePenalty, geoPenalty, trailPenalty, historyPenalty per prior serve up to historyMaxServes, over historyWindowDays) are passed to portavaRank.diversify, candidates carry their non-archived Trail memberships and this viewer''s prior discovery serves. A null magnitude keeps its axis off. OFF / absent / unreadable (the seed): no read, no magnitude; diversity is exactly as before (creator 0.35, content type 0.15). Enabling in production is an owner decision.',
   '{"placePenalty": 0.35, "geoPenalty": 0.15, "trailPenalty": 0.25, "historyPenalty": 0.15, "historyMaxServes": 3, "historyWindowDays": 7}'::jsonb)
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'discovery_diversity_axes_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3454): expected discovery_diversity_axes_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag = 'discovery_diversity_axes_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3454): discovery_diversity_axes_enabled is ON. This file seeds it FALSE and never flips it; turning it on in production is an owner decision (D-W10-R2-A1), and this must ship OFF.';
  END IF;
END $post$;
