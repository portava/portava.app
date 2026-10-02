-- 3338_media_processing_worker_flag.sql
-- Media — ONE capability flag for the media processing WORKER (census-media
-- §30, MD338), seeded OFF.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via isFlagEnabled.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- lib/media/mediaProcessingWorker runs on its own clock (every minute, after a
-- three-minute startup delay) and, per pass: recovers lapsed processing leases
-- (MediaLifecycleService.recoverStaleMediaProcessing); reads up to ten
-- `queued` / non-terminal `failed` media_assets rows; claims each
-- (claimMediaProcessing); re-runs the upload pipeline over the STORED object —
-- verifyUploadedBytes, then processImage for a still or the location scrub
-- and container probe for a video; and completes it `ready` with its measured
-- dimensions (completeMediaProcessing) or fails it (failMediaProcessing).
--
-- The SAME flag gates the owner's `POST /media/:id/retry`: while it is off the
-- retry refuses (404 feature_disabled) and writes nothing, because a failed
-- asset re-queued with no worker to claim it would be parked in `queued` —
-- off every canonical read path — for good.
--
-- ── WHAT FLIPPING IT ON DOES, ON A DATABASE AS IT STANDS ────────────────────
-- Before this worker existed nothing claimed queued work, so any row already
-- `queued` there (an owner retry since the retry route shipped) is claimed on
-- the first pass, and any non-terminal `failed` row once its retry clock is
-- due. A row that completes becomes `ready` and joins the canonical read paths
-- (Wall Quick Media, presence receipts) under their own eligibility rules. The
-- postcondition below counts both populations, so ON is never a surprise. A
-- `processing` row with no lease is NOT claimed (census-media §30.6).
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3338 and an applied one behave alike.
-- Reader: services/media/MediaLifecycleService.isMediaProcessingWorkerEnabled
-- (one reader, used by the worker's pass and by the retry).
-- Rollback: db/rollback/2026-09-26-3338-media-processing-worker-flag-rollback.sql
-- NOT applied to any database by the lane that wrote it.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
  IF to_regclass('public.media_processing_attempts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.media_processing_attempts (2951) does not exist; the worker would have no attempt ledger to write.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'media_processing_worker_enabled',
    false,
    'Media (census-media §30, MD338): the processing worker. ON: lib/media/mediaProcessingWorker recovers lapsed leases and, each minute, claims up to ten queued / non-terminal failed media_assets, re-runs the upload pipeline over the stored object (verify bytes and kind; a still must carry no GPS and must decode; a video must carry no location atoms and must state its display size) and completes it ready with its measured dimensions, or fails it — terminal at once when the stored bytes decide it. It never writes storage. The owner retry (POST /media/:id/retry) re-queues only a FAILED asset, and only while this is ON. OFF / absent / unreadable (the seed): the worker is one flag read a minute and writes nothing, and the retry refuses without writing.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int; queued int; failed_due int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_processing_worker_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected media_processing_worker_enabled present, found %', present;
  END IF;

  -- Tell the applier what the first ON pass would pick up on THIS database,
  -- measured with the worker's own predicate.
  SELECT count(*) INTO queued FROM public.media_assets
    WHERE processing_status = 'queued' AND processing_terminal = FALSE;
  SELECT count(*) INTO failed_due FROM public.media_assets
    WHERE processing_status = 'failed' AND processing_terminal = FALSE;
  RAISE NOTICE '3338: media_processing_worker_enabled seeded/kept. If flipped ON now, the worker would claim % queued and % non-terminal failed asset(s) on this database.', queued, failed_due;

  -- Seeded ON would mean this migration took the decision to start processing.
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_processing_worker_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_processing_worker_enabled is ON — starting the processing worker is an owner decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
