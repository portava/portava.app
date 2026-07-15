-- 0044_hashtag_reports.sql
-- Stores user reports against hashtags (spam / misleading / abusive).
-- Service role handles all reads; authenticated users insert own rows only.

CREATE TABLE IF NOT EXISTS hashtag_reports (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  hashtag_id   UUID        NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  reporter_id  UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason       TEXT        NOT NULL CHECK (reason IN ('spam', 'misleading', 'abusive')),
  created_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE hashtag_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hashtag_reports_insert_own"
  ON hashtag_reports FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = reporter_id);

CREATE POLICY "hashtag_reports_select_service"
  ON hashtag_reports FOR SELECT TO service_role USING (true);

CREATE INDEX IF NOT EXISTS hashtag_reports_hashtag_id_idx ON hashtag_reports (hashtag_id);
CREATE INDEX IF NOT EXISTS hashtag_reports_reporter_id_idx ON hashtag_reports (reporter_id);
