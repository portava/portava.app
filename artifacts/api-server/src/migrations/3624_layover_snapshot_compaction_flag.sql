-- 3624_layover_snapshot_compaction_flag.sql
-- census-layover L261 ("immutable snapshots with bounded retention/compaction").
-- Lane L-DATA, band 3623-3631. APPLIED TO NO DATABASE by the lane that wrote it.
--
-- Additive + idempotent. ONE INSERT: a feature_flags row seeded FALSE with
-- ON CONFLICT DO NOTHING. No schema object is created or changed.
--
-- `layover_snapshot_compaction_enabled` — services/layover/LayoverDecisionService.ts
--   (runSnapshotCompactionSweep, run each hour by the existing layover audit
--   retention tick). ON: stored decision records older than the retention
--   window (PROPOSED RULING L-DATA-L261: 90 days, at most 20 per session) are
--   DELETED with their time budget and return plan; the NEWEST record of every
--   session is always kept; any read failure deletes nothing. DESTRUCTIVE when
--   ON — turning it on is the owner's press.
--   OFF / absent / unreadable (the seed): the sweep reads only this flag and
--   touches no ledger table.
--   PREREQUISITE: 2700, 2992 and 3623 applied (3623's ON DELETE SET NULL is
--   what lets a compacted computation leave while a card still cites it).
--
-- Rollback: db/rollback/2026-10-10-3624-layover-snapshot-compaction-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3624): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_snapshot_compaction_enabled',
    false,
    'Layover L261 snapshot compaction. ON: decision records older than the retention window (proposed 90 days, max 20 per session; the newest per session always kept) are deleted with their time budget and return plan by the hourly layover retention tick. DESTRUCTIVE; enabling is an owner decision. REQUIRES 2700, 2992 and 3623 applied. OFF / absent (the seed): nothing is read or deleted.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_snapshot_compaction_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3624): layover_snapshot_compaction_enabled has no feature_flags row';
  END IF;
END $post$;
