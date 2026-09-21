-- 2957_presence_cleanup_flag.sql
--
-- IMPORTED from an out-of-band writer, RENUMBERED, and ALREADY APPLIED.
-- Arrived as 2261_presence_cleanup_flag.sql.
-- Its incoming prefix collided with this repository's APPLIED
-- 2261_passport_travel_dna_prefs.sql, so the unapplied-here file is the one that moved.
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
--   production (ajrurzioarfkagpuxfnb) .... 20260916075633
--   CI         (hwokxgbmezheskbzskfr) .... 20260916075553
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
-- 2261_presence_cleanup_flag.sql
-- Operationally enforce the presence_in_context session bound. OFF by default.
BEGIN;
INSERT INTO public.feature_flags(flag, enabled, description) VALUES
 ('presence_cleanup_enabled', false, 'Marks stale and deletes expired circle_presence rows; disabled by default until scheduler rollout is verified.')
ON CONFLICT (flag) DO NOTHING;
COMMIT;