-- Migration 0069: profile_privacy_settings + account_status on profiles
-- Comprehensive per-user privacy preference table.
-- Separate from user_privacy_settings (used by interactionPermissions engine).
-- Apply via Supabase SQL Editor or psql.

-- ── account_status column on profiles ────────────────────────────────────────
-- Canonical profile-level account status. Updated in sync with user_account_states.
-- Values: 'active' (default) | 'deactivated' | 'suspended' | 'banned' | 'deleted'
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('active', 'deactivated', 'suspended', 'banned', 'deleted'));

CREATE INDEX IF NOT EXISTS idx_profiles_account_status ON profiles (account_status)
  WHERE account_status <> 'active';

CREATE TABLE IF NOT EXISTS profile_privacy_settings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  profile_visibility       TEXT NOT NULL DEFAULT 'public'
                           CHECK (profile_visibility IN ('public', 'followers_only', 'private')),
  show_current_city        BOOLEAN NOT NULL DEFAULT true,
  show_home_country        BOOLEAN NOT NULL DEFAULT true,
  show_visited_places      BOOLEAN NOT NULL DEFAULT true,
  show_upcoming_trips      BOOLEAN NOT NULL DEFAULT true,
  show_past_trips          BOOLEAN NOT NULL DEFAULT true,
  show_posts               BOOLEAN NOT NULL DEFAULT true,
  show_stamps              BOOLEAN NOT NULL DEFAULT true,
  show_friends             BOOLEAN NOT NULL DEFAULT true,
  show_followers           BOOLEAN NOT NULL DEFAULT true,
  allow_messages_from      TEXT NOT NULL DEFAULT 'everyone'
                           CHECK (allow_messages_from IN ('everyone', 'friends', 'followers', 'nobody')),
  allow_friend_requests    BOOLEAN NOT NULL DEFAULT true,
  allow_follow             BOOLEAN NOT NULL DEFAULT true,
  allow_tagging            BOOLEAN NOT NULL DEFAULT true,
  allow_profile_discovery  BOOLEAN NOT NULL DEFAULT true,
  delayed_posting_default  BOOLEAN NOT NULL DEFAULT false,
  precise_location_visible BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pps_user ON profile_privacy_settings (user_id);

ALTER TABLE profile_privacy_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "owner can manage own privacy settings"
  ON profile_privacy_settings FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "service role full access"
  ON profile_privacy_settings FOR ALL TO service_role USING (true);

-- ── user_deletion_requests — 30-day soft-delete hold ─────────────────────────

CREATE TABLE IF NOT EXISTS user_deletion_requests (
  user_id       UUID NOT NULL PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'cancelled', 'completed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_deletion_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "owner can manage deletion request"
  ON user_deletion_requests FOR ALL TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "service role full access udr"
  ON user_deletion_requests FOR ALL TO service_role USING (true);
