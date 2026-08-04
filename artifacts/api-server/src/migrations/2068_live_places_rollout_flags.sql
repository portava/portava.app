-- Phase 4 Live Places rollout contract. All capabilities start disabled.
-- Canonical place discovery remains governed independently by external_places_enabled.
INSERT INTO feature_flags (flag, enabled, description, metadata) VALUES
  ('live_places_enabled', false, 'Master kill switch for Live Places experiential surfaces; requires external_places_enabled', '{"requires":["external_places_enabled"],"rollout":"phase4"}'),
  ('live_places_world_feed_enabled', false, 'Additive Live Places handoff to the existing World Feed; requires Live Places', '{"requires":["external_places_enabled","live_places_enabled"],"rollout":"phase4"}'),
  ('place_chat_enabled', false, 'Additive Place conversation handoff to Telegraph; requires Live Places', '{"requires":["external_places_enabled","live_places_enabled"],"rollout":"phase4"}')
ON CONFLICT (flag) DO UPDATE SET
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata;

UPDATE feature_flags SET metadata = '{"requires":["external_places_enabled","live_places_enabled"],"rollout":"phase4"}'
WHERE flag = 'place_days_enabled';
UPDATE feature_flags SET metadata = '{"requires":["external_places_enabled","live_places_enabled","place_days_enabled"],"rollout":"phase4"}'
WHERE flag IN ('shared_moments_enabled', 'place_recaps_enabled');
UPDATE feature_flags SET metadata = '{"requires":["external_places_enabled","live_places_enabled","place_days_enabled","shared_moments_enabled"],"rollout":"phase4"}'
WHERE flag IN ('shared_moments_compass_suggestions_enabled', 'shared_moments_clustering_enabled', 'shared_moments_chat_enabled', 'moment_recaps_enabled');