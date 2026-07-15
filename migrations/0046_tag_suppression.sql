-- Migration 0046: tag_suppression
-- Adds suppressed + suppressed_at to tags for soft-delete self-tag removal.
-- Partial indexes for active-by-source and suppressed-by-user lookups.

ALTER TABLE tags ADD COLUMN IF NOT EXISTS suppressed    BOOLEAN   NOT NULL DEFAULT FALSE;
ALTER TABLE tags ADD COLUMN IF NOT EXISTS suppressed_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS tags_active_by_source_idx
  ON tags(source_type, source_id) WHERE NOT suppressed;

CREATE INDEX IF NOT EXISTS tags_suppressed_by_user_idx
  ON tags(tagged_user_id) WHERE suppressed;
