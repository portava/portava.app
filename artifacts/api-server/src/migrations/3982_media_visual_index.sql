BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE public.media_visual_index_consents (
  asset_id uuid PRIMARY KEY REFERENCES public.media_assets(id) ON DELETE CASCADE,
  source_version integer NOT NULL CHECK (source_version > 0),
  owner_id uuid NOT NULL,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.media_visual_index_tombstones (
  asset_id uuid PRIMARY KEY,
  erased_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.media_visual_embeddings (
  asset_id uuid PRIMARY KEY REFERENCES public.media_assets(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  storage_bucket text NOT NULL CHECK (storage_bucket = 'post-media'),
  storage_path text NOT NULL,
  model_id text NOT NULL CHECK (model_id = 'openai/clip-vit-base-patch32@d44250afa9f05af7eca021052567539406661018:clip-rgb224-v1'),
  embedding extensions.vector(512) NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  consent_revision uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.media_derivative_jobs(id) ON DELETE CASCADE,
  lease_token uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX media_visual_embeddings_cosine ON public.media_visual_embeddings USING hnsw (embedding extensions.vector_cosine_ops);
CREATE INDEX media_visual_embeddings_expiry ON public.media_visual_embeddings(expires_at);

ALTER TABLE public.media_visual_index_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_visual_index_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.media_visual_index_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_visual_index_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE public.media_visual_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_visual_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY visual_consent_service ON public.media_visual_index_consents TO service_role USING (true) WITH CHECK (true);
CREATE POLICY visual_tombstone_service ON public.media_visual_index_tombstones TO service_role USING (true) WITH CHECK (true);
CREATE POLICY visual_embedding_service ON public.media_visual_embeddings TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.media_visual_index_consents, public.media_visual_index_tombstones, public.media_visual_embeddings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_visual_index_consents, public.media_visual_index_tombstones, public.media_visual_embeddings TO service_role;
GRANT USAGE ON SCHEMA extensions TO service_role;

CREATE VIEW public.media_visual_index_current WITH (security_invoker = true) AS
SELECT embedding.* FROM public.media_visual_embeddings embedding
JOIN public.media_assets source ON source.id = embedding.asset_id
JOIN public.media_visual_index_consents consent ON consent.asset_id = source.id
JOIN public.media_derivative_jobs job ON job.id = embedding.job_id AND job.state = 'completed'
  AND job.result->>'indexLeaseToken' = embedding.lease_token::text
  AND job.result->>'assetId' = embedding.asset_id::text
WHERE source.version = embedding.source_version AND source.owner_user_id = embedding.owner_id
  AND source.storage_bucket = embedding.storage_bucket AND source.storage_path = embedding.storage_path
  AND source.media_type = 'image' AND source.processing_status = 'ready' AND source.moderation_status IN ('active','approved')
  AND source.deleted_at IS NULL AND source.purge_status = 'not_requested'
  AND consent.source_version = source.version AND consent.owner_id = source.owner_user_id
  AND consent.revision = embedding.consent_revision AND consent.revoked_at IS NULL AND consent.expires_at > now()
  AND embedding.expires_at > now()
  AND NOT EXISTS (SELECT 1 FROM public.media_visual_index_tombstones tombstone WHERE tombstone.asset_id = source.id);
REVOKE ALL ON public.media_visual_index_current FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.media_visual_index_current TO service_role;

CREATE FUNCTION public.media_visual_index_consent(p_asset_id uuid, p_actor_id uuid, p_source_version integer, p_allowed boolean, p_expires_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, extensions, pg_temp AS $function$
DECLARE source public.media_assets%ROWTYPE; consent_revision uuid;
BEGIN
  SELECT * INTO source FROM public.media_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND OR source.owner_user_id IS DISTINCT FROM p_actor_id OR source.version IS DISTINCT FROM p_source_version OR p_allowed IS NULL THEN
    RAISE EXCEPTION 'visual_consent_source_mismatch';
  END IF;
  DELETE FROM public.media_visual_embeddings WHERE asset_id = p_asset_id;
  IF NOT p_allowed THEN
    UPDATE public.media_visual_index_consents SET revoked_at = now(), revision = gen_random_uuid() WHERE asset_id = p_asset_id;
    RETURN NULL;
  END IF;
  IF source.deleted_at IS NOT NULL OR source.purge_status IS DISTINCT FROM 'not_requested' OR source.media_type IS DISTINCT FROM 'image'
    OR EXISTS (SELECT 1 FROM public.media_visual_index_tombstones WHERE asset_id = p_asset_id)
    OR p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '30 days' THEN
    RAISE EXCEPTION 'visual_consent_invalid';
  END IF;
  consent_revision := gen_random_uuid();
  INSERT INTO public.media_visual_index_consents(asset_id, source_version, owner_id, revision, expires_at)
    VALUES(p_asset_id, p_source_version, p_actor_id, consent_revision, p_expires_at)
    ON CONFLICT(asset_id) DO UPDATE SET source_version = EXCLUDED.source_version, owner_id = EXCLUDED.owner_id,
      revision = EXCLUDED.revision, expires_at = EXCLUDED.expires_at, revoked_at = NULL, granted_at = now();
  RETURN consent_revision;
END;
$function$;

CREATE FUNCTION public.media_visual_index_revision_key(p_asset_id uuid, p_source_version integer, p_bucket text, p_path text, p_model_id text, p_consent_revision uuid)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path = pg_catalog AS $function$
  SELECT encode(sha256(convert_to('[' || to_json(p_asset_id::text)::text || ',' || p_source_version::text || ',' ||
    to_json(p_bucket)::text || ',' || to_json(p_path)::text || ',' || to_json(p_model_id || ':' || p_consent_revision::text)::text || ']', 'UTF8')), 'hex');
$function$;

CREATE FUNCTION public.media_visual_index_commit(
  p_asset_id uuid, p_source_version integer, p_bucket text, p_path text, p_model_id text,
  p_embedding extensions.vector(512), p_content_sha256 text, p_expires_at timestamptz, p_consent_revision uuid,
  p_job_id uuid, p_lease_token uuid, p_revision_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, extensions, pg_temp AS $function$
DECLARE source public.media_assets%ROWTYPE; consent public.media_visual_index_consents%ROWTYPE; job public.media_derivative_jobs%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_vision_provider_enabled' AND enabled IS TRUE)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_derivative_jobs_enabled' AND enabled IS TRUE) THEN
    RAISE EXCEPTION 'visual_index_disabled';
  END IF;
  SELECT * INTO source FROM public.media_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND OR source.version IS DISTINCT FROM p_source_version OR source.storage_bucket IS DISTINCT FROM p_bucket
    OR source.storage_path IS DISTINCT FROM p_path OR source.media_type IS DISTINCT FROM 'image'
    OR source.processing_status IS DISTINCT FROM 'ready' OR COALESCE(source.moderation_status, '') NOT IN ('active','approved')
    OR source.deleted_at IS NOT NULL OR source.purge_status IS DISTINCT FROM 'not_requested' THEN
    RAISE EXCEPTION 'visual_source_stale';
  END IF;
  SELECT * INTO consent FROM public.media_visual_index_consents WHERE asset_id = p_asset_id FOR SHARE;
  IF NOT FOUND OR consent.source_version IS DISTINCT FROM p_source_version OR consent.owner_id IS DISTINCT FROM source.owner_user_id
    OR consent.revision IS DISTINCT FROM p_consent_revision OR consent.revoked_at IS NOT NULL OR consent.expires_at <= now() THEN
    RAISE EXCEPTION 'visual_consent_revoked';
  END IF;
  SELECT * INTO job FROM public.media_derivative_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job.state IS DISTINCT FROM 'processing' OR job.lease_token IS DISTINCT FROM p_lease_token OR job.lease_until <= now()
    OR job.asset_id IS DISTINCT FROM p_asset_id OR job.source_version IS DISTINCT FROM p_source_version
    OR job.owner_user_id IS DISTINCT FROM source.owner_user_id OR job.kind IS DISTINCT FROM 'embedding'
    OR job.model_version IS DISTINCT FROM p_model_id OR job.revision_key IS DISTINCT FROM p_revision_key
    OR job.source_bucket IS DISTINCT FROM p_bucket OR job.source_path IS DISTINCT FROM p_path OR job.source_bytes IS DISTINCT FROM source.size_bytes
    OR p_revision_key IS DISTINCT FROM public.media_visual_index_revision_key(p_asset_id,p_source_version,p_bucket,p_path,p_model_id,p_consent_revision)
    OR p_revision_key IS NULL OR p_revision_key !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'visual_lease_lost'; END IF;
  IF EXISTS (SELECT 1 FROM public.media_visual_index_tombstones WHERE asset_id = p_asset_id) THEN RAISE EXCEPTION 'visual_asset_erased'; END IF;
  IF p_embedding IS NULL OR vector_dims(p_embedding) <> 512 OR abs(vector_norm(p_embedding) - 1) > 0.0001
    OR p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > consent.expires_at
    OR p_expires_at > job.created_at + interval '30 days' THEN RAISE EXCEPTION 'visual_embedding_invalid'; END IF;
  IF EXISTS (SELECT 1 FROM public.media_visual_embeddings WHERE asset_id = p_asset_id AND source_version = p_source_version AND content_sha256 <> p_content_sha256) THEN
    RAISE EXCEPTION 'visual_source_bytes_changed';
  END IF;
  INSERT INTO public.media_visual_embeddings(asset_id, owner_id, source_version, storage_bucket, storage_path, model_id, embedding, content_sha256, consent_revision, expires_at, job_id, lease_token)
    VALUES(p_asset_id, source.owner_user_id, p_source_version, p_bucket, p_path, p_model_id, p_embedding, p_content_sha256, p_consent_revision, p_expires_at, p_job_id, p_lease_token)
    ON CONFLICT(asset_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, source_version = EXCLUDED.source_version,
      storage_bucket = EXCLUDED.storage_bucket, storage_path = EXCLUDED.storage_path, model_id = EXCLUDED.model_id,
      embedding = EXCLUDED.embedding, content_sha256 = EXCLUDED.content_sha256, consent_revision = EXCLUDED.consent_revision,
      job_id = EXCLUDED.job_id, lease_token = EXCLUDED.lease_token,
      expires_at = LEAST(public.media_visual_embeddings.expires_at, EXCLUDED.expires_at), indexed_at = now();
  RETURN jsonb_build_object('applied', true);
END;
$function$;

CREATE FUNCTION public.media_visual_index_seed(p_post_id uuid, p_model_id text)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, extensions, pg_temp AS $function$
  SELECT to_jsonb(embedding.*) FROM public.media_visual_index_current embedding
  JOIN public.media_assets source ON source.id = embedding.asset_id
  WHERE embedding.model_id = p_model_id
    AND EXISTS (SELECT 1 FROM public.posts post WHERE post.id = p_post_id AND post.author_id = source.owner_user_id)
    AND (EXISTS (SELECT 1 FROM public.media_attachments attachment WHERE attachment.media_asset_id = source.id AND attachment.entity_type = 'post' AND attachment.entity_id = p_post_id)
      OR EXISTS (SELECT 1 FROM public.post_media attachment WHERE attachment.post_id = p_post_id AND attachment.storage_path = source.storage_path AND attachment.public_url = source.public_url AND attachment.processing_status = 'ready'))
    AND EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_vision_provider_enabled' AND enabled IS TRUE)
  ORDER BY embedding.asset_id LIMIT 65;
$function$;

CREATE FUNCTION public.media_visual_index_match(p_model_id text, p_embedding extensions.vector(512), p_limit integer DEFAULT 200)
RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, extensions, pg_temp AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR p_embedding IS NULL OR vector_dims(p_embedding) <> 512
    OR abs(vector_norm(p_embedding) - 1) > 0.0001 THEN RAISE EXCEPTION 'visual_query_invalid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_vision_provider_enabled' AND enabled IS TRUE) THEN RETURN; END IF;
  RETURN QUERY SELECT to_jsonb(embedding.*) || jsonb_build_object('score', GREATEST(0.0, LEAST(1.0, 1.0 - (embedding.embedding <=> p_embedding) / 2.0)))
    FROM public.media_visual_index_current embedding WHERE embedding.model_id = p_model_id
    ORDER BY embedding.embedding <=> p_embedding, embedding.asset_id LIMIT p_limit;
END;
$function$;

CREATE FUNCTION public.media_visual_index_erase(p_asset_id uuid, p_source_version integer, p_bucket text, p_path text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE source public.media_assets%ROWTYPE;
BEGIN
  SELECT * INTO source FROM public.media_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND OR p_source_version IS NULL OR p_source_version < 1 OR source.version < p_source_version
    OR source.storage_bucket IS DISTINCT FROM p_bucket OR source.storage_path IS DISTINCT FROM p_path
    OR (source.deleted_at IS NULL AND COALESCE(source.moderation_status, '') NOT IN ('owner_deleted','removed')) THEN
    RAISE EXCEPTION 'visual_erase_source_mismatch';
  END IF;
  INSERT INTO public.media_visual_index_tombstones(asset_id) VALUES(p_asset_id) ON CONFLICT DO NOTHING;
  DELETE FROM public.media_visual_embeddings WHERE asset_id = p_asset_id;
  DELETE FROM public.media_visual_index_consents WHERE asset_id = p_asset_id;
  RETURN jsonb_build_object('erased', true, 'remaining', (SELECT count(*) FROM public.media_visual_embeddings WHERE asset_id = p_asset_id));
END;
$function$;

CREATE FUNCTION public.media_visual_index_discard(p_asset_id uuid, p_job_id uuid, p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  IF p_asset_id IS NULL OR p_job_id IS NULL OR p_lease_token IS NULL THEN RAISE EXCEPTION 'visual_discard_identity'; END IF;
  DELETE FROM public.media_visual_embeddings WHERE asset_id = p_asset_id AND job_id = p_job_id AND lease_token = p_lease_token;
  RETURN jsonb_build_object('remaining', (SELECT count(*) FROM public.media_visual_embeddings WHERE asset_id = p_asset_id AND job_id = p_job_id AND lease_token = p_lease_token));
END;
$function$;

CREATE FUNCTION public.media_visual_index_sweep(p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE affected integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'visual_sweep_bound'; END IF;
  DELETE FROM public.media_visual_embeddings WHERE asset_id IN (
    SELECT asset_id FROM public.media_visual_embeddings WHERE expires_at <= now() ORDER BY expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$function$;

CREATE FUNCTION public.media_visual_index_source_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  DELETE FROM public.media_visual_embeddings WHERE asset_id = NEW.id AND (
    source_version IS DISTINCT FROM NEW.version OR owner_id IS DISTINCT FROM NEW.owner_user_id
    OR storage_bucket IS DISTINCT FROM NEW.storage_bucket OR storage_path IS DISTINCT FROM NEW.storage_path
    OR NEW.deleted_at IS NOT NULL OR NEW.purge_status IS DISTINCT FROM 'not_requested'
    OR NEW.processing_status IS DISTINCT FROM 'ready' OR COALESCE(NEW.moderation_status, '') NOT IN ('active','approved')
    OR NEW.media_type IS DISTINCT FROM 'image' OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
  );
  RETURN NEW;
END;
$function$;
CREATE TRIGGER media_visual_index_source_changed AFTER UPDATE ON public.media_assets
FOR EACH ROW EXECUTE FUNCTION public.media_visual_index_source_changed();

CREATE FUNCTION public.media_visual_index_consent_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.media_visual_embeddings WHERE asset_id = OLD.asset_id;
    RETURN OLD;
  END IF;
  DELETE FROM public.media_visual_embeddings WHERE asset_id = NEW.asset_id AND (
    consent_revision IS DISTINCT FROM NEW.revision OR source_version IS DISTINCT FROM NEW.source_version
    OR owner_id IS DISTINCT FROM NEW.owner_id OR NEW.revoked_at IS NOT NULL OR expires_at > NEW.expires_at
  );
  RETURN NEW;
END;
$function$;
CREATE TRIGGER media_visual_index_consent_changed AFTER UPDATE OR DELETE ON public.media_visual_index_consents
FOR EACH ROW EXECUTE FUNCTION public.media_visual_index_consent_changed();

REVOKE ALL ON FUNCTION public.media_visual_index_consent(uuid,uuid,integer,boolean,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_visual_index_revision_key(uuid,integer,text,text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_visual_index_commit(uuid,integer,text,text,text,extensions.vector,text,timestamptz,uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_visual_index_seed(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_visual_index_match(text,extensions.vector,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_visual_index_erase(uuid,integer,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_visual_index_sweep(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_visual_index_discard(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_visual_index_source_changed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_visual_index_consent_changed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_visual_index_consent(uuid,uuid,integer,boolean,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_visual_index_revision_key(uuid,integer,text,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_visual_index_commit(uuid,integer,text,text,text,extensions.vector,text,timestamptz,uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_visual_index_seed(uuid,text), public.media_visual_index_match(text,extensions.vector,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_visual_index_erase(uuid,integer,text,text), public.media_visual_index_sweep(integer), public.media_visual_index_source_changed() TO service_role;
GRANT EXECUTE ON FUNCTION public.media_visual_index_discard(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_visual_index_consent_changed() TO service_role;

COMMIT;
