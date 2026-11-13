-- Explicitly requested draft recovery: unfinished postcard uploads stay private.
-- Existing published posts are unchanged (NULL lifecycle). No expiry policy is
-- invented here; explicit discard records durable cleanup intent.
BEGIN;
-- A public bucket bypasses signed-URL authorization. Activation must verify the
-- existing bucket is private; do not silently flip other clients' deployment.
DO $private$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='post-media' AND public=false) THEN
    RAISE EXCEPTION 'post-media must be private before enabling composer draft uploads';
  END IF;
END;$private$;
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS postcard_draft_state text,
  ADD COLUMN IF NOT EXISTS postcard_requested_visibility public.post_visibility,
  ADD COLUMN IF NOT EXISTS postcard_draft_operation_id uuid,
  ADD COLUMN IF NOT EXISTS postcard_publish_on_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS postcard_cleanup_pending boolean NOT NULL DEFAULT false;
ALTER TABLE public.posts ADD CONSTRAINT posts_postcard_draft_state_check
  CHECK (postcard_draft_state IS NULL OR postcard_draft_state IN ('draft','published','cancelled'));
ALTER TABLE public.posts ADD CONSTRAINT posts_postcard_draft_private_check
  CHECK (postcard_draft_state IS NULL OR postcard_draft_state = 'published' OR
    (visibility = 'private' AND post_status = 'draft'));
CREATE UNIQUE INDEX IF NOT EXISTS posts_postcard_draft_operation_idx
  ON public.posts(author_id, postcard_draft_operation_id) WHERE postcard_draft_operation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_postcard_lifecycle_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF current_user NOT IN ('service_role','postgres') THEN
    IF TG_OP='INSERT' AND (NEW.postcard_draft_state IS NOT NULL OR NEW.postcard_requested_visibility IS NOT NULL OR NEW.postcard_draft_operation_id IS NOT NULL OR NEW.postcard_publish_on_complete OR NEW.postcard_cleanup_pending) THEN RAISE EXCEPTION 'server_owned_postcard_lifecycle'; END IF;
    IF TG_OP='UPDATE' AND (NEW.postcard_draft_state,NEW.postcard_requested_visibility,NEW.postcard_draft_operation_id,NEW.postcard_publish_on_complete,NEW.postcard_cleanup_pending) IS DISTINCT FROM (OLD.postcard_draft_state,OLD.postcard_requested_visibility,OLD.postcard_draft_operation_id,OLD.postcard_publish_on_complete,OLD.postcard_cleanup_pending) THEN RAISE EXCEPTION 'server_owned_postcard_lifecycle'; END IF;
  END IF;
  RETURN NEW;
END;$fn$;
CREATE TRIGGER posts_postcard_lifecycle_write BEFORE INSERT OR UPDATE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.guard_postcard_lifecycle_write();
REVOKE ALL ON FUNCTION public.guard_postcard_lifecycle_write() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.publish_postcard_draft(p_actor uuid, p_post uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE p public.posts%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND account_status='active') THEN RETURN jsonb_build_object('ok',false,'error','account_unavailable'); END IF;
  SELECT * INTO p FROM public.posts WHERE id = p_post AND author_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','not_found'); END IF;
  IF p.postcard_draft_state = 'cancelled' OR p.deleted_at IS NOT NULL OR p.status <> 'active' THEN
    RETURN jsonb_build_object('ok',false,'error','draft_cancelled');
  END IF;
  IF p.postcard_draft_state = 'published' OR (p.postcard_draft_state IS NULL AND p.post_status='published') THEN RETURN jsonb_build_object('ok',true,'repeated',true); END IF;
  IF p.postcard_draft_state IS DISTINCT FROM 'draft' OR p.postcard_requested_visibility IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','not_a_draft');
  END IF;
  IF p.trip_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.trip_members m WHERE m.trip_id=p.trip_id AND m.user_id=p_actor
      AND m.role IN ('owner','co_host','member','viewer') AND (m.status IS NULL OR m.status='accepted')
  ) AND NOT EXISTS (SELECT 1 FROM public.trips t WHERE t.id=p.trip_id AND t.owner_id=p_actor AND NOT EXISTS (SELECT 1 FROM public.trip_members m WHERE m.trip_id=p.trip_id AND m.user_id=p_actor)) THEN
    RETURN jsonb_build_object('ok',false,'error','not_member');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.post_media m WHERE m.post_id=p.id AND m.user_id=p_actor
    AND m.processing_status='ready' AND COALESCE(m.moderation_status,'pending') NOT IN ('flagged','rejected')) THEN
    RETURN jsonb_build_object('ok',false,'error','media_not_ready');
  END IF;
  UPDATE public.posts SET postcard_draft_state='published', visibility=p.postcard_requested_visibility,
    postcard_requested_visibility=NULL, post_status='published', published_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE id=p.id;
  RETURN jsonb_build_object('ok',true,'repeated',false);
END;
$fn$;
CREATE OR REPLACE FUNCTION public.cancel_postcard_draft(p_actor uuid, p_post uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE p public.posts%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.posts WHERE id=p_post AND author_id=p_actor FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'absent',true); END IF;
  IF p.postcard_draft_state IS NULL THEN RETURN jsonb_build_object('ok',false,'error','not_a_draft'); END IF;
  -- A cancellation racing publication is explicit withdrawal of THIS owned
  -- postcard operation. The row lock orders both sides; neither can resurrect it.
  UPDATE public.posts SET postcard_draft_state='cancelled', postcard_requested_visibility=NULL,
    postcard_cleanup_pending=true, visibility='private', post_status='draft', status='deleted',
    content='', media_urls='{}', media_count=0, location_name=NULL, location_city=NULL, location_country=NULL,
    location_lat=NULL, location_lng=NULL, location_place_id=NULL, original_lat=NULL, original_lng=NULL, public_lat=NULL, public_lng=NULL,
    deleted_at=COALESCE(deleted_at,clock_timestamp()), updated_at=clock_timestamp() WHERE id=p.id;
  -- A URL issued before cancellation may still accept a late PUT. Keep the
  -- slot in the existing pending-upload sweep until its authority expires.
  UPDATE public.post_media SET processing_status='pending', updated_at=clock_timestamp() WHERE post_id=p.id AND user_id=p_actor;
  DELETE FROM public.passport_postcards WHERE post_id=p.id AND user_id=p_actor;
  UPDATE public.posts SET postcard_cleanup_pending=EXISTS(SELECT 1 FROM public.post_media WHERE post_id=p.id) WHERE id=p.id;
  RETURN jsonb_build_object('ok',true,'absent',false);
END;
$fn$;
CREATE OR REPLACE FUNCTION public.guard_cancelled_postcard_media()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE lifecycle text;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT postcard_draft_state INTO lifecycle FROM public.posts WHERE id=NEW.post_id FOR SHARE;
    IF lifecycle='cancelled' THEN RAISE EXCEPTION 'draft_cancelled'; END IF;
  ELSIF NEW.processing_status='ready' AND EXISTS (
    SELECT 1 FROM public.posts p WHERE p.id=NEW.post_id AND p.postcard_draft_state='cancelled'
  ) THEN RAISE EXCEPTION 'draft_cancelled'; END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER postcard_cancelled_media_guard BEFORE INSERT OR UPDATE ON public.post_media
FOR EACH ROW EXECUTE FUNCTION public.guard_cancelled_postcard_media();
REVOKE ALL ON FUNCTION public.guard_cancelled_postcard_media() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.publish_postcard_draft(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_postcard_draft(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_postcard_draft(uuid,uuid), public.cancel_postcard_draft(uuid,uuid) TO service_role;
-- The existing transport sweep deletes bytes before rows. Its final row delete
-- acknowledges the cancellation cleanup; it does not start a new scheduler.
CREATE OR REPLACE FUNCTION public.finish_cancelled_postcard_cleanup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
  UPDATE public.posts SET postcard_cleanup_pending=false
    WHERE id=OLD.post_id AND postcard_draft_state='cancelled'
      AND NOT EXISTS(SELECT 1 FROM public.post_media WHERE post_id=OLD.post_id);
  RETURN OLD;
END;$fn$;
CREATE TRIGGER postcard_cancelled_cleanup_finished AFTER DELETE ON public.post_media
FOR EACH ROW EXECUTE FUNCTION public.finish_cancelled_postcard_cleanup();
REVOKE ALL ON FUNCTION public.finish_cancelled_postcard_cleanup() FROM PUBLIC,anon,authenticated;
-- The legacy passport policy can read an active/public projection independently
-- of the post lifecycle. Order late publish callbacks against cancellation so
-- they cannot recreate a visible caption after cancellation deleted the copy.
CREATE OR REPLACE FUNCTION public.guard_postcard_projection_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE lifecycle text;
BEGIN
  IF NEW.post_id IS NULL THEN RETURN NEW; END IF;
  SELECT postcard_draft_state INTO lifecycle FROM public.posts WHERE id=NEW.post_id FOR SHARE;
  IF lifecycle IN ('draft','cancelled') THEN RAISE EXCEPTION 'postcard_not_published'; END IF;
  RETURN NEW;
END;$fn$;
CREATE TRIGGER postcard_projection_lifecycle BEFORE INSERT OR UPDATE ON public.passport_postcards
FOR EACH ROW EXECUTE FUNCTION public.guard_postcard_projection_write();
REVOKE ALL ON FUNCTION public.guard_postcard_projection_write() FROM PUBLIC,anon,authenticated;
-- Operational upload intent for the main post composer. Draft text is local.
CREATE TABLE public.composer_upload_intents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready','cancelled','published')),
  storage_paths text[] NOT NULL,
  content_digest text NOT NULL,
  post_id uuid REFERENCES public.posts(id) ON DELETE SET NULL,
  cleanup_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX composer_upload_intents_paths_idx ON public.composer_upload_intents USING gin(storage_paths);
CREATE INDEX composer_upload_intents_owner_idx ON public.composer_upload_intents(owner_id);
CREATE INDEX composer_upload_intents_cleanup_idx ON public.composer_upload_intents(updated_at) WHERE cleanup_pending;
-- A canonical write may finish after cancellation/account erasure. Never let
-- that asynchronous write recreate draft metadata after the operational row
-- has been removed. Published and active owned operations remain writable.
CREATE OR REPLACE FUNCTION public.guard_composer_media_asset_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE operation public.composer_upload_intents%ROWTYPE;
BEGIN
  IF NEW.storage_bucket <> 'post-media' OR (NEW.storage_path NOT LIKE '%/composer-drafts/%' AND NEW.storage_path NOT LIKE '%/capture-stamps/%') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.deleted_at IS NOT NULL AND NEW.storage_path=OLD.storage_path AND NEW.owner_user_id=OLD.owner_user_id THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.profiles WHERE id=NEW.owner_user_id AND account_status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'draft_upload_unavailable'; END IF;
  -- Serialize with cancellation/erasure: neither may finish and then be
  -- followed by this transaction committing resurrected canonical metadata.
  SELECT * INTO operation FROM public.composer_upload_intents WHERE storage_paths @> ARRAY[NEW.storage_path] LIMIT 1 FOR SHARE;
  IF NOT FOUND AND NEW.storage_path NOT LIKE '%/composer-drafts/%' THEN RETURN NEW; END IF;
  IF operation.id IS NULL OR operation.state='cancelled' OR operation.owner_id<>NEW.owner_user_id OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=NEW.owner_user_id AND account_status='active') THEN RAISE EXCEPTION 'draft_upload_unavailable'; END IF;
  RETURN NEW;
END;$fn$;
CREATE TRIGGER composer_media_asset_write BEFORE INSERT OR UPDATE ON public.media_assets
FOR EACH ROW EXECUTE FUNCTION public.guard_composer_media_asset_write();
REVOKE ALL ON FUNCTION public.guard_composer_media_asset_write() FROM PUBLIC,anon,authenticated;
ALTER TABLE public.composer_upload_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.composer_upload_intents FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.composer_upload_intents TO service_role;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS composer_upload_operation_id uuid UNIQUE REFERENCES public.composer_upload_intents(id);
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS composer_publication_operation_id uuid;
CREATE UNIQUE INDEX posts_composer_publication_operation_idx ON public.posts(author_id,composer_publication_operation_id) WHERE composer_publication_operation_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.reserve_composer_upload(p_actor uuid,p_operation uuid,p_paths text[],p_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE r public.composer_upload_intents%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND account_status='active') THEN RETURN jsonb_build_object('ok',false,'error','account_unavailable'); END IF;
  IF cardinality(p_paths)<1 OR EXISTS(SELECT 1 FROM unnest(p_paths) k WHERE k NOT LIKE p_actor::text||'/%' OR k LIKE '%..%') THEN
    RETURN jsonb_build_object('ok',false,'error','invalid_payload');
  END IF;
  INSERT INTO public.composer_upload_intents(id,owner_id,storage_paths,content_digest) VALUES(p_operation,p_actor,p_paths,p_digest) ON CONFLICT(id) DO NOTHING;
  SELECT * INTO r FROM public.composer_upload_intents WHERE id=p_operation FOR UPDATE;
  IF r.state='cancelled' THEN RETURN jsonb_build_object('ok',false,'error','draft_cancelled'); END IF;
  IF r.owner_id<>p_actor OR r.content_digest<>p_digest OR r.storage_paths<>p_paths THEN RETURN jsonb_build_object('ok',false,'error','conflict'); END IF;
  IF r.state='cancelled' THEN RETURN jsonb_build_object('ok',false,'error','draft_cancelled'); END IF;
  RETURN jsonb_build_object('ok',true,'state',r.state);
END;$fn$;
CREATE OR REPLACE FUNCTION public.finish_composer_upload(p_actor uuid,p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE r public.composer_upload_intents%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND account_status='active') THEN RETURN jsonb_build_object('ok',false,'error','account_unavailable'); END IF;
  SELECT * INTO r FROM public.composer_upload_intents WHERE id=p_operation AND owner_id=p_actor FOR UPDATE;
  IF NOT FOUND OR r.state='cancelled' THEN RETURN jsonb_build_object('ok',false,'error','draft_cancelled'); END IF;
  UPDATE public.composer_upload_intents SET state=CASE WHEN state='published' THEN state ELSE 'ready' END,updated_at=clock_timestamp() WHERE id=r.id;
  RETURN jsonb_build_object('ok',true);
END;$fn$;
CREATE OR REPLACE FUNCTION public.cancel_composer_upload(p_actor uuid,p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE r public.composer_upload_intents%ROWTYPE;
BEGIN
  INSERT INTO public.composer_upload_intents(id,owner_id,state,storage_paths,content_digest,cleanup_pending) VALUES(p_operation,p_actor,'cancelled','{}','',true) ON CONFLICT(id) DO NOTHING;
  SELECT * INTO r FROM public.composer_upload_intents WHERE id=p_operation AND owner_id=p_actor FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'absent',true); END IF;
  IF r.state='published' THEN RETURN jsonb_build_object('ok',false,'error','already_published'); END IF;
  UPDATE public.composer_upload_intents SET state='cancelled',cleanup_pending=true,updated_at=clock_timestamp() WHERE id=r.id;
  RETURN jsonb_build_object('ok',true);
END;$fn$;
CREATE OR REPLACE FUNCTION public.claim_composer_upload()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE r public.composer_upload_intents%ROWTYPE;
BEGIN
  IF NEW.composer_upload_operation_id IS NULL THEN RETURN NEW; END IF;
  IF current_setting('rumazi.composer_publication_operation',true) IS DISTINCT FROM NEW.composer_upload_operation_id::text THEN RAISE EXCEPTION 'composer_publication_requires_atomic_commit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=NEW.author_id AND account_status='active') THEN RAISE EXCEPTION 'draft_upload_unavailable'; END IF;
  IF auth.uid() IS NOT NULL AND auth.uid()<>NEW.author_id THEN RAISE EXCEPTION 'draft_upload_unavailable'; END IF;
  SELECT * INTO r FROM public.composer_upload_intents WHERE id=NEW.composer_upload_operation_id FOR UPDATE;
  IF NOT FOUND OR r.owner_id<>NEW.author_id OR r.state<>'ready' THEN RAISE EXCEPTION 'draft_upload_unavailable'; END IF;
  UPDATE public.composer_upload_intents SET state='published',post_id=NEW.id,cleanup_pending=false,updated_at=clock_timestamp() WHERE id=r.id;
  RETURN NEW;
END;$fn$;
CREATE OR REPLACE FUNCTION public.release_composer_upload_claim()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF OLD.composer_upload_operation_id IS NOT NULL THEN
    UPDATE public.composer_upload_intents SET state='ready',post_id=NULL,updated_at=clock_timestamp() WHERE id=OLD.composer_upload_operation_id AND owner_id=OLD.author_id AND state='published';
  END IF;
  RETURN OLD;
END;$fn$;
CREATE TRIGGER posts_release_composer_upload BEFORE DELETE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.release_composer_upload_claim();
REVOKE ALL ON FUNCTION public.release_composer_upload_claim() FROM PUBLIC,anon,authenticated;
-- AFTER INSERT permits the intent's post FK, and both writes roll back together.
CREATE TRIGGER posts_claim_composer_upload AFTER INSERT ON public.posts FOR EACH ROW EXECUTE FUNCTION public.claim_composer_upload();
-- The post, intent claim and every attachment commit together. API retries or
-- cancellation can observe either all of them or none, never an incomplete
-- post that will later be removed by compensation. Only the service can invoke
-- this boundary; API code constructs both JSON objects from allowlisted fields.
CREATE OR REPLACE FUNCTION public.commit_composer_post(p_actor uuid,p_post jsonb,p_media jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE operation public.composer_upload_intents%ROWTYPE; post_id uuid; keys text; fields text;
BEGIN
  IF jsonb_typeof(p_post) IS DISTINCT FROM 'object' OR jsonb_typeof(p_media) IS DISTINCT FROM 'array'
    OR (p_post->>'author_id')::uuid IS DISTINCT FROM p_actor OR jsonb_array_length(p_media)<1
    OR p_post->>'composer_upload_operation_id' IS NULL THEN RAISE EXCEPTION 'invalid_composer_publication'; END IF;
  PERFORM 1 FROM public.profiles WHERE id=p_actor AND account_status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'draft_upload_unavailable'; END IF;
  SELECT * INTO operation FROM public.composer_upload_intents WHERE id=(p_post->>'composer_upload_operation_id')::uuid AND owner_id=p_actor FOR UPDATE;
  IF NOT FOUND OR operation.state NOT IN ('ready','published') THEN RAISE EXCEPTION 'draft_upload_unavailable'; END IF;
  IF operation.state='published' THEN
    IF operation.post_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.posts WHERE id=operation.post_id AND author_id=p_actor) THEN RAISE EXCEPTION 'draft_upload_unavailable'; END IF;
    RETURN jsonb_build_object('id',operation.post_id,'repeated',true);
  END IF;
  post_id := (p_post->>'id')::uuid;
  IF post_id IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_media) m WHERE
    (m->>'post_id')::uuid IS DISTINCT FROM post_id OR (m->>'user_id')::uuid IS DISTINCT FROM p_actor
    OR m->>'storage_bucket' IS DISTINCT FROM 'post-media' OR NOT COALESCE((m->>'storage_path')=ANY(operation.storage_paths),false)
    OR m->>'processing_status' IS DISTINCT FROM 'ready' OR m->>'moderation_status' IS DISTINCT FROM 'pending') THEN
    RAISE EXCEPTION 'invalid_composer_attachment';
  END IF;
  -- Quoted identifiers plus typed record conversion retain the posts defaults
  -- for omitted columns. Values never enter SQL text, and unknown columns fail.
  SELECT string_agg(format('%I',key),',' ORDER BY key),string_agg(format('r.%I',key),',' ORDER BY key)
    INTO keys,fields FROM jsonb_object_keys(p_post) key;
  PERFORM set_config('rumazi.composer_publication_operation',operation.id::text,true);
  EXECUTE format('INSERT INTO public.posts (%s) SELECT %s FROM jsonb_populate_record(NULL::public.posts,$1) r',keys,fields) USING p_post;
  INSERT INTO public.post_media(post_id,user_id,media_type,storage_bucket,storage_path,public_url,mime_type,processing_status,moderation_status,sort_order,thumbnail_storage_path,thumbnail_url,duration_seconds)
    SELECT x.post_id,x.user_id,x.media_type,x.storage_bucket,x.storage_path,x.public_url,x.mime_type,x.processing_status,x.moderation_status,x.sort_order,x.thumbnail_storage_path,x.thumbnail_url,x.duration_seconds
    FROM jsonb_to_recordset(p_media) x(post_id uuid,user_id uuid,media_type text,storage_bucket text,storage_path text,public_url text,mime_type text,processing_status text,moderation_status text,sort_order integer,thumbnail_storage_path text,thumbnail_url text,duration_seconds double precision);
  RETURN jsonb_build_object('id',post_id,'repeated',false);
END;$fn$;
REVOKE ALL ON FUNCTION public.commit_composer_post(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commit_composer_post(uuid,jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.reserve_composer_upload(uuid,uuid,text[],text),public.finish_composer_upload(uuid,uuid),public.cancel_composer_upload(uuid,uuid),public.claim_composer_upload() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_composer_upload(uuid,uuid,text[],text),public.finish_composer_upload(uuid,uuid),public.cancel_composer_upload(uuid,uuid) TO service_role;
COMMIT;

