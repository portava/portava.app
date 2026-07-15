-- Migration 0097: post_saves table + posts.save_count column
-- Applied manually to Supabase on 2026-07-04.
--
-- Provides a dedicated save/bookmark system for posts, separate from
-- the generic collections/collection_items mechanism.
-- The API server maintains save_count via increment/decrement on
-- POST /api/posts/:id/save and DELETE /api/posts/:id/save.

-- ── post_saves ────────────────────────────────────────────────────────────────
-- One row per (user, post) pair.  PRIMARY KEY enforces uniqueness so
-- duplicate-save is always idempotent via ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS post_saves (
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id    UUID        NOT NULL REFERENCES posts(id)      ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS post_saves_post_id_idx ON post_saves (post_id);

ALTER TABLE post_saves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "post_saves_own" ON post_saves;
CREATE POLICY "post_saves_own"
  ON post_saves FOR ALL
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── posts.save_count ──────────────────────────────────────────────────────────
-- Integer counter maintained by the API server (not a DB trigger).
-- Defaults to 0 for all existing posts.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS save_count INTEGER NOT NULL DEFAULT 0;
