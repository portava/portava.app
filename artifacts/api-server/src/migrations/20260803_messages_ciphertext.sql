-- Migration: messages_ciphertext
-- Phase E-2: end-to-end encryption for 1:1 threads.
--
-- Adds:
--   messages.ciphertext    — MLS ApplicationMessage bytes, base64-encoded.
--                            Non-null only for E2EE messages; body is null when
--                            ciphertext is present.
--   message_threads.is_e2ee — TRUE for new 1:1 threads created after E-2 rollout
--                             where both users have registered device keys.
--
-- Existing threads and messages are UNAFFECTED (ciphertext stays null; is_e2ee=false).

-- UP:

-- Add ciphertext column. Nullable: null for plaintext messages.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ciphertext TEXT;

-- Add is_e2ee flag to threads. Default FALSE preserves all existing threads.
ALTER TABLE message_threads
  ADD COLUMN IF NOT EXISTS is_e2ee BOOLEAN NOT NULL DEFAULT FALSE;

-- Index to efficiently query E2EE threads for a given user.
CREATE INDEX IF NOT EXISTS idx_message_threads_is_e2ee
  ON message_threads (is_e2ee)
  WHERE is_e2ee = TRUE;

-- Partial index: find unprocessed E2EE ciphertext for monitoring / reporting.
CREATE INDEX IF NOT EXISTS idx_messages_ciphertext_exists
  ON messages (thread_id, created_at)
  WHERE ciphertext IS NOT NULL;

-- DOWN:
-- DROP INDEX IF EXISTS idx_messages_ciphertext_exists;
-- DROP INDEX IF EXISTS idx_message_threads_is_e2ee;
-- ALTER TABLE message_threads DROP COLUMN IF EXISTS is_e2ee;
-- ALTER TABLE messages DROP COLUMN IF EXISTS ciphertext;
