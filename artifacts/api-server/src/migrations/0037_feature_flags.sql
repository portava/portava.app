-- Migration: 0037_feature_flags.sql
-- Creates feature_flags table and seeds initial location intelligence flags.

CREATE TABLE IF NOT EXISTS feature_flags (
  flag        text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT false,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- SEED NEUTRALISED 2026-08-12 — eight rows removed from this statement:
-- location_phase1_gps, location_phase2_zones, location_phase3_geofence,
-- location_phase4_discovery, location_phase5_pulse, location_phase6_crew,
-- telegraph_suggestions_enabled, notifications_digest_enabled.
--
-- All eight were seeded here, read by nothing in either shipping tree, and
-- ABSENT from production — the "seeded but absent" population of
-- docs/ops/flag-disposition.md. Because they are absent, 2086's DELETE matches
-- zero rows in production; removing them here is what actually retires them, so
-- a database built by replaying the migrations never creates them again.
--
-- The six location_phase* names are one of TWO parallel six-flag families for the
-- same rollout: production separately carried location_intelligence_phase1..6
-- (unseeded, unread), retired by the same migration. Neither side was ever read.
-- Their INERT_SEEDED_FLAGS entries asked for the phase plan to be confirmed
-- "before dropping six rows"; the census did that, and this is the confirmation
-- being acted on rather than deferred again.
--
-- telegraph_suggestions_enabled was seeded TRUE, so an operator would have read
-- it as "telegraph suggestions are on and can be turned off". Nothing consulted
-- it in either position.
--
-- Editing an applied migration is deliberate and is the `remove-from-seed`
-- remedy, as 2080 did. Their INERT_SEEDED_FLAGS entries are removed from
-- scripts/check-flag-polarity.mjs in this commit, per rule R7.
--
-- Location intelligence phases 1-6
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('trip_crew_map_enabled',             false, 'Trip crew map feature'),
  ('trip_crew_live_share_enabled',      false, 'Trip crew live location sharing'),
  ('trip_crew_ghost_mode_enabled',      false, 'Trip crew ghost mode'),
  ('passport_stamps_enabled',           false, 'Passport stamps feature'),
  ('passport_memories_enabled',         false, 'Passport memories feature'),
  ('passport_map_enabled',              false, 'Passport map feature'),
  ('passport_contribution_enabled',     false, 'Passport contribution events'),
  ('safe_return_enabled',               false, 'Safe return check-in feature'),
  ('hidden_gems_enabled',               true,  'Hidden gems discovery section'),
  ('plan_geofence_full_enabled',        false, 'Full plan geofence with check-ins')
ON CONFLICT (flag) DO NOTHING;
