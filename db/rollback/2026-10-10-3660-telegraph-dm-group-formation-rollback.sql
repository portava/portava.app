-- Rollback for artifacts/api-server/src/migrations/3660_telegraph_dm_group_formation.sql
-- Telegraph §14.3 — the 'group' thread type and the group-formation flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DESTROYS: NOTHING, AND IT REFUSES RATHER THAN DESTROY
-- ══════════════════════════════════════════════════════════════════════════════
-- Narrowing the CHECK back to direct | trip | circle is impossible while a
-- 'group' conversation exists, and deleting those conversations would delete
-- people's messages. So this file REFUSES when any group row exists; deciding
-- what happens to those conversations is an owner decision, not a rollback step.
--
-- CHECK BEFORE RUNNING:
--
--     SELECT count(*) FROM public.message_threads WHERE thread_type = 'group';
--
-- THE FLAG IS ALMOST CERTAINLY WHAT YOU WANT INSTEAD:
--
--     UPDATE public.feature_flags SET enabled = false
--      WHERE flag = 'telegraph_dm_group_formation_enabled';
--
-- That stops new groups being formed; existing groups keep working as ordinary
-- membership-gated conversations.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.message_threads WHERE thread_type = 'group') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: group conversations exist. Turn telegraph_dm_group_formation_enabled off instead, or decide their fate first.';
  END IF;
END $$;

ALTER TABLE public.message_threads DROP CONSTRAINT IF EXISTS chk_thread_context;
ALTER TABLE public.message_threads
  ADD CONSTRAINT chk_thread_context
  CHECK ((((thread_type = 'trip'::text) AND (trip_id IS NOT NULL) AND (circle_owner_id IS NULL))
       OR ((thread_type = 'circle'::text) AND (circle_owner_id IS NOT NULL) AND (trip_id IS NULL))
       OR ((thread_type = 'direct'::text) AND (trip_id IS NULL) AND (circle_owner_id IS NULL))));

ALTER TABLE public.message_threads DROP CONSTRAINT IF EXISTS message_threads_thread_type_check;
ALTER TABLE public.message_threads
  ADD CONSTRAINT message_threads_thread_type_check
  CHECK ((thread_type = ANY (ARRAY['direct'::text, 'trip'::text, 'circle'::text])));

DELETE FROM public.feature_flags
 WHERE flag = 'telegraph_dm_group_formation_enabled'
   AND description LIKE 'CAPABILITY gate for Telegraph §14.3 group formation:%';

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3660_telegraph_dm_group_formation.sql';
  END IF;
END $$;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.message_threads'::regclass AND conname = 'message_threads_thread_type_check';
  IF v_def LIKE '%''group''%' THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: thread_type still admits group.';
  END IF;
END $$;

COMMIT;
