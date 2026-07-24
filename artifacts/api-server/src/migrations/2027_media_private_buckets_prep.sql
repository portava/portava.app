-- Migration 2027: bucket-privacy STAGE 1 (prep) — flag + lookup indexes
--
-- Prepares for making the post-media bucket private WITHOUT changing any
-- behavior. The actual flip is a separate, deliberate, owner-run step
-- (STAGE3-flip-post-media-private.sql, with a matching rollback file).
--
--   1. Flag `media_private_buckets_enabled` (OFF): the /api/media/file
--      endpoint serves 302→public-URL while off, 302→signed-URL when on.
--      Authorization is enforced in BOTH modes.
--   2. Btree indexes for the object→entity lookups the authorizer performs
--      (messages/stories/highlights by media_url, post_media by storage_path,
--      trips by cover_url). All additive + idempotent.
--
-- NOTE prefix: numbered 0191 assuming 0190_media_assets is the current top.
-- Your agent also adds migrations — run checkMigrationPrefixes after applying;
-- if 0191 is taken, rename this file to the next free prefix (contents don't care).

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('media_private_buckets_enabled', FALSE,
   'Bucket privacy: /api/media/file serves signed URLs for private buckets (flip buckets via STAGE3 script first)')
ON CONFLICT (flag) DO NOTHING;

CREATE INDEX IF NOT EXISTS messages_media_url_idx
  ON messages (media_url) WHERE media_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_media_thumb_url_idx
  ON messages (media_thumbnail_url) WHERE media_thumbnail_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS stories_media_url_idx
  ON stories (media_url);
CREATE INDEX IF NOT EXISTS highlights_media_url_idx
  ON highlights (media_url);
CREATE INDEX IF NOT EXISTS post_media_storage_path_idx
  ON post_media (storage_path);
CREATE INDEX IF NOT EXISTS trips_cover_url_idx
  ON trips (cover_url) WHERE cover_url IS NOT NULL;
-- posts.media_urls is text[] — GIN enables the contains() lookup.
CREATE INDEX IF NOT EXISTS posts_media_urls_gin_idx
  ON posts USING gin (media_urls);
