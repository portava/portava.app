-- Migration: 0016_thread_reads.sql
-- Adds last_read_at to message_thread_members for unread-count queries.

ALTER TABLE message_thread_members
  ADD COLUMN IF NOT EXISTS last_read_at timestamptz;

CREATE INDEX IF NOT EXISTS thread_members_last_read_idx
  ON message_thread_members(thread_id, user_id, last_read_at);
