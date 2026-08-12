-- Phase 4 Live Places rollout contract. All capabilities start disabled.
-- Canonical place discovery remains governed independently by external_places_enabled.
-- SEED NEUTRALISED 2026-08-12 — two rows removed from this statement:
-- live_places_world_feed_enabled and place_chat_enabled.
--
-- Both were seeded here, live in production, and read by NOTHING. They are keys
-- in LIVE_PLACES_REQUIREMENTS (lib/featureFlags.ts:106-107) and in the app's
-- mirror of that map, but neither is ever passed to
-- isLivePlacesCapabilityEnabled(). Being a key in a requirements map is not
-- being read: resolveFeatureFlags() recomputes them for the public endpoint and
-- no caller consumes the result.
--
-- The sibling that survives makes the shape clear: shared_moments_chat_enabled
-- IS read (routes/sharedMoments.ts:109). This was a two-surface chat rollout
-- where only one surface was ever wired, and live_places_enabled — the master
-- switch, genuinely read at routes/placeLiving.ts:382 and :469 — stays.
--
-- This is the REMOVE-FROM-SEED outcome of docs/ops/flag-disposition.md: delete
-- the row (2086_retire_unread_flags.sql) AND stop the seed path re-creating it
-- (here). Note this statement's ON CONFLICT DO UPDATE makes neutralising
-- especially necessary — left in place it would not merely re-create the rows on
-- a fresh database, it would rewrite description and metadata on every replay
-- against an existing one.
--
-- Their INERT_SEEDED_FLAGS entries are removed from
-- scripts/check-flag-polarity.mjs in this commit, per rule R7.
--
-- The map entries in lib/featureFlags.ts and the client mirror are NOT touched
-- here — recorded as adjacent dead code in docs/ops/flag-disposition.md, outside
-- the approved scope of this unit.
INSERT INTO feature_flags (flag, enabled, description, metadata) VALUES
  ('live_places_enabled', false, 'Master kill switch for Live Places experiential surfaces; requires external_places_enabled', '{"requires":["external_places_enabled"],"rollout":"phase4"}')
ON CONFLICT (flag) DO UPDATE SET
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata;

UPDATE feature_flags SET metadata = '{"requires":["external_places_enabled","live_places_enabled"],"rollout":"phase4"}'
WHERE flag = 'place_days_enabled';
UPDATE feature_flags SET metadata = '{"requires":["external_places_enabled","live_places_enabled","place_days_enabled"],"rollout":"phase4"}'
WHERE flag IN ('shared_moments_enabled', 'place_recaps_enabled');
UPDATE feature_flags SET metadata = '{"requires":["external_places_enabled","live_places_enabled","place_days_enabled","shared_moments_enabled"],"rollout":"phase4"}'
WHERE flag IN ('shared_moments_compass_suggestions_enabled', 'shared_moments_clustering_enabled', 'shared_moments_chat_enabled', 'moment_recaps_enabled');