-- Migration 0068: Stories + Close Friends / Trusted Crew
-- ⚠️  Apply in Supabase SQL Editor — not applied automatically.
--
-- Creates:
--   story_state enum, story_visibility enum
--   stories table (24h-expiry ephemeral posts)
--   story_views (idempotent viewer tracking)
--   story_reactions (emoji reactions)
--   story_replies (direct text replies, private to owner+sender)
--   close_friends (private list, owner-only readable)
--
-- RLS:
--   stories    — public read for active+visible; owner all; service-role all
--   story_views — owner read own story's viewers; viewer read own views; service-role all
--   story_reactions — owner read; own insert/delete; service-role all
--   story_replies   — owner+sender read; sender insert; service-role all
--   close_friends   — owner all (strictly private); service-role all

-- ── Enums ──────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE story_state AS ENUM ('active', 'expired', 'saved', 'deleted', 'removed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE story_visibility AS ENUM (
    'public',
    'friends_only',
    'close_friends',
    'trip_crew',
    'circle_only',
    'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── stories ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stories (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  media_url             TEXT NOT NULL,
  media_type            TEXT NOT NULL,
  caption               TEXT,
  visibility            story_visibility NOT NULL DEFAULT 'public',
  allowed_user_ids      UUID[] NOT NULL DEFAULT '{}',
  hidden_user_ids       UUID[] NOT NULL DEFAULT '{}',
  close_friends_only    BOOLEAN NOT NULL DEFAULT FALSE,
  trip_id               UUID REFERENCES trips(id) ON DELETE SET NULL,
  event_id              UUID,
  place_id              TEXT,
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  saved_to_highlight_id UUID,
  state                 story_state NOT NULL DEFAULT 'active',
  hide_viewer_list      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup for the expiry sweeper and all "active stories" queries
CREATE INDEX IF NOT EXISTS stories_state_expires_idx
  ON stories (state, expires_at)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS stories_owner_state_idx
  ON stories (owner_id, state, created_at DESC);

-- ── RLS: stories ───────────────────────────────────────────────────────────────

ALTER TABLE stories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stories_owner_all" ON stories;
CREATE POLICY "stories_owner_all" ON stories
  FOR ALL
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- NOTE: Only truly-public stories are readable via the anon/user Supabase client.
-- All other visibility modes (friends_only, close_friends, trip_crew, circle_only, custom)
-- are enforced at the API layer using the service-role client after permission checks.
-- Exposing those modes here would leak private stories to any authenticated DB client.
DROP POLICY IF EXISTS "stories_public_read" ON stories;
CREATE POLICY "stories_public_read" ON stories
  FOR SELECT
  USING (
    state = 'active'
    AND expires_at > NOW()
    AND visibility = 'public'
  );

-- ── story_views ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS story_views (
  story_id    UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (story_id, viewer_id)
);

CREATE INDEX IF NOT EXISTS story_views_story_idx ON story_views (story_id, viewed_at DESC);

ALTER TABLE story_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "story_views_owner_read" ON story_views;
CREATE POLICY "story_views_owner_read" ON story_views
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM stories s WHERE s.id = story_id AND s.owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "story_views_viewer_insert" ON story_views;
CREATE POLICY "story_views_viewer_insert" ON story_views
  FOR INSERT
  WITH CHECK (auth.uid() = viewer_id);

-- ── story_reactions ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS story_reactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id    UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (story_id, user_id)
);

CREATE INDEX IF NOT EXISTS story_reactions_story_idx ON story_reactions (story_id);

ALTER TABLE story_reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "story_reactions_owner_read" ON story_reactions;
CREATE POLICY "story_reactions_owner_read" ON story_reactions
  FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM stories s WHERE s.id = story_id AND s.owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "story_reactions_own_write" ON story_reactions;
CREATE POLICY "story_reactions_own_write" ON story_reactions
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── story_replies ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS story_replies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id    UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS story_replies_story_idx ON story_replies (story_id, created_at DESC);

ALTER TABLE story_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "story_replies_access" ON story_replies;
CREATE POLICY "story_replies_access" ON story_replies
  FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM stories s WHERE s.id = story_id AND s.owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "story_replies_insert" ON story_replies;
CREATE POLICY "story_replies_insert" ON story_replies
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ── close_friends ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS close_friends (
  owner_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  friend_user_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, friend_user_id)
);

CREATE INDEX IF NOT EXISTS close_friends_owner_idx ON close_friends (owner_id);

ALTER TABLE close_friends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "close_friends_owner_all" ON close_friends;
CREATE POLICY "close_friends_owner_all" ON close_friends
  FOR ALL
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- ── Feature flag seed ──────────────────────────────────────────────────────────

INSERT INTO feature_flags (flag, enabled, description)
VALUES ('stories_enabled', true, 'Enable 24h ephemeral Stories feature')
ON CONFLICT (flag) DO NOTHING;
