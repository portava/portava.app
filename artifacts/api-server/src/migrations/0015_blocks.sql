-- Migration: 0015_blocks.sql
-- Creates `blocks` table and is_blocked() SECURITY DEFINER helper.

CREATE TABLE IF NOT EXISTS blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blocks_pair_unique UNIQUE (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS blocks_blocker_idx ON blocks(blocker_id);
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON blocks(blocked_id);

ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_view_own_blocks" ON blocks
  FOR SELECT USING (auth.uid() = blocker_id);

CREATE POLICY "users_insert_own_blocks" ON blocks
  FOR INSERT WITH CHECK (auth.uid() = blocker_id);

CREATE POLICY "users_delete_own_blocks" ON blocks
  FOR DELETE USING (auth.uid() = blocker_id);

-- SECURITY DEFINER helper: returns true if a blocks b OR b blocks a
CREATE OR REPLACE FUNCTION is_blocked(a uuid, b uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM blocks
    WHERE (blocker_id = a AND blocked_id = b)
       OR (blocker_id = b AND blocked_id = a)
  );
$$;
