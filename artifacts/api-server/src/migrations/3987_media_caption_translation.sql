BEGIN;

CREATE TABLE public.media_caption_translation_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  model_version text NOT NULL CHECK (model_version ~ '^[A-Za-z0-9._:/@+\-]{1,200}$'),
  config_version text NOT NULL CHECK (length(config_version) BETWEEN 1 AND 200),
  allowed_pairs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(allowed_pairs) = 'array' AND jsonb_array_length(allowed_pairs) <= 50),
  runtime_verified_at timestamptz,
  CHECK (NOT enabled OR (runtime_verified_at IS NOT NULL AND jsonb_array_length(allowed_pairs) > 0))
);
CREATE TABLE public.media_caption_translation_consents (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  consent_epoch bigint NOT NULL CHECK (consent_epoch BETWEEN 0 AND 9007199254740991),
  caption_revision_key text NOT NULL CHECK (caption_revision_key ~ '^[a-f0-9]{64}$'),
  job_revision_key text NOT NULL UNIQUE CHECK (job_revision_key ~ '^[a-f0-9]{64}$'),
  model_version text NOT NULL,
  config_version text NOT NULL,
  source_language text NOT NULL,
  target_language text NOT NULL CHECK (target_language <> source_language),
  job_id uuid NOT NULL UNIQUE REFERENCES public.media_derivative_jobs(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  cleanup_pending boolean NOT NULL DEFAULT false
);
CREATE TABLE public.media_caption_translation_epochs (
  asset_id uuid PRIMARY KEY REFERENCES public.media_assets(id) ON DELETE CASCADE,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch BETWEEN 0 AND 9007199254740991)
);
CREATE UNIQUE INDEX media_caption_translation_one_active ON public.media_caption_translation_consents(asset_id) WHERE revoked_at IS NULL;
CREATE INDEX media_caption_translation_asset ON public.media_caption_translation_consents(asset_id, granted_at);
ALTER TABLE public.media_caption_translation_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_caption_translation_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_caption_translation_epochs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_caption_translation_config, public.media_caption_translation_consents, public.media_caption_translation_epochs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_caption_translation_config, public.media_caption_translation_consents, public.media_caption_translation_epochs TO service_role;
INSERT INTO public.feature_flags(flag, enabled, description)
VALUES ('media_caption_translation_enabled', false, 'Creator-consented self-hosted subtitle drafts; requires reviewed pairs, runtime and explicit publication.')
ON CONFLICT (flag) DO NOTHING;

CREATE FUNCTION public.media_caption_translation_enqueue(p_asset_id uuid, p_owner_id uuid, p_source jsonb,
  p_caption_revision text, p_source_language text, p_target_language text, p_consent boolean, p_expected_epoch bigint)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  source_row public.media_assets%ROWTYPE;
  config_row public.media_caption_translation_config%ROWTYPE;
  consent_row public.media_caption_translation_consents%ROWTYPE;
  current_revision text;
  grant_id uuid;
  job_revision text;
  queued_id uuid;
  current_epoch bigint;
BEGIN
  IF p_consent IS DISTINCT FROM true OR p_expected_epoch IS NULL OR p_expected_epoch NOT BETWEEN 0 AND 9007199254740991 THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_captions_enabled' AND enabled IS TRUE)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_caption_translation_enabled' AND enabled IS TRUE)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_derivative_jobs_enabled' AND enabled IS TRUE) THEN RETURN NULL; END IF;
  SELECT * INTO source_row FROM public.media_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND OR source_row.owner_user_id IS DISTINCT FROM p_owner_id
    OR (p_source ?& ARRAY['id','owner_user_id','version','storage_bucket','storage_path','media_type','duration_ms','deleted_at','purge_status','processing_status','moderation_status']) IS NOT TRUE
    OR (to_jsonb(source_row) @> p_source) IS NOT TRUE
    OR source_row.deleted_at IS NOT NULL OR source_row.purge_status IS DISTINCT FROM 'not_requested'
    OR source_row.media_type IS DISTINCT FROM 'video' OR source_row.storage_bucket IS DISTINCT FROM 'post-media'
    OR source_row.processing_status IS DISTINCT FROM 'ready' OR coalesce(source_row.moderation_status,'') NOT IN ('active','approved')
    OR source_row.duration_ms IS NULL OR source_row.duration_ms NOT BETWEEN 1 AND 900000
    OR source_row.size_bytes IS NULL OR source_row.size_bytes NOT BETWEEN 1 AND 104857600 THEN RETURN NULL; END IF;
  INSERT INTO public.media_caption_translation_epochs(asset_id) VALUES(p_asset_id) ON CONFLICT(asset_id) DO NOTHING;
  SELECT epoch INTO current_epoch FROM public.media_caption_translation_epochs WHERE asset_id = p_asset_id FOR UPDATE;
  IF current_epoch IS DISTINCT FROM p_expected_epoch THEN RETURN NULL; END IF;
  SELECT revision_key INTO current_revision FROM public.media_caption_manifests
    WHERE asset_id = p_asset_id AND source_version = source_row.version AND object_path IS NOT NULL;
  IF p_caption_revision IS NULL OR current_revision IS DISTINCT FROM p_caption_revision THEN RETURN NULL; END IF;
  SELECT * INTO config_row FROM public.media_caption_translation_config
    WHERE singleton AND enabled AND runtime_verified_at <= now() FOR SHARE;
  IF NOT FOUND OR p_source_language IS NULL OR p_target_language IS NULL
    OR p_source_language !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' OR p_target_language !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
    OR p_source_language IN ('und','zxx') OR p_target_language IN ('und','zxx') OR lower(p_source_language) = lower(p_target_language)
    OR NOT config_row.allowed_pairs @> jsonb_build_array(jsonb_build_object('source',p_source_language,'target',p_target_language)) THEN RETURN NULL; END IF;
  SELECT * INTO consent_row FROM public.media_caption_translation_consents WHERE asset_id = p_asset_id AND revoked_at IS NULL FOR UPDATE;
  IF FOUND THEN
    IF consent_row.consent_epoch = current_epoch AND consent_row.source_version = source_row.version AND consent_row.caption_revision_key = p_caption_revision
      AND consent_row.model_version = config_row.model_version AND consent_row.config_version = config_row.config_version
      AND consent_row.source_language = p_source_language AND consent_row.target_language = p_target_language
      AND EXISTS (SELECT 1 FROM public.media_derivative_jobs WHERE id = consent_row.job_id AND state IN ('pending','processing','retrying','completed'))
      THEN RETURN consent_row.job_id; END IF;
    UPDATE public.media_caption_translation_consents SET revoked_at = now(),
      cleanup_pending = cleanup_pending OR EXISTS (SELECT 1 FROM public.media_derivative_jobs
        WHERE id = consent_row.job_id AND attempts > 0 AND (completed_at IS NULL OR attempts > 1))
      WHERE id = consent_row.id;
    UPDATE public.media_derivative_jobs SET state = 'cancelled', lease_token = NULL, lease_until = NULL,
      result = NULL, error_code = 'consent_revoked', updated_at = now() WHERE id = consent_row.job_id;
  END IF;
  grant_id := gen_random_uuid();
  job_revision := encode(sha256(convert_to(concat_ws(':',p_caption_revision,grant_id::text,config_row.config_version), 'UTF8')), 'hex');
  queued_id := public.media_derivative_enqueue(p_asset_id,p_owner_id,source_row.version,'subtitle_translation',config_row.model_version,p_target_language,job_revision);
  IF queued_id IS NULL THEN RAISE EXCEPTION 'translation_enqueue_unavailable' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.media_caption_translation_consents(id,asset_id,owner_user_id,source_version,consent_epoch,caption_revision_key,
    job_revision_key,model_version,config_version,source_language,target_language,job_id)
  VALUES(grant_id,p_asset_id,p_owner_id,source_row.version,current_epoch,p_caption_revision,job_revision,
    config_row.model_version,config_row.config_version,p_source_language,p_target_language,queued_id);
  RETURN queued_id;
END;
$$;

CREATE FUNCTION public.media_caption_translation_revoke(p_asset_id uuid, p_owner_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE source_owner uuid;
BEGIN
  SELECT owner_user_id INTO source_owner FROM public.media_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND OR source_owner IS DISTINCT FROM p_owner_id THEN RETURN false; END IF;
  INSERT INTO public.media_caption_translation_epochs(asset_id,epoch) VALUES(p_asset_id,1)
    ON CONFLICT(asset_id) DO UPDATE SET epoch = public.media_caption_translation_epochs.epoch + 1;
  UPDATE public.media_caption_translation_consents AS consent SET revoked_at = coalesce(consent.revoked_at, now()),
    cleanup_pending = consent.cleanup_pending OR EXISTS (SELECT 1 FROM public.media_derivative_jobs
      WHERE id = consent.job_id AND attempts > 0 AND (completed_at IS NULL OR attempts > 1))
    WHERE asset_id = p_asset_id;
  UPDATE public.media_derivative_jobs SET state = 'cancelled',lease_token = NULL,lease_until = NULL,
    result = NULL,error_code = 'consent_revoked',updated_at = now()
    WHERE id IN (SELECT job_id FROM public.media_caption_translation_consents WHERE asset_id = p_asset_id) AND state <> 'cancelled';
  RETURN true;
END;
$$;

CREATE FUNCTION public.cas_media_caption_translation(p_asset_id uuid,p_owner_id uuid,p_source jsonb,
  p_expected_revision text,p_revision text,p_object_path text,p_consent_id uuid,p_draft_id text,p_reviewed boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
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
  RETURN public.cas_media_caption_manifest(p_asset_id,p_owner_id,p_source,p_expected_revision,p_revision,p_object_path);
END;
$$;

CREATE FUNCTION public.media_caption_translation_revision_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE changed_asset uuid;
BEGIN
  changed_asset := CASE WHEN TG_OP = 'DELETE' THEN OLD.asset_id ELSE NEW.asset_id END;
  UPDATE public.media_caption_translation_consents AS consent SET revoked_at = now(),
    cleanup_pending = consent.cleanup_pending OR EXISTS (SELECT 1 FROM public.media_derivative_jobs
      WHERE id = consent.job_id AND attempts > 0 AND (completed_at IS NULL OR attempts > 1))
    WHERE asset_id = changed_asset AND revoked_at IS NULL
      AND (TG_OP = 'DELETE' OR caption_revision_key IS DISTINCT FROM NEW.revision_key OR source_version IS DISTINCT FROM NEW.source_version);
  UPDATE public.media_derivative_jobs SET state = 'cancelled',lease_token = NULL,lease_until = NULL,
    result = NULL,error_code = 'caption_revision_changed',updated_at = now()
    WHERE id IN (SELECT job_id FROM public.media_caption_translation_consents WHERE asset_id = changed_asset AND revoked_at IS NOT NULL) AND state <> 'cancelled';
  RETURN NULL;
END;
$$;
CREATE TRIGGER media_caption_translation_revision_invalidation AFTER INSERT OR UPDATE OR DELETE ON public.media_caption_manifests
FOR EACH ROW EXECUTE FUNCTION public.media_caption_translation_revision_changed();

REVOKE ALL ON FUNCTION public.media_caption_translation_enqueue(uuid,uuid,jsonb,text,text,text,boolean,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.media_caption_translation_revoke(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cas_media_caption_translation(uuid,uuid,jsonb,text,text,text,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.media_caption_translation_revision_changed() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.media_caption_translation_enqueue(uuid,uuid,jsonb,text,text,text,boolean,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_caption_translation_revoke(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.cas_media_caption_translation(uuid,uuid,jsonb,text,text,text,uuid,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_caption_translation_revision_changed() TO service_role;

COMMIT;
