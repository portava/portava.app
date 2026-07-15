-- Migration 0066: Post & Comment Interaction Layer
-- Adds post_reactions, comment_likes, post_shares tables,
-- and owner-control columns on posts.

-- ── post_reactions ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_reactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT post_reactions_user_post_unique UNIQUE (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_post_reactions_post_id ON post_reactions(post_id);

-- ── comment_likes ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comment_likes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id  UUID        NOT NULL REFERENCES posts_comments(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT comment_likes_user_comment_unique UNIQUE (comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_id ON comment_likes(comment_id);

-- ── post_shares ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_shares (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT post_shares_dedup_unique UNIQUE (post_id, user_id, target)
);
CREATE INDEX IF NOT EXISTS idx_post_shares_post_id ON post_shares(post_id);

-- ── Owner-control columns on posts ────────────────────────────────────────────
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS comments_setting   TEXT    NOT NULL DEFAULT 'everyone',
  ADD COLUMN IF NOT EXISTS likes_hidden        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sharing_disabled    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reposting_disabled  BOOLEAN NOT NULL DEFAULT FALSE;

-- Constrain comments_setting to known values
ALTER TABLE posts
  DROP CONSTRAINT IF EXISTS posts_comments_setting_check;
ALTER TABLE posts
  ADD CONSTRAINT posts_comments_setting_check
    CHECK (comments_setting IN ('everyone','friends','circle','trip_crew','verified','disabled'));

-- ── Threaded replies: parent_comment_id on posts_comments ─────────────────────
ALTER TABLE posts_comments
  ADD COLUMN IF NOT EXISTS parent_comment_id UUID REFERENCES posts_comments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_posts_comments_parent
  ON posts_comments(parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;

-- ── post_edits: tracks body changes for edit history ──────────────────────────
CREATE TABLE IF NOT EXISTS post_edits (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id),
  old_content TEXT,
  new_content TEXT,
  edited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_edits_post_id ON post_edits(post_id);
