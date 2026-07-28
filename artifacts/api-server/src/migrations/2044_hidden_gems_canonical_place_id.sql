-- Migration 2044: add canonical_place_id to hidden_gems
--
-- Gems submitted via the dedicated "Add a Gem" flow already carry a
-- canonical_place_id in code (HiddenGemService.ts GEM_SELECT_COLS), but the
-- column was never added to the table.  This migration adds it so that:
--   • the insert/select paths stop silently dropping the value
--   • the gem detail screen can fetch the linked canonical place and surface
--     FSQ-enriched phone, hours, and address via PlaceInfoSection

ALTER TABLE hidden_gems
  ADD COLUMN IF NOT EXISTS canonical_place_id UUID
    REFERENCES places(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS hidden_gems_canonical_place_idx
  ON hidden_gems (canonical_place_id)
  WHERE canonical_place_id IS NOT NULL;
