-- Rollback for artifacts/api-server/src/migrations/4090_telegraph_thread_notification_policy.sql
-- Telegraph §30A.6 — per-thread notification levels and temporary mute.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DESTROYS
-- ══════════════════════════════════════════════════════════════════════════════
-- Every member's chosen thread level (mentions / important / muted) and every
-- temporary mute in force. No message, membership or notification row is
-- touched. MUTED chosen through the legacy toggle lives in muted_at, which this
-- file does not touch, so those mutes survive.
--
-- CHECK BEFORE RUNNING:
--
--     SELECT notification_level, (muted_until > now()) AS temp_mute_live, count(*)
--       FROM public.message_thread_members
--      GROUP BY 1, 2 ORDER BY 3 DESC;
--
-- THE FLAG IS ALMOST CERTAINLY WHAT YOU WANT INSTEAD:
--
--     UPDATE public.feature_flags
--        SET enabled = false
--      WHERE flag = 'telegraph_thread_notification_policy_enabled';
--
-- That stops the levels being read or written (MUTED keeps working through
-- muted_at) while keeping what people chose.

BEGIN;

ALTER TABLE public.message_thread_members
  DROP CONSTRAINT IF EXISTS message_thread_members_notification_level_check;
ALTER TABLE public.message_thread_members
  DROP COLUMN IF EXISTS notification_level,
  DROP COLUMN IF EXISTS muted_until;

-- The flag row, only if it still carries this file's own seed description.
DELETE FROM public.feature_flags
 WHERE flag = 'telegraph_thread_notification_policy_enabled'
   AND description LIKE 'CAPABILITY gate for Telegraph §30A.6 per-thread notification levels.%';

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '4090_telegraph_thread_notification_policy.sql';
  END IF;
END $$;

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='message_thread_members'
       AND column_name IN ('notification_level','muted_until')
  ) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: a 4090 column is still present on message_thread_members.';
  END IF;
END $$;

COMMIT;
