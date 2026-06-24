-- Migration: 0037_feature_flags.sql
-- Creates feature_flags table and seeds initial location intelligence flags.

CREATE TABLE IF NOT EXISTS feature_flags (
  flag        text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT false,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Location intelligence phases 1–6
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('location_phase1_gps',               false, 'Phase 1: GPS-based location capture'),
  ('location_phase2_zones',             false, 'Phase 2: Geo-zone detection'),
  ('location_phase3_geofence',          false, 'Phase 3: Plan geofencing'),
  ('location_phase4_discovery',         false, 'Phase 4: Discovery location context'),
  ('location_phase5_pulse',             false, 'Phase 5: Pulse geo-tags'),
  ('location_phase6_crew',              false, 'Phase 6: Trip crew location sharing'),
  ('trip_crew_map_enabled',             false, 'Trip crew map feature'),
  ('trip_crew_live_share_enabled',      false, 'Trip crew live location sharing'),
  ('trip_crew_ghost_mode_enabled',      false, 'Trip crew ghost mode'),
  ('passport_stamps_enabled',           false, 'Passport stamps feature'),
  ('passport_memories_enabled',         false, 'Passport memories feature'),
  ('passport_map_enabled',              false, 'Passport map feature'),
  ('passport_contribution_enabled',     false, 'Passport contribution events'),
  ('safe_return_enabled',               false, 'Safe return check-in feature'),
  ('hidden_gems_enabled',               true,  'Hidden gems discovery section'),
  ('telegraph_suggestions_enabled',     true,  'Telegraph chat suggestions'),
  ('notifications_digest_enabled',      false, 'Notification digest batching'),
  ('plan_geofence_full_enabled',        false, 'Full plan geofence with check-ins')
ON CONFLICT (flag) DO NOTHING;
