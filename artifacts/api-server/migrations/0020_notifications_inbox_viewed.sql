-- Migration: 0020_notifications_inbox_viewed
-- Adds a timestamp to profiles that records when the user last viewed their
-- Inbox/Notifications screen. Used to compute unread notification counts
-- without a separate notifications log table.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notifications_inbox_viewed_at timestamptz;
