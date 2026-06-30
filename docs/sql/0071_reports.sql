-- ============================================================
-- 0071_reports.sql
-- Unified report table superseding the six scattered domain tables:
--   message_reports, thread_reports, highlight_reports,
--   hidden_gem_reports, discovery_place_reports, hashtag_reports.
-- Those tables are NOT dropped here — they remain and continue to
-- receive writes until retired in a later phase.
--
-- Shape-conflict notes (from Phase 1 audit):
--   - thread_reports.thread_id is text (not uuid). The unified table
--     uses context_id text to support both uuid and legacy string IDs.
--   - reason field: existing tables mix text and enums.
--     Unified table uses reason_code enum (superset) + reason_detail text.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE report_target_type AS ENUM (
    'user',
    'message',
    'thread',
    'highlight',
    'hidden_gem',
    'discovery_place',
    'hashtag',
    'trip',
    'circle',
    'comment'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE report_reason_code AS ENUM (
    -- User / content
    'spam',
    'harassment',
    'hate_speech',
    'violence',
    'self_harm',
    'sexual_content',
    'impersonation',
    'misinformation',
    'scam',
    -- Place / content accuracy
    'doesnt_exist',
    'safety',
    'misleading',
    -- Moderation
    'inappropriate',
    'abusive',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE report_status AS ENUM (
    'pending',
    'under_review',
    'resolved',
    'dismissed',
    'escalated'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE report_severity AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id                  uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: retain report record if reporter's account is deleted
  reporter_user_id    uuid               REFERENCES profiles(id) ON DELETE SET NULL,
  -- reported_user_id is the profile being reported; null for content-only reports
  reported_user_id    uuid               REFERENCES profiles(id) ON DELETE SET NULL,
  reason_code         report_reason_code NOT NULL,
  reason_detail       text,
  -- context_type / context_id identify the content object being reported
  context_type        report_target_type NOT NULL,
  -- context_id is text to accommodate both uuid and legacy text IDs
  context_id          text,
  status              report_status      NOT NULL DEFAULT 'pending',
  severity            report_severity    NOT NULL DEFAULT 'low',
  -- Reference to moderation_actions row if a moderation action was taken
  moderation_action   uuid               REFERENCES moderation_actions(id) ON DELETE SET NULL,
  created_at          timestamptz        NOT NULL DEFAULT now(),
  updated_at          timestamptz        NOT NULL DEFAULT now(),
  -- Prevent duplicate reports by the same reporter for the same object
  CONSTRAINT reports_unique_reporter_context
    UNIQUE NULLS NOT DISTINCT (reporter_user_id, context_type, context_id)
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_reports_reporter
  ON reports (reporter_user_id);

CREATE INDEX IF NOT EXISTS idx_reports_reported_user
  ON reports (reported_user_id)
  WHERE reported_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reports_context
  ON reports (context_type, context_id)
  WHERE context_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reports_status
  ON reports (status);

CREATE INDEX IF NOT EXISTS idx_reports_severity
  ON reports (severity);

CREATE INDEX IF NOT EXISTS idx_reports_created_at
  ON reports (created_at DESC);

-- ── Updated-at trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION update_reports_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reports_updated_at ON reports;
CREATE TRIGGER trg_reports_updated_at
  BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION update_reports_updated_at();

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- Reporters read only their own reports
DROP POLICY IF EXISTS "reports_select_own" ON reports;
CREATE POLICY "reports_select_own"
  ON reports FOR SELECT
  USING (reporter_user_id = auth.uid());

-- Reporters can insert their own reports
DROP POLICY IF EXISTS "reports_insert_own" ON reports;
CREATE POLICY "reports_insert_own"
  ON reports FOR INSERT
  WITH CHECK (reporter_user_id = auth.uid());

-- No user UPDATE or DELETE — status changes are service-role only

-- ── Verification ─────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'reports'
-- ORDER BY ordinal_position;
