-- Migration 0166: feature_flags reconciliation
--
-- Context: the feature_flags PK column is `flag` (0037_feature_flags.sql).
-- The legacy tree's 0040_safe_return.sql seeded flags against a `key` column
-- that does not exist in the live schema, and 11 call sites read `.eq("key",…)`
-- until 2026-07-23 — meaning several flags may never have been seeded and the
-- gated features silently read as disabled.
--
-- This migration idempotently ensures every flag referenced by those code
-- paths EXISTS as a row (disabled by default; ON CONFLICT DO NOTHING never
-- overrides an operator's live enabled/disabled choice).
--
-- Safe to re-run.

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('safe_return_enabled',                       false, 'Safe Return system master switch'),
  ('safe_return_live_share_enabled',            false, 'Safe Return time-boxed live location sharing'),
  ('safe_return_trusted_circle_alerts_enabled', false, 'Safe Return trusted-circle escalation alerts'),
  ('safe_return_admin_logs_enabled',            true,  'Safe Return admin audit logs'),
  ('plan_geofence_enabled',                     false, 'Plan-item geofence check-ins'),
  ('plan_geofence_full_enabled',                false, 'Full geofence pipeline (arrival detection)'),
  ('passport_stamps_enabled',                   false, 'Passport stamps v1 write paths (0085 may have enabled this — not overridden here)'),
  ('passport_memories_enabled',                 false, 'Passport suggested memories (0085 may have enabled this — not overridden here)'),
  ('hidden_gems_compass_enabled',               false, 'Hidden gems context inside Compass prompts'),
  ('trust_engine_enabled',                      false, 'Trust score event engine'),
  ('trust_gaming_detection_enabled',            false, 'Trust gaming/abuse detection'),
  ('compass_location_context_enabled',          false, 'City-level location context in Telegraph AI prompts')
ON CONFLICT (flag) DO NOTHING;

-- Verification (run manually):
--   SELECT flag, enabled FROM feature_flags WHERE flag IN (
--     'safe_return_enabled','plan_geofence_enabled','trust_engine_enabled',
--     'hidden_gems_compass_enabled','compass_location_context_enabled');
