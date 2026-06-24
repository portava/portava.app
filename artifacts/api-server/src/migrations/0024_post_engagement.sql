-- Migration: 0024_post_engagement.sql
-- Creates posts_likes and posts_comments tables; adds counters to posts.

CREATE TABLE IF NOT EXISTS posts_likes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT posts_likes_unique UNIQUE (post_id, user_id)
);

ALTER TABLE posts_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_view_post_likes" ON posts_likes
  FOR SELECT USING (true);

CREATE POLICY "users_insert_post_like" ON posts_likes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_like" ON posts_likes
  FOR DELETE USING (auth.uid() = user_id);


CREATE TABLE IF NOT EXISTS posts_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  body        text NOT NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS posts_comments_post_idx ON posts_comments(post_id);

ALTER TABLE posts_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_view_post_comments" ON posts_comments
  FOR SELECT USING (deleted_at IS NULL);

CREATE POLICY "users_insert_post_comment" ON posts_comments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_comment" ON posts_comments
  FOR DELETE USING (auth.uid() = user_id);


-- Engagement counters on posts
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS like_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comment_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS share_count   integer NOT NULL DEFAULT 0;
