-- Rollback for artifacts/api-server/src/migrations/3825_telegraph_message_link_previews.sql
-- Telegraph §30A.8 link previews (census-telegraph T404 / T446).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DESTROYS
-- ══════════════════════════════════════════════════════════════════════════════
-- Every stored link preview (title, description, site name, the link and its host, per message).
-- No message, thread or member row is touched; a message whose preview is dropped renders exactly as
-- it did before 3825 — its link as plain text.
--
-- CHECK BEFORE RUNNING:
--
--     SELECT status, count(*) FROM public.message_link_previews GROUP BY 1;
--
-- THE FLAG IS ALMOST CERTAINLY WHAT YOU WANT INSTEAD:
--
--     UPDATE public.feature_flags SET enabled = false WHERE flag = 'telegraph_link_previews_enabled';
--
-- That stops every new fetch and every read of the table while the drop-on-change trigger keeps
-- removing the rows of edited, unsent and deleted messages.

BEGIN;

DROP TRIGGER IF EXISTS telegraph_link_preview_drop_on_change ON public.messages;
DROP FUNCTION IF EXISTS public.telegraph_link_preview_drop_on_change();
DROP FUNCTION IF EXISTS public.telegraph_store_link_preview(uuid, uuid, text, text, text, text, text, text, text);
DROP TABLE IF EXISTS public.message_link_previews;

-- The flag row, only if it still carries this file's own seed description.
DELETE FROM public.feature_flags
 WHERE flag = 'telegraph_link_previews_enabled'
   AND description LIKE 'CAPABILITY gate for Telegraph §30A.8 link previews%';

DO $$
BEGIN
  IF to_regclass('public.message_link_previews') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK FAILED (3825): public.message_link_previews still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.messages'::regclass
              AND tgname = 'telegraph_link_preview_drop_on_change') THEN
    RAISE EXCEPTION 'ROLLBACK FAILED (3825): the drop-on-change trigger still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('telegraph_store_link_preview', 'telegraph_link_preview_drop_on_change')) THEN
    RAISE EXCEPTION 'ROLLBACK FAILED (3825): a 3825 function still exists.';
  END IF;
END $$;

COMMIT;
