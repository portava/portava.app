-- Migration 0043: Tags & Hashtags
-- Creates: tags, hashtags, hashtag_usage, user_hashtag_follows tables
-- Adds: tag_permission column to profiles

-- 1. tag_permission enum on profiles
DO $$ BEGIN
  CREATE TYPE tag_permission_level AS ENUM ('anyone', 'interacted', 'friends_only', 'nobody');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS tag_permission tag_permission_level NOT NULL DEFAULT 'anyone';

-- 2. hashtags table (one row per unique normalized slug)
CREATE TABLE IF NOT EXISTS hashtags (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text        NOT NULL,              -- display form e.g. "TravelBuddy"
  slug                    text        NOT NULL UNIQUE,       -- lowercase-normalized
  usage_count             integer     NOT NULL DEFAULT 0,
  is_blocked              boolean     NOT NULL DEFAULT false,
  is_hidden_from_trending boolean     NOT NULL DEFAULT false,
  blocked_at              timestamptz,
  blocked_reason          text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hashtags_slug_idx        ON hashtags(slug);
CREATE INDEX IF NOT EXISTS hashtags_usage_count_idx ON hashtags(usage_count DESC) WHERE NOT is_blocked;

-- 3. tags table (one row per @mention instance)
CREATE TABLE IF NOT EXISTS tags (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type     text        NOT NULL,   -- 'post' | 'comment' | 'message'
  source_id       text        NOT NULL,   -- UUID of the source row
  tagger_id       uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tagged_user_id  uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tags_tagged_user_idx ON tags(tagged_user_id);
CREATE INDEX IF NOT EXISTS tags_tagger_idx      ON tags(tagger_id);
CREATE INDEX IF NOT EXISTS tags_source_idx      ON tags(source_type, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS tags_dedup_idx ON tags(source_type, source_id, tagged_user_id);

-- 4. hashtag_usage table (one row per hashtag-in-content instance)
CREATE TABLE IF NOT EXISTS hashtag_usage (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  hashtag_id   uuid        NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  source_type  text        NOT NULL,   -- 'post' | 'comment' | 'message'
  source_id    text        NOT NULL,
  author_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  city         text,
  country      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hashtag_usage_hashtag_idx ON hashtag_usage(hashtag_id);
CREATE INDEX IF NOT EXISTS hashtag_usage_source_idx  ON hashtag_usage(source_type, source_id);
CREATE INDEX IF NOT EXISTS hashtag_usage_author_idx  ON hashtag_usage(author_id);
CREATE INDEX IF NOT EXISTS hashtag_usage_created_idx ON hashtag_usage(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS hashtag_usage_dedup_idx ON hashtag_usage(hashtag_id, source_type, source_id);

-- 5. user_hashtag_follows table
CREATE TABLE IF NOT EXISTS user_hashtag_follows (
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  hashtag_id  uuid        NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hashtag_id)
);

CREATE INDEX IF NOT EXISTS user_hashtag_follows_user_idx    ON user_hashtag_follows(user_id);
CREATE INDEX IF NOT EXISTS user_hashtag_follows_hashtag_idx ON user_hashtag_follows(hashtag_id);

-- 6. Helper function: atomic usage_count increment
CREATE OR REPLACE FUNCTION increment_hashtag_usage_count(p_hashtag_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE hashtags
  SET usage_count = usage_count + 1,
      updated_at  = now()
  WHERE id = p_hashtag_id;
$$;

-- 7. RLS
ALTER TABLE hashtags             ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE hashtag_usage        ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_hashtag_follows ENABLE ROW LEVEL SECURITY;

-- hashtags: public read; service-role manages writes
CREATE POLICY "hashtags_public_read"   ON hashtags FOR SELECT USING (true);
CREATE POLICY "hashtags_service_write" ON hashtags FOR ALL TO service_role USING (true);

-- tags: tagger or tagged user can read; service-role all
CREATE POLICY "tags_read_own"    ON tags FOR SELECT
  USING (tagger_id = auth.uid() OR tagged_user_id = auth.uid());
CREATE POLICY "tags_service_all" ON tags FOR ALL TO service_role USING (true);

-- hashtag_usage: public read; service-role writes
CREATE POLICY "hashtag_usage_public_read"   ON hashtag_usage FOR SELECT USING (true);
CREATE POLICY "hashtag_usage_service_write" ON hashtag_usage FOR ALL TO service_role USING (true);

-- user_hashtag_follows: users manage their own rows; public read
CREATE POLICY "hashtag_follows_read_all" ON user_hashtag_follows FOR SELECT USING (true);
CREATE POLICY "hashtag_follows_own_ins"  ON user_hashtag_follows FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "hashtag_follows_own_del"  ON user_hashtag_follows FOR DELETE USING (user_id = auth.uid());
CREATE POLICY "hashtag_follows_service"  ON user_hashtag_follows FOR ALL TO service_role USING (true);
