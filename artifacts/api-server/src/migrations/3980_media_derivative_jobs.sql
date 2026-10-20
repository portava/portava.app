BEGIN;

CREATE TABLE public.media_derivative_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  source_bucket text NOT NULL CHECK (source_bucket = 'post-media'),
  source_path text NOT NULL CHECK (length(source_path) BETWEEN 1 AND 2048),
  source_bytes bigint NOT NULL CHECK (source_bytes > 0),
  kind text NOT NULL CHECK (kind IN ('image_variants', 'adaptive_video', 'moderation', 'vision', 'embedding', 'captions', 'subtitle_translation', 'dubbing')),
  model_version text NOT NULL CHECK (length(model_version) BETWEEN 1 AND 200 AND model_version ~ '^[A-Za-z0-9._:/@+\-]+$'),
  target_language text NOT NULL DEFAULT '' CHECK (target_language = '' OR target_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  revision_key text NOT NULL DEFAULT '' CHECK (revision_key = '' OR revision_key ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'retrying', 'cancelled')),
  priority smallint NOT NULL CHECK (priority BETWEEN 0 AND 100),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  processing_ms bigint NOT NULL DEFAULT 0 CHECK (processing_ms >= 0),
  input_bytes bigint NOT NULL DEFAULT 0 CHECK (input_bytes >= 0),
  output_bytes bigint NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, source_version, kind, model_version, target_language, revision_key),
  CHECK ((state = 'processing') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state = 'processing') OR (lease_token IS NULL AND lease_until IS NULL))
);

CREATE INDEX media_derivative_jobs_due ON public.media_derivative_jobs(kind, model_version, priority, available_at, created_at)
  WHERE state IN ('pending', 'retrying');
CREATE INDEX media_derivative_jobs_leases ON public.media_derivative_jobs(lease_until)
  WHERE state = 'processing';
CREATE INDEX media_derivative_jobs_owner_pending ON public.media_derivative_jobs(owner_user_id)
  WHERE state IN ('pending', 'processing', 'retrying');

ALTER TABLE public.media_derivative_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_derivative_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_derivative_jobs TO service_role;

CREATE TABLE public.media_derivative_job_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.media_derivative_jobs(id) ON DELETE CASCADE,
  state text NOT NULL,
  attempt smallint NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_derivative_job_events_job ON public.media_derivative_job_events(job_id, created_at);
ALTER TABLE public.media_derivative_job_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_derivative_job_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.media_derivative_job_events TO service_role;
GRANT USAGE ON SEQUENCE public.media_derivative_job_events_id_seq TO service_role;
CREATE FUNCTION public.media_derivative_audit_state()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state THEN
    INSERT INTO public.media_derivative_job_events(job_id, state, attempt, error_code) VALUES(NEW.id, NEW.state, NEW.attempts, NEW.error_code);
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER media_derivative_state_audit AFTER INSERT OR UPDATE OF state ON public.media_derivative_jobs
FOR EACH ROW EXECUTE FUNCTION public.media_derivative_audit_state();
REVOKE ALL ON FUNCTION public.media_derivative_audit_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_derivative_audit_state() TO service_role;

INSERT INTO public.feature_flags(flag, enabled, description)
VALUES ('media_derivative_jobs_enabled', false, 'Independent self-hosted derivative workers; requires reviewed schema, models, permissions and deployment.')
ON CONFLICT (flag) DO NOTHING;

CREATE FUNCTION public.media_derivative_schema_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $function$
  SELECT jsonb_build_object(
    'media_derivative_jobs', to_regclass('public.media_derivative_jobs') IS NOT NULL,
    'media_caption_manifests', to_regclass('public.media_caption_manifests') IS NOT NULL,
    'media_visual_embeddings', to_regclass('public.media_visual_embeddings') IS NOT NULL,
    'media_image_understanding_artifacts', to_regclass('public.media_image_understanding_artifacts') IS NOT NULL,
    'media_dubbing_artifacts', to_regclass('public.media_dubbing_artifacts') IS NOT NULL
  );
$function$;
REVOKE ALL ON FUNCTION public.media_derivative_schema_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_derivative_schema_status() TO service_role;

CREATE FUNCTION public.media_derivative_enqueue(
  p_asset_id uuid, p_owner_user_id uuid, p_source_version integer, p_kind text,
  p_model_version text, p_target_language text DEFAULT '', p_revision_key text DEFAULT ''
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE
  source_asset public.media_assets%ROWTYPE;
  existing_id uuid;
  job_priority smallint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_derivative_jobs_enabled' AND enabled IS TRUE) THEN RETURN NULL; END IF;
  SELECT * INTO source_asset FROM public.media_assets WHERE id = p_asset_id FOR SHARE;
  IF NOT FOUND OR source_asset.owner_user_id IS DISTINCT FROM p_owner_user_id
    OR source_asset.version IS DISTINCT FROM p_source_version
    OR source_asset.deleted_at IS NOT NULL OR source_asset.purge_status IN ('pending','failed','completed')
    OR source_asset.storage_bucket IS DISTINCT FROM 'post-media'
    OR COALESCE(source_asset.storage_path, '') = '' OR COALESCE(source_asset.size_bytes, 0) <= 0
    OR COALESCE(source_asset.processing_status, '') NOT IN ('ready','uploaded','processing')
    OR (CASE WHEN p_kind = 'moderation' THEN COALESCE(source_asset.moderation_status, '') NOT IN ('processing','pending','limited','active','approved')
            ELSE COALESCE(source_asset.moderation_status, '') NOT IN ('active','approved') END)
  THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_user_id::text, 3980));
  SELECT id INTO existing_id FROM public.media_derivative_jobs
    WHERE asset_id = p_asset_id AND source_version = p_source_version AND kind = p_kind
      AND model_version = p_model_version AND target_language = p_target_language AND revision_key = p_revision_key;
  IF FOUND THEN RETURN existing_id; END IF;
  IF (SELECT count(*) FROM public.media_derivative_jobs WHERE owner_user_id = p_owner_user_id AND state IN ('pending','processing','retrying')) >= 100 THEN
    RAISE EXCEPTION 'media_queue_capacity' USING ERRCODE = 'P0001';
  END IF;
  job_priority := CASE p_kind WHEN 'moderation' THEN 0 WHEN 'image_variants' THEN 10 WHEN 'adaptive_video' THEN 20
    WHEN 'captions' THEN 40 WHEN 'vision' THEN 50 WHEN 'embedding' THEN 60 WHEN 'subtitle_translation' THEN 70 ELSE 80 END;
  INSERT INTO public.media_derivative_jobs(asset_id, owner_user_id, source_version, source_bucket, source_path, source_bytes, kind, model_version, target_language, revision_key, priority)
    VALUES(p_asset_id, p_owner_user_id, p_source_version, source_asset.storage_bucket, source_asset.storage_path, source_asset.size_bytes, p_kind, p_model_version, p_target_language, p_revision_key, job_priority)
    RETURNING id INTO existing_id;
  RETURN existing_id;
END;
$function$;

CREATE FUNCTION public.media_derivative_claim(p_kind text, p_model_version text, p_limit integer DEFAULT 1, p_lease_seconds integer DEFAULT 120)
RETURNS SETOF public.media_derivative_jobs
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 8 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 900 THEN
    RAISE EXCEPTION 'invalid_worker_bounds' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_derivative_jobs_enabled' AND enabled IS TRUE) THEN RETURN; END IF;
  RETURN QUERY
  UPDATE public.media_derivative_jobs AS job SET state = 'processing', attempts = job.attempts + 1,
    lease_token = gen_random_uuid(), lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), started_at = clock_timestamp(), updated_at = clock_timestamp(), error_code = NULL
  WHERE job.id IN (
    SELECT candidate.id FROM public.media_derivative_jobs AS candidate
    JOIN public.media_assets AS source_asset ON source_asset.id = candidate.asset_id
    WHERE candidate.kind = p_kind AND candidate.model_version = p_model_version
      AND candidate.state IN ('pending','retrying') AND candidate.available_at <= clock_timestamp() AND candidate.attempts < 5
      AND source_asset.version = candidate.source_version AND source_asset.owner_user_id = candidate.owner_user_id
      AND source_asset.storage_bucket = candidate.source_bucket AND source_asset.storage_path = candidate.source_path AND source_asset.size_bytes = candidate.source_bytes
      AND source_asset.deleted_at IS NULL AND COALESCE(source_asset.purge_status, 'none') NOT IN ('pending','failed','completed')
      AND source_asset.storage_bucket = 'post-media' AND source_asset.processing_status IN ('ready','uploaded','processing')
      AND CASE WHEN candidate.kind = 'moderation' THEN source_asset.moderation_status IN ('processing','pending','limited','active','approved')
          ELSE source_asset.moderation_status IN ('active','approved') END
    ORDER BY candidate.priority, candidate.available_at, candidate.created_at
    LIMIT p_limit FOR UPDATE OF candidate SKIP LOCKED
  ) RETURNING job.*;
END;
$function$;

CREATE FUNCTION public.media_derivative_finish(
  p_job_id uuid, p_lease_token uuid, p_success boolean, p_retryable boolean DEFAULT false,
  p_error_code text DEFAULT NULL, p_processing_ms bigint DEFAULT 0, p_input_bytes bigint DEFAULT 0, p_output_bytes bigint DEFAULT 0, p_result jsonb DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE
  source_asset public.media_assets%ROWTYPE;
  job_row public.media_derivative_jobs%ROWTYPE;
  written_id uuid;
  decision_at timestamptz;
BEGIN
  SELECT source.* INTO source_asset FROM public.media_assets AS source
    JOIN public.media_derivative_jobs AS job ON job.asset_id = source.id WHERE job.id = p_job_id FOR SHARE OF source;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO job_row FROM public.media_derivative_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  decision_at := clock_timestamp();
  IF job_row.state <> 'processing' OR job_row.lease_token IS DISTINCT FROM p_lease_token OR job_row.lease_until <= decision_at THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_derivative_jobs_enabled' AND enabled IS TRUE)
    OR source_asset.version IS DISTINCT FROM job_row.source_version OR source_asset.owner_user_id IS DISTINCT FROM job_row.owner_user_id
    OR source_asset.deleted_at IS NOT NULL OR source_asset.purge_status IN ('pending','failed','completed')
    OR source_asset.storage_bucket IS DISTINCT FROM job_row.source_bucket OR source_asset.storage_path IS DISTINCT FROM job_row.source_path OR source_asset.size_bytes IS DISTINCT FROM job_row.source_bytes
    OR COALESCE(source_asset.processing_status, '') NOT IN ('ready','uploaded','processing')
    OR (CASE WHEN job_row.kind = 'moderation' THEN COALESCE(source_asset.moderation_status, '') NOT IN ('processing','pending','limited','active','approved')
            ELSE COALESCE(source_asset.moderation_status, '') NOT IN ('active','approved') END)
  THEN
    UPDATE public.media_derivative_jobs SET state = 'cancelled', lease_token = NULL, lease_until = NULL, error_code = 'source_revoked', updated_at = decision_at WHERE id = p_job_id;
    RETURN false;
  END IF;
  IF p_success IS NULL OR p_retryable IS NULL OR p_processing_ms IS NULL OR p_input_bytes IS NULL OR p_output_bytes IS NULL
    OR p_processing_ms < 0 OR p_input_bytes < 0 OR p_output_bytes < 0 THEN RAISE EXCEPTION 'invalid_job_metrics' USING ERRCODE = '22023'; END IF;
  UPDATE public.media_derivative_jobs SET
    state = CASE WHEN p_success THEN 'completed' WHEN p_retryable AND attempts < 5 THEN 'retrying' ELSE 'failed' END,
    lease_token = NULL, lease_until = NULL,
    available_at = decision_at + make_interval(secs => LEAST(900, 30 * power(2, GREATEST(0, attempts - 1))::integer)),
    completed_at = CASE WHEN p_success THEN decision_at ELSE NULL END,
    error_code = CASE WHEN p_success THEN NULL ELSE COALESCE(p_error_code, 'processing_failed') END,
    result = CASE WHEN p_success THEN p_result ELSE NULL END,
    processing_ms = processing_ms + p_processing_ms, input_bytes = input_bytes + p_input_bytes, output_bytes = output_bytes + p_output_bytes, updated_at = decision_at
    WHERE id = p_job_id RETURNING id INTO written_id;
  RETURN written_id IS NOT NULL;
END;
$function$;

CREATE FUNCTION public.media_derivative_recover(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE affected integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'invalid_recovery_bound' USING ERRCODE = '22023'; END IF;
  UPDATE public.media_derivative_jobs AS job SET
    state = CASE WHEN job.attempts >= 5 THEN 'failed' ELSE 'retrying' END,
    lease_token = NULL, lease_until = NULL, error_code = 'lease_expired', updated_at = clock_timestamp(),
    available_at = clock_timestamp() + make_interval(secs => LEAST(900, 30 * power(2, GREATEST(0, job.attempts - 1))::integer))
  WHERE job.id IN (
    SELECT candidate.id FROM public.media_derivative_jobs AS candidate
    WHERE candidate.state = 'processing' AND candidate.lease_until <= clock_timestamp()
    ORDER BY candidate.lease_until LIMIT p_limit FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$function$;

CREATE FUNCTION public.media_derivative_renew(p_job_id uuid, p_lease_token uuid, p_lease_seconds integer DEFAULT 120)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE
  source_asset public.media_assets%ROWTYPE;
  job_row public.media_derivative_jobs%ROWTYPE;
  decision_at timestamptz;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 900 THEN RAISE EXCEPTION 'invalid_lease_bound' USING ERRCODE = '22023'; END IF;
  SELECT source.* INTO source_asset FROM public.media_assets AS source
    JOIN public.media_derivative_jobs AS job ON job.asset_id = source.id WHERE job.id = p_job_id FOR SHARE OF source;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO job_row FROM public.media_derivative_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  decision_at := clock_timestamp();
  IF job_row.state <> 'processing' OR job_row.lease_token IS DISTINCT FROM p_lease_token OR job_row.lease_until <= decision_at THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_derivative_jobs_enabled' AND enabled IS TRUE) THEN RETURN false; END IF;
  IF source_asset.version IS DISTINCT FROM job_row.source_version OR source_asset.owner_user_id IS DISTINCT FROM job_row.owner_user_id
    OR source_asset.storage_bucket IS DISTINCT FROM job_row.source_bucket OR source_asset.storage_path IS DISTINCT FROM job_row.source_path OR source_asset.size_bytes IS DISTINCT FROM job_row.source_bytes
    OR source_asset.deleted_at IS NOT NULL OR source_asset.purge_status IN ('pending','failed','completed')
    OR COALESCE(source_asset.processing_status, '') NOT IN ('ready','uploaded','processing')
    OR (CASE WHEN job_row.kind = 'moderation' THEN COALESCE(source_asset.moderation_status, '') NOT IN ('processing','pending','limited','active','approved')
        ELSE COALESCE(source_asset.moderation_status, '') NOT IN ('active','approved') END)
  THEN RETURN false; END IF;
  UPDATE public.media_derivative_jobs SET lease_until = decision_at + make_interval(secs => p_lease_seconds), updated_at = decision_at WHERE id = p_job_id;
  RETURN true;
END;
$function$;

CREATE FUNCTION public.media_derivative_cancel_stale()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  UPDATE public.media_derivative_jobs SET state = 'cancelled', lease_token = NULL, lease_until = NULL,
    error_code = 'source_revoked', updated_at = now()
    WHERE asset_id = NEW.id AND state <> 'cancelled' AND (
      source_version IS DISTINCT FROM NEW.version OR owner_user_id IS DISTINCT FROM NEW.owner_user_id
      OR source_bucket IS DISTINCT FROM NEW.storage_bucket OR source_path IS DISTINCT FROM NEW.storage_path OR source_bytes IS DISTINCT FROM NEW.size_bytes
      OR NEW.deleted_at IS NOT NULL OR NEW.purge_status IN ('pending','failed','completed')
      OR COALESCE(NEW.processing_status, '') NOT IN ('ready','uploaded','processing')
      OR CASE WHEN kind = 'moderation' THEN COALESCE(NEW.moderation_status, '') NOT IN ('processing','pending','limited','active','approved') ELSE COALESCE(NEW.moderation_status, '') NOT IN ('active','approved') END
    );
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.media_derivative_ready(p_asset_id uuid, p_source_version integer, p_kind text, p_model_version text, p_target_language text DEFAULT '', p_revision_key text DEFAULT '')
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $function$
  SELECT job.result FROM public.media_derivative_jobs AS job JOIN public.media_assets AS source ON source.id = job.asset_id
  WHERE job.asset_id = p_asset_id AND job.source_version = p_source_version AND job.kind = p_kind AND job.model_version = p_model_version
    AND job.target_language = p_target_language AND job.revision_key = p_revision_key AND job.state = 'completed'
    AND source.version = job.source_version AND source.owner_user_id = job.owner_user_id
    AND source.storage_bucket = job.source_bucket AND source.storage_path = job.source_path AND source.size_bytes = job.source_bytes
    AND source.deleted_at IS NULL AND COALESCE(source.purge_status, 'not_requested') NOT IN ('pending','failed','completed')
    AND source.processing_status IN ('ready','uploaded','processing') AND source.moderation_status IN ('active','approved')
    AND EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'media_derivative_jobs_enabled' AND enabled IS TRUE);
$function$;

CREATE FUNCTION public.media_derivative_cancel_asset(p_asset_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE source_asset public.media_assets%ROWTYPE;
BEGIN
  SELECT * INTO source_asset FROM public.media_assets WHERE id = p_asset_id FOR SHARE;
  IF NOT FOUND THEN RETURN true; END IF;
  IF source_asset.deleted_at IS NULL AND COALESCE(source_asset.purge_status, 'not_requested') NOT IN ('pending','failed','completed') THEN RETURN false; END IF;
  UPDATE public.media_derivative_jobs SET state = 'cancelled', lease_token = NULL, lease_until = NULL, error_code = 'source_revoked', updated_at = now()
    WHERE asset_id = p_asset_id AND state <> 'cancelled';
  RETURN true;
END;
$function$;
CREATE TRIGGER media_derivative_source_invalidation AFTER UPDATE ON public.media_assets
FOR EACH ROW EXECUTE FUNCTION public.media_derivative_cancel_stale();

REVOKE ALL ON FUNCTION public.media_derivative_enqueue(uuid, uuid, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_derivative_claim(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_derivative_finish(uuid, uuid, boolean, boolean, text, bigint, bigint, bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_derivative_renew(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_derivative_recover(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_derivative_cancel_stale() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_derivative_ready(uuid, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.media_derivative_cancel_asset(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_derivative_enqueue(uuid, uuid, integer, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_derivative_claim(text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_derivative_finish(uuid, uuid, boolean, boolean, text, bigint, bigint, bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_derivative_renew(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_derivative_recover(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_derivative_cancel_stale() TO service_role;
GRANT EXECUTE ON FUNCTION public.media_derivative_ready(uuid, integer, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.media_derivative_cancel_asset(uuid) TO service_role;

DO $postcondition$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.media_derivative_jobs'::regclass AND relrowsecurity) THEN RAISE EXCEPTION 'media_derivative_jobs_rls_missing'; END IF;
  IF has_table_privilege('anon', 'public.media_derivative_jobs', 'SELECT') OR has_table_privilege('authenticated', 'public.media_derivative_jobs', 'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'media_derivative_jobs_client_grant'; END IF;
  IF NOT has_function_privilege('service_role', 'public.media_derivative_claim(text,text,integer,integer)', 'EXECUTE') THEN RAISE EXCEPTION 'media_derivative_jobs_worker_grant_missing'; END IF;
END;
$postcondition$;

COMMIT;
