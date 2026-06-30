-- Phase 7: Safety, Moderation & Emergency Controls
-- Creates report_evidence table, seeds emergency feature flags.
-- All statements use IF NOT EXISTS so this is safe to re-apply.

-- ── Report evidence ─────────────────────────────────────────────────────────
-- Stores supporting evidence for reports.
-- ON DELETE RESTRICT on report_id ensures high-severity report evidence
-- cannot be deleted by cascading the parent report row.
CREATE TABLE IF NOT EXISTS report_evidence (
  id            uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  report_id     uuid        NOT NULL REFERENCES reports(id) ON DELETE RESTRICT,
  evidence_type text        NOT NULL, -- 'context' | 'message_id' | 'screenshot_ref' | 'profile_snapshot'
  content_ref   text,                  -- URL, UUID, or opaque identifier pointing to the evidence
  metadata      jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_evidence_report ON report_evidence (report_id);

ALTER TABLE report_evidence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Reporters can read their own evidence" ON report_evidence;
CREATE POLICY "Reporters can read their own evidence"
  ON report_evidence FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM reports
       WHERE reports.id = report_evidence.report_id
         AND reports.reporter_id = auth.uid()
    )
  );

-- ── feature_flags: add metadata column for parameterized emergency flags ─────
-- freeze_city / freeze_event / freeze_circle / freeze_booking store their
-- target IDs in this column.  Existing rows are unaffected (NULL default).
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS metadata jsonb;

-- ── Emergency feature flags ──────────────────────────────────────────────────
-- These are kill-switches for safety incidents.
-- Routes gate on these flags and fail-open (feature stays ON) on DB errors
-- so a DB outage never silently locks users out of the app.
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('disable_unknown_message_requests', false, 'Emergency: block DMs/message-requests from users with no shared context'),
  ('disable_new_event_creation',       false, 'Emergency: prevent any new event/meetup creation'),
  ('disable_rab_bookings',             false, 'Emergency: freeze all new rent-a-buddy booking requests'),
  ('disable_tagging',                  false, 'Emergency: disable all @mention tagging globally'),
  ('disable_location_sharing',         false, 'Emergency: freeze location sharing and live-share updates'),
  ('disable_profile_search',           false, 'Emergency: hide profile search results'),
  ('disable_media_uploads',            false, 'Emergency: block avatar, cover and media uploads'),
  ('freeze_city',                      false, 'Emergency: freeze city-scoped features (metadata.city required)'),
  ('freeze_event',                     false, 'Emergency: freeze a specific event (metadata.event_id required)'),
  ('freeze_circle',                    false, 'Emergency: freeze a specific circle (metadata.circle_id required)'),
  ('freeze_booking',                   false, 'Emergency: freeze a specific booking (metadata.booking_id required)')
ON CONFLICT (flag) DO NOTHING;
