-- Migration: 0120_stamp_definitions_universal_artwork.sql
-- Adds the AI-generated universal artwork image URL to stamp definitions.
-- Populated by the AI stamp artwork pipeline; nullable so existing
-- definitions keep working with the procedural fallback design.

ALTER TABLE stamp_definitions
  ADD COLUMN IF NOT EXISTS universal_artwork_url text;
