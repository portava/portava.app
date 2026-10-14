-- 3789_layover_operational_expiry_sweep_flag.sql
-- census-layover L159 ("Operational checkpoints — short-lived operational + bounded diagnostics").
-- B58 cluster LAY-R, layover band 3784-3799. APPLIED TO NO DATABASE by the lane that wrote it.
--
-- Additive + idempotent. ONE INSERT: a feature_flags row seeded FALSE with
-- ON CONFLICT DO NOTHING. No schema object is created or changed, and this file
-- does NOT depend on 2992 or 3900: the flag can exist before the tables it
-- governs, and the sweep reports a missing table (42P01 / PGRST205) as
-- "table absent", never as a failure and never as "nothing due".
--
-- `layover_operational_expiry_sweep_enabled` — lib/layoverOperationalRetentionScheduler.ts
--   (runLayoverOperationalExpiryPhase, run each hour by its own scheduler).
--   ON: rows of `layover_checkpoints` (2992) and `layover_presence` (3900) whose
--   `expires_at` has passed are DELETED, with no grace period (the L261 proposal,
--   docs/ops/layover-retention-proposal-L261-20261012.md §3.1 phase P1; OD-1012-LAY-3
--   has NOT ruled on that proposal). Every reader of both tables already hides a
--   row at that instant (`expires_at > now`), so a deleted row is one no caller
--   could observe. The pass reports COUNTS only (a log line and the job_health row
--   `layoverOperationalExpiry`); it copies no row anywhere. DESTRUCTIVE when ON —
--   turning it on is the owner's press.
--   OFF / absent / unreadable (the seed): the pass reads only this flag and
--   touches neither table.
--
-- Rollback: db/rollback/2026-10-14-3789-layover-operational-expiry-sweep-flag-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3789): public.feature_flags does not exist.';
  END IF;
END
$pre$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_operational_expiry_sweep_enabled',
    false,
    'Layover L159 operational expiry sweep. ON: layover_checkpoints (2992) and layover_presence (3900) rows past their expires_at are deleted each hour with no grace period; every reader already hides them at that instant. Counts only are logged and written to job_health (layoverOperationalExpiry); no row is copied. A missing table is reported as absent, not a failure. DESTRUCTIVE; enabling is an owner decision (L261 proposal P1, OD-1012-LAY-3 not ruled). OFF / absent (the seed): only this flag is read.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_operational_expiry_sweep_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3789): layover_operational_expiry_sweep_enabled has no feature_flags row';
  END IF;
END
$post$;
