-- ============================================================
-- 0062_user_privacy_settings.sql
-- Per-user privacy configuration table.
-- Separate from profiles to avoid SELECT * leakage and from
-- user_message_settings (messaging-only) and location_preferences
-- (location-only) which remain in their own tables.
-- ============================================================

-- Enum: who can perform a social action against this user
DO $$ BEGIN
  CREATE TYPE privacy_visibility AS ENUM (
    'everyone',
    'followers',
    'friends',
    'nobody'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE travel_mode_type AS ENUM (
    'home',
    'traveling',
    'away',
    'hidden'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_privacy_settings (
  user_id                  uuid        PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,

  -- Who can view this user's profile
  profile_visibility       privacy_visibility  NOT NULL DEFAULT 'everyone',

  -- Who can send DMs / message requests
  message_permissions      privacy_visibility  NOT NULL DEFAULT 'everyone',

  -- Who can send friend requests
  friend_request_permissions privacy_visibility NOT NULL DEFAULT 'everyone',

  -- Who can @mention / tag this user
  tagging_permissions      privacy_visibility  NOT NULL DEFAULT 'everyone',

  -- Who can invite this user to trips or circles
  invite_permissions       privacy_visibility  NOT NULL DEFAULT 'everyone',

  -- Who can see this user's current location / travel status
  location_visibility      privacy_visibility  NOT NULL DEFAULT 'friends',

  -- User's self-reported travel state
  travel_mode              travel_mode_type    NOT NULL DEFAULT 'home',

  -- JSONB comfort / content filter overrides (open-ended, versioned by app)
  comfort_settings         jsonb               NOT NULL DEFAULT '{}',

  -- Who can see whether this user is currently online
  online_status_visibility privacy_visibility  NOT NULL DEFAULT 'friends',

  -- Who can see read-receipt indicators on messages
  read_receipts_visibility privacy_visibility  NOT NULL DEFAULT 'friends',

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────
-- PK covers (user_id) lookups; no additional indexes needed for a 1:1 table.

-- ── Updated-at trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION update_user_privacy_settings_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_privacy_settings_updated_at ON user_privacy_settings;
CREATE TRIGGER trg_user_privacy_settings_updated_at
  BEFORE UPDATE ON user_privacy_settings
  FOR EACH ROW EXECUTE FUNCTION update_user_privacy_settings_updated_at();

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE user_privacy_settings ENABLE ROW LEVEL SECURITY;

-- Users read only their own row
DROP POLICY IF EXISTS "privacy_settings_select_own" ON user_privacy_settings;
CREATE POLICY "privacy_settings_select_own"
  ON user_privacy_settings FOR SELECT
  USING (user_id = auth.uid());

-- Users update only their own row
DROP POLICY IF EXISTS "privacy_settings_update_own" ON user_privacy_settings;
CREATE POLICY "privacy_settings_update_own"
  ON user_privacy_settings FOR UPDATE
  USING (user_id = auth.uid());

-- Insert is handled by the service role (on signup) or the user themselves
DROP POLICY IF EXISTS "privacy_settings_insert_own" ON user_privacy_settings;
CREATE POLICY "privacy_settings_insert_own"
  ON user_privacy_settings FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- ── Verification ─────────────────────────────────────────────
-- Run this in the Supabase SQL Editor after applying; expect at least one row.
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'user_privacy_settings'
-- ORDER BY ordinal_position;
