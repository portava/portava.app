-- Migration 0037: feature_flags
-- Central feature-flag registry; service-role manages rows.
-- Seeds location intelligence phase flags 1-6.

CREATE TABLE IF NOT EXISTS feature_flags (
  flag        text        PRIMARY KEY,
  enabled     boolean     NOT NULL DEFAULT false,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "feature_flags_public_read" ON feature_flags
  FOR SELECT USING (true);

CREATE POLICY "feature_flags_service_write" ON feature_flags
  FOR ALL TO service_role USING (true);

-- Seed rows for location intelligence phases 1-6
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('location_intelligence_phase1', false, 'Location intelligence phase 1: basic GPS capture'),
  ('location_intelligence_phase2', false, 'Location intelligence phase 2: city resolution'),
  ('location_intelligence_phase3', false, 'Location intelligence phase 3: venue detection'),
  ('location_intelligence_phase4', false, 'Location intelligence phase 4: geofencing'),
  ('location_intelligence_phase5', false, 'Location intelligence phase 5: trip crew location'),
  ('location_intelligence_phase6', false, 'Location intelligence phase 6: full location intelligence')
ON CONFLICT (flag) DO NOTHING;
