-- Migration 20260814: Media stamp-it reactions
-- Records "Stamp It" long-press reactions on media posts (Watch feed).
-- Separate from post_reactions (which has a single-reaction-per-user unique
-- constraint) so a stamp_it never conflicts with a normal ❤️ like row.
--
-- Design choices:
--   - Idempotent: UNIQUE (post_id, user_id) — a second stamp_it from the same
--     viewer on the same post is silently ignored.
--   - Cascades on post delete — no orphan rows.
--   - No FK to auth.users (service-role insert; user_id is always valid at
--     write time; avoids cross-schema FK maintenance cost).

CREATE TABLE IF NOT EXISTS media_stamp_reactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT media_stamp_reactions_post_user_unique UNIQUE (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_media_stamp_reactions_post_id
  ON media_stamp_reactions (post_id, created_at DESC);
