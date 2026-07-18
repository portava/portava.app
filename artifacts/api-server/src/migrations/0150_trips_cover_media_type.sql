-- Migration 0150: add cover_media_type column to trips table
-- Nullable TEXT with a CHECK constraint; NULL means legacy image (backward-compatible).
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS cover_media_type TEXT
    CHECK (cover_media_type IN ('image', 'video'));
