BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE public.media_caption_translation_artifacts (
  id uuid PRIMARY KEY,
  write_token uuid NOT NULL,
  asset_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  kind text NOT NULL CHECK (kind IN ('draft', 'publication')),
  storage_bucket text NOT NULL DEFAULT 'post-media' CHECK (storage_bucket = 'post-media'),
  storage_path text NOT NULL UNIQUE,
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object' AND octet_length(intent::text) < 4096),
  write_state text NOT NULL DEFAULT 'reserved' CHECK (write_state IN ('reserved', 'dispatched', 'uploaded', 'never_dispatched')),
  write_settled_at timestamptz,
  cleanup_requested boolean NOT NULL DEFAULT false,
  source_deleted boolean NOT NULL DEFAULT false,
  retirement_token uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((write_state IN ('uploaded', 'never_dispatched')) = (write_settled_at IS NOT NULL)),
  CHECK (NOT source_deleted OR cleanup_requested),
  CHECK (retirement_token IS NULL OR (cleanup_requested AND write_state IN ('uploaded', 'never_dispatched'))),
  CHECK (storage_path = 'manual-captions/' || asset_id::text || '/' || CASE WHEN kind = 'draft'
    THEN 'translation-v' || source_version::text || '-' || (intent->>'consent_id') || '-' || (intent->>'draft_id')
    ELSE 'v' || source_version::text || '-' || (intent->>'output_revision') END || '.json')
);
CREATE INDEX media_caption_translation_artifacts_asset ON public.media_caption_translation_artifacts(asset_id, id);
CREATE INDEX media_caption_translation_artifacts_owner ON public.media_caption_translation_artifacts(owner_user_id, id);
ALTER TABLE public.media_caption_translation_artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_caption_translation_artifacts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_caption_translation_artifacts TO service_role;
CREATE POLICY media_caption_translation_artifacts_service ON public.media_caption_translation_artifacts TO service_role USING (true) WITH CHECK (true);

CREATE FUNCTION public.media_caption_translation_artifact_reserve(p_id uuid, p_token uuid, p_intent jsonb, p_source jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET timezone = 'UTC' SET lock_timeout = '2s' SET statement_timeout = '10s' AS $$
DECLARE
  source_row public.media_assets%ROWTYPE;
  consent_row public.media_caption_translation_consents%ROWTYPE;
  job_row public.media_derivative_jobs%ROWTYPE;
  config_row public.media_caption_translation_config%ROWTYPE;
  artifact public.media_caption_translation_artifacts%ROWTYPE;
  target_path text;
BEGIN
  IF p_id IS NULL OR p_token IS NULL OR jsonb_typeof(p_intent) IS DISTINCT FROM 'object'
    OR (p_intent ?& ARRAY['asset_id','owner_user_id','source_version','consent_id','job_id','lease_token','kind','draft_id','caption_revision','output_revision']) IS NOT TRUE
    OR p_intent - ARRAY['asset_id','owner_user_id','source_version','consent_id','job_id','lease_token','kind','draft_id','caption_revision','output_revision'] <> '{}'::jsonb
    OR (p_intent->>'kind' IN ('draft','publication')) IS NOT TRUE
    OR (p_intent->>'draft_id' ~ '^[a-f0-9]{64}$') IS NOT TRUE
    OR (p_intent->>'caption_revision' ~ '^[a-f0-9]{64}$') IS NOT TRUE
    OR (p_intent->>'output_revision' ~ '^[a-f0-9]{64}$') IS NOT TRUE
    OR (p_intent->>'lease_token')::uuid IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO source_row FROM public.media_assets WHERE id = (p_intent->>'asset_id')::uuid FOR UPDATE;
  IF NOT FOUND OR source_row.owner_user_id IS DISTINCT FROM (p_intent->>'owner_user_id')::uuid
    OR source_row.version IS DISTINCT FROM (p_intent->>'source_version')::integer
    OR (p_source ?& ARRAY['id','owner_user_id','version','storage_bucket','storage_path','media_type','duration_ms','deleted_at','purge_status','processing_status','moderation_status']) IS NOT TRUE
    OR (to_jsonb(source_row) @> p_source) IS NOT TRUE
    OR source_row.deleted_at IS NOT NULL OR source_row.purge_status IS DISTINCT FROM 'not_requested'
    OR source_row.media_type IS DISTINCT FROM 'video' OR source_row.storage_bucket IS DISTINCT FROM 'post-media'
    OR source_row.processing_status IS DISTINCT FROM 'ready' OR (source_row.moderation_status IN ('active','approved')) IS NOT TRUE
    OR (source_row.duration_ms BETWEEN 1 AND 900000) IS NOT TRUE
    OR (source_row.size_bytes BETWEEN 1 AND 104857600) IS NOT TRUE THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.media_caption_manifests WHERE asset_id = source_row.id AND source_version = source_row.version
    AND revision_key = p_intent->>'caption_revision'
    AND object_path = 'manual-captions/' || source_row.id::text || '/v' || source_row.version::text || '-' || (p_intent->>'caption_revision') || '.json' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_captions_enabled' AND enabled IS TRUE)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_caption_translation_enabled' AND enabled IS TRUE)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_derivative_jobs_enabled' AND enabled IS TRUE) THEN RETURN NULL; END IF;
  SELECT * INTO config_row FROM public.media_caption_translation_config WHERE singleton AND enabled AND runtime_verified_at <= now() FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO consent_row FROM public.media_caption_translation_consents WHERE id = (p_intent->>'consent_id')::uuid FOR UPDATE;
  IF NOT FOUND OR consent_row.revoked_at IS NOT NULL OR consent_row.asset_id IS DISTINCT FROM source_row.id
    OR consent_row.owner_user_id IS DISTINCT FROM source_row.owner_user_id OR consent_row.source_version IS DISTINCT FROM source_row.version
    OR consent_row.caption_revision_key IS DISTINCT FROM p_intent->>'caption_revision'
    OR consent_row.job_id IS DISTINCT FROM (p_intent->>'job_id')::uuid
    OR consent_row.model_version IS DISTINCT FROM config_row.model_version OR consent_row.config_version IS DISTINCT FROM config_row.config_version
    OR NOT EXISTS (SELECT 1 FROM public.media_caption_translation_epochs WHERE asset_id = source_row.id AND epoch = consent_row.consent_epoch)
    OR (config_row.allowed_pairs @> jsonb_build_array(jsonb_build_object('source',consent_row.source_language,'target',consent_row.target_language))) IS NOT TRUE THEN RETURN NULL; END IF;
  SELECT * INTO job_row FROM public.media_derivative_jobs WHERE id = consent_row.job_id FOR UPDATE;
  IF NOT FOUND OR job_row.asset_id IS DISTINCT FROM source_row.id OR job_row.owner_user_id IS DISTINCT FROM source_row.owner_user_id
    OR job_row.source_version IS DISTINCT FROM source_row.version OR job_row.source_bucket IS DISTINCT FROM source_row.storage_bucket
    OR job_row.source_path IS DISTINCT FROM source_row.storage_path OR job_row.source_bytes IS DISTINCT FROM source_row.size_bytes
    OR job_row.kind IS DISTINCT FROM 'subtitle_translation' OR job_row.model_version IS DISTINCT FROM consent_row.model_version
    OR job_row.target_language IS DISTINCT FROM consent_row.target_language OR job_row.revision_key IS DISTINCT FROM consent_row.job_revision_key THEN RETURN NULL; END IF;
  IF p_intent->>'kind' = 'draft' THEN
    IF job_row.state IS DISTINCT FROM 'processing' OR job_row.lease_token IS DISTINCT FROM (p_intent->>'lease_token')::uuid
      OR (job_row.lease_until > clock_timestamp()) IS NOT TRUE
      OR p_intent->>'output_revision' IS DISTINCT FROM p_intent->>'draft_id' THEN RETURN NULL; END IF;
    target_path := 'manual-captions/' || source_row.id::text || '/translation-v' || source_row.version::text || '-' || consent_row.id::text || '-' || (p_intent->>'draft_id') || '.json';
  ELSE
    IF job_row.state IS DISTINCT FROM 'completed' OR (job_row.result @> jsonb_build_object('state','draft_ready','consentId',consent_row.id::text,
      'draftId',p_intent->>'draft_id','revisionKey',consent_row.caption_revision_key,'sourceVersion',source_row.version)) IS NOT TRUE THEN RETURN NULL; END IF;
    PERFORM 1 FROM public.media_caption_translation_artifacts WHERE storage_path = job_row.result->>'artifactKey'
      AND kind = 'draft' AND asset_id = source_row.id AND owner_user_id = source_row.owner_user_id
      AND intent->>'job_id' = job_row.id::text AND intent->>'consent_id' = consent_row.id::text
      AND intent->>'lease_token' = p_intent->>'lease_token' AND intent->>'draft_id' = p_intent->>'draft_id'
      AND write_state = 'uploaded' AND NOT cleanup_requested AND retirement_token IS NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    target_path := 'manual-captions/' || source_row.id::text || '/v' || source_row.version::text || '-' || (p_intent->>'output_revision') || '.json';
    IF p_intent->>'output_revision' = p_intent->>'caption_revision' THEN RETURN NULL; END IF;
  END IF;
  INSERT INTO public.media_caption_translation_artifacts(id,write_token,asset_id,owner_user_id,source_version,kind,storage_path,intent)
    VALUES(p_id,p_token,source_row.id,source_row.owner_user_id,source_row.version,p_intent->>'kind',target_path,p_intent)
    ON CONFLICT DO NOTHING;
  SELECT * INTO artifact FROM public.media_caption_translation_artifacts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR artifact.write_token IS DISTINCT FROM p_token OR artifact.intent IS DISTINCT FROM p_intent
    OR artifact.cleanup_requested OR artifact.retirement_token IS NOT NULL THEN RETURN NULL; END IF;
  RETURN to_jsonb(artifact);
END;
$$;

CREATE FUNCTION public.media_caption_translation_artifact_dispatch(p_id uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET timezone = 'UTC' SET lock_timeout = '2s' SET statement_timeout = '10s' AS $$
DECLARE artifact public.media_caption_translation_artifacts%ROWTYPE; source_row public.media_assets%ROWTYPE; checked jsonb;
BEGIN
  SELECT * INTO artifact FROM public.media_caption_translation_artifacts WHERE id = p_id AND write_token = p_token;
  IF NOT FOUND OR artifact.write_state IS DISTINCT FROM 'reserved' THEN RETURN NULL; END IF;
  SELECT * INTO source_row FROM public.media_assets WHERE id = artifact.asset_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  checked := public.media_caption_translation_artifact_reserve(p_id,p_token,artifact.intent,to_jsonb(source_row));
  IF checked IS NULL THEN RETURN NULL; END IF;
  UPDATE public.media_caption_translation_artifacts SET write_state = 'dispatched'
    WHERE id = p_id AND write_token = p_token AND write_state = 'reserved' AND NOT cleanup_requested AND retirement_token IS NULL RETURNING * INTO artifact;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(artifact);
END;
$$;

CREATE FUNCTION public.media_caption_translation_artifact_settle(p_id uuid, p_token uuid, p_state text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET timezone = 'UTC' SET lock_timeout = '2s' SET statement_timeout = '10s' AS $$
DECLARE artifact public.media_caption_translation_artifacts%ROWTYPE;
BEGIN
  IF (p_state IN ('uploaded','never_dispatched')) IS NOT TRUE THEN RETURN NULL; END IF;
  SELECT * INTO artifact FROM public.media_caption_translation_artifacts WHERE id = p_id AND write_token = p_token FOR UPDATE;
  IF NOT FOUND OR artifact.retirement_token IS NOT NULL THEN RETURN NULL; END IF;
  IF artifact.write_state = p_state THEN RETURN to_jsonb(artifact); END IF;
  IF artifact.write_state IS DISTINCT FROM (CASE WHEN p_state = 'uploaded' THEN 'dispatched' ELSE 'reserved' END) THEN RETURN NULL; END IF;
  UPDATE public.media_caption_translation_artifacts SET write_state = p_state, write_settled_at = clock_timestamp()
    WHERE id = p_id RETURNING * INTO artifact;
  RETURN to_jsonb(artifact);
END;
$$;

CREATE FUNCTION public.media_caption_translation_retain_deleted_source()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '2s' AS $$
BEGIN
  UPDATE public.media_caption_translation_artifacts SET cleanup_requested = true, source_deleted = true WHERE asset_id = OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER media_caption_translation_retain_deleted_source BEFORE DELETE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.media_caption_translation_retain_deleted_source();

CREATE FUNCTION public.media_caption_translation_artifact_retire(p_expected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET timezone = 'UTC' SET lock_timeout = '2s' SET statement_timeout = '10s' AS $$
DECLARE
  artifact public.media_caption_translation_artifacts%ROWTYPE;
  source_row public.media_assets%ROWTYPE;
  head public.media_caption_manifests%ROWTYPE;
  source_present boolean;
  withdrawn boolean;
  permitted boolean;
BEGIN
  IF jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
  SELECT * INTO source_row FROM public.media_assets WHERE id = (p_expected->>'asset_id')::uuid FOR UPDATE;
  source_present := FOUND;
  withdrawn := source_present AND (source_row.deleted_at IS NOT NULL OR source_row.purge_status IN ('pending','failed','completed') OR source_row.moderation_status IN ('owner_deleted','removed'));
  SELECT * INTO head FROM public.media_caption_manifests WHERE asset_id = (p_expected->>'asset_id')::uuid FOR UPDATE;
  IF source_present THEN
    PERFORM 1 FROM public.media_caption_translation_consents WHERE asset_id = source_row.id AND id = (p_expected->'intent'->>'consent_id')::uuid FOR UPDATE;
    PERFORM 1 FROM public.media_derivative_jobs WHERE asset_id = source_row.id AND id = (p_expected->'intent'->>'job_id')::uuid FOR UPDATE;
  END IF;
  SELECT * INTO artifact FROM public.media_caption_translation_artifacts WHERE id = (p_expected->>'id')::uuid FOR UPDATE;
  IF NOT FOUND OR to_jsonb(artifact) IS DISTINCT FROM p_expected OR artifact.write_state NOT IN ('uploaded','never_dispatched') THEN RETURN NULL; END IF;
  IF source_present AND head.object_path = p_expected->>'storage_path' THEN
    IF withdrawn IS NOT TRUE THEN RETURN NULL; END IF;
    IF public.cas_media_caption_manifest(source_row.id,source_row.owner_user_id,to_jsonb(source_row),head.revision_key,
      encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),NULL) IS NOT TRUE THEN RETURN NULL; END IF;
  END IF;
  IF artifact.retirement_token IS NOT NULL THEN RETURN to_jsonb(artifact); END IF;
  permitted := NOT source_present AND artifact.source_deleted;
  IF source_present AND source_row.owner_user_id = artifact.owner_user_id THEN
    permitted := withdrawn OR source_row.version <> artifact.source_version OR NOT EXISTS (
      SELECT 1 FROM public.media_caption_translation_consents AS consent JOIN public.media_derivative_jobs AS job ON job.id = consent.job_id
      WHERE consent.id = (artifact.intent->>'consent_id')::uuid AND consent.revoked_at IS NULL
        AND consent.caption_revision_key = head.revision_key AND consent.source_version = source_row.version
        AND job.id = (artifact.intent->>'job_id')::uuid AND (
          (artifact.kind = 'draft' AND ((job.state = 'processing' AND job.lease_token = (artifact.intent->>'lease_token')::uuid AND job.lease_until > clock_timestamp())
            OR (job.state = 'completed' AND job.result->>'artifactKey' = artifact.storage_path)))
          OR (artifact.kind = 'publication' AND job.state = 'completed')));
  END IF;
  IF permitted IS NOT TRUE THEN RETURN NULL; END IF;
  UPDATE public.media_caption_translation_artifacts SET cleanup_requested = true, retirement_token = gen_random_uuid()
    WHERE id = artifact.id RETURNING * INTO artifact;
  RETURN to_jsonb(artifact);
END;
$$;

CREATE FUNCTION public.media_caption_translation_artifact_forget(p_receipt jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET timezone = 'UTC' SET lock_timeout = '2s' SET statement_timeout = '10s' AS $$
DECLARE artifact public.media_caption_translation_artifacts%ROWTYPE;
BEGIN
  SELECT * INTO artifact FROM public.media_caption_translation_artifacts WHERE id = (p_receipt->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF artifact.retirement_token IS NULL OR to_jsonb(artifact) IS DISTINCT FROM p_receipt THEN RETURN false; END IF;
  DELETE FROM public.media_caption_translation_artifacts WHERE id = artifact.id;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.media_caption_translation_guard_retained_head()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '2s' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.media_caption_translation_artifacts WHERE storage_path = NEW.object_path
    AND (kind <> 'publication' OR write_state <> 'uploaded' OR retirement_token IS NOT NULL OR cleanup_requested)) THEN
    RAISE EXCEPTION 'translation_output_not_publishable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_caption_translation_guard_retained_head BEFORE INSERT OR UPDATE ON public.media_caption_manifests
  FOR EACH ROW EXECUTE FUNCTION public.media_caption_translation_guard_retained_head();

REVOKE ALL ON FUNCTION public.media_caption_translation_artifact_reserve(uuid,uuid,jsonb,jsonb),
  public.media_caption_translation_artifact_dispatch(uuid,uuid), public.media_caption_translation_artifact_settle(uuid,uuid,text),
  public.media_caption_translation_artifact_retire(jsonb), public.media_caption_translation_artifact_forget(jsonb),
  public.media_caption_translation_retain_deleted_source(), public.media_caption_translation_guard_retained_head() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_caption_translation_artifact_reserve(uuid,uuid,jsonb,jsonb),
  public.media_caption_translation_artifact_dispatch(uuid,uuid), public.media_caption_translation_artifact_settle(uuid,uuid,text),
  public.media_caption_translation_artifact_retire(jsonb), public.media_caption_translation_artifact_forget(jsonb),
  public.media_caption_translation_retain_deleted_source(), public.media_caption_translation_guard_retained_head() TO service_role;

CREATE OR REPLACE FUNCTION public.cas_media_caption_translation(p_asset_id uuid,p_owner_id uuid,p_source jsonb,
  p_expected_revision text,p_revision text,p_object_path text,p_consent_id uuid,p_draft_id text,p_reviewed boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET timezone = 'UTC' SET lock_timeout = '2s' SET statement_timeout = '10s' AS $$
DECLARE
  source_row public.media_assets%ROWTYPE;
  config_row public.media_caption_translation_config%ROWTYPE;
  consent_row public.media_caption_translation_consents%ROWTYPE;
  job_row public.media_derivative_jobs%ROWTYPE;
  draft_path text;
BEGIN
  IF p_reviewed IS DISTINCT FROM true OR p_object_path IS NULL OR p_draft_id IS NULL OR p_draft_id !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  SELECT * INTO source_row FROM public.media_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND OR source_row.owner_user_id IS DISTINCT FROM p_owner_id THEN RETURN false; END IF;
  PERFORM 1 FROM public.media_caption_manifests WHERE asset_id = p_asset_id AND source_version = source_row.version
    AND revision_key = p_expected_revision
    AND object_path = 'manual-captions/' || p_asset_id::text || '/v' || source_row.version::text || '-' || p_expected_revision || '.json' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_captions_enabled' AND enabled IS TRUE)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_caption_translation_enabled' AND enabled IS TRUE)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_derivative_jobs_enabled' AND enabled IS TRUE) THEN RETURN false; END IF;
  SELECT * INTO config_row FROM public.media_caption_translation_config WHERE singleton AND enabled AND runtime_verified_at <= now() FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO consent_row FROM public.media_caption_translation_consents WHERE id = p_consent_id FOR UPDATE;
  IF NOT FOUND OR consent_row.revoked_at IS NOT NULL OR consent_row.asset_id IS DISTINCT FROM p_asset_id
    OR consent_row.owner_user_id IS DISTINCT FROM p_owner_id OR consent_row.source_version IS DISTINCT FROM source_row.version
    OR consent_row.caption_revision_key IS DISTINCT FROM p_expected_revision
    OR NOT EXISTS (SELECT 1 FROM public.media_caption_translation_epochs WHERE asset_id = p_asset_id AND epoch = consent_row.consent_epoch)
    OR consent_row.model_version IS DISTINCT FROM config_row.model_version OR consent_row.config_version IS DISTINCT FROM config_row.config_version
    OR NOT config_row.allowed_pairs @> jsonb_build_array(jsonb_build_object('source',consent_row.source_language,'target',consent_row.target_language)) THEN RETURN false; END IF;
  SELECT * INTO job_row FROM public.media_derivative_jobs WHERE id = consent_row.job_id FOR UPDATE;
  draft_path := 'manual-captions/' || p_asset_id::text || '/translation-v' || source_row.version::text || '-' || consent_row.id::text || '-' || p_draft_id || '.json';
  IF NOT FOUND OR job_row.state IS DISTINCT FROM 'completed' OR job_row.kind IS DISTINCT FROM 'subtitle_translation'
    OR job_row.asset_id IS DISTINCT FROM p_asset_id OR job_row.owner_user_id IS DISTINCT FROM p_owner_id
    OR job_row.source_version IS DISTINCT FROM source_row.version OR job_row.source_bucket IS DISTINCT FROM source_row.storage_bucket
    OR job_row.source_path IS DISTINCT FROM source_row.storage_path OR job_row.source_bytes IS DISTINCT FROM source_row.size_bytes
    OR job_row.revision_key IS DISTINCT FROM consent_row.job_revision_key OR job_row.model_version IS DISTINCT FROM consent_row.model_version
    OR job_row.target_language IS DISTINCT FROM consent_row.target_language
    OR (job_row.result @> jsonb_build_object('state','draft_ready','consentId',consent_row.id::text,'draftId',p_draft_id,'artifactKey',draft_path,
      'sourceVersion',source_row.version,'revisionKey',p_expected_revision,'modelVersion',consent_row.model_version,
      'sourceLanguage',consent_row.source_language,'targetLanguage',consent_row.target_language)) IS NOT TRUE THEN RETURN false; END IF;
  PERFORM 1 FROM public.media_caption_translation_artifacts WHERE asset_id = p_asset_id AND owner_user_id = p_owner_id
    AND source_version = source_row.version AND kind = 'publication' AND storage_path = p_object_path
    AND intent->>'consent_id' = p_consent_id::text AND intent->>'draft_id' = p_draft_id
    AND intent->>'caption_revision' = p_expected_revision AND intent->>'output_revision' = p_revision
    AND write_state = 'uploaded' AND NOT cleanup_requested AND retirement_token IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN public.cas_media_caption_manifest(p_asset_id,p_owner_id,p_source,p_expected_revision,p_revision,p_object_path);
END;
$$;

COMMIT;
