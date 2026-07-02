-- Migration 0077: Re-seed trip crew location feature flags
-- Migration 0041 accidentally used column name "key" when inserting into
-- feature_flags, but the PK column is "flag". These three flags were therefore
-- never seeded. This migration inserts them using the correct column name.

INSERT INTO feature_flags (flag, enabled, description, updated_at)
VALUES
  ('trip_crew_map_enabled',        true, 'Enable the Trip Crew location map feature', now()),
  ('trip_crew_live_share_enabled', true, 'Enable temporary live location sharing within trip crew', now()),
  ('trip_crew_ghost_mode_enabled', true, 'Enable ghost mode for trip crew location hiding', now())
ON CONFLICT (flag) DO NOTHING;
