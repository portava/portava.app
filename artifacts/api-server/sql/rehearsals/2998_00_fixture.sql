-- Minimal faithful subset of the production schema the retention work touches.
-- Column names, types, nullability, enum values, cascades and indexes are copied
-- from 0068_stories.sql; auth.users and trips are stubbed because they are
-- Supabase-managed and irrelevant to retention.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY);
CREATE TABLE trips (id UUID PRIMARY KEY, owner_id UUID);

DO $$ BEGIN
  CREATE TYPE story_state AS ENUM ('active','expired','saved','deleted','removed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE story_visibility AS ENUM ('public','friends_only','close_friends','trip_crew','circle_only','custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE stories (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  media_url             TEXT NOT NULL,
  media_type            TEXT NOT NULL,
  caption               TEXT NULL,
  visibility            story_visibility NOT NULL DEFAULT 'public',
  allowed_user_ids      UUID[] NOT NULL DEFAULT '{}',
  hidden_user_ids       UUID[] NOT NULL DEFAULT '{}',
  close_friends_only    BOOLEAN NOT NULL DEFAULT FALSE,
  trip_id               UUID NULL REFERENCES trips(id) ON DELETE SET NULL,
  event_id              UUID NULL,
  place_id              TEXT NULL,
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
  saved_to_highlight_id UUID NULL,
  state                 story_state NOT NULL DEFAULT 'active',
  hide_viewer_list      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stories_state_expires_idx ON stories (state, expires_at);
CREATE INDEX stories_owner_state_created_idx ON stories (owner_id, state, created_at DESC);

CREATE TABLE story_views (
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_id)
);
CREATE TABLE story_reactions (
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (story_id, user_id)
);
CREATE TABLE story_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Highlights: only the columns the reference guard reads.
CREATE TABLE highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  media_url TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  expires_at TIMESTAMPTZ NULL
);
