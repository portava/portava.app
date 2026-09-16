-- 2954_media_lifecycle_rls.sql
--
-- IMPORTED from an out-of-band writer, RENUMBERED, and ALREADY APPLIED.
-- Arrived as 3003_media_lifecycle_rls.sql.
-- Its incoming prefix (3003) is outside this repository's canonical
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
--   production (ajrurzioarfkagpuxfnb) .... 20260916120421
--   CI         (hwokxgbmezheskbzskfr) .... 20260916120319
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
-- Media lifecycle audit tables: service-role writes, owner-readable history.
-- Additive/idempotent. This migration is intentionally not applied by this lane.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.media_asset_lifecycle_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2952 before 2954';
  END IF;
END $$;

ALTER TABLE media_processing_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_asset_lifecycle_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY media_processing_attempts_owner_select ON media_processing_attempts
    FOR SELECT USING (EXISTS (
      SELECT 1 FROM media_assets a
      WHERE a.id = media_processing_attempts.media_asset_id
        AND a.owner_user_id = auth.uid()
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY media_asset_lifecycle_events_owner_select ON media_asset_lifecycle_events
    FOR SELECT USING (EXISTS (
      SELECT 1 FROM media_assets a
      WHERE a.id = media_asset_lifecycle_events.media_asset_id
        AND a.owner_user_id = auth.uid()
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'media_asset_lifecycle_events'
      AND policyname = 'media_asset_lifecycle_events_owner_select'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: lifecycle owner policy missing';
  END IF;
END $$;
COMMIT;