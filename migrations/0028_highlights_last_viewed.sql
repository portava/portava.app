-- Migration 0028: highlights_last_viewed_at
-- Adds highlights_last_viewed_at to profiles; used by GET /api/me/unread-counts
-- to compute the newHighlights badge count.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS highlights_last_viewed_at TIMESTAMPTZ;
