-- 0024_post_engagement.sql
-- Social engagement: likes and comments for posts
-- Adds denormalized counters to posts for fast feed queries

-- ── posts_likes ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts_likes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, user_id)
);

ALTER TABLE posts_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "posts_likes_select_all"
  ON posts_likes FOR SELECT USING (true);

CREATE POLICY "posts_likes_insert_own"
  ON posts_likes FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "posts_likes_delete_own"
  ON posts_likes FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS posts_likes_post_id_idx ON posts_likes (post_id);
CREATE INDEX IF NOT EXISTS posts_likes_user_id_idx ON posts_likes (user_id);

-- ── posts_comments ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts_comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id           uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body              text NOT NULL,
  parent_comment_id uuid REFERENCES posts_comments(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz,
  deleted_at        timestamptz,
  CHECK (char_length(trim(body)) BETWEEN 1 AND 1000)
);

ALTER TABLE posts_comments ENABLE ROW LEVEL SECURITY;

-- Visible comments only (soft-delete pattern)
CREATE POLICY "posts_comments_select"
  ON posts_comments FOR SELECT USING (deleted_at IS NULL);

CREATE POLICY "posts_comments_insert_own"
  ON posts_comments FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Author may edit/soft-delete their own comment
CREATE POLICY "posts_comments_update_own"
  ON posts_comments FOR UPDATE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS posts_comments_post_id_idx ON posts_comments (post_id);
CREATE INDEX IF NOT EXISTS posts_comments_user_id_idx ON posts_comments (user_id);

-- ── Denormalized counters on posts ────────────────────────────────────────────
-- DEFAULT 0 so all existing rows are valid immediately after migration.
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS like_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comment_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS share_count   integer NOT NULL DEFAULT 0;
