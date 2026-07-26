-- 20260812_posts_publish_at.sql
--
-- Adds publish_at to the posts table for the delayed-posting privacy gate.
--
-- Context: the media feed eligibility filter (mediaEligibility.ts) and the
-- candidate query in mediaFeed.ts enforce delayed posting by checking
-- publish_at IS NULL OR publish_at <= now().  Without this column the feed
-- query would fail with an "unknown column" DB error.
--
-- Post lifecycle for delayed posts:
--   1. Author creates post with post_status = 'pending_delay' and a future
--      publish_at timestamp.
--   2. The delayedPostPublisher scheduler runs periodically; when it fires
--      it flips post_status = 'published' and clears publish_at.
--   3. The media feed gate (publish_at IS NULL OR publish_at <= now()) is a
--      belt-and-suspenders guard in case the scheduler misses a window.
--
-- post_status is the PRIMARY delayed-post gate; publish_at is secondary.
-- Both must pass for an item to appear in the feed.
--
-- Existing rows: publish_at defaults to NULL (no scheduled time) so they
-- behave exactly as before.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS posts_publish_at_idx
  ON posts (publish_at)
  WHERE publish_at IS NOT NULL;

COMMENT ON COLUMN posts.publish_at IS
  'Scheduled publish time for delayed posts. NULL = publish immediately / already published. Feed queries exclude rows where publish_at > now().';
