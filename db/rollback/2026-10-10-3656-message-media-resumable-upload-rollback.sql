-- Rollback for 3656_message_media_resumable_upload.sql
-- NOT applied to any database at the time of writing.
--
-- 3656 seeded one flag (message_media_resumable_upload_enabled, FALSE) and
-- nothing else. Deleting the row returns POST/DELETE /media/upload-session to
-- 404 (the application reads it false-on-absent); the client falls back to
-- POST /media/upload. Parts left by sessions in flight are removed by the
-- parts sweep, which does not read this flag.

BEGIN;

DELETE FROM public.feature_flags WHERE flag = 'message_media_resumable_upload_enabled';

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'message_media_resumable_upload_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3656): the flag row survived.';
  END IF;
END $post$;

COMMIT;
