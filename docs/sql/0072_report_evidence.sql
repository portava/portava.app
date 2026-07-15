-- ============================================================
-- 0072_report_evidence.sql
-- Supporting evidence / attachments for a report row.
-- evidence_type describes what reference_id points to.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE evidence_type AS ENUM (
    'screenshot',
    'message_id',
    'media_url',
    'highlight_id',
    'post_id',
    'note'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_evidence (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       uuid          NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  evidence_type   evidence_type NOT NULL,
  -- reference_id is text: could be a uuid, a URL, or a freeform note
  reference_id    text          NOT NULL,
  metadata        jsonb         NOT NULL DEFAULT '{}',
  created_at      timestamptz   NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_report_evidence_report_id
  ON report_evidence (report_id);

CREATE INDEX IF NOT EXISTS idx_report_evidence_type
  ON report_evidence (evidence_type);

CREATE INDEX IF NOT EXISTS idx_report_evidence_created_at
  ON report_evidence (created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE report_evidence ENABLE ROW LEVEL SECURITY;

-- Users may read evidence for reports they filed
DROP POLICY IF EXISTS "report_evidence_select_reporter" ON report_evidence;
CREATE POLICY "report_evidence_select_reporter"
  ON report_evidence FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM reports r
      WHERE r.id = report_evidence.report_id
        AND r.reporter_user_id = auth.uid()
    )
  );

-- Users may insert evidence on their own reports
DROP POLICY IF EXISTS "report_evidence_insert_reporter" ON report_evidence;
CREATE POLICY "report_evidence_insert_reporter"
  ON report_evidence FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM reports r
      WHERE r.id = report_evidence.report_id
        AND r.reporter_user_id = auth.uid()
    )
  );

-- No UPDATE or DELETE for users — evidence is append-only

-- ── Verification ─────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'report_evidence'
-- ORDER BY ordinal_position;
