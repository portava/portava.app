-- 4031: account-erasure security boundary and a DISABLED retention proposal.
-- Q11(a) explicitly requires legal review before retention activation. This
-- migration does not enable collection or retention and performs no bulk purge.
-- Empty scaffold created with Supabase CLI; SQL authored and validated locally.
-- Canonical forward migration; no hosted application is implied.
BEGIN;
CREATE TABLE IF NOT EXISTS public.media_event_erasure_fences (
 user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
 started_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.media_event_erasure_fences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_event_erasure_fences FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT ON public.media_event_erasure_fences TO service_role;
COMMENT ON TABLE public.media_event_erasure_fences IS 'Deletion control only. Prevents delayed media telemetry reappearing after account erasure begins. Same UUID as the existing tombstone profile; no events, device identifiers or content. Removed with the profile; not a behavioral retention record.';
INSERT INTO public.feature_flags(flag,enabled,description,metadata) VALUES(
 'media_event_retention_enabled',false,'PROPOSED 30-day raw media-event deletion. Keep disabled until Q11(a) legal review and explicit activation.',
 '{"keep_days":30,"policy_status":"proposed_pending_legal_review"}'::jsonb) ON CONFLICT(flag) DO NOTHING;
CREATE INDEX IF NOT EXISTS media_events_expiry_idx ON public.media_events(occurred_at,id);
-- Existing author/owner/submitted_by indexes cover the other ownership edges.
CREATE INDEX IF NOT EXISTS posts_created_by_media_event_erasure_idx ON public.posts(created_by,id);
CREATE INDEX IF NOT EXISTS media_assets_uploader_media_event_erasure_idx ON public.media_assets(uploader_user_id,id);
CREATE INDEX IF NOT EXISTS media_events_viewer_id_erasure_idx ON public.media_events (lower(payload->>'viewer_id'),id);
CREATE INDEX IF NOT EXISTS media_events_creator_id_erasure_idx ON public.media_events (lower(payload->>'creator_id'),id);
CREATE INDEX IF NOT EXISTS media_events_media_id_erasure_idx ON public.media_events (lower(payload->>'media_id'),id);
CREATE INDEX IF NOT EXISTS media_events_post_id_erasure_idx ON public.media_events (lower(payload->>'post_id'),id);
CREATE INDEX IF NOT EXISTS media_events_gem_id_erasure_idx ON public.media_events (lower(payload->>'gem_id'),id);

CREATE OR REPLACE FUNCTION public.media_event_uuid(p_value text) RETURNS uuid
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
 SELECT CASE WHEN p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_value::uuid ELSE NULL END;
$fn$;
CREATE OR REPLACE FUNCTION public.media_composer_payload_valid(p_payload jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
 SELECT CASE WHEN jsonb_typeof(p_payload)='object' THEN COALESCE(
   p_payload->'version'='1'::jsonb
   AND p_payload->>'surface' IN ('comment_sheet','comment_inline','postcard','post')
   AND p_payload->>'outcome' IN ('left_with_unsent','discarded_draft','upload_cancelled','upload_failed','post_discarded_after_upload','published')
   AND p_payload - ARRAY['version','surface','outcome','failure_code']='{}'::jsonb
   AND (NOT (p_payload ? 'failure_code') OR (
     p_payload->>'outcome'='upload_failed' AND p_payload->>'failure_code' IN ('network','storage','unsupported_media','rejected','unknown')
   )),false) ELSE false END;
$fn$;
CREATE OR REPLACE FUNCTION public.guard_media_event_erasure() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE subjects uuid[] := '{}'::uuid[]; subject uuid; reference uuid; owners uuid[]; state text; field text; value jsonb;
BEGIN
 IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF NEW.event_type='composer_outcome' THEN
   IF NOT public.media_composer_payload_valid(NEW.payload) THEN RETURN NULL; END IF;
 ELSE
   IF NEW.payload->>'viewer_id' IS NULL THEN RETURN NULL; END IF;
   FOR field,value IN SELECT * FROM jsonb_each(NEW.payload) LOOP
     IF field IN ('media_id','post_id','creator_id','viewer_id','session_id','place_id','event_id','trip_id','gem_id','route_plan_id') THEN
       IF jsonb_typeof(value)<>'null' AND (jsonb_typeof(value)<>'string' OR value#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$') THEN RETURN NULL; END IF;
     ELSIF field IN ('feed_type','mode','media_type','surface','gems_filter','entity_kind','action_id','from_mode','to_mode','failure_code','failure_reason','processing_status','source_type','ranking_version','contribution_type') THEN
       IF jsonb_typeof(value)<>'string' OR value#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' THEN RETURN NULL; END IF;
     ELSIF field IN ('watched_ms','position','completion_fraction') THEN
       IF jsonb_typeof(value)<>'number' THEN RETURN NULL; END IF;
       IF (value#>>'{}')::numeric<0 OR (value#>>'{}')::numeric > (CASE field WHEN 'watched_ms' THEN 86400000 WHEN 'position' THEN 10000 ELSE 1 END) THEN RETURN NULL; END IF;
       IF field<>'completion_fraction' AND trunc((value#>>'{}')::numeric)<>(value#>>'{}')::numeric THEN RETURN NULL; END IF;
     ELSIF field='is_rewatch' THEN
       IF jsonb_typeof(value)<>'boolean' THEN RETURN NULL; END IF;
     ELSE RETURN NULL;
     END IF;
   END LOOP;
 END IF;
 -- New writes cannot future-date the server ingestion clock; updates/retries
 -- of an existing row cannot extend its original expiry window.
 NEW.occurred_at := LEAST(COALESCE(NEW.occurred_at,now()),now());
 IF TG_OP='UPDATE' THEN NEW.occurred_at := LEAST(OLD.occurred_at,NEW.occurred_at); END IF;
 FOREACH state IN ARRAY ARRAY['viewer_id','creator_id'] LOOP
   IF NEW.payload->>state IS NOT NULL THEN
     subject := public.media_event_uuid(NEW.payload->>state);
     IF subject IS NULL THEN RETURN NULL; END IF;
     subjects := array_append(subjects,subject);
   END IF;
 END LOOP;
 -- Account erasure must precede canonical content deletion. This also catches
 -- another viewer's late event for a deleted creator's still-tombstoned object.
 FOREACH state IN ARRAY ARRAY['media_id','post_id','gem_id'] LOOP
   reference := public.media_event_uuid(NEW.payload->>state);
   IF reference IS NOT NULL THEN
     SELECT array_agg(DISTINCT who) INTO owners FROM (
       SELECT author_id who FROM public.posts WHERE id=reference
       UNION SELECT created_by FROM public.posts WHERE id=reference
       UNION SELECT owner_user_id FROM public.media_assets WHERE id=reference
       UNION SELECT uploader_user_id FROM public.media_assets WHERE id=reference
       UNION SELECT submitted_by FROM public.hidden_gems WHERE id=reference
     ) s WHERE who IS NOT NULL;
     -- An unknown canonical UUID is not evidence of a media interaction.
     IF owners IS NULL THEN RETURN NULL; END IF;
     subjects := subjects || owners;
   END IF;
 END LOOP;
 -- Stable lock order avoids two-account creator/viewer deadlocks. The erasure
 -- RPC takes FOR UPDATE on this same profile before publishing its fence.
 FOR subject IN SELECT DISTINCT unnest(subjects) ORDER BY 1 LOOP
   SELECT account_status INTO state FROM public.profiles WHERE id=subject FOR SHARE;
   IF NOT FOUND OR state='deleted' OR EXISTS(SELECT 1 FROM public.media_event_erasure_fences WHERE user_id=subject) THEN RETURN NULL; END IF;
 END LOOP;
 RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS media_event_erasure_guard ON public.media_events;
CREATE TRIGGER media_event_erasure_guard BEFORE INSERT OR UPDATE ON public.media_events
 FOR EACH ROW EXECUTE FUNCTION public.guard_media_event_erasure();

-- Indexed ownership/reference branches return bounded candidate sets. A large
-- actor history can still require more index work; explicit receipts prevent a
-- PostgREST row cap from silently reporting a partially erased account complete.
CREATE OR REPLACE FUNCTION public.media_event_ids_for_actor(p_actor uuid,p_limit integer)
RETURNS TABLE(id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
 SELECT DISTINCT id FROM (
(SELECT e.id FROM public.media_events e WHERE lower(e.payload->>'viewer_id')=p_actor::text ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.media_events e WHERE lower(e.payload->>'creator_id')=p_actor::text ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.posts o JOIN public.media_events e ON lower(e.payload->>'media_id')=o.id::text WHERE o.author_id=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.posts o JOIN public.media_events e ON lower(e.payload->>'media_id')=o.id::text WHERE o.created_by=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.media_assets o JOIN public.media_events e ON lower(e.payload->>'media_id')=o.id::text WHERE o.owner_user_id=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.media_assets o JOIN public.media_events e ON lower(e.payload->>'media_id')=o.id::text WHERE o.uploader_user_id=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.hidden_gems o JOIN public.media_events e ON lower(e.payload->>'media_id')=o.id::text WHERE o.submitted_by=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.posts o JOIN public.media_events e ON lower(e.payload->>'post_id')=o.id::text WHERE o.author_id=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.posts o JOIN public.media_events e ON lower(e.payload->>'post_id')=o.id::text WHERE o.created_by=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.media_assets o JOIN public.media_events e ON lower(e.payload->>'post_id')=o.id::text WHERE o.owner_user_id=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.media_assets o JOIN public.media_events e ON lower(e.payload->>'post_id')=o.id::text WHERE o.uploader_user_id=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.hidden_gems o JOIN public.media_events e ON lower(e.payload->>'post_id')=o.id::text WHERE o.submitted_by=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.posts o JOIN public.media_events e ON lower(e.payload->>'gem_id')=o.id::text WHERE o.author_id=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.posts o JOIN public.media_events e ON lower(e.payload->>'gem_id')=o.id::text WHERE o.created_by=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.media_assets o JOIN public.media_events e ON lower(e.payload->>'gem_id')=o.id::text WHERE o.owner_user_id=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.media_assets o JOIN public.media_events e ON lower(e.payload->>'gem_id')=o.id::text WHERE o.uploader_user_id=p_actor ORDER BY e.id LIMIT p_limit)
 UNION ALL
 (SELECT e.id FROM public.hidden_gems o JOIN public.media_events e ON lower(e.payload->>'gem_id')=o.id::text WHERE o.submitted_by=p_actor ORDER BY e.id LIMIT p_limit)
 ) candidates ORDER BY id LIMIT p_limit;
$fn$;
CREATE OR REPLACE FUNCTION public.erase_media_events_for_actor(p_actor uuid,p_limit integer DEFAULT 500)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE n integer; batch_size integer := LEAST(GREATEST(COALESCE(p_limit,500),1),500);
BEGIN
 IF p_actor IS NULL THEN RAISE EXCEPTION 'media_erasure_actor_required'; END IF;
 PERFORM 1 FROM public.profiles WHERE id=p_actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'media_erasure_profile_required'; END IF;
 INSERT INTO public.media_event_erasure_fences(user_id) VALUES(p_actor) ON CONFLICT(user_id) DO NOTHING;
 DELETE FROM public.media_events e USING public.media_event_ids_for_actor(p_actor,batch_size) c WHERE e.id=c.id;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN jsonb_build_object('deleted',n,'more',EXISTS(SELECT 1 FROM public.media_event_ids_for_actor(p_actor,1)));
END;
$fn$;
-- The actor is transient authorization context, never a stored event mapping.
-- This closes delayed authenticated composer requests after erasure without
-- weakening the established no-actor/no-content composer payload boundary.
CREATE OR REPLACE FUNCTION public.admit_composer_outcomes(p_actor uuid,p_rows jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE state text;
BEGIN
 IF p_actor IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'composer_admission_invalid'; END IF;
 IF jsonb_array_length(p_rows)<1 OR jsonb_array_length(p_rows)>50 THEN RAISE EXCEPTION 'composer_admission_invalid'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE jsonb_typeof(r)<>'object') THEN RAISE EXCEPTION 'composer_admission_invalid'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE
   public.media_event_uuid(r->>'id') IS NULL OR r->>'event_type' IS DISTINCT FROM 'composer_outcome'
   OR r - ARRAY['id','event_type','payload']<>'{}'::jsonb
   OR NOT public.media_composer_payload_valid(r->'payload')) THEN RAISE EXCEPTION 'composer_admission_invalid'; END IF;
 SELECT account_status INTO state FROM public.profiles WHERE id=p_actor FOR SHARE;
 IF NOT FOUND OR state='deleted' OR EXISTS(SELECT 1 FROM public.media_event_erasure_fences WHERE user_id=p_actor) THEN RETURN false; END IF;
 INSERT INTO public.media_events(id,event_type,payload)
 SELECT (r->>'id')::uuid,'composer_outcome',r->'payload' FROM jsonb_array_elements(p_rows) r
 ON CONFLICT(id) DO NOTHING;
 -- A duplicate is acknowledged only when it is the same immutable event.
 -- Fixed error text avoids echoing untrusted telemetry. An exception also
 -- rolls back any other rows inserted in a mixed conflicting batch.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE NOT EXISTS(
   SELECT 1 FROM public.media_events e WHERE e.id=(r->>'id')::uuid
    AND e.event_type='composer_outcome' AND e.payload=r->'payload'
 )) THEN RAISE EXCEPTION 'composer_admission_conflict'; END IF;
 RETURN true;
END;
$fn$;
CREATE OR REPLACE FUNCTION public.purge_expired_media_events(p_limit integer DEFAULT 500)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE enabled boolean; n integer; batch_size integer := LEAST(GREATEST(COALESCE(p_limit,500),1),500);
BEGIN
 SELECT f.enabled AND f.metadata->>'policy_status'='approved_after_legal_review' INTO enabled
 FROM public.feature_flags f WHERE flag='media_event_retention_enabled' FOR SHARE;
 IF enabled IS DISTINCT FROM true THEN RETURN jsonb_build_object('enabled',false,'deleted',0,'more',false); END IF;
 -- Collection flag intentionally irrelevant: turning capture off must not stop
 -- already-approved expiry. Policy activation is a separate reviewed decision.
 WITH due AS (SELECT id FROM public.media_events WHERE occurred_at<=now()-interval '720 hours'
   ORDER BY occurred_at,id LIMIT batch_size FOR UPDATE SKIP LOCKED)
 DELETE FROM public.media_events e USING due WHERE e.id=due.id;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN jsonb_build_object('enabled',true,'deleted',n,'more',EXISTS(SELECT 1 FROM public.media_events WHERE occurred_at<=now()-interval '720 hours'));
END;
$fn$;
REVOKE ALL ON FUNCTION public.media_event_uuid(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.media_event_uuid(text) TO service_role;
REVOKE ALL ON FUNCTION public.media_composer_payload_valid(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.media_composer_payload_valid(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.guard_media_event_erasure() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_media_event_erasure() TO service_role;
REVOKE ALL ON FUNCTION public.media_event_ids_for_actor(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.media_event_ids_for_actor(uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION public.erase_media_events_for_actor(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erase_media_events_for_actor(uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION public.purge_expired_media_events(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_media_events(integer) TO service_role;
REVOKE ALL ON FUNCTION public.admit_composer_outcomes(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admit_composer_outcomes(uuid,jsonb) TO service_role;
COMMIT;
