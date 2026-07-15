-- Phase 4: Interaction Foundation Tables
-- Creates the tables referenced by interactionPermissions.ts (Phase 3) that were
-- classified as MISSING-build-new in the Phase 1 audit.
-- All statements use IF NOT EXISTS so this is safe to re-apply.
-- Policies use DROP...IF EXISTS + CREATE (no IF NOT EXISTS on CREATE POLICY —
-- not supported in standard PostgreSQL syntax).

-- ── User interaction cooldowns ─────────────────────────────────────────────
-- Anti-retaliation gate for repeated social actions after decline/block/report.
-- cooldown_type values: 'message_request' | 'friend_request' | 'follow' | 'nudge' | 'tag'
CREATE TABLE IF NOT EXISTS user_interaction_cooldowns (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_user_id uuid     NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  cooldown_type text      NOT NULL,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_user_id, cooldown_type)
);

CREATE INDEX IF NOT EXISTS idx_uic_user_target
  ON user_interaction_cooldowns (user_id, target_user_id);

ALTER TABLE user_interaction_cooldowns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own cooldowns" ON user_interaction_cooldowns;
CREATE POLICY "Users can read their own cooldowns"
  ON user_interaction_cooldowns FOR SELECT
  USING (auth.uid() = user_id);

-- ── User-level mutes ───────────────────────────────────────────────────────
-- Global user mute (hides person from muter's feeds, notifications, etc.).
-- Orthogonal to message_thread_members.muted_at (thread-scoped mute).
-- mute_types values: 'messages' | 'posts' | 'event_invites' | 'circle_invites' | 'trip_invites' | 'all'
CREATE TABLE IF NOT EXISTS user_mutes (
  id         uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  muter_id   uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  muted_id   uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  mute_types text[]      NOT NULL DEFAULT '{all}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (muter_id, muted_id)
);

CREATE INDEX IF NOT EXISTS idx_user_mutes_muter ON user_mutes (muter_id);

ALTER TABLE user_mutes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own mutes" ON user_mutes;
CREATE POLICY "Users can manage their own mutes"
  ON user_mutes FOR ALL
  USING (auth.uid() = muter_id);

-- ── User-initiated restrictions ────────────────────────────────────────────
-- restrictor hides read receipts + online status from restricted user; messages
-- are downgraded to requests; restricted user is NOT notified.
-- Separate from admin trust restrictions in trust-admin.ts.
CREATE TABLE IF NOT EXISTS user_restrictions (
  id            uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  restrictor_id uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  restricted_id uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  options       jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restrictor_id, restricted_id)
);

CREATE INDEX IF NOT EXISTS idx_user_restrictions_restrictor
  ON user_restrictions (restrictor_id);

ALTER TABLE user_restrictions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own restrictions" ON user_restrictions;
CREATE POLICY "Users can manage their own restrictions"
  ON user_restrictions FOR ALL
  USING (auth.uid() = restrictor_id);

-- ── Unified reports ────────────────────────────────────────────────────────
-- Single cross-domain report table replacing scattered domain tables.
-- target_type: 'user' | 'message' | 'thread' | 'trip' | 'post' | 'place' | 'event'
-- reason_code: 'harassment' | 'spam' | 'hate_speech' | 'violence' |
--              'impersonation' | 'nudity' | 'misinformation' | 'other'
-- severity:    'low' | 'normal' | 'high' | 'critical'
-- status:      'open' | 'reviewed' | 'resolved' | 'dismissed'
CREATE TABLE IF NOT EXISTS reports (
  id               uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  reporter_id      uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_type      text        NOT NULL,
  target_id        uuid        NOT NULL,
  reason_code      text        NOT NULL,
  reason_detail    text        CHECK (char_length(reason_detail) <= 500),
  context_type     text,
  context_id       uuid,
  severity         text        NOT NULL DEFAULT 'normal',
  status           text        NOT NULL DEFAULT 'open',
  moderation_notes text,
  reviewed_by      uuid        REFERENCES profiles(id),
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reports_reporter
  ON reports (reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_target
  ON reports (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_status
  ON reports (status, created_at DESC);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Reporters can read their own reports" ON reports;
CREATE POLICY "Reporters can read their own reports"
  ON reports FOR SELECT
  USING (auth.uid() = reporter_id);

-- ── User profile saves ─────────────────────────────────────────────────────
-- Private bookmark of a user profile.
-- Grants NO access to private content — purely a social bookmark.
CREATE TABLE IF NOT EXISTS user_saves (
  id         uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  saver_id   uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  saved_id   uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (saver_id, saved_id)
);

CREATE INDEX IF NOT EXISTS idx_user_saves_saver ON user_saves (saver_id);

ALTER TABLE user_saves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own saves" ON user_saves;
CREATE POLICY "Users can manage their own saves"
  ON user_saves FOR ALL
  USING (auth.uid() = saver_id);

-- ── Moderation actions ─────────────────────────────────────────────────────
-- Admin/moderator action log against users or content.
-- Referenced by interactionPermissions.ts safetyWarnings ('target_under_moderation').
CREATE TABLE IF NOT EXISTS moderation_actions (
  id             uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  target_user_id uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  action_type    text        NOT NULL,
  reason         text,
  performed_by   uuid        REFERENCES profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mod_actions_target
  ON moderation_actions (target_user_id);

ALTER TABLE moderation_actions ENABLE ROW LEVEL SECURITY;

-- ── User account states ────────────────────────────────────────────────────
-- Separate table so suspended/banned columns never appear in SELECT * on profiles.
-- state values: 'active' | 'suspended' | 'limited' | 'deleted' | 'deactivated' | 'banned'
CREATE TABLE IF NOT EXISTS user_account_states (
  id         uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  state      text        NOT NULL,
  reason     text,
  expires_at timestamptz,
  set_by     uuid        REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, state)
);

CREATE INDEX IF NOT EXISTS idx_uas_user ON user_account_states (user_id);

ALTER TABLE user_account_states ENABLE ROW LEVEL SECURITY;

-- ── User privacy settings ──────────────────────────────────────────────────
-- Unified per-user privacy config for tag/find/invite/online-status control.
-- who_can_tag: 'anyone' | 'friends_only' | 'interacted' | 'nobody'
-- profile_visibility: 'public' | 'private' | NULL (falls back to profiles.is_private)
CREATE TABLE IF NOT EXISTS user_privacy_settings (
  id                       uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                  uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  profile_visibility       text,
  who_can_tag              text,
  age_restriction_enabled  boolean     NOT NULL DEFAULT false,
  allow_location_sharing   boolean     NOT NULL DEFAULT true,
  show_online_status       boolean     NOT NULL DEFAULT true,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE user_privacy_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own privacy settings" ON user_privacy_settings;
CREATE POLICY "Users can manage their own privacy settings"
  ON user_privacy_settings FOR ALL
  USING (auth.uid() = user_id);
