-- Media lifecycle: bounded retention metadata for retry and purge workers.
-- Additive/idempotent. This migration is intentionally not applied by this lane.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets must exist before 3002';
  END IF;
END $$;

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS processing_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purge_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'media_assets'
      AND column_name = 'processing_last_attempt_at'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: processing retention columns missing';
  END IF;
END $$;
COMMIT;