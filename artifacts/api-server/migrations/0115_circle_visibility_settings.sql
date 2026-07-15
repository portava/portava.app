-- Find Your Circle — Migration 0115
--
-- Context: trip_crew_location_* tables handle trip-specific real-time GPS sharing.
-- These new tables handle opt-in status/presence coordination for both trips and
-- events — no GPS stored in V1, no crossover with Safe Return or Discovery.
--
-- This migration creates the user-level global settings + consent table.

CREATE TABLE IF NOT EXISTS circle_visibility_settings (
  user_id           UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  global_enabled    BOOLEAN NOT NULL DEFAULT false,
  -- Default visibility mode when sharing; precise_live is reserved for V2.
  visibility_mode   TEXT NOT NULL DEFAULT 'status_only'
                    CHECK (visibility_mode IN ('status_only','approximate_area','venue_checkin','precise_live')),
  consent_version   TEXT,
  consented_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE circle_visibility_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cvs_owner_all ON circle_visibility_settings;
CREATE POLICY cvs_owner_all ON circle_visibility_settings
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cvs_service_all ON circle_visibility_settings;
CREATE POLICY cvs_service_all ON circle_visibility_settings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Seed the feature flag
INSERT INTO feature_flags (flag, enabled, description)
VALUES ('find_your_circle_enabled', false, 'Find Your Circle — opt-in status presence coordination')
ON CONFLICT (flag) DO NOTHING;

INSERT INTO feature_flags (flag, enabled, description)
VALUES ('find_your_circle_disabled', false, 'Emergency kill switch — disables all Find Your Circle endpoints')
ON CONFLICT (flag) DO NOTHING;
