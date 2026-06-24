-- Migration: 0020_notifications_inbox_viewed.sql
-- Adds notifications_inbox_viewed_at to profiles for unread badge count.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notifications_inbox_viewed_at timestamptz;
