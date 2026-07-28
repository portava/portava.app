-- Migration 2042: stamp_auto_approve_artwork feature flag
--
-- Adds the feature flag that controls automatic approval of the first
-- passing candidate produced by the generation worker.  When enabled, the
-- worker promotes the first candidate to `approved`, sets
-- `universal_stamp_catalog.active_version_id`, and archives the remaining
-- candidates without waiting for manual admin review.
--
-- The existing admin activate-version endpoint continues to work and always
-- takes precedence (an admin can swap to a different candidate at any time).
--
-- Safe to re-run: ON CONFLICT DO NOTHING throughout.

INSERT INTO feature_flags (flag, enabled, description)
VALUES (
  'stamp_auto_approve_artwork',
  FALSE,
  'Auto-approve the first passing candidate immediately after generation — skips manual admin review for procedural / common-city stamps'
)
ON CONFLICT (flag) DO NOTHING;
