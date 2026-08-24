-- 2158_post_media_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without owner approval.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- post_media.moderation_status / processing_status — an owner can self-set the
-- moderation verdict + processing state on their own media via a direct PostgREST
-- write (proven ALLOWED, adversarially re-verified). moderation_status gates
-- visibility, so self-approving is a MODERATION BYPASS. Same class as 2144-2154:
-- anon+authenticated hold TABLE-LEVEL write on every column; post_media_owner_write
-- scopes the ROW (user_id=auth.uid() + owns the post), not the COLUMNS.
--
-- ── FIX ─────────────────────────────────────────────────────────────────────
-- Content-allowlist: REVOKE ALL from anon+authenticated, GRANT SELECT back, and
-- re-GRANT column INSERT/UPDATE on the media-descriptor columns only. Server-owned
-- (NOT client-writable): moderation_status, processing_status (mandate) + the media
-- pipeline outputs phash, dedup_processed, canonical_place_id, feed_storage_path,
-- feed_url, stamp_overlay. RLS unchanged. SAFE TO RE-RUN.

BEGIN;
DO $$ BEGIN
  IF to_regclass('public.post_media') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED: missing'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.post_media'::regclass) THEN RAISE EXCEPTION 'PRECONDITION FAILED: RLS off'; END IF;
END $$;
REVOKE ALL ON TABLE public.post_media FROM anon;
REVOKE ALL ON TABLE public.post_media FROM authenticated;
GRANT SELECT ON TABLE public.post_media TO anon;
GRANT SELECT ON TABLE public.post_media TO authenticated;
GRANT INSERT (post_id, user_id, media_type, storage_bucket, storage_path, public_url, thumbnail_url, thumbnail_storage_path, mime_type, file_size_bytes, duration_seconds, width, height, sort_order)
  ON TABLE public.post_media TO authenticated;
GRANT UPDATE (media_type, storage_bucket, storage_path, public_url, thumbnail_url, thumbnail_storage_path, mime_type, file_size_bytes, duration_seconds, width, height, sort_order)
  ON TABLE public.post_media TO authenticated;
DO $$
DECLARE anon_p text; auth_p text; bad text;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO anon_p FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='post_media' AND grantee='anon';
  IF anon_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon=%',anon_p; END IF;
  SELECT COALESCE(string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type),'(none)') INTO auth_p FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='post_media' AND grantee='authenticated';
  IF auth_p <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated=%',auth_p; END IF;
  SELECT string_agg(DISTINCT grantee||'/'||privilege_type||'/'||column_name,', ') INTO bad FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='post_media' AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE') AND column_name IN ('moderation_status','processing_status','phash','dedup_processed','canonical_place_id','feed_storage_path','feed_url','stamp_overlay');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED: protected column client-writable: %',bad; END IF;
END $$;
COMMIT;
