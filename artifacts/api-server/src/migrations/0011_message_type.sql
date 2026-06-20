-- Add msg_type and subtype columns to messages for structured message categorisation.
-- msg_type: 'text' (default) | 'system'
-- subtype:  further classifies system messages, e.g. 'meetup'
ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS subtype TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_subtype
  ON messages(subtype) WHERE subtype IS NOT NULL;
