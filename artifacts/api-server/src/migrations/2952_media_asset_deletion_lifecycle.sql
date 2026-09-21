-- 2952_media_asset_deletion_lifecycle.sql
--
-- IMPORTED from an out-of-band writer, RENUMBERED, and ALREADY APPLIED.
-- Arrived as 3001_media_asset_deletion_lifecycle.sql.
-- Its incoming prefix (3001) is outside this repository's canonical
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
--   production (ajrurzioarfkagpuxfnb) .... 20260916120416
--   CI         (hwokxgbmezheskbzskfr) .... 20260916120308
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
-- Media lifecycle: owner-authorized soft deletion and auditable storage purge.
-- Additive/idempotent. This migration is intentionally not applied by this lane.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets must exist before 2952';
  END IF;
END $$;

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purge_status TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (purge_status IN ('not_requested','pending','completed','failed')),
  ADD COLUMN IF NOT EXISTS purge_error TEXT;

CREATE TABLE IF NOT EXISTS media_asset_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  actor_user_id UUID,
  event_type TEXT NOT NULL CHECK (event_type IN ('soft_deleted','purge_succeeded','purge_failed')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_asset_lifecycle_events_asset_idx
  ON media_asset_lifecycle_events (media_asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_assets_purge_idx
  ON media_assets (purge_status, deleted_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'media_assets'
      AND column_name = 'purge_status'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets.purge_status missing';
  END IF;
  IF to_regclass('public.media_asset_lifecycle_events') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_asset_lifecycle_events missing';
  END IF;
END $$;
COMMIT;