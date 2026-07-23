-- Migration 0176: moderation_reports — DDL reconcile
--
-- The UI wave (2026-07-23) shipped routes/moderation.ts (user-facing reporting:
-- POST /api/moderation/report, GET /api/moderation/reports/mine) but no
-- migration created its table — it existed only ad-hoc in the dev database.
-- This migration is the canonical DDL, written to match the route exactly.
--
-- Safe to re-run, and safe if the table already exists in some form:
-- IF NOT EXISTS throughout + ADD COLUMN IF NOT EXISTS for every column.
--
-- status is deliberately unconstrained TEXT (default 'open'): the reporter
-- route only ever writes 'open'; admin triage flows own the rest of the
-- lifecycle and should not be fought by a CHECK here.

CREATE TABLE IF NOT EXISTS moderation_reports (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject_type    TEXT        NOT NULL CHECK (subject_type IN
                    ('user','post','comment','message','event','review','buddy_listing')),
  subject_id      UUID        NOT NULL,
  subject_user_id UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  category        TEXT        NOT NULL CHECK (category IN
                    ('impersonation','harassment','scam_fraud','inappropriate_content',
                     'safety_concern','underage','spam','other')),
  details         TEXT,
  thread_id       UUID,
  status          TEXT        NOT NULL DEFAULT 'open',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reconcile columns if an ad-hoc version of the table already existed.
ALTER TABLE moderation_reports ADD COLUMN IF NOT EXISTS subject_user_id UUID;
ALTER TABLE moderation_reports ADD COLUMN IF NOT EXISTS details         TEXT;
ALTER TABLE moderation_reports ADD COLUMN IF NOT EXISTS thread_id       UUID;
ALTER TABLE moderation_reports ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'open';
ALTER TABLE moderation_reports ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

-- Dedup lookup used by POST /api/moderation/report (open-report collapse).
CREATE INDEX IF NOT EXISTS modrep_dedup_idx
  ON moderation_reports (reporter_id, subject_type, subject_id, status);

-- Reporter history (GET /reports/mine) and admin triage.
CREATE INDEX IF NOT EXISTS modrep_reporter_idx ON moderation_reports (reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS modrep_status_idx   ON moderation_reports (status, created_at DESC);

ALTER TABLE moderation_reports ENABLE ROW LEVEL SECURITY;

-- Reporters may read their own reports (API uses service role; this protects
-- any future PostgREST/direct access path).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'moderation_reports' AND policyname = 'modrep_reporter_read'
  ) THEN
    CREATE POLICY modrep_reporter_read ON moderation_reports FOR SELECT
      USING (reporter_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'moderation_reports' AND policyname = 'modrep_svc'
  ) THEN
    CREATE POLICY modrep_svc ON moderation_reports FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;
