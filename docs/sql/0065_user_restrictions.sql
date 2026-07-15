-- ============================================================
-- 0065_user_restrictions.sql
-- User-initiated restrictions.
-- DISTINCT from trust_restrictions (admin-only behavioural caps).
-- A restriction limits what the target can do TO the restrictor
-- (see online status, read receipts, message visibility) without
-- a full block. The target is not notified.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE restrict_surface AS ENUM (
    'read_receipts',
    'online_status',
    'message_delivery',
    'all'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_restrictions (
  id              uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  restrictor_id   uuid             NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  restricted_id   uuid             NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  restrict_types  restrict_surface[] NOT NULL DEFAULT '{all}',
  created_at      timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT user_restrictions_unique UNIQUE (restrictor_id, restricted_id),
  CONSTRAINT user_restrictions_no_self CHECK (restrictor_id <> restricted_id)
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_restrictions_restrictor_id
  ON user_restrictions (restrictor_id);

CREATE INDEX IF NOT EXISTS idx_user_restrictions_restricted_id
  ON user_restrictions (restricted_id);

CREATE INDEX IF NOT EXISTS idx_user_restrictions_pair
  ON user_restrictions (restrictor_id, restricted_id);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE user_restrictions ENABLE ROW LEVEL SECURITY;

-- Restrictor reads rows they created
DROP POLICY IF EXISTS "user_restrictions_select_restrictor" ON user_restrictions;
CREATE POLICY "user_restrictions_select_restrictor"
  ON user_restrictions FOR SELECT
  USING (restrictor_id = auth.uid());

-- Service role (permission engine) may also read the restricted_id side
-- (service role bypasses RLS by default in Supabase)

DROP POLICY IF EXISTS "user_restrictions_insert_own" ON user_restrictions;
CREATE POLICY "user_restrictions_insert_own"
  ON user_restrictions FOR INSERT
  WITH CHECK (restrictor_id = auth.uid());

DROP POLICY IF EXISTS "user_restrictions_update_own" ON user_restrictions;
CREATE POLICY "user_restrictions_update_own"
  ON user_restrictions FOR UPDATE
  USING (restrictor_id = auth.uid());

DROP POLICY IF EXISTS "user_restrictions_delete_own" ON user_restrictions;
CREATE POLICY "user_restrictions_delete_own"
  ON user_restrictions FOR DELETE
  USING (restrictor_id = auth.uid());

-- ── Verification ─────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'user_restrictions'
-- ORDER BY ordinal_position;
