-- 2951_media_processing_lifecycle.sql
--
-- IMPORTED from an out-of-band writer, RENUMBERED, and ALREADY APPLIED.
-- Arrived as 3000_media_processing_lifecycle.sql.
-- Its incoming prefix (3000) is outside this repository's canonical
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
--   production (ajrurzioarfkagpuxfnb) .... 20260916120414
--   CI         (hwokxgbmezheskbzskfr) .... 20260916120301
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
-- Media lifecycle: durable processing attempts, retry scheduling, and leases.
-- Additive/idempotent. This migration is intentionally not applied by this lane.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets must exist before 2951';
  END IF;
END $$;

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS processing_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_lease_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_lease_token TEXT,
  ADD COLUMN IF NOT EXISTS processing_error TEXT,
  ADD COLUMN IF NOT EXISTS processing_terminal BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS media_processing_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  lease_token TEXT,
  status TEXT NOT NULL CHECK (status IN ('claimed','succeeded','retryable_failure','terminal_failure','recovered')),
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (media_asset_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS media_processing_due_idx
  ON media_assets (processing_status, processing_next_retry_at, processing_lease_until);
CREATE INDEX IF NOT EXISTS media_processing_attempt_asset_idx
  ON media_processing_attempts (media_asset_id, attempt_number DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'media_assets'
      AND column_name = 'processing_terminal'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets.processing_terminal missing';
  END IF;
  IF to_regclass('public.media_processing_attempts') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_processing_attempts missing';
  END IF;
END $$;
COMMIT;