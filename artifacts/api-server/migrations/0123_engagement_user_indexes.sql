-- 0123_engagement_user_indexes
-- User-perspective indexes for engagement like/reaction tables.
-- Complements the post-perspective indexes from migration 0106
-- (idx_posts_likes_post_created etc.) which support cursor-based pagination
-- in GET /api/engagement/likes.
--
-- These indexes cover the reverse lookup: "which posts/comments/highlights/
-- memories has a given user liked?" — used by profile pages and the
-- 'liked by me' indicator on the feed. Without them Postgres must do a
-- sequential scan on each like table filtered by user_id.
--
-- All idempotent (IF NOT EXISTS) — safe to re-apply.

CREATE INDEX IF NOT EXISTS idx_posts_likes_user_created
  ON posts_likes (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_post_reactions_user_created
  ON post_reactions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comment_likes_user_created
  ON comment_likes (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_highlight_likes_user_created
  ON highlight_likes (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_likes_user_created
  ON memory_likes (user_id, created_at DESC);
