BEGIN;

CREATE TABLE public.media_image_understanding_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
  source_version integer NOT NULL CHECK (source_version > 0),
  post_media_id uuid NOT NULL REFERENCES public.post_media(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  policy_version text NOT NULL CHECK (policy_version ~ '^[A-Za-z0-9._-]{1,80}$'),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (asset_id, source_version, post_media_id, owner_user_id, policy_version)
);
CREATE INDEX media_image_understanding_consents_attachment ON public.media_image_understanding_consents(post_media_id);
CREATE INDEX media_image_understanding_consents_owner ON public.media_image_understanding_consents(owner_user_id);

CREATE TABLE public.media_image_understanding_artifacts (
  job_id uuid PRIMARY KEY REFERENCES public.media_derivative_jobs(id) ON DELETE CASCADE,
  artifact_key text NOT NULL UNIQUE CHECK (length(artifact_key) BETWEEN 1 AND 400),
  consent_id uuid NOT NULL REFERENCES public.media_image_understanding_consents(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  post_media_id uuid NOT NULL REFERENCES public.post_media(id) ON DELETE CASCADE,
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object' AND octet_length(request::text) < 4096),
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) < 8192)),
  publication_token uuid,
  published_at timestamptz,
  CHECK ((result IS NULL) = (publication_token IS NULL)),
  CHECK ((result IS NULL) = (published_at IS NULL))
);
CREATE INDEX media_image_understanding_artifacts_consent ON public.media_image_understanding_artifacts(consent_id);
CREATE INDEX media_image_understanding_artifacts_post ON public.media_image_understanding_artifacts(post_id);
CREATE INDEX media_image_understanding_artifacts_attachment ON public.media_image_understanding_artifacts(post_media_id);

ALTER TABLE public.media_image_understanding_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_image_understanding_artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_image_understanding_consents, public.media_image_understanding_artifacts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_image_understanding_consents, public.media_image_understanding_artifacts TO service_role;

CREATE FUNCTION public.media_image_understanding_source_current(p_source jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_vision_provider_enabled' AND enabled IS TRUE)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_derivative_jobs_enabled' AND enabled IS TRUE)
    OR jsonb_typeof(p_source) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_source)) <> 9
  THEN RETURN false; END IF;
  PERFORM 1 FROM public.media_assets AS asset
    JOIN public.post_media AS attachment ON attachment.id = (p_source->>'postMediaId')::uuid
    JOIN public.posts AS post ON post.id = attachment.post_id
    JOIN public.profiles AS profile ON profile.id = asset.owner_user_id
    WHERE asset.id = (p_source->>'assetId')::uuid AND asset.version = (p_source->>'sourceVersion')::integer
      AND asset.owner_user_id = (p_source->>'ownerId')::uuid AND profile.account_status = 'active'
      AND NOT EXISTS (SELECT 1 FROM public.user_account_states WHERE user_id = profile.id AND state IN ('banned','suspended') AND (expires_at IS NULL OR expires_at > now()))
      AND asset.storage_bucket = 'post-media' AND asset.storage_bucket = p_source->>'bucket' AND asset.storage_path = p_source->>'path'
      AND asset.storage_path LIKE asset.owner_user_id::text || '/%' AND asset.storage_path ~ '^[A-Za-z0-9._/-]+$'
      AND asset.storage_path !~ '(^|/)(\.|\.\.|)($|/)' AND length(asset.storage_path) <= 1024
      AND asset.media_type = p_source->>'mediaType' AND asset.media_type IN ('image','video')
      AND asset.processing_status = 'ready' AND asset.moderation_status IN ('active','approved')
      AND asset.deleted_at IS NULL AND asset.purge_status = 'not_requested'
      AND ((asset.media_type = 'image' AND p_source->'framePath' = 'null'::jsonb AND asset.mime_type IN ('image/jpeg','image/png','image/webp'))
        OR (asset.media_type = 'video' AND asset.thumbnail_path = asset.storage_path || '.poster.jpg' AND asset.thumbnail_path = p_source->>'framePath'))
      AND attachment.post_id = (p_source->>'postId')::uuid AND attachment.user_id = asset.owner_user_id
      AND attachment.storage_bucket = asset.storage_bucket AND attachment.storage_path = asset.storage_path AND attachment.media_type = asset.media_type
      AND attachment.processing_status = 'ready' AND attachment.moderation_status = 'approved'
      AND post.author_id = asset.owner_user_id AND post.status = 'active' AND post.post_status = 'published' AND post.deleted_at IS NULL
    FOR SHARE OF asset, attachment, post, profile;
  RETURN FOUND;
END;
$function$;

CREATE FUNCTION public.media_image_understanding_grant(p_source jsonb, p_owner_user_id uuid, p_policy_version text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE consent_row public.media_image_understanding_consents%ROWTYPE;
BEGIN
  IF p_owner_user_id IS NULL OR p_source->>'ownerId' IS DISTINCT FROM p_owner_user_id::text
    OR NOT public.media_image_understanding_source_current(p_source) THEN RETURN false; END IF;
  INSERT INTO public.media_image_understanding_consents(asset_id, source_version, post_media_id, owner_user_id, policy_version)
    VALUES((p_source->>'assetId')::uuid, (p_source->>'sourceVersion')::integer, (p_source->>'postMediaId')::uuid, p_owner_user_id, p_policy_version)
    ON CONFLICT (asset_id, source_version, post_media_id, owner_user_id, policy_version) DO NOTHING;
  SELECT * INTO consent_row FROM public.media_image_understanding_consents WHERE asset_id = (p_source->>'assetId')::uuid
    AND source_version = (p_source->>'sourceVersion')::integer AND post_media_id = (p_source->>'postMediaId')::uuid
    AND owner_user_id = p_owner_user_id AND policy_version = p_policy_version FOR SHARE;
  RETURN FOUND AND consent_row.revoked_at IS NULL;
END;
$function$;

CREATE FUNCTION public.media_image_understanding_enqueue(p_job jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE
  source jsonb := p_job->'source';
  consent_row public.media_image_understanding_consents%ROWTYPE;
  queue_id uuid;
  expected_key text;
BEGIN
  IF p_job->>'kind' IS DISTINCT FROM 'image_understanding'
    OR p_job->>'modelId' IS DISTINCT FROM 'google/siglip-base-patch16-224'
    OR p_job->>'modelRevision' IS DISTINCT FROM '7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed'
    OR p_job->>'taxonomyVersion' IS DISTINCT FROM 'travel-scene-v1'
    OR jsonb_typeof(p_job) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_job)) <> 7
    OR NOT public.media_image_understanding_source_current(source) THEN RETURN NULL; END IF;
  expected_key := concat_ws(':', 'vision', source->>'assetId', source->>'sourceVersion', p_job->>'modelRevision', p_job->>'taxonomyVersion', p_job->>'consentVersion', source->>'postMediaId');
  IF p_job->>'key' IS DISTINCT FROM expected_key THEN RETURN NULL; END IF;
  SELECT * INTO consent_row FROM public.media_image_understanding_consents
    WHERE asset_id = (source->>'assetId')::uuid AND source_version = (source->>'sourceVersion')::integer
      AND post_media_id = (source->>'postMediaId')::uuid AND owner_user_id = (source->>'ownerId')::uuid
      AND policy_version = p_job->>'consentVersion' AND revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  queue_id := public.media_derivative_enqueue(consent_row.asset_id, consent_row.owner_user_id, consent_row.source_version, 'vision',
    'google/siglip-base-patch16-224@7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed/travel-scene-v1', '', encode(sha256(convert_to(expected_key, 'UTF8')), 'hex'));
  IF queue_id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.media_image_understanding_artifacts(job_id, artifact_key, consent_id, post_id, post_media_id, request)
    VALUES(queue_id, expected_key, consent_row.id, (source->>'postId')::uuid, consent_row.post_media_id, p_job)
    ON CONFLICT (job_id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.media_image_understanding_artifacts WHERE job_id = queue_id AND request = p_job)
    THEN RAISE EXCEPTION 'vision_request_conflict'; END IF;
  RETURN queue_id;
END;
$function$;

CREATE FUNCTION public.media_image_understanding_publish(p_job_id uuid, p_lease_token uuid, p_result jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE artifact public.media_image_understanding_artifacts%ROWTYPE;
BEGIN
  SELECT * INTO artifact FROM public.media_image_understanding_artifacts WHERE job_id = p_job_id;
  IF NOT FOUND OR NOT public.media_image_understanding_source_current(artifact.request->'source') THEN RETURN false; END IF;
  PERFORM 1 FROM public.media_image_understanding_consents WHERE id = artifact.consent_id AND revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.media_derivative_jobs WHERE id = p_job_id AND state = 'processing' AND lease_token = p_lease_token AND lease_until > clock_timestamp()
    AND kind = 'vision' AND source_version = (artifact.request->'source'->>'sourceVersion')::integer
    AND asset_id = (artifact.request->'source'->>'assetId')::uuid AND owner_user_id = (artifact.request->'source'->>'ownerId')::uuid
    AND source_bucket = artifact.request->'source'->>'bucket' AND source_path = artifact.request->'source'->>'path'
    AND source_bytes = (SELECT size_bytes FROM public.media_assets WHERE id = (artifact.request->'source'->>'assetId')::uuid)
    AND model_version = 'google/siglip-base-patch16-224@7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed/travel-scene-v1'
    AND target_language = '' AND revision_key = encode(sha256(convert_to(artifact.artifact_key, 'UTF8')), 'hex') FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_result)) <> 8
    OR p_result->'source' IS DISTINCT FROM artifact.request->'source' OR p_result->>'consentVersion' IS DISTINCT FROM artifact.request->>'consentVersion'
    OR p_result->'recognition'->>'modelId' IS DISTINCT FROM artifact.request->>'modelId'
    OR p_result->'recognition'->>'modelRevision' IS DISTINCT FROM artifact.request->>'modelRevision'
    OR p_result->'recognition'->>'taxonomyVersion' IS DISTINCT FROM artifact.request->>'taxonomyVersion'
    OR p_result->'recognition'->>'confidenceKind' IS DISTINCT FROM 'uncalibrated_similarity'
    OR jsonb_typeof(p_result->'recognition') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_result->'recognition')) <> 8
    OR jsonb_typeof(p_result->'recognition'->'confidence') IS DISTINCT FROM 'number'
    OR (p_result->'recognition'->>'confidence')::numeric NOT BETWEEN 0 AND 1
    OR jsonb_typeof(p_result->'recognition'->'inferenceMs') IS DISTINCT FROM 'number'
    OR (p_result->'recognition'->>'inferenceMs')::numeric NOT BETWEEN 0 AND 90000
    OR NOT (p_result->'recognition' ? 'crowdLevel')
    OR NOT (p_result->'recognition'->'crowdLevel' = 'null'::jsonb OR p_result->'recognition'->>'crowdLevel' IN ('empty','quiet','busy','social'))
    OR p_result->>'pixelScope' IS DISTINCT FROM (CASE WHEN artifact.request->'source'->>'mediaType' = 'image' THEN 'image' ELSE 'stored_poster' END)
    OR COALESCE(p_result->>'pixelSha256', '') !~ '^[a-f0-9]{64}$'
    OR p_result->>'processedAt' IS NULL OR (p_result->>'processedAt')::timestamptz NOT BETWEEN now() - interval '5 minutes' AND now() + interval '1 second'
    OR jsonb_typeof(p_result->'metrics') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_result->'metrics')) <> 4
    OR p_result->'metrics'->'estimatedExternalCostUsd' IS DISTINCT FROM '0'::jsonb
    OR jsonb_typeof(p_result->'metrics'->'inputBytes') IS DISTINCT FROM 'number' OR (p_result->'metrics'->>'inputBytes')::numeric NOT BETWEEN 1 AND 8388608
    OR jsonb_typeof(p_result->'metrics'->'normalizedBytes') IS DISTINCT FROM 'number' OR (p_result->'metrics'->>'normalizedBytes')::numeric NOT BETWEEN 1 AND 2097152
    OR jsonb_typeof(p_result->'metrics'->'elapsedMs') IS DISTINCT FROM 'number' OR (p_result->'metrics'->>'elapsedMs')::numeric NOT BETWEEN 0 AND 90000
    OR jsonb_typeof(p_result->'candidates') IS DISTINCT FROM 'array' OR jsonb_array_length(p_result->'candidates') > 1
  THEN RETURN false; END IF;
  IF jsonb_typeof(p_result->'recognition'->'travelCandidates') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_result->'recognition'->'travelCandidates') > 6 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_result->'recognition'->'travelCandidates') AS candidate WHERE
    jsonb_typeof(candidate) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(candidate)) <> 6
    OR COALESCE(candidate->>'tag', '') NOT IN ('beach','ocean','mountain','architecture','food','sunset','forest','snow','desert','waterfall','lake','garden','boat','market')
    OR candidate->>'category' IS DISTINCT FROM (CASE WHEN candidate->>'tag' IN ('food','boat') THEN 'object' ELSE 'scene' END)
    OR jsonb_typeof(candidate->'confidence') IS DISTINCT FROM 'number' OR (candidate->>'confidence')::numeric NOT BETWEEN 0.5 AND 1
    OR candidate->>'basis' IS DISTINCT FROM 'visual_inference' OR candidate->'verified' IS DISTINCT FROM 'false'::jsonb
    OR candidate->'eligibleAsObservation' IS DISTINCT FROM 'false'::jsonb)
    OR (SELECT count(DISTINCT candidate->>'tag') FROM jsonb_array_elements(p_result->'recognition'->'travelCandidates') AS candidate) <> jsonb_array_length(p_result->'recognition'->'travelCandidates')
    THEN RETURN false; END IF;
  IF jsonb_array_length(p_result->'candidates') IS DISTINCT FROM (CASE WHEN p_result->'recognition'->'crowdLevel' = 'null'::jsonb THEN 0 ELSE 1 END)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_result->'candidates') AS candidate WHERE
    candidate IS DISTINCT FROM jsonb_build_object('mediaId', artifact.post_id, 'kind', 'crowd_level', 'value', p_result->'recognition'->'crowdLevel',
      'confidence', p_result->'recognition'->'confidence', 'provider', 'self_hosted_siglip', 'basis', 'visual_inference', 'verified', false, 'eligibleAsObservation', false)) THEN RETURN false; END IF;
  UPDATE public.media_image_understanding_artifacts SET result = p_result, publication_token = p_lease_token, published_at = now() WHERE job_id = p_job_id;
  RETURN FOUND;
END;
$function$;

CREATE FUNCTION public.media_image_understanding_read(p_artifact_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE artifact public.media_image_understanding_artifacts%ROWTYPE;
BEGIN
  SELECT artifact_row.* INTO artifact FROM public.media_image_understanding_artifacts AS artifact_row
    JOIN public.media_derivative_jobs AS job ON job.id = artifact_row.job_id
    WHERE artifact_row.artifact_key = p_artifact_key AND artifact_row.published_at IS NOT NULL
      AND job.state = 'completed' AND job.kind = 'vision'
      AND job.asset_id = (artifact_row.request->'source'->>'assetId')::uuid AND job.owner_user_id = (artifact_row.request->'source'->>'ownerId')::uuid
      AND job.source_version = (artifact_row.request->'source'->>'sourceVersion')::integer
      AND job.source_bucket = artifact_row.request->'source'->>'bucket' AND job.source_path = artifact_row.request->'source'->>'path'
      AND job.model_version = 'google/siglip-base-patch16-224@7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed/travel-scene-v1'
      AND job.target_language = '' AND job.revision_key = encode(sha256(convert_to(artifact_row.artifact_key, 'UTF8')), 'hex')
      AND job.result = jsonb_build_object('artifactKey', artifact_row.artifact_key, 'publicationToken', artifact_row.publication_token);
  IF NOT FOUND OR NOT public.media_image_understanding_source_current(artifact.request->'source') THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.media_image_understanding_consents WHERE id = artifact.consent_id AND revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN artifact.result;
END;
$function$;

CREATE FUNCTION public.media_image_understanding_discard(p_job_id uuid, p_lease_token uuid)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
  UPDATE public.media_image_understanding_artifacts SET result = NULL, publication_token = NULL, published_at = NULL
    WHERE job_id = p_job_id AND publication_token = p_lease_token
      AND NOT EXISTS (SELECT 1 FROM public.media_derivative_jobs AS job WHERE job.id = p_job_id AND job.state = 'completed'
        AND job.result = jsonb_build_object('artifactKey', media_image_understanding_artifacts.artifact_key, 'publicationToken', p_lease_token));
$function$;

CREATE FUNCTION public.media_image_understanding_revoke(p_post_media_id uuid, p_owner_user_id uuid)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
  UPDATE public.media_image_understanding_consents SET revoked_at = now()
    WHERE post_media_id = p_post_media_id AND owner_user_id = p_owner_user_id AND revoked_at IS NULL;
$function$;

CREATE FUNCTION public.media_image_understanding_consent_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.source_version IS DISTINCT FROM OLD.source_version
    OR NEW.post_media_id IS DISTINCT FROM OLD.post_media_id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.granted_at IS DISTINCT FROM OLD.granted_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at))
    THEN RAISE EXCEPTION 'vision_consent_immutable'; END IF;
  UPDATE public.media_derivative_jobs SET state = 'cancelled', lease_token = NULL, lease_until = NULL, result = NULL, error_code = 'vision_consent_revoked'
    WHERE id IN (SELECT job_id FROM public.media_image_understanding_artifacts WHERE consent_id = OLD.id);
  DELETE FROM public.media_image_understanding_artifacts WHERE consent_id = OLD.id;
  RETURN COALESCE(NEW, OLD);
END;
$function$;
CREATE TRIGGER media_image_understanding_consent_invalidation BEFORE UPDATE OR DELETE ON public.media_image_understanding_consents
FOR EACH ROW EXECUTE FUNCTION public.media_image_understanding_consent_changed();

CREATE FUNCTION public.media_image_understanding_job_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  IF NEW.state NOT IN ('processing','completed') THEN
    UPDATE public.media_image_understanding_artifacts SET result = NULL, publication_token = NULL, published_at = NULL WHERE job_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER media_image_understanding_job_invalidation AFTER UPDATE OF state ON public.media_derivative_jobs
FOR EACH ROW EXECUTE FUNCTION public.media_image_understanding_job_changed();

CREATE FUNCTION public.media_image_understanding_source_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) = to_jsonb(OLD) THEN RETURN NEW; END IF;
  UPDATE public.media_image_understanding_consents SET revoked_at = now() WHERE revoked_at IS NULL AND
    ((TG_TABLE_NAME = 'media_assets' AND asset_id = OLD.id)
      OR (TG_TABLE_NAME = 'post_media' AND post_media_id = OLD.id)
      OR (TG_TABLE_NAME = 'posts' AND post_media_id IN (SELECT id FROM public.post_media WHERE post_id = OLD.id))
      OR (TG_TABLE_NAME = 'profiles' AND owner_user_id = OLD.id));
  RETURN COALESCE(NEW, OLD);
END;
$function$;
CREATE TRIGGER media_image_understanding_asset_invalidation BEFORE UPDATE OR DELETE ON public.media_assets
FOR EACH ROW EXECUTE FUNCTION public.media_image_understanding_source_changed();
CREATE TRIGGER media_image_understanding_attachment_invalidation BEFORE UPDATE OF post_id, user_id, storage_bucket, storage_path, media_type, processing_status, moderation_status, sort_order OR DELETE ON public.post_media
FOR EACH ROW EXECUTE FUNCTION public.media_image_understanding_source_changed();
CREATE TRIGGER media_image_understanding_post_invalidation BEFORE UPDATE OF author_id, status, post_status, deleted_at, visibility, trip_id OR DELETE ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.media_image_understanding_source_changed();
CREATE TRIGGER media_image_understanding_owner_invalidation BEFORE UPDATE OF account_status OR DELETE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.media_image_understanding_source_changed();

CREATE FUNCTION public.media_image_understanding_account_restricted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
BEGIN
  IF NEW.state IN ('banned','suspended') AND (NEW.expires_at IS NULL OR NEW.expires_at > now()) THEN
    PERFORM 1 FROM public.profiles WHERE id = NEW.user_id FOR UPDATE;
    UPDATE public.media_image_understanding_consents SET revoked_at = now() WHERE owner_user_id = NEW.user_id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER media_image_understanding_restriction_invalidation BEFORE INSERT OR UPDATE ON public.user_account_states
FOR EACH ROW EXECUTE FUNCTION public.media_image_understanding_account_restricted();

DO $permissions$
DECLARE procedure record;
BEGIN
  FOR procedure IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'media_image_understanding_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', procedure.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', procedure.signature);
  END LOOP;
END;
$permissions$;

COMMIT;
