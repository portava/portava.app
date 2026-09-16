-- Media lifecycle: durable processing attempts, retry scheduling, and leases.
-- Additive/idempotent. This migration is intentionally not applied by this lane.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets must exist before 3000';
  END IF;
END $$;

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS processing_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_lease_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_lease_token TEXT,
  ADD COLUMN IF NOT EXISTS processing_error TEXT,
  ADD COLUMN IF NOT EXISTS processing_terminal BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS media_processing_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  lease_token TEXT,
  status TEXT NOT NULL CHECK (status IN ('claimed','succeeded','retryable_failure','terminal_failure','recovered')),
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (media_asset_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS media_processing_due_idx
  ON media_assets (processing_status, processing_next_retry_at, processing_lease_until);
CREATE INDEX IF NOT EXISTS media_processing_attempt_asset_idx
  ON media_processing_attempts (media_asset_id, attempt_number DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'media_assets'
      AND column_name = 'processing_terminal'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets.processing_terminal missing';
  END IF;
  IF to_regclass('public.media_processing_attempts') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_processing_attempts missing';
  END IF;
END $$;
COMMIT;