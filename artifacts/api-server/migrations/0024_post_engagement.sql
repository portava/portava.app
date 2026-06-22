-- Migration 0024: post engagement tables (likes, comments) + posts counters
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS

-- Engagement counters on posts
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS like_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comment_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS share_count   INTEGER NOT NULL DEFAULT 0;

-- posts_likes: one row per (post, user) — unique so upsert is idempotent
CREATE TABLE IF NOT EXISTS posts_likes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS posts_likes_post_idx ON posts_likes (post_id);
CREATE INDEX IF NOT EXISTS posts_likes_user_idx ON posts_likes (user_id);

ALTER TABLE posts_likes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='posts_likes' AND policyname='posts_likes_select') THEN
    CREATE POLICY posts_likes_select ON posts_likes FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='posts_likes' AND policyname='posts_likes_insert') THEN
    CREATE POLICY posts_likes_insert ON posts_likes FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='posts_likes' AND policyname='posts_likes_delete') THEN
    CREATE POLICY posts_likes_delete ON posts_likes FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- posts_comments: soft-delete via deleted_at
CREATE TABLE IF NOT EXISTS posts_comments (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body       TEXT        NOT NULL CHECK (length(body) > 0 AND length(body) <= 1000),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS posts_comments_post_idx ON posts_comments (post_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS posts_comments_user_idx ON posts_comments (user_id);

ALTER TABLE posts_comments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='posts_comments' AND policyname='posts_comments_select') THEN
    CREATE POLICY posts_comments_select ON posts_comments FOR SELECT USING (deleted_at IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='posts_comments' AND policyname='posts_comments_insert') THEN
    CREATE POLICY posts_comments_insert ON posts_comments FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='posts_comments' AND policyname='posts_comments_update') THEN
    CREATE POLICY posts_comments_update ON posts_comments FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;
