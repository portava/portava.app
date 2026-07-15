-- Migration 0028: highlights_last_viewed_at
-- Adds a timestamp to profiles so the unread-highlights badge knows when
-- the user last opened the highlights viewer on the Explore tab.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS highlights_last_viewed_at TIMESTAMPTZ;
