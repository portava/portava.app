-- Find Your Circle — Migration 0116
-- Per-trip / per-event override settings for a user's circle presence.
-- A user can turn off or pause sharing for a specific context without touching
-- their global setting.

CREATE TABLE IF NOT EXISTS circle_context_settings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type             TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id               UUID NOT NULL,
  enabled                  BOOLEAN NOT NULL DEFAULT true,
  -- If set, overrides the global visibility_mode for this context only.
  visibility_mode_override TEXT CHECK (
    visibility_mode_override IS NULL OR
    visibility_mode_override IN ('status_only','approximate_area','venue_checkin','precise_live')
  ),
  paused                   BOOLEAN NOT NULL DEFAULT false,
  paused_until             TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, context_type, context_id)
);

CREATE INDEX IF NOT EXISTS ccs_context_idx
  ON circle_context_settings (context_type, context_id);

ALTER TABLE circle_context_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ccs_owner_all ON circle_context_settings;
CREATE POLICY ccs_owner_all ON circle_context_settings
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS ccs_service_all ON circle_context_settings;
CREATE POLICY ccs_service_all ON circle_context_settings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
