-- Migration 0104: Compass new tables
-- Adds compass_feedback, compass_recent_context, compass_settings.
-- All statements are idempotent (IF NOT EXISTS). RLS restricts to owning user.

-- ── compass_feedback ──────────────────────────────────────────────────────────
-- Structured per-recommendation feedback distinct from compass_feedback_events
-- (which is the append-only preference-update audit log).
-- This table captures the discrete in-feed feedback actions users take.

CREATE TABLE IF NOT EXISTS compass_feedback (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id           TEXT        NOT NULL,
  item_type         TEXT        NOT NULL,
  action            TEXT        NOT NULL CHECK (action IN (
    'not_now', 'not_interested', 'more_like_this', 'hide',
    'wrong_city', 'already_went', 'not_safe', 'wrong_vibe',
    'too_expensive', 'report'
  )),
  recommendation_id TEXT,
  metadata          JSONB       DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compass_feedback_user_idx
  ON compass_feedback (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS compass_feedback_item_idx
  ON compass_feedback (item_id, action);

ALTER TABLE compass_feedback ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'compass_feedback' AND policyname = 'compass_feedback_owner'
  ) THEN
    CREATE POLICY compass_feedback_owner ON compass_feedback
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── compass_recent_context ────────────────────────────────────────────────────
-- Persists the user's most recent Compass context session between app launches.
-- expires_at enforces session freshness; stale rows are treated as absent.

CREATE TABLE IF NOT EXISTS compass_recent_context (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  context_state    TEXT        NOT NULL DEFAULT 'normal',
  intent_mode      TEXT        NOT NULL DEFAULT 'explore_now',
  city             TEXT,
  country          TEXT,
  signals          JSONB       DEFAULT '{}',
  client_hints     JSONB       DEFAULT '{}',
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '4 hours'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compass_recent_context_user_expires_idx
  ON compass_recent_context (user_id, expires_at);

ALTER TABLE compass_recent_context ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'compass_recent_context' AND policyname = 'compass_recent_context_owner'
  ) THEN
    CREATE POLICY compass_recent_context_owner ON compass_recent_context
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── compass_settings ──────────────────────────────────────────────────────────
-- User-level privacy and data-use settings for Compass personalisation.
-- Distinct from compass_user_preferences (interest weights/categories):
-- these are binary on/off privacy controls the user sees in Settings.

CREATE TABLE IF NOT EXISTS compass_settings (
  user_id                      UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  use_location                 BOOLEAN     NOT NULL DEFAULT true,
  use_trip_data                BOOLEAN     NOT NULL DEFAULT true,
  use_saved_items              BOOLEAN     NOT NULL DEFAULT true,
  use_history                  BOOLEAN     NOT NULL DEFAULT true,
  show_buddy_recommendations   BOOLEAN     NOT NULL DEFAULT true,
  show_people_recommendations  BOOLEAN     NOT NULL DEFAULT true,
  allow_smart_notifications    BOOLEAN     NOT NULL DEFAULT true,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE compass_settings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'compass_settings' AND policyname = 'compass_settings_owner'
  ) THEN
    CREATE POLICY compass_settings_owner ON compass_settings
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;
