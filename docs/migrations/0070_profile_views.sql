-- Migration 0070: profile_views + post_impressions tables for private owner analytics
-- Tracks authenticated non-owner profile views so owners can see interest
-- in their passport without exposing viewer identity.
-- Apply via Supabase SQL Editor or psql.

CREATE TABLE IF NOT EXISTS profile_views (
  id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  viewer_id UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary analytics query: target's views within a time window.
CREATE INDEX IF NOT EXISTS profile_views_target_viewed_idx
  ON profile_views (target_id, viewed_at DESC);

-- Viewer lookup (rare; used only for dedup if needed in future).
CREATE INDEX IF NOT EXISTS profile_views_viewer_idx
  ON profile_views (viewer_id)
  WHERE viewer_id IS NOT NULL;

-- Post impressions: tracks when a post_card is viewed by a non-owner.
-- Inserted fire-and-forget from the passport postcard feed routes.
-- Aggregated in GET /me/profile/analytics for the owner only.
CREATE TABLE IF NOT EXISTS post_impressions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID        NOT NULL,            -- references post_cards(id)
  user_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,  -- post owner
  viewer_id  UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary analytics query: owner's impressions in a time window.
CREATE INDEX IF NOT EXISTS post_impressions_user_viewed_idx
  ON post_impressions (user_id, viewed_at DESC);

-- Performance indexes for profile discovery queries
-- profiles(username) — passport lookup by username
CREATE INDEX IF NOT EXISTS profiles_username_idx
  ON profiles (username)
  WHERE username IS NOT NULL;

-- profiles(account_status) — exclude deactivated/banned in search
CREATE INDEX IF NOT EXISTS profiles_account_status_idx
  ON profiles (account_status)
  WHERE account_status <> 'active';

-- user_follows(follower_id) — follower list queries
CREATE INDEX IF NOT EXISTS user_follows_follower_id_idx
  ON user_follows (follower_id);

-- user_follows(following_id) — following list queries
CREATE INDEX IF NOT EXISTS user_follows_following_id_idx
  ON user_follows (following_id);

-- stamps(user_id) — stamp count queries
CREATE INDEX IF NOT EXISTS stamps_user_id_idx
  ON stamps (user_id)
  WHERE user_id IS NOT NULL;

-- user_deletion_requests(status) — admin deletion queue filter
CREATE INDEX IF NOT EXISTS user_deletion_requests_status_idx
  ON user_deletion_requests (status, scheduled_at)
  WHERE status = 'pending';
