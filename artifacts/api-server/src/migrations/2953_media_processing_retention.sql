-- 2953_media_processing_retention.sql
--
-- IMPORTED from an out-of-band writer, RENUMBERED, and ALREADY APPLIED.
-- Arrived as 3002_media_processing_retention.sql.
-- Its incoming prefix (3002) is outside this repository's canonical
-- 2100-2999 band, which checkMigrationPrefixes enforces, so it had to move.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THIS FILE IS A RECORD OF SOMETHING THAT ALREADY RAN. DO NOT REPLAY IT BY HAND.
-- ══════════════════════════════════════════════════════════════════════════════
-- Its DDL reached both databases before this repository ever saw it, applied by a
-- second writer through the Supabase CLI. That path writes
-- supabase_migrations.schema_migrations and NOT public.schema_migration_ledger,
-- which is why this repository's ledger has no row for it and why its absence
-- there is not evidence it never ran. The versions it actually ran as:
--
--   production (ajrurzioarfkagpuxfnb) .... 20260916120418
--   CI         (hwokxgbmezheskbzskfr) .... 20260916120313
--
-- Verified by reading the live schemas on 2026-09-16, not inferred: the objects
-- below are present in both. Bringing the file in under a repository number is
-- what puts it under the migration chain's governance for the first time; the
-- SQL is deliberately NOT re-executed against either database. The ledger row
-- recorded for it names this filename, its checksum, and the version above.
--
-- It stays idempotent because a fresh database — the CI kernel job replaying the
-- whole chain onto an empty Postgres — DOES need to run it, and must reach the
-- same state either way.
--
-- ── The original file's own header follows ────────────────────────────────────
-- Media lifecycle: bounded retention metadata for retry and purge workers.
-- Additive/idempotent. This migration is intentionally not applied by this lane.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets must exist before 2953';
  END IF;
END $$;

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS processing_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purge_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'media_assets'
      AND column_name = 'processing_last_attempt_at'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: processing retention columns missing';
  END IF;
END $$;
COMMIT;