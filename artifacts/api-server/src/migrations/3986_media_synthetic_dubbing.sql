BEGIN;

CREATE TABLE public.media_dubbing_epochs (
  asset_id uuid PRIMARY KEY REFERENCES public.media_assets(id) ON DELETE CASCADE,
  epoch text NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')) CHECK (epoch ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.media_dubbing_consents (
  asset_id uuid NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  target_language text NOT NULL CHECK (target_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  source_version integer NOT NULL CHECK (source_version > 0),
  caption_revision text NOT NULL CHECK (caption_revision ~ '^[a-f0-9]{64}$'),
  translation_revision text NOT NULL CHECK (translation_revision ~ '^[a-f0-9]{64}$'),
  consent_revision text NOT NULL CHECK (consent_revision ~ '^[a-f0-9]{64}$'),
  previous_revision text NOT NULL CHECK (previous_revision ~ '^[a-f0-9]{64}$'),
  opted_in boolean NOT NULL DEFAULT false,
  disclosure_version text NOT NULL CHECK (disclosure_version = 'synthetic-dubbing-v1'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, target_language)
);

CREATE TABLE public.media_dubbing_artifacts (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  job_id uuid NOT NULL,
  lease_token uuid NOT NULL,
  storage_bucket text NOT NULL CHECK (storage_bucket ~ '^[a-z][a-z0-9-]{2,62}$' AND storage_bucket <> 'post-media'),
  storage_path text NOT NULL UNIQUE CHECK (storage_path = 'synthetic-dubbing/' || id::text || '.wav'),
  write_state text NOT NULL DEFAULT 'pending' CHECK (write_state IN ('pending', 'uploaded', 'aborted')),
  write_settled_at timestamptz,
  cleanup_requested boolean NOT NULL DEFAULT false,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object' AND octet_length(manifest::text) <= 60000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((write_state = 'pending') = (write_settled_at IS NULL))
);
CREATE INDEX media_dubbing_artifacts_asset ON public.media_dubbing_artifacts(asset_id, owner_user_id);
CREATE INDEX media_dubbing_artifacts_job ON public.media_dubbing_artifacts(job_id);
ALTER TABLE public.media_dubbing_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_dubbing_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_dubbing_epochs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_dubbing_consents, public.media_dubbing_artifacts, public.media_dubbing_epochs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_dubbing_consents, public.media_dubbing_artifacts, public.media_dubbing_epochs TO service_role;

INSERT INTO public.feature_flags(flag, enabled, description)
VALUES ('media_dubbing_enabled', false, 'Creator opt-in synthetic dubbing; requires approved offline stock model, translated captions, protected storage and worker integration.')
ON CONFLICT (flag) DO NOTHING;

CREATE FUNCTION public.media_dubbing_consent_state(p_asset uuid, p_owner uuid, p_language text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE receipt jsonb;
BEGIN
  IF p_language IS NULL OR length(p_language) > 35 OR p_language !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' THEN RETURN NULL; END IF;
  PERFORM 1 FROM media_assets WHERE id = p_asset AND owner_user_id = p_owner FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('consentRevision', COALESCE(consent.consent_revision, epochs.epoch, repeat('0', 64)),
    'optedIn', COALESCE(consent.opted_in AND consent.owner_user_id = p_owner, false)) INTO receipt
    FROM media_assets AS source
    LEFT JOIN media_dubbing_epochs AS epochs ON epochs.asset_id = source.id
    LEFT JOIN media_dubbing_consents AS consent ON consent.asset_id = source.id AND consent.target_language = p_language
    WHERE source.id = p_asset;
  RETURN receipt;
END;
$function$;
REVOKE ALL ON FUNCTION public.media_dubbing_consent_state(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_dubbing_consent_state(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.media_dubbing_current(p_asset uuid, p_owner uuid, p_source integer, p_language text, p_caption text, p_translation text, p_consent text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $function$
  SELECT EXISTS (
    SELECT 1 FROM media_assets AS source
    JOIN media_dubbing_consents AS consent ON consent.asset_id = source.id
    JOIN media_caption_manifests AS captions ON captions.asset_id = source.id
    WHERE source.id = p_asset AND source.owner_user_id = p_owner AND source.version = p_source
      AND source.deleted_at IS NULL AND COALESCE(source.purge_status, 'none') NOT IN ('pending','failed','completed')
      AND source.storage_bucket = 'post-media' AND source.processing_status IN ('ready','uploaded','processing')
      AND source.moderation_status IN ('active','approved')
      AND consent.owner_user_id = p_owner AND consent.source_version = p_source
      AND consent.target_language = p_language AND consent.caption_revision = p_caption
      AND consent.translation_revision = p_translation AND consent.consent_revision = p_consent
      AND captions.source_version = p_source AND captions.revision_key = p_caption AND captions.object_path IS NOT NULL
      AND consent.opted_in IS TRUE AND consent.disclosure_version = 'synthetic-dubbing-v1'
      AND EXISTS (SELECT 1 FROM feature_flags WHERE flag = 'media_dubbing_enabled' AND enabled IS TRUE)
  );
$function$;

CREATE FUNCTION public.media_dubbing_grant(p_asset uuid, p_owner uuid, p_source integer, p_language text, p_caption text, p_translation text, p_opt_in boolean, p_disclosure text, p_expected text)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE source_row public.media_assets%ROWTYPE; existing_consent public.media_dubbing_consents%ROWTYPE; receipt text;
BEGIN
  IF p_opt_in IS DISTINCT FROM true OR p_disclosure IS DISTINCT FROM 'synthetic-dubbing-v1'
    OR p_language IS NULL OR p_language !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
    OR p_caption IS NULL OR p_caption !~ '^[a-f0-9]{64}$' OR p_translation IS NULL OR p_translation !~ '^[a-f0-9]{64}$'
    OR p_expected IS NULL OR p_expected !~ '^[a-f0-9]{64}$'
    OR NOT EXISTS (SELECT 1 FROM feature_flags WHERE flag = 'media_dubbing_enabled' AND enabled IS TRUE) THEN RETURN NULL; END IF;
  SELECT * INTO source_row FROM media_assets WHERE id = p_asset FOR UPDATE;
  IF NOT FOUND OR source_row.owner_user_id IS DISTINCT FROM p_owner OR source_row.version IS DISTINCT FROM p_source
    OR source_row.deleted_at IS NOT NULL OR COALESCE(source_row.purge_status, 'none') IN ('pending','failed','completed')
    OR source_row.storage_bucket IS DISTINCT FROM 'post-media' OR COALESCE(source_row.processing_status, '') NOT IN ('ready','uploaded','processing')
    OR COALESCE(source_row.moderation_status, '') NOT IN ('active','approved') THEN RETURN NULL; END IF;
  PERFORM 1 FROM media_caption_manifests WHERE asset_id = p_asset AND source_version = p_source
    AND revision_key = p_caption AND object_path IS NOT NULL FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO existing_consent FROM media_dubbing_consents WHERE asset_id = p_asset AND target_language = p_language FOR UPDATE;
  IF FOUND THEN
    IF existing_consent.opted_in AND existing_consent.owner_user_id = p_owner AND existing_consent.source_version = p_source
      AND existing_consent.caption_revision = p_caption AND existing_consent.translation_revision = p_translation
      AND p_expected IN (existing_consent.consent_revision, existing_consent.previous_revision) THEN RETURN existing_consent.consent_revision; END IF;
    IF p_expected IS DISTINCT FROM existing_consent.consent_revision THEN RETURN NULL; END IF;
  ELSIF p_expected IS DISTINCT FROM COALESCE((SELECT epoch FROM media_dubbing_epochs WHERE asset_id = p_asset), repeat('0', 64)) THEN RETURN NULL;
  END IF;
  INSERT INTO media_dubbing_consents AS existing(asset_id, owner_user_id, target_language, source_version, caption_revision, translation_revision, consent_revision, previous_revision, opted_in, disclosure_version)
  VALUES(p_asset, p_owner, p_language, p_source, p_caption, p_translation, replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), p_expected, true, p_disclosure)
  ON CONFLICT (asset_id, target_language) DO UPDATE SET
    owner_user_id = EXCLUDED.owner_user_id, source_version = EXCLUDED.source_version,
    caption_revision = EXCLUDED.caption_revision, translation_revision = EXCLUDED.translation_revision,
    consent_revision = EXCLUDED.consent_revision, previous_revision = EXCLUDED.previous_revision,
    opted_in = true, disclosure_version = EXCLUDED.disclosure_version, updated_at = now()
  RETURNING consent_revision INTO receipt;
  RETURN receipt;
END;
$function$;

CREATE FUNCTION public.media_dubbing_revoke(p_asset uuid, p_owner uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM 1 FROM media_assets WHERE id = p_asset AND owner_user_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO media_dubbing_epochs(asset_id) VALUES(p_asset)
    ON CONFLICT (asset_id) DO UPDATE SET epoch = EXCLUDED.epoch, updated_at = clock_timestamp();
  UPDATE media_dubbing_consents SET opted_in = false, consent_revision = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), updated_at = now()
    WHERE asset_id = p_asset AND owner_user_id = p_owner;
  UPDATE media_derivative_jobs SET state = 'cancelled', lease_token = NULL, lease_until = NULL, result = NULL, error_code = 'consent_revoked', updated_at = now()
    WHERE asset_id = p_asset AND owner_user_id = p_owner AND kind = 'dubbing';
  RETURN true;
END;
$function$;

CREATE FUNCTION public.media_dubbing_stage(p_job uuid, p_token uuid, p_id uuid, p_manifest jsonb, p_bucket text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE source_row public.media_assets%ROWTYPE; job_row public.media_derivative_jobs%ROWTYPE;
BEGIN
  IF p_bucket IS NULL OR p_bucket !~ '^[a-z][a-z0-9-]{2,62}$' OR p_bucket = 'post-media' THEN RETURN false; END IF;
  SELECT source.* INTO source_row FROM media_assets AS source JOIN media_derivative_jobs AS job ON job.asset_id = source.id WHERE job.id = p_job FOR SHARE OF source;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO job_row FROM media_derivative_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND OR job_row.kind <> 'dubbing' OR job_row.state <> 'processing' OR job_row.lease_token IS DISTINCT FROM p_token THEN RETURN false; END IF;
  PERFORM 1 FROM media_dubbing_consents WHERE asset_id = job_row.asset_id AND target_language = job_row.target_language FOR SHARE;
  IF job_row.lease_until IS NULL OR job_row.lease_until <= clock_timestamp() THEN RETURN false; END IF;
  IF jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
    OR p_manifest->>'kind' IS DISTINCT FROM 'synthetic_dubbing' OR p_manifest->>'label' IS DISTINCT FROM 'AI-generated translated audio'
    OR p_manifest->'voiceCloning' IS DISTINCT FROM 'false'::jsonb OR p_manifest->'training' IS DISTINCT FROM 'false'::jsonb OR p_manifest->'originalPreserved' IS DISTINCT FROM 'true'::jsonb
    OR p_manifest->>'assetId' IS DISTINCT FROM job_row.asset_id::text OR p_manifest->>'sourceVersion' IS DISTINCT FROM job_row.source_version::text
    OR p_manifest->>'modelVersion' IS DISTINCT FROM job_row.model_version OR p_manifest->>'revisionKey' IS DISTINCT FROM job_row.revision_key
    OR p_manifest->>'language' IS DISTINCT FROM job_row.target_language
    OR source_row.storage_path IS DISTINCT FROM job_row.source_path OR source_row.storage_bucket IS DISTINCT FROM job_row.source_bucket OR source_row.size_bytes IS DISTINCT FROM job_row.source_bytes
    OR NOT media_dubbing_current(job_row.asset_id, job_row.owner_user_id, job_row.source_version, job_row.target_language, p_manifest->>'captionRevision', p_manifest->>'translationRevision', p_manifest->>'consentRevision') THEN RETURN false; END IF;
  INSERT INTO media_dubbing_artifacts(id, asset_id, owner_user_id, job_id, lease_token, storage_bucket, storage_path, manifest)
  VALUES(p_id, job_row.asset_id, job_row.owner_user_id, job_row.id, p_token, p_bucket, 'synthetic-dubbing/' || p_id::text || '.wav', p_manifest);
  RETURN true;
END;
$function$;

CREATE FUNCTION public.media_dubbing_settle(p_job uuid, p_token uuid, p_id uuid, p_uploaded boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE settled text;
BEGIN
  IF p_uploaded IS NULL THEN RETURN false; END IF;
  settled := CASE WHEN p_uploaded THEN 'uploaded' ELSE 'aborted' END;
  UPDATE media_dubbing_artifacts SET write_state = settled, write_settled_at = COALESCE(write_settled_at, clock_timestamp())
    WHERE id = p_id AND job_id = p_job AND lease_token = p_token AND write_state IN ('pending', settled);
  RETURN FOUND;
END;
$function$;

CREATE FUNCTION public.media_dubbing_retire(p_id uuid, p_owner uuid, p_job uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE artifact public.media_dubbing_artifacts%ROWTYPE;
BEGIN
  UPDATE media_dubbing_artifacts SET cleanup_requested = true
    WHERE id = p_id AND ((p_owner IS NOT NULL AND owner_user_id = p_owner AND p_job IS NULL AND p_token IS NULL)
      OR (p_owner IS NULL AND job_id = p_job AND lease_token = p_token))
    RETURNING * INTO artifact;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(artifact);
END;
$function$;

CREATE FUNCTION public.media_dubbing_forget(p_id uuid, p_owner uuid, p_job uuid, p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  DELETE FROM media_dubbing_artifacts WHERE id = p_id AND cleanup_requested AND write_state <> 'pending'
    AND ((p_owner IS NOT NULL AND owner_user_id = p_owner AND p_job IS NULL AND p_token IS NULL)
      OR (p_owner IS NULL AND job_id = p_job AND lease_token = p_token));
  RETURN FOUND OR NOT EXISTS (SELECT 1 FROM media_dubbing_artifacts WHERE id = p_id);
END;
$function$;

CREATE FUNCTION public.media_dubbing_keep_pending() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  IF OLD.write_state = 'pending' THEN RAISE EXCEPTION 'Dubbing writer settlement is unknown'; END IF;
  RETURN OLD;
END;
$function$;
CREATE TRIGGER media_dubbing_keep_pending BEFORE DELETE ON public.media_dubbing_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.media_dubbing_keep_pending();

CREATE FUNCTION public.media_dubbing_mark_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.opted_in IS NOT TRUE OR NEW.consent_revision IS DISTINCT FROM OLD.consent_revision THEN
    UPDATE media_dubbing_artifacts SET cleanup_requested = true
      WHERE asset_id = OLD.asset_id AND owner_user_id = OLD.owner_user_id
        AND manifest->>'language' = OLD.target_language AND manifest->>'consentRevision' = OLD.consent_revision;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER media_dubbing_mark_cleanup AFTER UPDATE OR DELETE ON public.media_dubbing_consents
  FOR EACH ROW EXECUTE FUNCTION public.media_dubbing_mark_cleanup();
REVOKE ALL ON FUNCTION public.media_dubbing_settle(uuid,uuid,uuid,boolean), public.media_dubbing_retire(uuid,uuid,uuid,uuid), public.media_dubbing_forget(uuid,uuid,uuid,uuid), public.media_dubbing_keep_pending(), public.media_dubbing_mark_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_dubbing_settle(uuid,uuid,uuid,boolean), public.media_dubbing_retire(uuid,uuid,uuid,uuid), public.media_dubbing_forget(uuid,uuid,uuid,uuid), public.media_dubbing_keep_pending(), public.media_dubbing_mark_cleanup() TO service_role;

CREATE VIEW public.media_dubbing_readable WITH (security_invoker = true) AS
SELECT artifact.* FROM media_dubbing_artifacts AS artifact
JOIN media_derivative_jobs AS job ON job.id = artifact.job_id
WHERE artifact.write_state = 'uploaded' AND NOT artifact.cleanup_requested
  AND job.state = 'completed' AND job.result->>'artifactId' = artifact.id::text
  AND job.result->>'publicationToken' = artifact.lease_token::text
  AND media_dubbing_current(artifact.asset_id, artifact.owner_user_id, job.source_version, job.target_language,
    artifact.manifest->>'captionRevision', artifact.manifest->>'translationRevision', artifact.manifest->>'consentRevision');
REVOKE ALL ON public.media_dubbing_readable FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.media_dubbing_readable TO service_role;

CREATE FUNCTION public.media_dubbing_invalidate_source() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  IF NEW.version IS DISTINCT FROM OLD.version OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket OR NEW.storage_path IS DISTINCT FROM OLD.storage_path OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.deleted_at IS NOT NULL OR COALESCE(NEW.purge_status, 'none') IN ('pending','failed','completed')
    OR COALESCE(NEW.moderation_status, '') NOT IN ('active','approved') OR COALESCE(NEW.processing_status, '') NOT IN ('ready','uploaded','processing') THEN
    INSERT INTO media_dubbing_epochs(asset_id) VALUES(NEW.id)
      ON CONFLICT (asset_id) DO UPDATE SET epoch = EXCLUDED.epoch, updated_at = clock_timestamp();
    UPDATE media_dubbing_consents SET opted_in = false, consent_revision = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), updated_at = now() WHERE asset_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER media_dubbing_invalidate_source AFTER UPDATE ON public.media_assets FOR EACH ROW EXECUTE FUNCTION public.media_dubbing_invalidate_source();

CREATE FUNCTION public.media_dubbing_invalidate_captions() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.source_version IS DISTINCT FROM OLD.source_version
    OR NEW.revision_key IS DISTINCT FROM OLD.revision_key OR NEW.object_path IS DISTINCT FROM OLD.object_path THEN
    INSERT INTO media_dubbing_epochs(asset_id) SELECT id FROM media_assets WHERE id = OLD.asset_id
      ON CONFLICT (asset_id) DO UPDATE SET epoch = EXCLUDED.epoch, updated_at = clock_timestamp();
    UPDATE media_dubbing_consents SET opted_in = false,
      consent_revision = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), updated_at = now()
      WHERE asset_id = OLD.asset_id;
    UPDATE media_derivative_jobs SET state = 'cancelled', lease_token = NULL, lease_until = NULL, result = NULL,
      error_code = 'caption_revision_changed', updated_at = now()
      WHERE asset_id = OLD.asset_id AND kind = 'dubbing' AND state IN ('pending','processing','completed','retrying');
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER media_dubbing_invalidate_captions AFTER UPDATE OR DELETE ON public.media_caption_manifests
  FOR EACH ROW EXECUTE FUNCTION public.media_dubbing_invalidate_captions();
REVOKE ALL ON FUNCTION public.media_dubbing_invalidate_captions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_dubbing_invalidate_captions() TO service_role;

REVOKE ALL ON FUNCTION public.media_dubbing_current(uuid,uuid,integer,text,text,text,text), public.media_dubbing_grant(uuid,uuid,integer,text,text,text,boolean,text,text), public.media_dubbing_revoke(uuid,uuid), public.media_dubbing_stage(uuid,uuid,uuid,jsonb,text), public.media_dubbing_invalidate_source() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_dubbing_current(uuid,uuid,integer,text,text,text,text), public.media_dubbing_grant(uuid,uuid,integer,text,text,text,boolean,text,text), public.media_dubbing_revoke(uuid,uuid), public.media_dubbing_stage(uuid,uuid,uuid,jsonb,text), public.media_dubbing_invalidate_source() TO service_role;

COMMIT;
