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

-- ── Row-level access for post_media ──────────────────────────────────────────
--
-- Write policy: the inserting/updating user must own both the media row AND
-- the parent post.  This prevents an authenticated client from attaching media
-- rows to another user's post via a direct Supabase client call.
DROP POLICY IF EXISTS "post_media_owner_write" ON post_media;
CREATE POLICY "post_media_owner_write"
  ON post_media FOR ALL
  USING  (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM posts
      WHERE posts.id = post_media.post_id
        AND posts.author_id = auth.uid()
    )
  );

-- Select policy: owner always sees all their media (including pending/failed/rejected).
-- Other callers may read ready, non-rejected/flagged media when they are permitted to
-- see the parent post under the production visibility model (public / trip_only).
-- Note: post_visibility enum only has public, trip_only, private — no followers branch.
DROP POLICY IF EXISTS "post_media_public_select" ON post_media;
CREATE POLICY "post_media_public_select"
  ON post_media FOR SELECT
  USING (
    -- Owner always sees all their own media
    user_id = auth.uid()
    OR (
      -- Media must be ready and not moderated out
      post_media.processing_status = 'ready'
      AND post_media.moderation_status NOT IN ('rejected', 'flagged')
      -- No block relationship between the viewer and the author
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE (b.blocker_id = auth.uid() AND b.blocked_id = post_media.user_id)
           OR (b.blocker_id = post_media.user_id AND b.blocked_id = auth.uid())
      )
      -- Viewer is authorized to see the parent post under the visibility model
      AND EXISTS (
        SELECT 1 FROM posts p
        WHERE p.id     = post_media.post_id
          AND p.status = 'active'
          AND (
            -- public: any authenticated caller
            p.visibility = 'public'
            -- trip_only: caller is a member of the parent trip
            OR (
              p.visibility = 'trip_only'
              AND p.trip_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM trip_members tm
                WHERE tm.trip_id = p.trip_id
                  AND tm.user_id = auth.uid()
              )
            )
          )
      )
    )
  );

-- ── Storage bucket policies: post-media ───────────────────────────────────────
-- Path convention enforced by the API server: post-media/{userId}/{postId}/{mediaId}.{ext}
-- These policies restrict direct (non-signed-URL) storage access.  Signed
-- upload URLs issued by the API server bypass RLS — these policies are
-- defence-in-depth for clients that attempt direct bucket access.
DROP POLICY IF EXISTS "post_media_storage_owner_insert" ON storage.objects;
CREATE POLICY "post_media_storage_owner_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'post-media'
    -- Restrict upload to the caller's own user-prefix folder
    AND (storage.foldername(name))[1] = auth.uid()::text
    -- Allow only supported image and video file extensions (defence-in-depth;
    -- the API server enforces MIME type and size before issuing signed URLs)
    AND lower(storage.extension(name)) IN (
      'jpg', 'jpeg', 'png', 'webp', 'heic',
      'mp4', 'mov', 'webm', '3gp'
    )
  );

DROP POLICY IF EXISTS "post_media_storage_owner_delete" ON storage.objects;
CREATE POLICY "post_media_storage_owner_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'post-media'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "post_media_storage_public_read" ON storage.objects;
CREATE POLICY "post_media_storage_public_read"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'post-media');

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
