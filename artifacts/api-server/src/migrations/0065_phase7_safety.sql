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
--
-- SUPERSEDED 2026-08-10 (commit c89f09a77). The two lines below describe
-- behaviour the code NO LONGER HAS. They are kept, not deleted, because they
-- record a deliberate trade-off and the reversal of it should be visible at the
-- place a reader meets the original:
--
--   > Routes gate on these flags and fail-open (feature stays ON) on DB errors
--   > so a DB outage never silently locks users out of the app.
--
-- That was a real choice — "users keep working during an outage" preferred over
-- "the stop holds during an outage" — and it was reversed on purpose, not
-- corrected as an oversight. A kill switch inverts the meaning of every value:
-- `disable_x = true` means STOP, so false-on-error means "do not stop", and the
-- switch disengaged exactly when an operator was reaching for it.
--
-- Current behaviour: the eleven converted stops are read through
-- `isKillSwitchEngaged` (lib/featureFlags.ts), which ENGAGES on a query error
-- and does NOT engage on a missing row — an absent flag means no stop is
-- configured, so unseeded flags are not outages. `isFlagEnabled` is unchanged
-- and still returns false on error, which remains correct for capability gates.
--
-- RETIRED 2026-08-11: four freeze_* rows were seeded here and have been removed
-- from this statement.
--
-- They were freeze_city / freeze_event / freeze_circle / freeze_booking, seeded
-- as parameterised emergency stops whose target was to live in
-- feature_flags.metadata and be read back through getFlagRow(). getFlagRow()
-- has zero callers; the design was seeded and never built, so all four were
-- operator-visible switches that gated nothing.
--
-- They are removed from the seed HERE so a fresh database never creates them,
-- and deleted from existing databases by
-- src/migrations/0209_retire_freeze_flags.sql. Editing this applied migration
-- is deliberate and is the remedy scripts/check-flag-polarity.mjs names as the
-- `remove-from-seed` disposition: leaving the INSERT in place would mean a new
-- environment re-creates the exact rows 0209 exists to remove. Their
-- INERT_SEEDED_FLAGS entries are removed in the same commit, as rule R7 of that
-- script requires once a flag is no longer seeded.
--
-- The seven disable_* rows below are unaffected: those are read through
-- isKillSwitchEngaged and are genuine stops.
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('disable_unknown_message_requests', false, 'Emergency: block DMs/message-requests from users with no shared context'),
  ('disable_new_event_creation',       false, 'Emergency: prevent any new event/meetup creation'),
  ('disable_rab_bookings',             false, 'Emergency: freeze all new rent-a-buddy booking requests'),
  ('disable_tagging',                  false, 'Emergency: disable all @mention tagging globally'),
  ('disable_location_sharing',         false, 'Emergency: freeze location sharing and live-share updates'),
  ('disable_profile_search',           false, 'Emergency: hide profile search results'),
  ('disable_media_uploads',            false, 'Emergency: block avatar, cover and media uploads')
ON CONFLICT (flag) DO NOTHING;
