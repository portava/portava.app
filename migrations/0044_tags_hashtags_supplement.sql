-- 0044_tags_hashtags_supplement.sql
-- Supplements migration 0043 with columns and functions required by TaggingService:
--   • tags.tagged_at       — used for rate-limit queries (code refs tagged_at, not created_at)
--   • hashtags.normalized_name — slug with all non-alphanumeric chars removed (admin PATCH)
--   • upsert_hashtag_usage_and_increment — atomic insert+increment (race-safe usage_count)

-- ── user_hashtag_follows: fix overly-broad public-read SELECT policy ──────────────
-- 0043 accidentally used USING (true), exposing all rows. Drop it and replace with
-- own-row-only access; service role already covered by the FOR ALL policy.
DROP POLICY IF EXISTS "hashtag_follows_read_all" ON user_hashtag_follows;
CREATE POLICY IF NOT EXISTS "hashtag_follows_own_sel" ON user_hashtag_follows
  FOR SELECT USING (user_id = auth.uid());

-- ── tags: add tagged_at (mirrors created_at; code uses this column for rate-limit) ──
ALTER TABLE tags ADD COLUMN IF NOT EXISTS tagged_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill tagged_at from created_at for rows inserted by the old migration path
UPDATE tags SET tagged_at = created_at WHERE tagged_at = now() AND created_at < now() - interval '1 second';

-- Update index so rate-limit queries on tagged_at are efficient
CREATE INDEX IF NOT EXISTS tags_tagger_tagged_at_idx ON tags (tagger_id, tagged_at DESC);

-- ── hashtags: add normalized_name ─────────────────────────────────────────────────
ALTER TABLE hashtags ADD COLUMN IF NOT EXISTS normalized_name TEXT;

-- Backfill: strip all non-alphanumeric characters from existing slugs
UPDATE hashtags SET normalized_name = regexp_replace(slug, '[^a-z0-9]', '', 'g')
  WHERE normalized_name IS NULL;

-- ── upsert_hashtag_usage_and_increment ────────────────────────────────────────────
-- Atomically inserts a hashtag_usage row (ON CONFLICT DO NOTHING) and increments
-- usage_count only when a new row is inserted — preventing double-counting under
-- concurrent writes for the same (hashtag_id, source_type, source_id) triple.
CREATE OR REPLACE FUNCTION upsert_hashtag_usage_and_increment(
  p_hashtag_id  UUID,
  p_source_type TEXT,
  p_source_id   TEXT,
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
