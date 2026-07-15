-- Migration 0116: Post Hides
-- Users can hide individual posts from their feeds.
-- The feed query will filter out hidden posts using a NOT IN / LEFT JOIN pattern.

CREATE TABLE IF NOT EXISTS post_hides (
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id    UUID        NOT NULL REFERENCES posts(id)      ON DELETE CASCADE,
  hidden_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT post_hides_unique UNIQUE (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_post_hides_user    ON post_hides(user_id);
CREATE INDEX IF NOT EXISTS idx_post_hides_user_post ON post_hides(user_id, post_id);

ALTER TABLE post_hides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own post hides" ON post_hides;
CREATE POLICY "Users can manage their own post hides"
  ON post_hides FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
