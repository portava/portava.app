-- 0044_tags_hashtags.sql
-- Tags, hashtags, hashtag_usage, user_hashtag_follows tables.
-- Adds tag_permission to profiles and normalized_name to hashtags.

-- ── tag_permission enum + column ────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE tag_permission AS ENUM ('anyone', 'interacted', 'friends_only', 'nobody');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS tag_permission tag_permission NOT NULL DEFAULT 'anyone';

-- ── tags ────────────────────────────────────────────────────────────────────────
-- One row per @-mention event. Deduped on (source_type, source_id, tagged_user_id).
CREATE TABLE IF NOT EXISTS tags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type     TEXT NOT NULL,                        -- 'post' | 'comment' | 'message'
  source_id       UUID NOT NULL,
  tagger_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tagged_user_id  UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tagged_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tags_dedup_idx
  ON tags (source_type, source_id, tagged_user_id);

CREATE INDEX IF NOT EXISTS tags_tagger_idx    ON tags (tagger_id, tagged_at DESC);
CREATE INDEX IF NOT EXISTS tags_tagged_idx    ON tags (tagged_user_id, tagged_at DESC);
CREATE INDEX IF NOT EXISTS tags_source_idx    ON tags (source_type, source_id);

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY tags_select ON tags FOR SELECT
  USING (tagged_user_id = auth.uid() OR tagger_id = auth.uid());

CREATE POLICY tags_insert ON tags FOR INSERT
  WITH CHECK (tagger_id = auth.uid());

-- ── hashtags ─────────────────────────────────────────────────────────────────────
-- Canonical hashtag registry; slug is unique and normalized to lowercase.
CREATE TABLE IF NOT EXISTS hashtags (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                    TEXT NOT NULL,                -- lowercase, alphanumeric, e.g. 'wanderlust'
  name                    TEXT NOT NULL,                -- display form, e.g. 'Wanderlust'
  normalized_name         TEXT,                         -- slug with all non-alphanumeric chars removed
  usage_count             INTEGER NOT NULL DEFAULT 0,
  is_blocked              BOOLEAN NOT NULL DEFAULT FALSE,
  is_hidden_from_trending BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_at              TIMESTAMPTZ,
  blocked_reason          TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS hashtags_slug_idx ON hashtags (slug);
CREATE INDEX IF NOT EXISTS hashtags_usage_idx ON hashtags (usage_count DESC);
CREATE INDEX IF NOT EXISTS hashtags_blocked_idx ON hashtags (is_blocked) WHERE is_blocked = TRUE;

ALTER TABLE hashtags ENABLE ROW LEVEL SECURITY;

CREATE POLICY hashtags_select ON hashtags FOR SELECT USING (true);
CREATE POLICY hashtags_admin_write ON hashtags FOR ALL USING (false); -- service role bypasses RLS

-- ── hashtag_usage ────────────────────────────────────────────────────────────────
-- One row per (hashtag × content item). Deduped on (hashtag_id, source_type, source_id).
CREATE TABLE IF NOT EXISTS hashtag_usage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hashtag_id   UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  source_type  TEXT NOT NULL,   -- 'post' | 'comment' | 'message' | 'trip' | ...
  source_id    UUID NOT NULL,
  author_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  city         TEXT,
  country      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS hashtag_usage_dedup_idx
  ON hashtag_usage (hashtag_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS hashtag_usage_hashtag_idx ON hashtag_usage (hashtag_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hashtag_usage_author_idx  ON hashtag_usage (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hashtag_usage_city_idx    ON hashtag_usage (city, created_at DESC)
  WHERE city IS NOT NULL;

ALTER TABLE hashtag_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY hashtag_usage_select ON hashtag_usage FOR SELECT USING (true);
CREATE POLICY hashtag_usage_admin_write ON hashtag_usage FOR ALL USING (false); -- service role

-- ── user_hashtag_follows ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_hashtag_follows (
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  hashtag_id  UUID NOT NULL REFERENCES hashtags(id)  ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hashtag_id)
);

CREATE INDEX IF NOT EXISTS user_hashtag_follows_hashtag_idx ON user_hashtag_follows (hashtag_id);

ALTER TABLE user_hashtag_follows ENABLE ROW LEVEL SECURITY;

CREATE POLICY uhf_select ON user_hashtag_follows FOR SELECT USING (user_id = auth.uid());
CREATE POLICY uhf_insert ON user_hashtag_follows FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY uhf_delete ON user_hashtag_follows FOR DELETE USING (user_id = auth.uid());

-- ── increment_hashtag_usage_count() ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION increment_hashtag_usage_count(p_hashtag_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE hashtags SET usage_count = usage_count + 1, updated_at = now()
  WHERE id = p_hashtag_id;
END;
$$;

-- ── upsert_hashtag_usage_and_increment() ──────────────────────────────────────────
-- Atomically inserts a hashtag_usage row (ON CONFLICT DO NOTHING) and increments
-- usage_count only when a new row is inserted — preventing double-counting under
-- concurrent writes for the same (hashtag_id, source_type, source_id) triple.
-- Returns TRUE if a new row was inserted, FALSE if it already existed.
CREATE OR REPLACE FUNCTION upsert_hashtag_usage_and_increment(
  p_hashtag_id  UUID,
  p_source_type TEXT,
  p_source_id   UUID,
  p_author_id   UUID,
  p_city        TEXT DEFAULT NULL,
  p_country     TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_inserted BOOLEAN := FALSE;
BEGIN
  INSERT INTO hashtag_usage (hashtag_id, source_type, source_id, author_id, city, country)
  VALUES (p_hashtag_id, p_source_type, p_source_id, p_author_id, p_city, p_country)
  ON CONFLICT (hashtag_id, source_type, source_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted THEN
    UPDATE hashtags SET usage_count = usage_count + 1, updated_at = now()
    WHERE id = p_hashtag_id;
  END IF;

  RETURN v_inserted;
END;
$$;
