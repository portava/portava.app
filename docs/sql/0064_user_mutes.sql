-- ============================================================
-- 0064_user_mutes.sql
-- Global per-user mutes.
-- Orthogonal to message_thread_members.muted_at (thread-scoped mute).
-- A mute hides the target's content from the muter's feeds; the
-- target is not notified and can still see the muter.
-- ============================================================

-- mute_type covers the surfaces where the target is hidden
DO $$ BEGIN
  CREATE TYPE mute_surface AS ENUM (
    'posts',
    'stories',
    'suggestions',
    'all'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_mutes (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  muter_id    uuid          NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  muted_id    uuid          NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Array of surfaces; use '{all}' to mute everywhere
  mute_types  mute_surface[] NOT NULL DEFAULT '{all}',
  created_at  timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT user_mutes_unique UNIQUE (muter_id, muted_id),
  -- Cannot mute yourself
  CONSTRAINT user_mutes_no_self CHECK (muter_id <> muted_id)
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_mutes_muter_id
  ON user_mutes (muter_id);

CREATE INDEX IF NOT EXISTS idx_user_mutes_muted_id
  ON user_mutes (muted_id);

CREATE INDEX IF NOT EXISTS idx_user_mutes_pair
  ON user_mutes (muter_id, muted_id);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE user_mutes ENABLE ROW LEVEL SECURITY;

-- Muter reads their own mutes only
DROP POLICY IF EXISTS "user_mutes_select_own" ON user_mutes;
CREATE POLICY "user_mutes_select_own"
  ON user_mutes FOR SELECT
  USING (muter_id = auth.uid());

-- Muter inserts their own mutes
DROP POLICY IF EXISTS "user_mutes_insert_own" ON user_mutes;
CREATE POLICY "user_mutes_insert_own"
  ON user_mutes FOR INSERT
  WITH CHECK (muter_id = auth.uid());

-- Muter updates their own mute (e.g. change mute_types)
DROP POLICY IF EXISTS "user_mutes_update_own" ON user_mutes;
CREATE POLICY "user_mutes_update_own"
  ON user_mutes FOR UPDATE
  USING (muter_id = auth.uid());

-- Muter deletes (unmutes)
DROP POLICY IF EXISTS "user_mutes_delete_own" ON user_mutes;
CREATE POLICY "user_mutes_delete_own"
  ON user_mutes FOR DELETE
  USING (muter_id = auth.uid());

-- ── Verification ─────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'user_mutes'
-- ORDER BY ordinal_position;
