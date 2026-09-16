-- Media lifecycle audit tables: service-role writes, owner-readable history.
-- Additive/idempotent. This migration is intentionally not applied by this lane.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.media_asset_lifecycle_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 3001 before 3003';
  END IF;
END $$;

ALTER TABLE media_processing_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_asset_lifecycle_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY media_processing_attempts_owner_select ON media_processing_attempts
    FOR SELECT USING (EXISTS (
      SELECT 1 FROM media_assets a
      WHERE a.id = media_processing_attempts.media_asset_id
        AND a.owner_user_id = auth.uid()
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY media_asset_lifecycle_events_owner_select ON media_asset_lifecycle_events
    FOR SELECT USING (EXISTS (
      SELECT 1 FROM media_assets a
      WHERE a.id = media_asset_lifecycle_events.media_asset_id
        AND a.owner_user_id = auth.uid()
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'media_asset_lifecycle_events'
      AND policyname = 'media_asset_lifecycle_events_owner_select'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: lifecycle owner policy missing';
  END IF;
END $$;
COMMIT;