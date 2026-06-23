-- Migration 0037: feature_flags
-- Server-side feature flag table for graduated rollout
-- Safe to re-run: IF NOT EXISTS throughout

CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT        PRIMARY KEY,
  enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GPS v2 feature flags — disabled by default, enabled when ready
INSERT INTO feature_flags (key, enabled, description) VALUES
  ('gps_v2_enabled',                TRUE,  'Master GPS v2 intelligence layer'),
  ('pulse_geo_enabled',             TRUE,  'Location visibility options in Pulse post creation'),
  ('discovery_geo_enabled',         TRUE,  'Context modes (near_me, in_city, etc.) in Discovery'),
  ('plan_geofence_enabled',         FALSE, 'Plan geofencing: check-in radius and arrival status'),
  ('safe_return_geo_enabled',       FALSE, 'Safe Return: live-share sessions and timer'),
  ('compass_location_context_enabled', FALSE, 'Compass AI: location context injection')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  -- Everyone can read flags; only service role writes them
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='feature_flags' AND policyname='ff_select_all') THEN
    CREATE POLICY ff_select_all ON feature_flags FOR SELECT USING (TRUE);
  END IF;
END $$;
