-- Rollback for src/migrations/2810_telegraph_message_kernel.sql
-- Telegraph §12.1 / §13.3 / §17.1 — the message envelope, the per-conversation
-- sequence, the transactional outbox and the member sequence bounds.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- READ THIS BEFORE RUNNING IT
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FLAG IS THE ROLLBACK YOU ALMOST CERTAINLY WANT.
--
--     UPDATE public.feature_flags SET enabled = false
--      WHERE flag = 'telegraph_message_kernel_enabled';
--
-- Both triggers read that flag as their first statement and return immediately
-- when it is not TRUE. With it off, a database that has run 2810 behaves
-- exactly as one that has not: no sequences are allocated, no outbox rows are
-- written, and no shipped reader consults any column 2810 added. Turning the
-- flag off is instantaneous, reversible and loses nothing.
--
-- THIS FILE IS DESTRUCTIVE AND IS NOT REVERSIBLE.
-- Dropping `messages.sequence` destroys every sequence ever allocated. The
-- backfill can renumber a conversation afterwards — deterministically, by
-- (created_at, id) — but any client that had ACKNOWLEDGED a sequence (§17.2's
-- "reconnect resumes from last acknowledged conversation/event sequence") is
-- holding a cursor into a numbering that no longer exists, and will either
-- re-receive or skip messages on its next reconnect. Dropping
-- `public.telegraph_outbox` destroys every event that had not yet been
-- consumed.
--
-- So: run the UPDATE above. Run this file only when the columns themselves must
-- go, and only after establishing that no client holds a sequence cursor.
--
-- ORDER MATTERS: triggers before functions, functions before the table and
-- columns they reference, or the DROPs fail on dependencies.

BEGIN;

-- 1. Stop the writers first, so nothing allocates or enqueues mid-rollback.
DROP TRIGGER IF EXISTS telegraph_outbox_from_message ON public.messages;
DROP TRIGGER IF EXISTS telegraph_assign_message_sequence ON public.messages;

DROP FUNCTION IF EXISTS public.telegraph_outbox_from_message();
DROP FUNCTION IF EXISTS public.telegraph_assign_message_sequence();
DROP FUNCTION IF EXISTS public.telegraph_backfill_message_sequences(uuid);

-- 2. The outbox. Everything unpublished in it is lost at this point.
DROP INDEX IF EXISTS public.telegraph_outbox_unpublished_idx;
DROP INDEX IF EXISTS public.telegraph_outbox_dedupe_uniq;
DROP TABLE IF EXISTS public.telegraph_outbox;

-- 3. Indexes on messages, before the columns they cover.
DROP INDEX IF EXISTS public.messages_thread_sequence_idx;
DROP INDEX IF EXISTS public.messages_idempotency_uniq;

-- 4. The envelope columns.
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_lifecycle_state_check;
ALTER TABLE public.messages DROP COLUMN IF EXISTS lifecycle_state;
ALTER TABLE public.messages DROP COLUMN IF EXISTS unsent_at;
ALTER TABLE public.messages DROP COLUMN IF EXISTS content_ref;
ALTER TABLE public.messages DROP COLUMN IF EXISTS idempotency_key;
ALTER TABLE public.messages DROP COLUMN IF EXISTS client_message_id;
ALTER TABLE public.messages DROP COLUMN IF EXISTS sequence;

-- 5. The conversation counter and policy columns.
ALTER TABLE public.message_threads DROP COLUMN IF EXISTS policy_version;
ALTER TABLE public.message_threads DROP COLUMN IF EXISTS policy_id;
ALTER TABLE public.message_threads DROP COLUMN IF EXISTS last_sequence;

-- 6. The member bounds and cursors.
--
-- NOTE: `visible_from_at` (migration 2400) is NOT dropped here. It is a
-- different bound, in a different coordinate, owned by a different migration
-- and still read by the message reader when telegraph_history_bound_enabled is
-- on. Dropping it from this file would turn a rollback of the sequence kernel
-- into a silent removal of the §14.3 history bound.
ALTER TABLE public.message_thread_members DROP COLUMN IF EXISTS seen_sequence;
ALTER TABLE public.message_thread_members DROP COLUMN IF EXISTS delivered_sequence;
ALTER TABLE public.message_thread_members DROP COLUMN IF EXISTS visible_until_sequence;
ALTER TABLE public.message_thread_members DROP COLUMN IF EXISTS visible_from_sequence;

-- 7. The flag row. Left LAST so that if anything above fails, the flag is still
-- there to be turned off.
DELETE FROM public.feature_flags WHERE flag = 'telegraph_message_kernel_enabled';

COMMIT;
