-- Migration: add cover_source to events table
-- Tracks who last set the cover image so the priority guard can block AI
-- images from overwriting user uploads.
-- Values: 'user_upload' | 'ai_generated' | NULL (unknown / not yet set)

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS cover_source TEXT
    CHECK (cover_source IN ('user_upload', 'ai_generated'));
