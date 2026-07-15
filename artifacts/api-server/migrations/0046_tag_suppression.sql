-- 0046_tag_suppression.sql
-- Soft-delete support for user self-removal of @mention tags.
-- When a user removes their own tag, we set suppressed=true rather than deleting
-- the row. This preserves the unique constraint (source_type, source_id, tagged_user_id),
-- so a future re-tag of the same user on the same content cannot bypass the suppression.
-- The tagger cannot re-notify a user who has suppressed themselves.

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS suppressed      BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS suppressed_at   TIMESTAMPTZ  NULL;

-- Fast lookup of non-suppressed tags per source (used by enrichSpans)
CREATE INDEX IF NOT EXISTS tags_active_by_source_idx
  ON tags (source_type, source_id)
  WHERE suppressed = FALSE;

-- Fast lookup of all suppressed tags for a given tagged_user_id
CREATE INDEX IF NOT EXISTS tags_suppressed_by_user_idx
  ON tags (tagged_user_id)
  WHERE suppressed = TRUE;
