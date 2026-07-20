-- 0161: friend_requests response-time auditing
-- Adds responded_at (when the request was accepted/declined/cancelled) and
-- updated_at so admins can audit response times. message_requests already
-- has responded_at; this brings friend_requests to parity.

ALTER TABLE friend_requests ADD COLUMN IF NOT EXISTS responded_at timestamptz;
ALTER TABLE friend_requests ADD COLUMN IF NOT EXISTS updated_at timestamptz;
