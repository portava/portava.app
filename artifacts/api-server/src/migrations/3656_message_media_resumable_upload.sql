-- 3656_message_media_resumable_upload.sql
-- Telegraph §16.2 "Resumable/chunked upload for poor travel connectivity"
-- (census-telegraph T223). POST-CUTOVER CANONICAL FORWARD MIGRATION.
-- Lane T-REL band 3654-3659.
--
-- WHAT THIS IS. The capability flag for the resumable MESSAGE-media transport
-- (routes/messageMediaTransport.ts), which reuses the postcard part-upload
-- protocol (lib/postcardMediaTransport.ts: fixed 4 MiB parts PUT straight to
-- signed Storage URLs, a session that lists what landed, assemble that checks
-- every part's size and the bytes' kind) and then stores the assembled bytes
-- through the SAME processing path as POST /media/upload
-- (routes/posts.ts storeVerifiedMediaUpload: EXIF/GPS strip, thumbnail, video
-- location scrub, media_assets record). The object it produces is exactly the
-- one /media/upload produces, so POST /threads/:id/media and every reader are
-- unchanged.
--
-- No table: a session is (caller, client-generated upload id, declared mime and
-- size), restated on every call and re-verified at assemble; parts live under
-- post-media/message-upload-parts/<user id>/<upload id>.parts/, a prefix no
-- client storage policy grants and only the server signs into. Abandoned parts
-- (raw, unprocessed bytes) are removed by lib/messageMediaPartsSweep.ts after
-- the signed-URL lifetime + grace (2.5 h of inactivity), and at once when the
-- owner's profile no longer exists. That sweep is not flag-gated: it only ever
-- deletes temporary raw bytes, and a flag would only be a way to keep them.
--
-- Seeded FALSE: POST /media/upload-session answers 404 and the client keeps
-- using the single-request POST /media/upload, exactly as before.
--
-- ROLLBACK: db/rollback/2026-10-10-3656-message-media-resumable-upload-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3656): public.feature_flags must exist.';
  END IF;
END $pre$;

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('message_media_resumable_upload_enabled', false,
   'CAPABILITY gate for resumable message-media upload (Telegraph §16.2, census-telegraph T223, migration 3656). OFF (the seed): POST/DELETE /media/upload-session answer 404 and the client uses the single-request POST /media/upload. ON: 4 MiB parts go straight to signed Storage URLs under post-media/message-upload-parts/<user>/, a dropped connection costs only the part in flight, and assemble stores the bytes through the same processing path as /media/upload. Emergency stop disable_media_uploads still applies.')
ON CONFLICT (flag) DO NOTHING;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'message_media_resumable_upload_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3656): message_media_resumable_upload_enabled was not seeded.';
  END IF;
END $post$;

COMMIT;
