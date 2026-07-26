-- Migration: Real-place image accuracy — place_image_reports table.
--
-- Records user "wrong place" reports so the admin review queue can surface
-- images that the community flags as inaccurate. Each report targets one
-- (place, image_url) pair and moves through a simple status lifecycle:
--   pending → reviewed (accepted | rejected)
--
-- Design choices:
--   • (place_id, status) index covers the common admin queue query.
--   • confidence_adjustment is a signed float: negative values decrease
--     the place's image confidence score, positive values restore it.
--   • FK to profiles for reported_by / reviewed_by; ON DELETE SET NULL so
--     a deleted account doesn't cascade-delete the report audit trail.
--
-- Fully idempotent: CREATE TABLE IF NOT EXISTS + IF NOT EXISTS indexes.

BEGIN;

CREATE TABLE IF NOT EXISTS place_image_reports (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which place and which image URL is being reported
  place_id             TEXT NOT NULL,   -- TEXT matches discovery_places.id (OSM/text keys)
  image_url            TEXT NOT NULL,

  -- Reporter
  reported_by          UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- Free-text or enum reason: 'wrong_place' | 'outdated' | 'low_quality' | 'other'
  report_reason        TEXT NOT NULL DEFAULT 'wrong_place',

  -- Lifecycle: pending → reviewed_accepted | reviewed_rejected
  status               TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewed_accepted', 'reviewed_rejected')),

  -- Signed delta applied to the place image confidence score when accepted
  confidence_adjustment DOUBLE PRECISION,

  -- Reviewer (admin / moderator)
  reviewed_by          UUID REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at          TIMESTAMPTZ,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin queue: open reports by place
CREATE INDEX IF NOT EXISTS place_image_reports_place_status_idx
  ON place_image_reports (place_id, status);

-- Reporter look-up (my reports)
CREATE INDEX IF NOT EXISTS place_image_reports_reporter_idx
  ON place_image_reports (reported_by);

-- Recency ordering for the review queue
CREATE INDEX IF NOT EXISTS place_image_reports_created_idx
  ON place_image_reports (created_at DESC);

-- RLS: service role writes; authenticated users read their own; admins read all
--      (actual policies are wired in the RLS hardening migration wave).
ALTER TABLE place_image_reports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY place_image_reports_self_read
    ON place_image_reports FOR SELECT
    USING (reported_by = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
