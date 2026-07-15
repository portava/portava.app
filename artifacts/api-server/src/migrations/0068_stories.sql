-- ============================================================
-- Migration 0068: Stories + Close Friends
-- ============================================================

-- story_state enum
DO $$ BEGIN
  CREATE TYPE story_state AS ENUM ('active', 'expired', 'saved', 'deleted', 'removed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- story_visibility enum
DO $$ BEGIN
  CREATE TYPE story_visibility AS ENUM ('public', 'friends_only', 'close_friends', 'trip_crew', 'circle_only', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── stories ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stories (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              UUID          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  media_url             TEXT          NOT NULL,
  media_type            TEXT          NOT NULL,
  caption               TEXT          NULL,
  visibility            story_visibility NOT NULL DEFAULT 'public',
  allowed_user_ids      UUID[]        NOT NULL DEFAULT '{}',
  hidden_user_ids       UUID[]        NOT NULL DEFAULT '{}',
  close_friends_only    BOOLEAN       NOT NULL DEFAULT FALSE,
  trip_id               UUID          NULL REFERENCES trips(id) ON DELETE SET NULL,
  event_id              UUID          NULL,
  place_id              TEXT          NULL,
  expires_at            TIMESTAMPTZ   NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
  saved_to_highlight_id UUID          NULL,
  state                 story_state   NOT NULL DEFAULT 'active',
  hide_viewer_list      BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stories_state_expires_idx
  ON stories (state, expires_at);

CREATE INDEX IF NOT EXISTS stories_owner_state_created_idx
  ON stories (owner_id, state, created_at DESC);

ALTER TABLE stories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner manages own stories" ON stories;
CREATE POLICY "Owner manages own stories"
  ON stories FOR ALL
  USING  (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "Public read active non-expired stories" ON stories;
CREATE POLICY "Public read active non-expired stories"
  ON stories FOR SELECT
  USING (state = 'active' AND expires_at > now());

-- ── story_views ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS story_views (
  story_id    UUID        NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_id)
);

CREATE INDEX IF NOT EXISTS story_views_story_viewed_at_idx
  ON story_views (story_id, viewed_at DESC);

ALTER TABLE story_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner reads own story viewers" ON story_views;
CREATE POLICY "Owner reads own story viewers"
  ON story_views FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM stories s
      WHERE s.id = story_views.story_id
        AND s.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Viewer inserts own view" ON story_views;
CREATE POLICY "Viewer inserts own view"
  ON story_views FOR INSERT
  WITH CHECK (viewer_id = auth.uid());

-- ── story_reactions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS story_reactions (
  story_id    UUID        NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (story_id, user_id)
);

ALTER TABLE story_reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner and reactor read story reactions" ON story_reactions;
CREATE POLICY "Owner and reactor read story reactions"
  ON story_reactions FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM stories s
      WHERE s.id = story_reactions.story_id
        AND s.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users write own reactions" ON story_reactions;
CREATE POLICY "Users write own reactions"
  ON story_reactions FOR ALL
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── story_replies ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS story_replies (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id    UUID        NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS story_replies_story_idx
  ON story_replies (story_id, created_at DESC);

ALTER TABLE story_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner and sender read story replies" ON story_replies;
CREATE POLICY "Owner and sender read story replies"
  ON story_replies FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM stories s
      WHERE s.id = story_replies.story_id
        AND s.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Sender inserts own replies" ON story_replies;
CREATE POLICY "Sender inserts own replies"
  ON story_replies FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- ── close_friends ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS close_friends (
  owner_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  friend_user_id  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, friend_user_id)
);

CREATE INDEX IF NOT EXISTS close_friends_owner_idx
  ON close_friends (owner_id);

ALTER TABLE close_friends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner manages own close friends list" ON close_friends;
CREATE POLICY "Owner manages own close friends list"
  ON close_friends FOR ALL
  USING  (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- ── Feature flag seed ─────────────────────────────────────────────────────────
INSERT INTO feature_flags (flag, enabled, description)
VALUES ('stories_enabled', TRUE, 'Enable the Stories feature (story posting, feed, reactions, replies)')
ON CONFLICT (flag) DO NOTHING;
