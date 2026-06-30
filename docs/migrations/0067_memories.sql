-- Migration 0067: Full Memory System
-- Tables: memories, memory_items, memory_tags, memory_likes, memory_saves
-- Migrations are provided as SQL; apply in Supabase SQL Editor.

-- ── memories ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memories (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title            TEXT,
  caption          TEXT,
  visibility       TEXT NOT NULL DEFAULT 'friends_only'
                   CHECK (visibility IN ('public','friends_only','trip_crew','circle_only','only_me','custom')),
  allowed_user_ids UUID[] NOT NULL DEFAULT '{}',
  hidden_user_ids  UUID[] NOT NULL DEFAULT '{}',
  trip_id          UUID REFERENCES trips(id) ON DELETE SET NULL,
  event_id         UUID REFERENCES events(id) ON DELETE SET NULL,
  place_id         TEXT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  state            TEXT NOT NULL DEFAULT 'published'
                   CHECK (state IN ('draft','published','archived','deleted','removed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memories_owner_all" ON memories
  FOR ALL USING (owner_id = auth.uid());

CREATE POLICY "memories_public_read" ON memories
  FOR SELECT USING (
    state = 'published'
    AND visibility = 'public'
    AND owner_id <> auth.uid()
  );

CREATE INDEX IF NOT EXISTS memories_owner_idx      ON memories(owner_id);
CREATE INDEX IF NOT EXISTS memories_trip_idx       ON memories(trip_id) WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_event_idx      ON memories(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_state_vis_idx  ON memories(state, visibility);

-- ── memory_items ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id   UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  media_url   TEXT NOT NULL,
  media_type  TEXT NOT NULL DEFAULT 'image/jpeg',
  caption     TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memory_items_via_memory" ON memory_items
  FOR ALL USING (
    EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_id AND m.owner_id = auth.uid())
  );

CREATE POLICY "memory_items_public_read" ON memory_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM memories m
      WHERE m.id = memory_id
        AND m.state = 'published'
        AND m.visibility = 'public'
    )
  );

CREATE INDEX IF NOT EXISTS memory_items_memory_idx ON memory_items(memory_id, position);

-- ── memory_tags ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id      UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tagged_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','removed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, tagged_user_id)
);

ALTER TABLE memory_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memory_tags_owner_read" ON memory_tags
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_id AND m.owner_id = auth.uid())
    OR tagged_user_id = auth.uid()
  );

CREATE POLICY "memory_tags_tagged_update" ON memory_tags
  FOR UPDATE USING (tagged_user_id = auth.uid())
  WITH CHECK (tagged_user_id = auth.uid());

CREATE POLICY "memory_tags_owner_insert" ON memory_tags
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_id AND m.owner_id = auth.uid())
  );

CREATE POLICY "memory_tags_owner_delete" ON memory_tags
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_id AND m.owner_id = auth.uid())
    OR tagged_user_id = auth.uid()
  );

CREATE INDEX IF NOT EXISTS memory_tags_tagged_idx ON memory_tags(tagged_user_id);

-- ── memory_likes ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_likes (
  memory_id  UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, user_id)
);

ALTER TABLE memory_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memory_likes_own" ON memory_likes
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "memory_likes_read" ON memory_likes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM memories m
      WHERE m.id = memory_id
        AND m.state = 'published'
        AND m.visibility = 'public'
    )
  );

CREATE INDEX IF NOT EXISTS memory_likes_memory_idx ON memory_likes(memory_id);

-- ── memory_saves ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_saves (
  memory_id  UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, user_id)
);

ALTER TABLE memory_saves ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memory_saves_own" ON memory_saves
  FOR ALL USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS memory_saves_user_idx ON memory_saves(user_id);
