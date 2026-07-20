-- Compass conversational AI: persistent multi-turn session tables.
--
-- compass_conversations  — one row per logical conversation session.
--   A new conversation starts when the client sends no conversation_id OR
--   last_active_at is older than 6 hours (enforced in application code).
--
-- compass_conversation_messages — ordered message history per conversation.
--   role: 'user' | 'assistant'
--   payload: optional structured JSON (card data, recommendation payload)
--   prompt_version: Compass prompt version used when the assistant replied

-- ── compass_conversations ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS compass_conversations (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compass_conversations_user_last_active
  ON compass_conversations (user_id, last_active_at DESC);

ALTER TABLE compass_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "compass_conversations_owner" ON compass_conversations
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── compass_conversation_messages ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS compass_conversation_messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES compass_conversations(id) ON DELETE CASCADE,
  role            TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT        NOT NULL,
  payload         JSONB,
  prompt_version  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compass_conversation_messages_conv_created
  ON compass_conversation_messages (conversation_id, created_at ASC);

ALTER TABLE compass_conversation_messages ENABLE ROW LEVEL SECURITY;

-- Messages inherit read/write access from the owning conversation.
CREATE POLICY "compass_conversation_messages_owner" ON compass_conversation_messages
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM compass_conversations c
      WHERE c.id = conversation_id
        AND c.user_id = auth.uid()
    )
  );
