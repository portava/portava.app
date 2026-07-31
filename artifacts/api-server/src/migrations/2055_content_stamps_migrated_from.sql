-- Migration 2055: content_stamps — add migrated_from column
--
-- Marks rows in content_stamps that were bulk-inserted from the legacy like
-- tables (posts_likes, media_likes, post_reactions) during the
-- 2049_content_stamps migration.
--
-- The Compass outcome-signal handler checks this column and skips firing a new
-- "liked" signal for migrated rows, preventing the intelligence graph from
-- double-counting a like that was already recorded by the old
-- /posts/:id/like endpoint.  Without this guard, replaying or reweighting
-- historical signals would inflate affinity scores for early-adopter content.

ALTER TABLE content_stamps
  ADD COLUMN IF NOT EXISTS migrated_from TEXT;

-- Backfill rows that originated from posts_likes.
-- Identified by matching (user_id, entity_id) against the legacy source table.
-- Guarded with IF EXISTS since posts_likes may not exist in all environments.
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'posts_likes'
  ) THEN
    UPDATE content_stamps cs
       SET migrated_from = 'posts_likes'
     WHERE cs.entity_type   = 'post'
       AND cs.migrated_from IS NULL
       AND EXISTS (
             SELECT 1 FROM posts_likes pl
              WHERE pl.user_id = cs.user_id
                AND pl.post_id = cs.entity_id
           );
  END IF;
END $$;

-- Backfill rows that originated from media_likes.
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'media_likes'
  ) THEN
    UPDATE content_stamps cs
       SET migrated_from = 'media_likes'
     WHERE cs.entity_type   = 'media'
       AND cs.migrated_from IS NULL
       AND EXISTS (
             SELECT 1 FROM media_likes ml
              WHERE ml.user_id = cs.user_id
                AND ml.media_id = cs.entity_id
           );
  END IF;
END $$;

-- Backfill rows that originated from post_reactions (Watch-feed ❤️ likes).
-- Only heart-emoji rows were migrated as stamps; other emoji are not affected.
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'post_reactions'
  ) THEN
    UPDATE content_stamps cs
       SET migrated_from = 'post_reactions'
     WHERE cs.entity_type   = 'media'
       AND cs.migrated_from IS NULL
       AND EXISTS (
             SELECT 1 FROM post_reactions pr
              WHERE pr.user_id = cs.user_id
                AND pr.post_id = cs.entity_id
                AND pr.emoji   = '❤️'
           );
  END IF;
END $$;
