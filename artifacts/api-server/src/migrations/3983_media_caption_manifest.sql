BEGIN;

CREATE TABLE public.media_caption_manifests (
  asset_id uuid PRIMARY KEY REFERENCES public.media_assets(id) ON DELETE CASCADE,
  source_version integer NOT NULL CHECK (source_version > 0),
  revision_key text NOT NULL CHECK (revision_key ~ '^[a-f0-9]{64}$'),
  object_path text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (object_path IS NULL OR object_path = 'manual-captions/' || asset_id::text || '/v' || source_version::text || '-' || revision_key || '.json')
);

ALTER TABLE public.media_caption_manifests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_caption_manifests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_caption_manifests TO service_role;

CREATE TABLE public.media_caption_asr_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  model_version text NOT NULL CHECK (model_version ~ '^[A-Za-z0-9._:/@+\-]{1,200}$'),
  config_version text NOT NULL CHECK (length(config_version) BETWEEN 1 AND 200),
  allowed_languages text[] NOT NULL DEFAULT '{}',
  runtime_verified_at timestamptz,
  CHECK (cardinality(allowed_languages) BETWEEN 0 AND 50),
  CHECK (NOT enabled OR (runtime_verified_at IS NOT NULL AND cardinality(allowed_languages) > 0))
);
CREATE TABLE public.media_caption_asr_epochs (
  asset_id uuid PRIMARY KEY REFERENCES public.media_assets(id) ON DELETE CASCADE,
  consent_epoch text NOT NULL CHECK (consent_epoch ~ '^[a-f0-9]{64}$')
);
CREATE TABLE public.media_caption_asr_consents (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  consent_epoch text NOT NULL CHECK (consent_epoch ~ '^[a-f0-9]{64}$'),
  source_version integer NOT NULL CHECK (source_version > 0),
  caption_revision_key text NOT NULL CHECK (caption_revision_key ~ '^[a-f0-9]{64}$'),
  job_revision_key text NOT NULL UNIQUE CHECK (job_revision_key ~ '^[a-f0-9]{64}$'),
  model_version text NOT NULL,
  config_version text NOT NULL,
  target_language text NOT NULL,
  job_id uuid NOT NULL UNIQUE REFERENCES public.media_derivative_jobs(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX media_caption_asr_one_active ON public.media_caption_asr_consents(asset_id) WHERE revoked_at IS NULL;
CREATE INDEX media_caption_asr_asset ON public.media_caption_asr_consents(asset_id, granted_at);
ALTER TABLE public.media_caption_asr_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_caption_asr_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_caption_asr_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_caption_asr_config, public.media_caption_asr_epochs, public.media_caption_asr_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_caption_asr_config, public.media_caption_asr_epochs, public.media_caption_asr_consents TO service_role;
INSERT INTO public.feature_flags(flag, enabled, description)
VALUES ('media_caption_asr_enabled', false, 'Creator-consented local ASR; requires validated pinned runtime/languages and privacy review.')
ON CONFLICT (flag) DO NOTHING;

CREATE FUNCTION public.cas_media_caption_manifest(
  p_asset_id uuid, p_owner_id uuid, p_source jsonb,
  p_expected_revision text, p_revision text, p_object_path text, p_asr_consent_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  source_row public.media_assets%ROWTYPE;
  current_revision text;
BEGIN
  IF p_expected_revision IS NULL OR p_expected_revision !~ '^[a-f0-9]{64}$'
    OR p_revision IS NULL OR p_revision !~ '^[a-f0-9]{64}$'
    OR p_revision = p_expected_revision THEN RETURN false; END IF;
  SELECT * INTO source_row FROM public.media_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF (source_row.owner_user_id = p_owner_id
    AND source_row.id::text = p_source->>'id'
    AND source_row.owner_user_id::text = p_source->>'owner_user_id'
    AND source_row.version = (p_source->>'version')::integer
    AND source_row.storage_bucket = p_source->>'storage_bucket'
    AND source_row.storage_path = p_source->>'storage_path'
    AND source_row.media_type = p_source->>'media_type'
    AND source_row.duration_ms IS NOT DISTINCT FROM (p_source->>'duration_ms')::integer
    AND source_row.deleted_at IS NOT DISTINCT FROM (p_source->>'deleted_at')::timestamptz
    AND source_row.purge_status = p_source->>'purge_status'
    AND source_row.processing_status = p_source->>'processing_status'
    AND source_row.moderation_status = p_source->>'moderation_status') IS NOT TRUE THEN RETURN false; END IF;
  IF p_object_path IS NOT NULL AND (source_row.deleted_at IS NULL
    AND source_row.purge_status = 'not_requested' AND source_row.processing_status = 'ready'
    AND source_row.moderation_status IN ('active', 'approved')
    AND source_row.storage_bucket = 'post-media' AND source_row.media_type = 'video'
    AND source_row.duration_ms > 0) IS NOT TRUE THEN RETURN false; END IF;
  SELECT revision_key INTO current_revision FROM public.media_caption_manifests WHERE asset_id = p_asset_id FOR UPDATE;
  IF coalesce(current_revision, repeat('0', 64)) <> p_expected_revision THEN RETURN false; END IF;
  IF p_asr_consent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.media_caption_asr_consents AS consent
    JOIN public.media_derivative_jobs AS job ON job.id = consent.job_id
    WHERE consent.id = p_asr_consent_id AND consent.asset_id = p_asset_id AND consent.owner_user_id = p_owner_id
      AND consent.source_version = source_row.version AND consent.caption_revision_key = p_expected_revision
      AND consent.revoked_at IS NULL AND job.state = 'completed' AND job.kind = 'captions'
  ) THEN RETURN false; END IF;
  INSERT INTO public.media_caption_manifests(asset_id, source_version, revision_key, object_path)
  VALUES (p_asset_id, source_row.version, p_revision, p_object_path)
  ON CONFLICT (asset_id) DO UPDATE SET source_version = EXCLUDED.source_version,
    revision_key = EXCLUDED.revision_key, object_path = EXCLUDED.object_path, updated_at = now();
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.cas_media_caption_manifest(uuid, uuid, jsonb, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cas_media_caption_manifest(uuid, uuid, jsonb, text, text, text, uuid) TO service_role;

CREATE FUNCTION public.media_caption_asr_epoch(p_asset_id uuid, p_owner_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE source_owner uuid; current_epoch text;
BEGIN
  SELECT owner_user_id INTO source_owner FROM public.media_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND OR source_owner IS DISTINCT FROM p_owner_id THEN RETURN NULL; END IF;
  INSERT INTO public.media_caption_asr_epochs(asset_id, consent_epoch)
  VALUES(p_asset_id, encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'))
  ON CONFLICT (asset_id) DO NOTHING;
  SELECT consent_epoch INTO current_epoch FROM public.media_caption_asr_epochs WHERE asset_id = p_asset_id;
  RETURN current_epoch;
END;
$$;

CREATE FUNCTION public.media_caption_asr_enqueue(p_asset_id uuid, p_owner_id uuid, p_source jsonb,
  p_caption_revision text, p_target_language text, p_consent boolean, p_expected_consent_epoch text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  source_row public.media_assets%ROWTYPE;
  config_row public.media_caption_asr_config%ROWTYPE;
  consent_row public.media_caption_asr_consents%ROWTYPE;
  current_revision text;
  grant_id uuid;
  job_revision text;
  queued_id uuid;
BEGIN
  IF p_consent IS DISTINCT FROM true OR p_expected_consent_epoch IS NULL
    OR p_expected_consent_epoch !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_captions_enabled' AND enabled IS TRUE)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_caption_asr_enabled' AND enabled IS TRUE)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_derivative_jobs_enabled' AND enabled IS TRUE) THEN RETURN NULL; END IF;
  SELECT * INTO source_row FROM public.media_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND OR source_row.owner_user_id IS DISTINCT FROM p_owner_id
    OR (to_jsonb(source_row) @> p_source) IS NOT TRUE
    OR source_row.version IS DISTINCT FROM (p_source->>'version')::integer
    OR source_row.deleted_at IS NOT NULL OR source_row.purge_status IS DISTINCT FROM 'not_requested'
    OR source_row.media_type IS DISTINCT FROM 'video' OR source_row.storage_bucket IS DISTINCT FROM 'post-media'
    OR source_row.processing_status IS DISTINCT FROM 'ready' OR coalesce(source_row.moderation_status,'') NOT IN ('active','approved')
    OR source_row.duration_ms IS NULL OR source_row.duration_ms NOT BETWEEN 1 AND 900000
    OR source_row.size_bytes IS NULL OR source_row.size_bytes NOT BETWEEN 1 AND 104857600 THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.media_caption_asr_epochs
    WHERE asset_id = p_asset_id AND consent_epoch = p_expected_consent_epoch) THEN RETURN NULL; END IF;
  SELECT revision_key INTO current_revision FROM public.media_caption_manifests WHERE asset_id = p_asset_id;
  IF p_caption_revision IS NULL OR coalesce(current_revision, repeat('0',64)) <> p_caption_revision THEN RETURN NULL; END IF;
  SELECT * INTO config_row FROM public.media_caption_asr_config WHERE singleton AND enabled AND runtime_verified_at IS NOT NULL FOR SHARE;
  IF NOT FOUND OR p_target_language IS NULL OR (p_target_language <> '' AND
    (p_target_language !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' OR NOT p_target_language = ANY(config_row.allowed_languages))) THEN RETURN NULL; END IF;
  SELECT * INTO consent_row FROM public.media_caption_asr_consents WHERE asset_id = p_asset_id AND revoked_at IS NULL FOR UPDATE;
  IF FOUND THEN
    IF consent_row.consent_epoch = p_expected_consent_epoch
      AND consent_row.source_version = source_row.version AND consent_row.caption_revision_key = p_caption_revision
      AND consent_row.model_version = config_row.model_version AND consent_row.config_version = config_row.config_version
      AND consent_row.target_language = p_target_language THEN RETURN consent_row.job_id; END IF;
    UPDATE public.media_caption_asr_consents SET revoked_at = now() WHERE id = consent_row.id;
    UPDATE public.media_derivative_jobs SET state = 'cancelled', lease_token = NULL, lease_until = NULL,
      result = NULL, error_code = 'consent_revoked', updated_at = now() WHERE id = consent_row.job_id;
  END IF;
  grant_id := gen_random_uuid();
  job_revision := encode(sha256(convert_to(concat_ws(':', p_caption_revision, grant_id::text, config_row.config_version), 'UTF8')), 'hex');
  queued_id := public.media_derivative_enqueue(p_asset_id, p_owner_id, source_row.version, 'captions', config_row.model_version, p_target_language, job_revision);
  IF queued_id IS NULL THEN RAISE EXCEPTION 'caption_enqueue_unavailable' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.media_caption_asr_consents(id, asset_id, owner_user_id, consent_epoch, source_version, caption_revision_key,
    job_revision_key, model_version, config_version, target_language, job_id)
  VALUES(grant_id, p_asset_id, p_owner_id, p_expected_consent_epoch, source_row.version, p_caption_revision, job_revision,
    config_row.model_version, config_row.config_version, p_target_language, queued_id);
  RETURN queued_id;
END;
$$;

CREATE FUNCTION public.media_caption_asr_revoke(p_asset_id uuid, p_owner_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE source_owner uuid;
BEGIN
  SELECT owner_user_id INTO source_owner FROM public.media_assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND OR source_owner IS DISTINCT FROM p_owner_id THEN RETURN false; END IF;
  INSERT INTO public.media_caption_asr_epochs(asset_id, consent_epoch)
  VALUES(p_asset_id, encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'))
  ON CONFLICT (asset_id) DO UPDATE SET consent_epoch = EXCLUDED.consent_epoch;
  UPDATE public.media_caption_asr_consents SET revoked_at = now() WHERE asset_id = p_asset_id AND revoked_at IS NULL;
  UPDATE public.media_derivative_jobs SET state = 'cancelled', lease_token = NULL, lease_until = NULL,
    result = NULL, error_code = 'consent_revoked', updated_at = now()
  WHERE id IN (SELECT job_id FROM public.media_caption_asr_consents WHERE asset_id = p_asset_id) AND state <> 'cancelled';
  RETURN true;
END;
$$;

CREATE FUNCTION public.media_caption_asr_revision_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  UPDATE public.media_caption_asr_consents SET revoked_at = now()
    WHERE asset_id = NEW.asset_id AND revoked_at IS NULL
      AND (caption_revision_key <> NEW.revision_key OR source_version <> NEW.source_version);
  UPDATE public.media_derivative_jobs SET state = 'cancelled', lease_token = NULL, lease_until = NULL,
    result = NULL, error_code = 'caption_revision_changed', updated_at = now()
    WHERE id IN (SELECT job_id FROM public.media_caption_asr_consents WHERE asset_id = NEW.asset_id AND revoked_at IS NOT NULL) AND state <> 'cancelled';
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_caption_asr_revision_invalidation AFTER INSERT OR UPDATE ON public.media_caption_manifests
FOR EACH ROW EXECUTE FUNCTION public.media_caption_asr_revision_changed();
REVOKE ALL ON FUNCTION public.media_caption_asr_epoch(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_caption_asr_enqueue(uuid,uuid,jsonb,text,text,boolean,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_caption_asr_revoke(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_caption_asr_revision_changed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_caption_asr_epoch(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_caption_asr_enqueue(uuid,uuid,jsonb,text,text,boolean,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_caption_asr_revoke(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_caption_asr_revision_changed() TO service_role;

COMMIT;
