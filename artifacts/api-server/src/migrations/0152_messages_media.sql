-- Migration 0152: add media columns to messages
-- Adds nullable media fields; NULL = text-only message.
-- media_type check keeps values to the two supported kinds.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_url              TEXT,
  ADD COLUMN IF NOT EXISTS media_type             TEXT CHECK (media_type IN ('image', 'video')),
  ADD COLUMN IF NOT EXISTS media_thumbnail_url    TEXT,
  ADD COLUMN IF NOT EXISTS media_duration_seconds INTEGER;

-- Index to let feeds quickly filter media-only messages per thread.
CREATE INDEX IF NOT EXISTS idx_messages_media_url
  ON messages (thread_id, created_at DESC)
  WHERE media_url IS NOT NULL;
