-- 3400_media_pending_upload_sweep_flag.sql
-- The abandoned-upload sweep (census-discovery DV-77 / §56). ONE capability
-- flag, seeded OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; Discovery
-- cross-architecture adapters lane 3400-3404). APPLIED TO NO DATABASE by the
-- lane that wrote it.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- `media_pending_upload_sweep_enabled`. Read at the top of every pass of
-- lib/media/pendingUploadSweepScheduler.ts (hourly) through readFlagState.
--   ON:          the pass runs services/media/PendingUploadSweep.ts — every
--                `post_media` row still `pending` an hour after its slot was
--                reserved (its /complete never ran, or refused the bytes) has
--                its UNSTRIPPED original, feed variant, resumable parts and
--                poster removed from `post-media`, then the row deleted. Oldest
--                first, 200 a pass; a failed removal keeps the row for the next.
--   OFF/absent:  the pass reads nothing else and does nothing.
--   unreadable:  the pass does nothing and records a FAILURE (never a clean,
--                idle tick): a deletion job must not run on a guess.
-- The manual trigger POST /api/postcards/sweep-orphans (INTERNAL_API_SECRET) is
-- NOT gated by this flag; it runs the same pass once, on an operator's act.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3400 and an applied one behave alike.
-- Turning it ON DELETES USER UPLOADS older than the cutoff that never completed
-- — including a resumable upload its owner is still sending after an hour — and
-- is the owner's decision (census-discovery §56 states the question).
--
-- No storage policy, bucket setting, table or column is touched.
--
-- Rollback: db/rollback/2026-09-27-3400-media-pending-upload-sweep-flag-rollback.sql
-- (deletes the row while it is still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3400): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'media_pending_upload_sweep_enabled',
    false,
    'Abandoned-upload sweep (census-discovery DV-77, §56): Phase 0.4, no unstripped original persists because a completion handler never ran. ON: hourly, every post_media row still pending an hour after its slot was reserved has its original, feed variant, resumable parts and poster removed from post-media, then the row deleted (oldest first, 200 a pass; a failed removal keeps the row). OFF / absent (the seed): nothing runs. Unreadable: nothing runs and the pass records a failure. Turning it ON deletes never-completed uploads, including a resumable upload still in progress after an hour; that is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_pending_upload_sweep_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3400): expected media_pending_upload_sweep_enabled present, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_pending_upload_sweep_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3400): media_pending_upload_sweep_enabled is ON — enabling a job that deletes user uploads is an owner decision and this must ship OFF';
  END IF;
END $post$;
