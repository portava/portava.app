-- 0070_appeals.sql
-- Moderation appeals system.
-- Users submit appeals against moderation actions; admins review and resolve them.
-- target_type covers all appealable action domains.
-- UNIQUE (appellant_id, target_type, target_id) enforces one-active-appeal-per-target.

-- ── Enum types ────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'appeal_state'
  ) THEN
    CREATE TYPE appeal_state AS ENUM (
      'submitted',
      'under_review',
      'approved',
      'denied'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'appeal_target_type'
  ) THEN
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
  END IF;
END $$;

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS appeals (
  id               UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  appellant_id     UUID               NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_type      appeal_target_type NOT NULL,
  target_id        UUID               NOT NULL,
  reason           TEXT               NOT NULL,
  evidence_url     TEXT,
  state            appeal_state       NOT NULL DEFAULT 'submitted',
  moderator_id     UUID               REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note  TEXT,
  created_at       TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  -- One active appeal per appellant+target (prevents duplicate filing)
  UNIQUE (appellant_id, target_type, target_id)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS appeals_appellant_idx
  ON appeals (appellant_id);

CREATE INDEX IF NOT EXISTS appeals_state_created_idx
  ON appeals (state, created_at ASC);

CREATE INDEX IF NOT EXISTS appeals_moderator_idx
  ON appeals (moderator_id)
  WHERE moderator_id IS NOT NULL;

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE appeals ENABLE ROW LEVEL SECURITY;

-- Appellants can read and insert their own appeals
DROP POLICY IF EXISTS "Appellants read own appeals" ON appeals;
CREATE POLICY "Appellants read own appeals"
  ON appeals FOR SELECT
  USING (appellant_id = auth.uid());

DROP POLICY IF EXISTS "Appellants insert own appeals" ON appeals;
CREATE POLICY "Appellants insert own appeals"
  ON appeals FOR INSERT
  WITH CHECK (appellant_id = auth.uid());

-- Service role has unrestricted write access (bypasses RLS when using service key).
-- Admin/moderator read access is enforced at the application layer via requireAdminGuard()
-- using the service role client which bypasses RLS entirely.
