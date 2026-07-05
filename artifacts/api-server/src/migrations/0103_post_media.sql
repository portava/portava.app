-- Migration: 0103_post_media.sql
-- Adds structured post_media table + media summary columns on posts and passport_postcards.
--
-- Audit of existing media state (as of migration 0102):
--   posts.media_urls           — text[] of public Storage URLs (images + video, may mix types)
--   posts.media_type           — single text field for the primary MIME type
--   posts.add_to_passport      — bool; auto-creates passport_postcards when true + media present
--   passport_postcards.media_url — single text URL (first media of the parent post)
--   Storage bucket: post-media (public, accepts image/* and video/*)
--   Upload path: post-media/{userId}/{timestamp}.{ext}  (proxied through API server)
--   Gap: no per-item metadata (duration, dimensions, thumbnail, processing/moderation status)
--   Gap: no structured join from post → individual media rows
--   Gap: posts/postcards lack media summary columns for feed serialisation

-- ── post_media ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_media (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id                UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id                UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  media_type             TEXT        NOT NULL CHECK (media_type IN ('image', 'video')),
  storage_bucket         TEXT        NOT NULL DEFAULT 'post-media',
  storage_path           TEXT        NOT NULL DEFAULT '',
  public_url             TEXT        NOT NULL DEFAULT '',
  thumbnail_url          TEXT,
  thumbnail_storage_path TEXT,
  mime_type              TEXT        NOT NULL,
  file_size_bytes        BIGINT,
  duration_seconds       FLOAT,
  width                  INTEGER,
  height                 INTEGER,
  processing_status      TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (processing_status IN ('pending', 'ready', 'failed')),
  moderation_status      TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (moderation_status IN ('pending', 'approved', 'flagged', 'rejected')),
  sort_order             INTEGER     NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS post_media_post_id_idx
  ON post_media (post_id);

CREATE INDEX IF NOT EXISTS post_media_user_id_idx
  ON post_media (user_id);

CREATE INDEX IF NOT EXISTS post_media_post_status_idx
  ON post_media (post_id, processing_status);

ALTER TABLE post_media ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "post_media_owner_write" ON post_media;
CREATE POLICY "post_media_owner_write"
  ON post_media FOR ALL
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "post_media_public_select" ON post_media;
CREATE POLICY "post_media_public_select"
  ON post_media FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM posts p
      WHERE p.id = post_media.post_id
        AND p.status = 'active'
        AND p.visibility = 'public'
    )
  );

-- ── Extend posts ────────────────────────────────────────────────────────────────
ALTER TABLE posts ADD COLUMN IF NOT EXISTS primary_media_type TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_count        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS has_video          BOOLEAN NOT NULL DEFAULT false;

UPDATE posts
SET
  primary_media_type = CASE
    WHEN array_length(media_urls, 1) > 0 THEN 'image'
    ELSE 'none'
  END,
  media_count = COALESCE(array_length(media_urls, 1), 0),
  has_video   = false
WHERE primary_media_type IS NULL;

-- ── Extend passport_postcards ────────────────────────────────────────────────────
ALTER TABLE passport_postcards ADD COLUMN IF NOT EXISTS primary_media_type TEXT;
ALTER TABLE passport_postcards ADD COLUMN IF NOT EXISTS media_count        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE passport_postcards ADD COLUMN IF NOT EXISTS has_video          BOOLEAN NOT NULL DEFAULT false;

UPDATE passport_postcards
SET
  primary_media_type = 'image',
  media_count        = 1,
  has_video          = false
WHERE primary_media_type IS NULL;
