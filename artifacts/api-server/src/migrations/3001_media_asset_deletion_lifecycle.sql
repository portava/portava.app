-- Media lifecycle: owner-authorized soft deletion and auditable storage purge.
-- Additive/idempotent. This migration is intentionally not applied by this lane.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: media_assets must exist before 3001';
  END IF;
END $$;

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purge_status TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (purge_status IN ('not_requested','pending','completed','failed')),
  ADD COLUMN IF NOT EXISTS purge_error TEXT;

CREATE TABLE IF NOT EXISTS media_asset_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  actor_user_id UUID,
  event_type TEXT NOT NULL CHECK (event_type IN ('soft_deleted','purge_succeeded','purge_failed')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_asset_lifecycle_events_asset_idx
  ON media_asset_lifecycle_events (media_asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_assets_purge_idx
  ON media_assets (purge_status, deleted_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'media_assets'
      AND column_name = 'purge_status'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_assets.purge_status missing';
  END IF;
  IF to_regclass('public.media_asset_lifecycle_events') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_asset_lifecycle_events missing';
  END IF;
END $$;
COMMIT;