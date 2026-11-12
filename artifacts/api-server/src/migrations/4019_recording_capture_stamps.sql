-- An issuer-owned receipt for one verified video upload and one current publication.
-- A recording receipt is neither a social reaction nor evidence of location/presence.
CREATE TABLE public.recording_capture_stamps (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 sha256 text UNIQUE CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 storage_path text UNIQUE,
 sealed_at timestamptz,
 issued_at timestamptz,
 stamp_id uuid UNIQUE,
 target_type text CHECK(target_type IN ('post','story')),
 post_id uuid UNIQUE REFERENCES public.posts(id) ON DELETE SET NULL,
 story_id uuid UNIQUE REFERENCES public.stories(id) ON DELETE SET NULL,
 object_id uuid,
 object_version text,
 CHECK ((sha256 IS NULL) = (storage_path IS NULL) AND (sha256 IS NULL) = (sealed_at IS NULL)),
 CHECK ((issued_at IS NULL) = (target_type IS NULL) AND (issued_at IS NULL) = (object_id IS NULL) AND (issued_at IS NULL) = (stamp_id IS NULL)),
 CHECK (post_id IS NULL OR target_type='post'), CHECK (story_id IS NULL OR target_type='story')
);
CREATE INDEX recording_capture_stamp_owner_time ON public.recording_capture_stamps(owner_id,created_at);
CREATE INDEX recording_capture_stamp_pending ON public.recording_capture_stamps(expires_at) WHERE issued_at IS NULL;
ALTER TABLE public.recording_capture_stamps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recording_capture_stamps FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.recording_capture_stamps TO service_role;
CREATE POLICY recording_capture_stamp_service ON public.recording_capture_stamps FOR ALL TO service_role USING(true) WITH CHECK(true);
-- The normal owner storage policies must not permit the camera original to be
-- planted, replaced, renamed into this prefix or deleted/recreated underneath a receipt.
CREATE POLICY recording_original_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO anon,authenticated
 WITH CHECK(NOT (bucket_id='post-media' AND split_part(name,'/',2)='capture-stamps'));
CREATE POLICY recording_original_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon,authenticated
 USING(NOT (bucket_id='post-media' AND split_part(name,'/',2)='capture-stamps'))
 WITH CHECK(NOT (bucket_id='post-media' AND split_part(name,'/',2)='capture-stamps'));
CREATE POLICY recording_original_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO anon,authenticated
 USING(NOT (bucket_id='post-media' AND split_part(name,'/',2)='capture-stamps'));

CREATE FUNCTION public.open_recording_capture(p_owner uuid,p_id uuid,p_hash text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE expiry timestamptz := clock_timestamp()+interval '30 minutes';
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('recording-capture:'||p_owner::text,0));
 DELETE FROM public.recording_capture_stamps WHERE issued_at IS NULL AND expires_at < clock_timestamp()-interval '1 day';
 IF (SELECT count(*) FROM public.recording_capture_stamps WHERE owner_id=p_owner AND created_at>clock_timestamp()-interval '1 hour')>=12 THEN RAISE EXCEPTION 'capture_rate_limit'; END IF;
 INSERT INTO public.recording_capture_stamps(id,owner_id,token_hash,expires_at) VALUES(p_id,p_owner,p_hash,expiry);
 RETURN expiry;
END $$;

CREATE FUNCTION public.seal_recording_capture(p_owner uuid,p_id uuid,p_hash text,p_sha text,p_extension text) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE c public.recording_capture_stamps%ROWTYPE; object_path text;
BEGIN
 SELECT * INTO c FROM public.recording_capture_stamps WHERE id=p_id AND owner_id=p_owner AND token_hash=p_hash FOR UPDATE;
 IF NOT FOUND OR c.expires_at<=clock_timestamp() OR c.issued_at IS NOT NULL OR p_sha IS NULL OR p_sha!~'^[a-f0-9]{64}$' OR p_extension IS NULL OR p_extension NOT IN('mp4','mov','webm','m4v','3gp') THEN RAISE EXCEPTION 'capture_refused'; END IF;
 object_path:=p_owner::text||'/capture-stamps/'||p_id::text||'.'||p_extension;
 IF c.sealed_at IS NOT NULL THEN
   IF c.sha256=p_sha AND c.storage_path=object_path THEN RETURN object_path; END IF;
   RAISE EXCEPTION 'capture_refused';
 END IF;
 UPDATE public.recording_capture_stamps SET sha256=p_sha,storage_path=object_path,sealed_at=clock_timestamp() WHERE id=p_id;
 RETURN object_path;
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'capture_refused';
END $$;

CREATE FUNCTION public.recording_capture_attached(p_owner uuid,p_type text,p_target uuid,p_path text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT CASE p_type
 WHEN 'story' THEN EXISTS(SELECT 1 FROM public.stories s WHERE s.id=p_target AND s.owner_id=p_owner AND s.state='active'
   AND s.expires_at>now() AND s.media_type LIKE 'video%' AND s.media_url='post-media/'||p_path)
 WHEN 'post' THEN EXISTS(SELECT 1 FROM public.posts p JOIN public.post_media m ON m.post_id=p.id
   WHERE p.id=p_target AND p.author_id=p_owner AND p.status='active' AND p.deleted_at IS NULL
     AND p.post_status='published' AND m.media_type='video' AND m.storage_bucket='post-media' AND m.storage_path=p_path
     AND m.processing_status='ready' AND m.moderation_status::text IN('pending','approved','active'))
 ELSE false END
$$;
CREATE FUNCTION public.issue_recording_capture(p_owner uuid,p_id uuid,p_hash text,p_type text,p_target uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE c public.recording_capture_stamps%ROWTYPE; obj uuid; generation text;
BEGIN
 SELECT * INTO c FROM public.recording_capture_stamps WHERE id=p_id AND owner_id=p_owner AND token_hash=p_hash FOR UPDATE;
 IF NOT FOUND OR c.sealed_at IS NULL OR p_type NOT IN('post','story') OR p_type IS NULL OR p_target IS NULL THEN RAISE EXCEPTION 'capture_refused'; END IF;
 IF NOT public.recording_capture_attached(p_owner,p_type,p_target,c.storage_path) THEN RAISE EXCEPTION 'capture_refused'; END IF;
 SELECT o.id,coalesce(to_jsonb(o)->>'version',to_jsonb(o)->>'updated_at') INTO obj,generation
   FROM storage.objects o WHERE o.bucket_id='post-media' AND o.name=c.storage_path FOR SHARE;
 IF obj IS NULL THEN RAISE EXCEPTION 'capture_refused'; END IF;
 IF c.issued_at IS NOT NULL THEN
   IF c.target_type=p_type AND coalesce(c.post_id,c.story_id)=p_target AND c.object_id=obj AND c.object_version IS NOT DISTINCT FROM generation THEN RETURN c.stamp_id; END IF;
   RAISE EXCEPTION 'capture_refused';
 END IF;
 IF c.sealed_at < clock_timestamp()-interval '1 day' THEN RAISE EXCEPTION 'capture_refused'; END IF;
 UPDATE public.recording_capture_stamps SET target_type=p_type,post_id=CASE WHEN p_type='post' THEN p_target END,
   story_id=CASE WHEN p_type='story' THEN p_target END,issued_at=clock_timestamp(),stamp_id=gen_random_uuid(),object_id=obj,object_version=generation WHERE id=c.id
 RETURNING stamp_id INTO c.stamp_id;
 RETURN c.stamp_id;
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'capture_refused';
END $$;
CREATE FUNCTION public.read_recording_capture(p_type text,p_target uuid)
RETURNS TABLE(id uuid,owner_id uuid,issued_at timestamptz,storage_path text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT c.stamp_id,c.owner_id,c.issued_at,c.storage_path FROM public.recording_capture_stamps c JOIN storage.objects o ON o.id=c.object_id
 WHERE c.target_type=p_type AND ((p_type='post' AND c.post_id=p_target) OR (p_type='story' AND c.story_id=p_target))
   AND c.issued_at IS NOT NULL AND o.bucket_id='post-media' AND o.name=c.storage_path
   AND c.object_version IS NOT DISTINCT FROM coalesce(to_jsonb(o)->>'version',to_jsonb(o)->>'updated_at')
   AND public.recording_capture_attached(c.owner_id,p_type,p_target,c.storage_path)
$$;
REVOKE ALL ON FUNCTION public.open_recording_capture(uuid,uuid,text), public.seal_recording_capture(uuid,uuid,text,text,text),
 public.recording_capture_attached(uuid,text,uuid,text), public.issue_recording_capture(uuid,uuid,text,text,uuid),
 public.read_recording_capture(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.open_recording_capture(uuid,uuid,text), public.seal_recording_capture(uuid,uuid,text,text,text),
 public.recording_capture_attached(uuid,text,uuid,text), public.issue_recording_capture(uuid,uuid,text,text,uuid),
 public.read_recording_capture(text,uuid) TO service_role;
