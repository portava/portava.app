-- Migration: 0028_highlights_last_viewed.sql
-- Adds highlights_last_viewed_at to profiles for unread-highlights badge.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS highlights_last_viewed_at timestamptz;
