-- Migration 0044: hashtag_reports
-- Users can report hashtags as spam/misleading/abusive.
-- Service role reads all; auth users insert own rows only.

CREATE TABLE IF NOT EXISTS hashtag_reports (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  hashtag_id  uuid        NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  reporter_id uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason      text        NOT NULL CHECK (reason IN ('spam', 'misleading', 'abusive')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE hashtag_reports ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS hashtag_reports_hashtag_idx  ON hashtag_reports(hashtag_id);
CREATE INDEX IF NOT EXISTS hashtag_reports_reporter_idx ON hashtag_reports(reporter_id);

CREATE POLICY "hashtag_reports_auth_insert" ON hashtag_reports
  FOR INSERT WITH CHECK (auth.uid() = reporter_id);

CREATE POLICY "hashtag_reports_service_read" ON hashtag_reports
  FOR SELECT TO service_role USING (true);

CREATE POLICY "hashtag_reports_service_all" ON hashtag_reports
  FOR ALL TO service_role USING (true);
