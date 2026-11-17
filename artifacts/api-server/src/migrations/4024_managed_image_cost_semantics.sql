-- Managed hosting cost is unknown until billing evidence; never report it as free.
CREATE OR REPLACE FUNCTION public.media_image_understanding_publish(p_job_id uuid, p_lease_token uuid, p_result jsonb)
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
    OR p_result->'metrics'->'estimatedExternalCostUsd' IS DISTINCT FROM
      (CASE WHEN p_result->>'consentVersion' LIKE 'hf-siglip-v1-%' THEN 'null'::jsonb ELSE '0'::jsonb END)
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
