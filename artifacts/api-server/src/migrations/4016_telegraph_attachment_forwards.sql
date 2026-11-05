-- Private, sanitized attachment copies. The journal is durable before Storage writes.
-- Service-only; no source lineage is exposed to the target conversation.
BEGIN;
CREATE TABLE IF NOT EXISTS public.telegraph_forward_media_jobs (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL,
 source_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
 target_thread_id uuid REFERENCES public.message_threads(id) ON DELETE SET NULL,
 forwarder_id uuid NOT NULL,
 source_fingerprint text NOT NULL,
 capability text NOT NULL CHECK(capability IN ('ALLOW','SOURCE_POLICY','EXPIRES_WITH_SOURCE')),
 state text NOT NULL CHECK(state IN ('preparing','ready','abandoned')),
 storage_paths text[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
 UNIQUE(forwarder_id,request_id)
);
ALTER TABLE public.telegraph_forward_media_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegraph_forward_media_jobs FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.telegraph_forward_media_jobs TO service_role;
CREATE INDEX IF NOT EXISTS telegraph_forward_media_cleanup_idx ON public.telegraph_forward_media_jobs(state,expires_at);

-- Serialize author policy changes on the same source-row lock as forwarding.
-- This also closes the absent-capability-row race in the original text writer.
CREATE OR REPLACE FUNCTION public.telegraph_set_content_capability(p_message uuid,p_actor uuid,p_capability text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source public.messages%ROWTYPE;
BEGIN
 SELECT * INTO source FROM public.messages WHERE id=p_message FOR UPDATE;
 IF NOT FOUND OR source.sender_id<>p_actor OR source.deleted_at IS NOT NULL OR source.unsent_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.message_forwards WHERE target_message_id=p_message)
  OR NOT EXISTS(SELECT 1 FROM public.message_thread_members WHERE thread_id=source.thread_id AND user_id=p_actor AND left_at IS NULL)
  OR p_capability IS NULL OR p_capability NOT IN ('ALLOW','NO_FORWARD','SOURCE_POLICY','EXPIRES_WITH_SOURCE') THEN RAISE EXCEPTION 'forward_policy_unavailable'; END IF;
 INSERT INTO public.message_content_capabilities(message_id,capability,set_by,updated_at)
 VALUES(p_message,p_capability,p_actor,now()) ON CONFLICT(message_id) DO UPDATE SET capability=EXCLUDED.capability,set_by=EXCLUDED.set_by,updated_at=EXCLUDED.updated_at;
END $$;
REVOKE ALL ON FUNCTION public.telegraph_set_content_capability(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_set_content_capability(uuid,uuid,text) TO service_role;

-- Called again at commit, after all potentially slow Storage work.
CREATE OR REPLACE FUNCTION public.telegraph_media_forward_facts(p_source uuid,p_target uuid,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s public.messages%ROWTYPE; m public.message_thread_members%ROWTYPE; cap text; inherited text; t public.message_threads%ROWTYPE;
BEGIN
 SELECT * INTO t FROM public.message_threads WHERE id=p_target FOR SHARE;
 IF NOT FOUND OR t.is_e2ee IS TRUE OR t.status='archived' THEN RAISE EXCEPTION 'forward_unavailable'; END IF;
 PERFORM 1 FROM public.message_thread_members WHERE thread_id=p_target AND user_id=p_actor AND left_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'forward_unavailable'; END IF;
 SELECT * INTO s FROM public.messages WHERE id=p_source FOR SHARE;
 IF NOT FOUND OR s.deleted_at IS NOT NULL OR s.unsent_at IS NOT NULL OR s.ciphertext IS NOT NULL THEN RAISE EXCEPTION 'forward_unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM public.message_threads WHERE id=s.thread_id AND is_e2ee IS TRUE) THEN RAISE EXCEPTION 'forward_unavailable'; END IF;
 SELECT * INTO m FROM public.message_thread_members WHERE thread_id=s.thread_id AND user_id=p_actor AND left_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'forward_unavailable'; END IF;
 IF s.sender_id<>p_actor AND ((m.visible_from_at IS NOT NULL AND s.created_at<m.visible_from_at)
   OR (m.visible_from_sequence IS NOT NULL AND (s.sequence IS NULL OR s.sequence<m.visible_from_sequence))
   OR (m.visible_until_sequence IS NOT NULL AND (s.sequence IS NULL OR s.sequence>m.visible_until_sequence))) THEN RAISE EXCEPTION 'forward_unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM public.blocks WHERE (blocker_id=p_actor AND blocked_id=s.sender_id) OR (blocked_id=p_actor AND blocker_id=s.sender_id)) THEN RAISE EXCEPTION 'forward_unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM public.blocks b JOIN public.message_thread_members tm ON tm.thread_id=p_target AND tm.left_at IS NULL
   WHERE (b.blocker_id=p_actor AND b.blocked_id=tm.user_id) OR (b.blocked_id=p_actor AND b.blocker_id=tm.user_id)) THEN RAISE EXCEPTION 'forward_unavailable'; END IF;
 SELECT capability INTO cap FROM public.message_content_capabilities WHERE message_id=p_source FOR SHARE;
 SELECT capability INTO inherited FROM public.message_forwards WHERE target_message_id=p_source FOR SHARE;
 cap:=coalesce(cap,inherited,'SOURCE_POLICY');
 IF cap='NO_FORWARD' OR (cap='SOURCE_POLICY' AND s.sender_id<>p_actor) THEN RAISE EXCEPTION 'forward_restricted'; END IF;
 RETURN jsonb_build_object('capability',cap,'fingerprint',md5(jsonb_build_array(s.body,s.media_url,s.media_type,s.msg_type,s.subtype)::text));
END $$;

CREATE OR REPLACE FUNCTION public.telegraph_prepare_media_forward(p_id uuid,p_request uuid,p_source uuid,p_target uuid,p_actor uuid,p_asset_count integer,p_source_snapshot jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE facts jsonb; j public.telegraph_forward_media_jobs%ROWTYPE; paths text[]; base text;
BEGIN
 IF p_asset_count IS NULL OR p_asset_count<1 OR p_asset_count>20 THEN RAISE EXCEPTION 'invalid_attachment_count'; END IF;
 facts:=public.telegraph_media_forward_facts(p_source,p_target,p_actor);
 IF facts->>'fingerprint' IS DISTINCT FROM md5(p_source_snapshot::text) THEN RAISE EXCEPTION 'forward_source_changed'; END IF;
 base:=p_actor::text||'/telegraph-forwards/'||p_id::text||'/';
 SELECT array_agg(path) INTO paths FROM (SELECT base||i::text AS path FROM generate_series(0,p_asset_count-1) i UNION ALL SELECT base||i::text||'.thumb.jpg' FROM generate_series(0,p_asset_count-1) i) p;
 INSERT INTO public.telegraph_forward_media_jobs(id,request_id,source_message_id,target_thread_id,forwarder_id,source_fingerprint,capability,state,storage_paths)
 VALUES(p_id,p_request,p_source,p_target,p_actor,facts->>'fingerprint',facts->>'capability','preparing',paths)
 ON CONFLICT(forwarder_id,request_id) DO NOTHING;
 IF FOUND THEN RETURN jsonb_build_object('outcome','prepared','id',p_id,'paths',paths,'capability',facts->>'capability'); END IF;
 SELECT * INTO j FROM public.telegraph_forward_media_jobs WHERE forwarder_id=p_actor AND request_id=p_request FOR UPDATE;
 IF j.source_message_id IS DISTINCT FROM p_source OR j.target_thread_id IS DISTINCT FROM p_target THEN RAISE EXCEPTION 'forward_key_conflict'; END IF;
 IF j.state='ready' AND EXISTS(SELECT 1 FROM public.messages WHERE id=j.id AND deleted_at IS NULL AND unsent_at IS NULL) THEN
   RETURN jsonb_build_object('outcome','replay','id',j.id,'capability',(SELECT capability FROM public.message_forwards WHERE target_message_id=j.id));
 END IF;
 RETURN jsonb_build_object('outcome','busy');
END $$;

CREATE OR REPLACE FUNCTION public.telegraph_finish_media_forward(p_id uuid,p_body text,p_msg_type text,p_media_url text,p_media_type text,p_thumbnail text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE j public.telegraph_forward_media_jobs%ROWTYPE; facts jsonb; asset jsonb; at timestamptz; body jsonb;
BEGIN
 SELECT * INTO j FROM public.telegraph_forward_media_jobs WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR j.state<>'preparing' OR j.expires_at<=now() THEN RAISE EXCEPTION 'forward_unavailable'; END IF;
 facts:=public.telegraph_media_forward_facts(j.source_message_id,j.target_thread_id,j.forwarder_id);
 IF facts->>'fingerprint' IS DISTINCT FROM j.source_fingerprint OR facts->>'capability' IS DISTINCT FROM j.capability THEN RAISE EXCEPTION 'forward_source_changed'; END IF;
 IF p_msg_type='media' THEN
   IF p_media_type IS NULL OR p_media_type NOT IN ('image','video') OR p_media_url IS NULL OR NOT (substring(p_media_url from 12)=ANY(j.storage_paths)) OR p_media_url NOT LIKE 'post-media/%' THEN RAISE EXCEPTION 'invalid_forward_attachment'; END IF;
   IF p_thumbnail IS NOT NULL AND (p_thumbnail NOT LIKE 'post-media/%' OR NOT (substring(p_thumbnail from 12)=ANY(j.storage_paths))) THEN RAISE EXCEPTION 'invalid_forward_attachment'; END IF;
   IF coalesce(p_body,'')<>'' THEN RAISE EXCEPTION 'invalid_forward_attachment'; END IF;
 ELSIF p_msg_type='media_album' THEN
   body:=p_body::jsonb;
   IF body->>'kind' IS DISTINCT FROM 'MEDIA_ALBUM' OR body->>'envelopeVersion' IS DISTINCT FROM '1' OR jsonb_typeof(body->'payload'->'assets') IS DISTINCT FROM 'array' OR jsonb_array_length(body->'payload'->'assets') NOT BETWEEN 2 AND 20 THEN RAISE EXCEPTION 'invalid_forward_attachment'; END IF;
   FOR asset IN SELECT value FROM jsonb_array_elements(body->'payload'->'assets') LOOP
     IF asset->>'mediaType' IS NULL OR asset->>'mediaType' NOT IN ('image','video') OR asset->>'url' IS NULL OR asset->>'url' NOT LIKE 'post-media/%' OR NOT(substring(asset->>'url' from 12)=ANY(j.storage_paths)) THEN RAISE EXCEPTION 'invalid_forward_attachment'; END IF;
     IF asset->>'thumbnailUrl' IS NOT NULL AND (asset->>'thumbnailUrl' NOT LIKE 'post-media/%' OR NOT(substring(asset->>'thumbnailUrl' from 12)=ANY(j.storage_paths))) THEN RAISE EXCEPTION 'invalid_forward_attachment'; END IF;
   END LOOP;
 ELSE RAISE EXCEPTION 'invalid_forward_attachment'; END IF;
 INSERT INTO public.messages(id,thread_id,sender_id,body,msg_type,media_url,media_type,media_thumbnail_url)
 VALUES(j.id,j.target_thread_id,j.forwarder_id,p_body,p_msg_type,p_media_url,p_media_type,p_thumbnail) RETURNING created_at INTO at;
 INSERT INTO public.message_forwards(target_message_id,source_message_id,provenance,capability,forwarded_by)
 VALUES(j.id,j.source_message_id,'COPIED_ATTACHMENT',j.capability,j.forwarder_id);
 UPDATE public.telegraph_forward_media_jobs SET state='ready' WHERE id=j.id;
 UPDATE public.message_threads SET last_message_at=at,updated_at=at WHERE id=j.target_thread_id;
 RETURN jsonb_build_object('outcome','forwarded','messageId',j.id,'createdAt',at,'capability',j.capability);
END $$;

-- New object forwards persist their canonical reference atomically with the
-- existing writer. Keep the old signature for an older deployed server.
CREATE OR REPLACE FUNCTION public.telegraph_record_forward(
 p_source_message_id uuid,p_target_thread_id uuid,p_forwarder_id uuid,p_body text,
 p_msg_type text,p_subtype text,p_provenance text,p_capability text,p_content_ref text
) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 result:=public.telegraph_record_forward(p_source_message_id,p_target_thread_id,p_forwarder_id,p_body,p_msg_type,p_subtype,p_provenance,p_capability);
 IF result->>'outcome'='forwarded' AND p_content_ref IS NOT NULL THEN
  UPDATE public.messages SET content_ref=p_content_ref WHERE id=(result->>'messageId')::uuid;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.telegraph_record_forward(uuid,uuid,uuid,text,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_record_forward(uuid,uuid,uuid,text,text,text,text,text,text) TO service_role;

-- A copied path has no owner bypass: even its forwarder needs the live target.
CREATE OR REPLACE FUNCTION public.telegraph_can_read_forward_media(p_id uuid,p_viewer uuid,p_path text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.telegraph_forward_media_jobs j
 JOIN public.messages msg ON msg.id=j.id AND msg.deleted_at IS NULL AND msg.unsent_at IS NULL
 JOIN public.message_thread_members m ON m.thread_id=msg.thread_id AND m.user_id=p_viewer AND m.left_at IS NULL
 WHERE j.id=p_id AND j.state='ready' AND p_path=ANY(j.storage_paths)
 AND (msg.sender_id=p_viewer OR ((m.visible_from_at IS NULL OR msg.created_at>=m.visible_from_at)
  AND (m.visible_from_sequence IS NULL OR msg.sequence>=m.visible_from_sequence)
  AND (m.visible_until_sequence IS NULL OR msg.sequence<=m.visible_until_sequence)))
 AND NOT EXISTS(SELECT 1 FROM public.blocks b WHERE (b.blocker_id=p_viewer AND b.blocked_id=msg.sender_id) OR (b.blocked_id=p_viewer AND b.blocker_id=msg.sender_id)))
$$;

-- Claim before deleting bytes, so a stale writer can never publish a swept job.
CREATE OR REPLACE FUNCTION public.telegraph_claim_forward_media_cleanup()
RETURNS SETOF public.telegraph_forward_media_jobs LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 RETURN QUERY WITH expired AS (SELECT j.id FROM public.telegraph_forward_media_jobs j WHERE
  (j.state='abandoned' OR (j.state='preparing' AND j.expires_at<now()) OR (j.state='ready' AND NOT EXISTS(SELECT 1 FROM public.messages m WHERE m.id=j.id AND m.deleted_at IS NULL AND m.unsent_at IS NULL)))
  ORDER BY j.created_at LIMIT 100 FOR UPDATE SKIP LOCKED)
 UPDATE public.telegraph_forward_media_jobs j SET state='abandoned' FROM expired e WHERE j.id=e.id RETURNING j.*;
END $$;

REVOKE ALL ON FUNCTION public.telegraph_media_forward_facts(uuid,uuid,uuid),public.telegraph_prepare_media_forward(uuid,uuid,uuid,uuid,uuid,integer,jsonb),public.telegraph_finish_media_forward(uuid,text,text,text,text,text),public.telegraph_can_read_forward_media(uuid,uuid,text),public.telegraph_claim_forward_media_cleanup() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_media_forward_facts(uuid,uuid,uuid),public.telegraph_prepare_media_forward(uuid,uuid,uuid,uuid,uuid,integer,jsonb),public.telegraph_finish_media_forward(uuid,text,text,text,text,text),public.telegraph_can_read_forward_media(uuid,uuid,text),public.telegraph_claim_forward_media_cleanup() TO service_role;
COMMIT;
