-- Migration 0016: last_read_at on message_thread_members
-- Tracks when each user last read a thread, used to compute unread counts
-- for the Messages tab badge.

ALTER TABLE message_thread_members
  ADD COLUMN IF NOT EXISTS last_read_at timestamptz;

-- Index for the unread-count query: filters by user_id then joins on thread_id
CREATE INDEX IF NOT EXISTS message_thread_members_user_read_idx
  ON message_thread_members (user_id, thread_id, last_read_at);
