-- Provider-bound consent. Apply this migration before serving managed-processing status.
ALTER TABLE public.media_caption_asr_config
  ADD COLUMN processing_provider text NOT NULL DEFAULT 'local'
    CHECK (processing_provider IN ('local','deepgram'));
ALTER TABLE public.media_caption_asr_consents ADD COLUMN processing_disclosure_version text;

CREATE FUNCTION public.media_caption_asr_enqueue_v2(p_asset_id uuid, p_owner_id uuid, p_source jsonb,
  p_caption_revision text, p_target_language text, p_consent boolean, p_expected_consent_epoch text,
  p_expected_provider text, p_expected_model text, p_expected_config text, p_disclosure_version text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  config_row public.media_caption_asr_config%ROWTYPE;
  queued_id uuid;
BEGIN
  -- Match the established lock order: asset, config, consent, job.
  PERFORM 1 FROM public.media_assets WHERE id = p_asset_id AND owner_user_id = p_owner_id FOR UPDATE;
  IF NOT FOUND OR p_consent IS DISTINCT FROM true THEN RETURN NULL; END IF;
  SELECT * INTO config_row FROM public.media_caption_asr_config
    WHERE singleton AND enabled AND runtime_verified_at IS NOT NULL FOR SHARE;
  IF NOT FOUND OR config_row.processing_provider IS DISTINCT FROM p_expected_provider
    OR config_row.model_version IS DISTINCT FROM p_expected_model
    OR config_row.config_version IS DISTINCT FROM p_expected_config
    OR p_disclosure_version IS DISTINCT FROM (CASE config_row.processing_provider
      WHEN 'local' THEN 'local-audio-v1' WHEN 'deepgram' THEN 'deepgram-audio-opt-out-v1' END)
    THEN RETURN NULL; END IF;
  queued_id := public.media_caption_asr_enqueue(p_asset_id, p_owner_id, p_source,
    p_caption_revision, p_target_language, p_consent, p_expected_consent_epoch);
  IF queued_id IS NOT NULL THEN
    UPDATE public.media_caption_asr_consents SET processing_disclosure_version = p_disclosure_version
      WHERE job_id = queued_id AND owner_user_id = p_owner_id AND revoked_at IS NULL;
  END IF;
  RETURN queued_id;
END;
$$;
REVOKE ALL ON FUNCTION public.media_caption_asr_enqueue_v2(uuid,uuid,jsonb,text,text,boolean,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_caption_asr_enqueue_v2(uuid,uuid,jsonb,text,text,boolean,text,text,text,text,text) TO service_role;
COMMENT ON COLUMN public.media_caption_asr_consents.processing_disclosure_version IS
  'Receipt for the provider disclosure accepted for this pinned model/config. NULL legacy consent never authorizes managed audio processing.';

