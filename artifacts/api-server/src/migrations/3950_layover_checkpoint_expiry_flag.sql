-- 3950_layover_checkpoint_expiry_flag.sql
--
-- census-layover L159 (spec §17: "Operational checkpoints — short-lived operational + bounded diagnostics"): the owner's
-- press for deleting expired check-ins. Lane LAYOVER, census drive 2026-10-23. APPLIED TO NO DATABASE by the lane that
-- wrote it.
--
-- ── WHAT THIS FILE IS ──────────────────────────────────────────────────────
-- ONE feature-flag row, `layover_checkpoint_expiry_enabled`, seeded FALSE. Nothing else: no table, no column, no index,
-- no function, no privilege. Its reader is artifacts/api-server/src/lib/layoverCheckpointExpirySweep.ts (the fail-closed
-- `isFlagEnabled`), the checkpoint phase of the presence expiry scheduler's tick:
--   OFF / absent / unreadable (the seed): the phase issues NO statement against public.layover_checkpoints and deletes
--     nothing. Check-ins stay hidden from every read at their `expires_at` (2992's filter), exactly as before.
--   ON: rows whose `expires_at` has passed are deleted in batches of 200, the exact complement of the readers'
--     `expires_at > now()`, so no answer any caller can get changes.
--
-- ── WHY A FLAG, AND WHY IT SHIPS OFF ───────────────────────────────────────
-- `expires_at` is the writer's READ horizon — max(now, scheduled departure) + 6 h
-- (services/layover/LayoverCheckpointStore.ts CHECKPOINT_VISIBLE_AFTER_DEPARTURE_MIN) — which 2992 calls "a filter, not
-- a retention promise". No spec line, owner ruling or lead ruling sets it as a retention period: OD-1012-LAY-3 asked for
-- a proposal, and docs/ops/layover-retention-proposal-L261-20261012.md is unapproved. Deleting production rows is
-- therefore the owner's decision, taken by turning this flag on, never a side effect of a deploy.
--
-- ── ORDER INDEPENDENCE ─────────────────────────────────────────────────────
-- It depends only on public.feature_flags (0118 and earlier; columns flag, enabled, description). No file numbered above
-- 3950 alters, drops or truncates feature_flags or names this flag. A plain INSERT writes no feature_flag_audit_log row
-- (only toggle_feature_flag_with_audit does).
--
-- Rollback: db/rollback/2026-10-23-3950-layover-checkpoint-expiry-flag-rollback.sql (refuses while the flag is TRUE or
-- while feature_flag_audit_log holds a row for it — 0118's ON DELETE CASCADE would erase that history).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION '3950: public.feature_flags does not exist';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'feature_flags' AND column_name IN ('flag', 'enabled', 'description')) <> 3 THEN
    RAISE EXCEPTION '3950: public.feature_flags lacks one of flag / enabled / description';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_checkpoint_expiry_enabled' AND enabled IS NOT FALSE) THEN
    RAISE EXCEPTION '3950: layover_checkpoint_expiry_enabled already exists and is not FALSE; this file seeds it OFF and will not overwrite an operator''s setting';
  END IF;
END
$pre$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_checkpoint_expiry_enabled',
    false,
    'Layover check-in retention (spec §17 "short-lived operational + bounded diagnostics"; census-layover L159). ON: the presence expiry scheduler''s checkpoint phase (lib/layoverCheckpointExpirySweep.ts) deletes public.layover_checkpoints rows whose expires_at (scheduled departure + 6 h, the readers'' visibility horizon) has passed, in batches of 200; no answer changes because every reader already hides them. OFF / absent / unreadable (the seed): nothing is deleted and no statement is issued against the table. Turning it ON is the owner''s retention decision (OD-1012-LAY-3; the L261 proposal is unapproved).'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'layover_checkpoint_expiry_enabled';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3950): layover_checkpoint_expiry_enabled is not present';
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'layover_checkpoint_expiry_enabled' AND enabled IS NOT FALSE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3950): layover_checkpoint_expiry_enabled is ON; it must ship OFF';
  END IF;
END
$post$;
