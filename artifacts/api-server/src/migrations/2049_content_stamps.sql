-- Migration 2047: content_stamps — unified polymorphic stamp table
--
-- Replaces the fragmented like model (posts_likes, post_reactions for media
-- likes, stamp_admires) with a single polymorphic table covering all
-- stampable entity types.  Stamps are Portava's primary positive interaction
-- signal — "worth experiencing, remembering, recommending."
--
-- Existing rows from posts_likes are migrated verbatim so zero engagement
-- data is lost.  media_likes is guarded with IF EXISTS since the table is
-- inconsistently present across environments.

CREATE TABLE IF NOT EXISTS content_stamps (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT        NOT NULL,
  entity_id   UUID        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_stamps_unique UNIQUE (user_id, entity_type, entity_id),
  CONSTRAINT content_stamps_entity_type_check CHECK (
    entity_type IN (
      'post', 'media', 'gem', 'event', 'trip', 'guide',
      'profile', 'buddy_profile', 'hotel', 'restaurant', 'destination'
    )
  )
);

-- Lookup by entity (count queries, feed enrichment)
CREATE INDEX IF NOT EXISTS content_stamps_entity_idx
  ON content_stamps (entity_type, entity_id);

-- Lookup by viewer (isStampedByViewer batch checks)
CREATE INDEX IF NOT EXISTS content_stamps_user_type_idx
  ON content_stamps (user_id, entity_type);

-- ── Migrate existing post likes ────────────────────────────────────────────────
-- posts_likes uses (post_id, user_id) with no surrogate id column.
INSERT INTO content_stamps (user_id, entity_type, entity_id, created_at)
SELECT user_id, 'post', post_id, created_at
FROM posts_likes
ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING;

-- ── Migrate media likes (guard: table may not exist in all envs) ───────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'media_likes'
  ) THEN
    INSERT INTO content_stamps (user_id, entity_type, entity_id, created_at)
    SELECT user_id, 'media', media_id, created_at
    FROM media_likes
    ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING;
  END IF;
END $$;

-- ── Migrate media likes from post_reactions (Watch feed legacy source) ────────
-- post_reactions stores per-emoji reactions; only the ❤️ heart rows represent
-- "likes" (the emoji used by the legacy Watch-feed like button).  Other emoji
-- (e.g. 😂 😮) are distinct reaction types and must NOT become stamps.
-- Guarded with IF EXISTS since the table may not exist in all environments.
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'post_reactions'
  ) THEN
    INSERT INTO content_stamps (user_id, entity_type, entity_id, created_at)
    SELECT pr.user_id, 'media', pr.post_id, pr.created_at
    FROM post_reactions pr
    WHERE pr.emoji = '❤️'
    ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING;
  END IF;
END $$;

-- ── Row-level security ─────────────────────────────────────────────────────────
ALTER TABLE content_stamps ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read stamps (counts are public information)
CREATE POLICY "content_stamps_select"
  ON content_stamps FOR SELECT
  USING (true);

-- Users can only insert their own stamps
CREATE POLICY "content_stamps_insert"
  ON content_stamps FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can only remove their own stamps
CREATE POLICY "content_stamps_delete"
  ON content_stamps FOR DELETE
  USING (auth.uid() = user_id);
