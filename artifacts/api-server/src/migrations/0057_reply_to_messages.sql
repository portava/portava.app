-- 0057_reply_to_messages.sql
-- Adds reply_to_id (message threading) and saved_messages table.

-- ── Reply threading ────────────────────────────────────────────────────────────
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to_id
  ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;

-- ── Saved messages ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  saved_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_messages_user
  ON saved_messages(user_id, saved_at DESC);

-- RLS
ALTER TABLE saved_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS saved_messages_select_own ON saved_messages;
CREATE POLICY saved_messages_select_own ON saved_messages
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS saved_messages_insert_own ON saved_messages;
CREATE POLICY saved_messages_insert_own ON saved_messages
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS saved_messages_delete_own ON saved_messages;
CREATE POLICY saved_messages_delete_own ON saved_messages
  FOR DELETE USING (auth.uid() = user_id);
