-- ============================================================
-- 0063_user_account_states.sql
-- Account lifecycle state for a user (active, limited, suspended, banned …).
-- Stored separately from profiles to avoid SELECT * leakage and to allow
-- multiple historical state rows per user.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE account_state AS ENUM (
    'active',
    'new',
    'verified',
    'limited',
    'under_review',
    'suspended',
    'banned',
    'deleted',
    'deactivated'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_account_states (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  state       account_state NOT NULL DEFAULT 'active',
  reason      text,
  metadata    jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_account_states_user_id
  ON user_account_states (user_id);

CREATE INDEX IF NOT EXISTS idx_user_account_states_state
  ON user_account_states (state);

CREATE INDEX IF NOT EXISTS idx_user_account_states_expires_at
  ON user_account_states (expires_at)
  WHERE expires_at IS NOT NULL;

-- ── Updated-at trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION update_user_account_states_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_account_states_updated_at ON user_account_states;
CREATE TRIGGER trg_user_account_states_updated_at
  BEFORE UPDATE ON user_account_states
  FOR EACH ROW EXECUTE FUNCTION update_user_account_states_updated_at();

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE user_account_states ENABLE ROW LEVEL SECURITY;

-- Users may read their own state rows
DROP POLICY IF EXISTS "account_states_select_own" ON user_account_states;
CREATE POLICY "account_states_select_own"
  ON user_account_states FOR SELECT
  USING (user_id = auth.uid());

-- All writes go through the service role (no user INSERT/UPDATE/DELETE policies)

-- ── Verification ─────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'user_account_states'
-- ORDER BY ordinal_position;
