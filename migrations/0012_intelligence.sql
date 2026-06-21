-- ============================================================================
-- Travel Buddy — Migration 0012
-- Telegraph Intelligence Pack
--
-- Source: artifacts/api-server/migrations/20260620_telegraph_intelligence.sql
--
-- Tables created:
--   user_preference_profiles  — per-user explicit + inferred preference store
--   user_preference_events    — feedback signal log driving preference learning
--
-- RLS: users can only read/write their own rows (ALL-operations policy).
-- Safe to run multiple times (all statements are idempotent).
-- ============================================================================

-- ── User Preference Profiles ──────────────────────────────────────────────────
-- Stores explicit user settings and inferred behavioral signals.
-- explicit_preferences_json: set by the user in Settings
-- inferred_preferences_json: learned by the engine, reset via POST /reset-learned

CREATE TABLE IF NOT EXISTS user_preference_profiles (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  explicit_preferences_json  TEXT NOT NULL DEFAULT '{}',
  inferred_preferences_json  TEXT NOT NULL DEFAULT '{}',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

-- RLS: users can only read/write their own profile
ALTER TABLE user_preference_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_preference_profiles_owner" ON user_preference_profiles;
CREATE POLICY "user_preference_profiles_owner" ON user_preference_profiles
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── User Preference Events ────────────────────────────────────────────────────
-- Immutable log of behavioral signals (save, dismiss, more_like_this, etc.)
-- Used by the learning engine to compute inferred preferences with recency decay.
-- Privacy: no other user's events are ever exposed; scoped to user_id only.

CREATE TABLE IF NOT EXISTS user_preference_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recommendation_id TEXT NOT NULL,
  category          TEXT NOT NULL,
  signal            TEXT NOT NULL,   -- save | add_to_plan | more_like_this | less_like_this | not_for_me | dismiss | view | share
  trip_id           UUID REFERENCES trips(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for recency-weighted queries
CREATE INDEX IF NOT EXISTS user_preference_events_user_created
  ON user_preference_events (user_id, created_at DESC);

-- RLS: users can only read/write their own events
ALTER TABLE user_preference_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_preference_events_owner" ON user_preference_events;
CREATE POLICY "user_preference_events_owner" ON user_preference_events
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
