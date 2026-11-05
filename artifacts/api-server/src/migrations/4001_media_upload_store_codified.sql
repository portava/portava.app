-- 4001_media_upload_store_codified.sql
--
-- Written 2026-11-04 on the owner's decision ("codify" for the chunked-upload
-- store and the deletion lease, 23:09 UTC) over the 59 production objects that
-- check:undeclared-production-objects (PR #820) carried as owner-pending. The
-- journey-shadow programme stays on that ratchet, undecided.
--
-- Codifies production's chunked-upload store: media_upload_sessions,
-- media_upload_chunks, commit_media_upload_chunk(uuid, uuid, bigint, integer,
-- text, text) and three media_assets columns (hls_path, subtitle_paths,
-- subtitle_processing_status). Code outside this repository created them on
-- production between the 2026-09-22 and 2026-10-24 captures; no file in this
-- tree declared them, nothing in this tree reads or writes them, and the
-- reverse drift guard carried them as owner-pending. Every definition below is
-- the census note's transcription of production's catalogue
-- (docs/architecture/census-media.md, "Note (2026-10-24, capability refresh,
-- PR #788)"): the function body byte for byte, the columns, checks, keys and
-- indexes by name.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. Its prerequisites all sort before
-- it: media_assets (0103's band) and auth.users.
--
-- WHAT IT DOES, BY STARTING SHAPE
--   production     every object exists and matches: the function is skipped by
--                  its digest guard, every other statement is IF NOT EXISTS or
--                  a privilege it already holds. Only the postconditions read.
--   portava-ci,    creates the two tables, the function and the three columns
--   local chain    with production's privileges: RLS enabled with no policy,
--                  table privileges to service_role only (no anon, no
--                  authenticated), EXECUTE to service_role only.
--
-- It changes no row anywhere. The body runs inside BEGIN/COMMIT; the
-- postconditions follow the COMMIT as read-only DO blocks, the shape
-- scripts/src/apply-migrations.ts applies and certify:migrations re-runs.

-- ── media_upload_sessions ───────────────────────────────────────────────────
BEGIN;

CREATE TABLE IF NOT EXISTS public.media_upload_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resume_token_hash text NOT NULL,
  total_bytes bigint NOT NULL CHECK ((total_bytes > 0) AND (total_bytes <= 104857600)),
  declared_mime text NOT NULL,
  expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'::text),
  offset_bytes bigint NOT NULL DEFAULT 0 CHECK (offset_bytes >= 0),
  state text NOT NULL DEFAULT 'uploading'::text CHECK (state = ANY (ARRAY['uploading'::text, 'completed'::text])),
  expires_at timestamptz NOT NULL,
  completed_url text,
  asset_id uuid REFERENCES public.media_assets(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS media_upload_sessions_expiry_idx
  ON public.media_upload_sessions (expires_at) WHERE (state = 'uploading'::text);
CREATE INDEX IF NOT EXISTS media_upload_sessions_owner_idx
  ON public.media_upload_sessions (owner_user_id, created_at DESC);

ALTER TABLE public.media_upload_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.media_upload_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.media_upload_sessions TO service_role;

-- ── media_upload_chunks ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.media_upload_chunks (
  session_id uuid NOT NULL REFERENCES public.media_upload_sessions(id) ON DELETE CASCADE,
  offset_bytes bigint NOT NULL CHECK (offset_bytes >= 0),
  byte_length integer NOT NULL CHECK ((byte_length > 0) AND (byte_length <= 8388608)),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'::text),
  storage_path text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, offset_bytes)
);

ALTER TABLE public.media_upload_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.media_upload_chunks FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.media_upload_chunks TO service_role;

-- ── commit_media_upload_chunk ───────────────────────────────────────────────
-- Production's pg_get_functiondef, re-quoted from $function$ to $fn$ only. The
-- census records md5(pg_get_functiondef) = 016ffeae860d57898841514512beabb1 for
-- production's copy; the same text applied on PostgreSQL 16 yields the same
-- digest, which the postcondition below also requires. The guard makes a
-- re-run a strict no-op where the function already matches. The definition
-- is not indented inside the block: the body text is part of the digest.
DO $do$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.commit_media_upload_chunk(uuid, uuid, bigint, integer, text, text)'))
     IS DISTINCT FROM '016ffeae860d57898841514512beabb1' THEN
CREATE OR REPLACE FUNCTION public.commit_media_upload_chunk(p_session_id uuid, p_owner_user_id uuid, p_offset bigint, p_chunk_bytes integer, p_sha256 text, p_storage_path text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  s media_upload_sessions%ROWTYPE;
  prior media_upload_chunks%ROWTYPE;
BEGIN
  SELECT * INTO s FROM media_upload_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND OR s.owner_user_id <> p_owner_user_id THEN
    RETURN jsonb_build_object('result','invalid','offset',0);
  END IF;
  IF s.state <> 'uploading' OR s.expires_at <= now() THEN
    RETURN jsonb_build_object('result','expired','offset',s.offset_bytes);
  END IF;
  IF p_chunk_bytes <= 0 OR p_chunk_bytes > 8388608 OR p_offset + p_chunk_bytes > s.total_bytes THEN
    RETURN jsonb_build_object('result','invalid','offset',s.offset_bytes);
  END IF;
  IF p_offset = s.offset_bytes THEN
    INSERT INTO media_upload_chunks(session_id, offset_bytes, byte_length, sha256, storage_path)
    VALUES (p_session_id, p_offset, p_chunk_bytes, p_sha256, p_storage_path);
    UPDATE media_upload_sessions SET offset_bytes = offset_bytes + p_chunk_bytes WHERE id = p_session_id;
    RETURN jsonb_build_object('result','accepted','offset',s.offset_bytes + p_chunk_bytes);
  END IF;
  SELECT * INTO prior FROM media_upload_chunks
    WHERE session_id = p_session_id AND offset_bytes = p_offset;
  IF FOUND AND prior.byte_length = p_chunk_bytes AND prior.sha256 = p_sha256 THEN
    RETURN jsonb_build_object('result','replay','offset',s.offset_bytes);
  END IF;
  RETURN jsonb_build_object('result','conflict','offset',s.offset_bytes);
END $fn$;

REVOKE EXECUTE ON FUNCTION public.commit_media_upload_chunk(uuid, uuid, bigint, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_media_upload_chunk(uuid, uuid, bigint, integer, text, text) TO service_role;
  END IF;
END $do$;

-- ── media_assets: three columns ─────────────────────────────────────────────
ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS hls_path text;
ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS subtitle_paths jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS subtitle_processing_status text NOT NULL DEFAULT 'not_requested'::text;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_assets_subtitle_processing_status_check'
      AND conrelid = 'public.media_assets'::regclass
  ) THEN
    ALTER TABLE public.media_assets
      ADD CONSTRAINT media_assets_subtitle_processing_status_check
      CHECK (subtitle_processing_status = ANY (ARRAY['not_requested'::text, 'pending'::text, 'ready'::text, 'unavailable'::text]));
  END IF;
END $do$;

COMMIT;

-- ── Postconditions: read only ───────────────────────────────────────────────
DO $do$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.media_upload_sessions') IS NULL THEN missing := missing || 'media_upload_sessions'; END IF;
  IF to_regclass('public.media_upload_chunks') IS NULL THEN missing := missing || 'media_upload_chunks'; END IF;
  IF to_regprocedure('public.commit_media_upload_chunk(uuid, uuid, bigint, integer, text, text)') IS NULL THEN
    missing := missing || 'commit_media_upload_chunk';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'media_assets' AND column_name = 'hls_path') THEN missing := missing || 'media_assets.hls_path'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'media_assets' AND column_name = 'subtitle_paths') THEN missing := missing || 'media_assets.subtitle_paths'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'media_assets' AND column_name = 'subtitle_processing_status') THEN missing := missing || 'media_assets.subtitle_processing_status'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_assets_subtitle_processing_status_check') THEN missing := missing || 'media_assets_subtitle_processing_status_check'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'media_upload_sessions_expiry_idx') THEN missing := missing || 'media_upload_sessions_expiry_idx'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'media_upload_sessions_owner_idx') THEN missing := missing || 'media_upload_sessions_owner_idx'; END IF;
  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION '4001: postcondition failed, missing %', array_to_string(missing, ', ');
  END IF;
END $do$;

-- The function is production's byte for byte, and the privileges are
-- production's: service_role only, nothing to anon, authenticated or PUBLIC.
DO $do$
DECLARE
  got text;
  widened text[] := ARRAY[]::text[];
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO got FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.commit_media_upload_chunk(uuid, uuid, bigint, integer, text, text)');
  IF got IS DISTINCT FROM '016ffeae860d57898841514512beabb1' THEN
    RAISE EXCEPTION '4001: postcondition failed, commit_media_upload_chunk differs from production (digest %, production 016ffeae860d57898841514512beabb1)', coalesce(got, 'absent');
  END IF;
  IF has_function_privilege('anon', 'public.commit_media_upload_chunk(uuid, uuid, bigint, integer, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.commit_media_upload_chunk(uuid, uuid, bigint, integer, text, text)', 'EXECUTE') THEN
    widened := widened || 'commit_media_upload_chunk EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.commit_media_upload_chunk(uuid, uuid, bigint, integer, text, text)', 'EXECUTE') THEN
    widened := widened || 'commit_media_upload_chunk EXECUTE missing for service_role';
  END IF;
  FOR got IN SELECT unnest(ARRAY['media_upload_sessions', 'media_upload_chunks']) LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || got)::regclass) THEN
      widened := widened || (got || ' RLS off');
    END IF;
    IF has_table_privilege('anon', 'public.' || got, 'SELECT, INSERT, UPDATE, DELETE')
       OR has_table_privilege('authenticated', 'public.' || got, 'SELECT, INSERT, UPDATE, DELETE') THEN
      widened := widened || (got || ' client privilege');
    END IF;
    IF NOT has_table_privilege('service_role', 'public.' || got, 'SELECT, INSERT, UPDATE, DELETE') THEN
      widened := widened || (got || ' service_role privilege missing');
    END IF;
  END LOOP;
  IF array_length(widened, 1) IS NOT NULL THEN
    RAISE EXCEPTION '4001: postcondition failed, privileges are not production''s: %', array_to_string(widened, ', ');
  END IF;
END $do$;
