-- Migration 0061: discovery_place_reports
-- Stores user reports on community-submitted discovery places.
-- One report per (place, reporter) pair (upsert on conflict).

CREATE TABLE IF NOT EXISTS discovery_place_reports (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id    UUID        NOT NULL REFERENCES discovery_places(id) ON DELETE CASCADE,
  reporter_id UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason      TEXT        NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT discovery_place_reports_unique UNIQUE (place_id, reporter_id)
);

ALTER TABLE discovery_place_reports ENABLE ROW LEVEL SECURITY;

-- Auth users can insert their own reports
CREATE POLICY "auth_insert_own_report"
  ON discovery_place_reports
  FOR INSERT
  TO authenticated
  WITH CHECK (reporter_id = auth.uid());

-- Auth users can read their own reports (to check if they've already reported)
CREATE POLICY "auth_select_own_report"
  ON discovery_place_reports
  FOR SELECT
  TO authenticated
  USING (reporter_id = auth.uid());

-- Index for admin reporting queries: order by most-reported places
CREATE INDEX IF NOT EXISTS discovery_place_reports_place_idx ON discovery_place_reports(place_id);
CREATE INDEX IF NOT EXISTS discovery_place_reports_reporter_idx ON discovery_place_reports(reporter_id);
