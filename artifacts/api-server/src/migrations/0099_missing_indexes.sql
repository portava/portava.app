-- Migration 0099: Missing performance indexes
-- Not yet applied to production.
--
-- Run these statements manually in the Supabase SQL editor.
-- All statements are idempotent (IF NOT EXISTS).

-- ── posts(author_id, post_status) ─────────────────────────────────────────────
-- Hot path for feed queries that filter by author and publication state.
-- post_status column added by migration 0049_delayed_geotag_posts.sql.
CREATE INDEX IF NOT EXISTS posts_author_status_idx
  ON posts (author_id, post_status);

-- ── post_saves(post_id, created_at DESC) ──────────────────────────────────────
-- Allows efficient ordered listing of saves per post (e.g. "who saved this post"
-- paginated by save time).  Supplements the existing post_saves_post_id_idx
-- (post_id only) added in migration 0097.
CREATE INDEX IF NOT EXISTS post_saves_post_created_idx
  ON post_saves (post_id, created_at DESC);
