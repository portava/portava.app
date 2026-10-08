-- Rollback for 3705_moderation_report_capture_and_action_link.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Drops moderation_report_captures (every captured excerpt with it),
-- moderation_actions.report_id (metadata.report_id still records the link) and
-- the moderation_report_capture_enabled flag row. REFUSES while the flag is
-- TRUE: with capture on, dropping the table would make every new report's
-- capture fail without anyone having decided to stop capturing. Turn the flag
-- off first, on purpose.

BEGIN;

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'moderation_report_capture_enabled' AND enabled IS TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3705): moderation_report_capture_enabled is TRUE. Turn it off first.';
  END IF;
END $pre$;

DROP INDEX IF EXISTS public.idx_moderation_actions_report_id;
ALTER TABLE public.moderation_actions DROP COLUMN IF EXISTS report_id;
DROP TABLE IF EXISTS public.moderation_report_captures;
DELETE FROM public.feature_flags WHERE flag = 'moderation_report_capture_enabled';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.moderation_report_captures') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3705): moderation_report_captures still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.moderation_actions'::regclass AND attname = 'report_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3705): moderation_actions.report_id still exists.';
  END IF;
END $post$;
