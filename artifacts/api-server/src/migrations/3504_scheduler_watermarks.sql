-- 3504_scheduler_watermarks.sql
-- A durable "processed through" mark per background scheduler, so a scheduler
-- that asks "what happened since last time" survives the process dying.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lane that wrote it other than the local PostgreSQL 16
-- harness.
--
-- Additive + idempotent. Safe to re-run.
--
-- ── WHY THIS TABLE EXISTS ───────────────────────────────────────────────────
-- Several schedulers select work with a window anchored on the current clock —
-- "every row created in the last hour", "every event in the last 24 hours" —
-- and keep no record of where the previous tick got to. That shape is correct
-- only while the ticks keep pace. The API runs on Replit autoscale
-- (`deploymentTarget = "autoscale"` in .replit), which suspends a container
-- after fifteen idle minutes, and a suspended container's event loop does not
-- advance. So a one-hour window is narrower than an ordinary quiet night, and
-- every row that fell inside the gap is outside the next tick's window and is
-- never examined by any later tick.
--
-- On 2026-09-30 every in-process scheduler stopped for fifty-four hours, which
-- is how this was found, but the outage is not the reason the table exists: the
-- narrow windows lose rows routinely, and an always-on host would hide that
-- rather than fix it.
--
-- One watermark per JOB, not per scheduler, because a scheduler can run several
-- detectors with different windows and one failing must not advance another's
-- mark. `lib/schedulerWatermark.ts` owns the read/advance rules — above all
-- that the mark is advanced only after the window's work actually succeeded,
-- and that a mark which cannot be READ makes the caller fall back to its old
-- lookback rather than assume "nothing processed yet" and scan from scratch.
--
-- This is NOT a liveness record. It says how far work got, never whether the
-- scheduler is running; `job_health` (0017) and GET /healthz/schedulers are the
-- liveness surfaces, and they cover four of the fifty-eight jobs.
CREATE TABLE IF NOT EXISTS public.scheduler_watermarks (
  job               text PRIMARY KEY,
  processed_through timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.scheduler_watermarks IS
  'Per-job "processed through" mark for background schedulers whose work is selected by a time window. Written only after that window''s work succeeded. Server operational state; no client involvement.';
COMMENT ON COLUMN public.scheduler_watermarks.processed_through IS
  'The instant up to which this job''s work is known to have been done. The next tick scans from here, not from now minus a fixed lookback.';

-- Server operational state, exactly like job_health (see 2070's hardening of
-- it): RLS ON with NO policies, so the service role the API uses reaches it and
-- every client role reaches nothing. There is no user-linked column here, so
-- the table states no deletion fate: it holds no personal data and nothing in
-- it survives or outlives an account.
DO $$
BEGIN
  IF to_regclass('public.scheduler_watermarks') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.scheduler_watermarks ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;
