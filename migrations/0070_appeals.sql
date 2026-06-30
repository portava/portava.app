-- Migration 0070: Moderation appeals
-- Users can appeal: removed content, Trust Score penalties, no-show markings, etc.
-- NOT applied automatically — run in Supabase SQL Editor

-- ── Enums ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE appeal_target_type AS ENUM (
    'post',
    'memory',
    'highlight',
    'account_warning',
    'trust_score_event',
    'no_show',
    'event',
    'event_membership',
    'trip',
    'trip_membership',
    'review'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE appeal_state AS ENUM ('submitted', 'under_review', 'approved', 'denied');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── appeals ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS appeals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appellant_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_type      appeal_target_type NOT NULL,
  target_id        UUID NOT NULL,
  reason           TEXT NOT NULL,
  evidence_url     TEXT,
  state            appeal_state NOT NULL DEFAULT 'submitted',
  moderator_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active (non-denied) appeal per appellant per target
-- Prevents spam while allowing a fresh appeal after a denial
CREATE UNIQUE INDEX IF NOT EXISTS appeals_active_per_target_idx
  ON appeals (appellant_id, target_type, target_id)
  WHERE state IN ('submitted', 'under_review', 'approved');

-- Admin queue — filter by state
CREATE INDEX IF NOT EXISTS appeals_state_created_idx
  ON appeals (state, created_at DESC);

-- User's own appeal history
CREATE INDEX IF NOT EXISTS appeals_appellant_idx
  ON appeals (appellant_id, created_at DESC);

-- Target lookups (to find appeal for a specific moderated item)
CREATE INDEX IF NOT EXISTS appeals_target_idx
  ON appeals (target_type, target_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE appeals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Appellants read own appeals" ON appeals;
CREATE POLICY "Appellants read own appeals"
  ON appeals FOR SELECT
  USING (appellant_id = auth.uid());

DROP POLICY IF EXISTS "Appellants insert own appeals" ON appeals;
CREATE POLICY "Appellants insert own appeals"
  ON appeals FOR INSERT
  WITH CHECK (appellant_id = auth.uid());

-- Service role handles all writes (state transitions, resolution_note) — bypasses RLS
