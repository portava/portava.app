-- Migration: add canonical_place_id, source_type, moderation_status to hidden_gems
-- Required by the Gems mode feed endpoint (/api/media/gems-feed) for:
--   - canonical_place_id: eligibility gate — gems without a place link are excluded
--   - source_type: provenance label — 'ai_generated_generic' gems excluded from feed
--   - moderation_status: hydration — surfaced in MediaFeedItem.moderation

ALTER TABLE hidden_gems
  ADD COLUMN IF NOT EXISTS canonical_place_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_type        TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS moderation_status  TEXT DEFAULT NULL;

-- Index for the canonical_place_id eligibility filter
CREATE INDEX IF NOT EXISTS hidden_gems_canonical_place_id_idx
  ON hidden_gems (canonical_place_id)
  WHERE canonical_place_id IS NOT NULL;
