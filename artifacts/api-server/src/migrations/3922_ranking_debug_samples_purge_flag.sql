-- 3922_ranking_debug_samples_purge_flag.sql
-- One capability flag, seeded OFF: the scheduled caller of the 7-day
-- ranking_debug_samples purge (census-discovery §133, DV-52).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane DISCOVERY,
-- 3920-3929). ORDER-INDEPENDENT AND IDEMPOTENT: it needs only
-- public.feature_flags, inserts one row with ON CONFLICT DO NOTHING, and never
-- changes a row that already exists. Rehearsed on the local PostgreSQL harness.
--
-- ── WHY A FLAG, AND WHY IT SHIPS OFF ────────────────────────────────────────
-- purge_old_ranking_debug_samples() (0203, search_path pinned by 0204) deletes
-- every row older than 7 days. Nothing in the API calls it, and pg_cron is not
-- installed (production, read 2026-10-23), so debug samples (which carry
-- viewer_id) accumulate. The 7 days is a constant in a backfilled function, NOT
-- a recorded retention ruling: D-OWNER1004-1 (discovery-decision-register.md)
-- records that "which horizon governs ranking_debug_samples is unknown and is
-- one of the things the legal review must settle". A sweep that deletes at a
-- coded horizon nobody ruled on must not run unflagged (the Layover lane's
-- ruling, carried here). So lib/rankingDebugSamplePurgeScheduler.ts calls the
-- purge ONLY while this row reads TRUE; OFF, absent or unreadable it issues no
-- DELETE. Turning it ON is the owner's retention ruling to make.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE ─────────────────────────────────────────
-- Rollback: db/rollback/2026-10-23-3922-ranking-debug-samples-purge-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3922): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'ranking_debug_samples_purge_enabled',
    false,
    'Scheduled caller of purge_old_ranking_debug_samples() (0203: deletes ranking_debug_samples older than 7 days). census-discovery DV-52, §133. The 7-day horizon is NOT a recorded retention ruling (D-OWNER1004-1), so OFF (the seed), absent or unreadable: no DELETE is issued. Turning it ON is the owner''s retention decision for debug samples.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'ranking_debug_samples_purge_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3922): ranking_debug_samples_purge_enabled is absent.';
  END IF;
END $post$;
