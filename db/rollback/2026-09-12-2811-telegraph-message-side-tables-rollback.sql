-- Rollback for src/migrations/2811_telegraph_message_side_tables.sql
-- Telegraph §12 — message_edits, message_reactions, message_attachments,
-- conversation_action_refs.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DESTROYS
-- ══════════════════════════════════════════════════════════════════════════════
-- As written, 2811's four tables have no application writer, so on a database
-- where that is still true this rollback loses nothing. THAT IS THE CONDITION,
-- NOT A PROPERTY OF THE FILE. Check it before running:
--
--     SELECT 'message_edits', count(*) FROM public.message_edits
--     UNION ALL SELECT 'message_reactions', count(*) FROM public.message_reactions
--     UNION ALL SELECT 'message_attachments', count(*) FROM public.message_attachments
--     UNION ALL SELECT 'conversation_action_refs', count(*) FROM public.conversation_action_refs;
--
-- A non-zero count in `message_edits` means previous message text that exists
-- nowhere else. A non-zero count in `conversation_action_refs` means revocation
-- state — which objects a conversation has stopped being allowed to reference —
-- that cannot be recomputed, because the thing it records is a decision.
-- `message_attachments` rows can be re-derived from `messages.media_url` only
-- for the single-attachment case that column can express; anything plural is
-- lost.
--
-- There is no flag to turn off instead, deliberately: 2811 shares 2810's flag
-- (`telegraph_message_kernel_enabled`), and turning that off stops the kernel
-- writing but does not make these tables go away. If the goal is "stop using
-- them", the flag is the answer and this file is not.
--
-- ORDER: policies are dropped with their tables; the tables have no
-- dependencies on each other, but `message_attachments` references
-- `public.media_assets` with ON DELETE RESTRICT, so dropping the table is the
-- only way to remove that restriction.

BEGIN;

DROP TABLE IF EXISTS public.conversation_action_refs;
DROP TABLE IF EXISTS public.message_attachments;
DROP TABLE IF EXISTS public.message_reactions;
DROP TABLE IF EXISTS public.message_edits;

COMMIT;
