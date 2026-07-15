-- 0106_engagement_indexes
-- Performance indexes for the GET /api/engagement/likes viewer endpoint.
-- Allows cursor-based pagination (created_at DESC) for each like/reaction table.

CREATE INDEX IF NOT EXISTS idx_posts_likes_post_created
  ON posts_likes (post_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_post_reactions_post_emoji_created
  ON post_reactions (post_id, emoji, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_created
  ON comment_likes (comment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_highlight_likes_highlight_created
  ON highlight_likes (highlight_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_likes_memory_created
  ON memory_likes (memory_id, created_at DESC);
