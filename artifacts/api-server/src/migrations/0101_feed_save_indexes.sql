-- Migration 0101: Feed and save query performance indexes
-- Not yet applied to production.
--
-- Run these statements manually in the Supabase SQL editor.
-- All statements are idempotent (IF NOT EXISTS).

-- ── posts(post_status, published_at DESC) ────────────────────────────────────
-- Hot path for the public feed query:
--   SELECT * FROM posts WHERE post_status = 'published'
--   ORDER BY published_at DESC LIMIT 20
-- Without this index Postgres seq-scans all posts to evaluate the WHERE clause
-- and then sorts the full result before applying LIMIT.  A composite index on
-- (post_status, published_at DESC) lets Postgres seek directly to published
-- rows in reverse-chronological order, so the LIMIT 20 stops almost instantly.
-- post_status and published_at columns were added by migration 0049.
CREATE INDEX IF NOT EXISTS posts_status_published_at_idx
  ON posts (post_status, published_at DESC);

-- ── post_saves(created_at DESC) ──────────────────────────────────────────────
-- Hot path for the saves listing query:
--   SELECT * FROM post_saves ORDER BY created_at DESC
-- The existing post_saves_post_created_idx (migration 0099) covers
-- (post_id, created_at DESC) which is efficient for per-post saves pages but
-- does not help a full-table listing sorted only by created_at.  This index
-- lets Postgres satisfy the ORDER BY with an index scan instead of a sort.
-- post_saves.created_at was added by migration 0097.
CREATE INDEX IF NOT EXISTS post_saves_created_at_idx
  ON post_saves (created_at DESC);
