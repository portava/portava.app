-- Empty scaffold created with Supabase CLI; canonical SQL authored locally.
-- Atomic bounded dwell admission using existing canonical rank_events only.
-- No collection activation, retention extension, new table or client grant.
BEGIN;

CREATE OR REPLACE FUNCTION public.admit_discovery_dwell(
  p_user_id uuid, p_exposure_id uuid, p_recommendation_id text,
  p_item_id text, p_measurements jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
 exposure public.rank_events%ROWTYPE;
 measurement jsonb;
 receipt public.rank_events%ROWTYPE;
 expected integer;
 landed integer;
BEGIN
 IF p_user_id IS NULL OR p_exposure_id IS NULL
    OR p_recommendation_id IS NULL OR p_recommendation_id !~ '^[A-Za-z0-9_-]{22}$'
    OR p_item_id IS NULL OR length(p_item_id) NOT BETWEEN 1 AND 200
    OR jsonb_typeof(p_measurements) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'dwell_invalid_payload';
 END IF;
 expected := jsonb_array_length(p_measurements);
 IF expected NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'dwell_invalid_payload'; END IF;
 FOR measurement IN SELECT value FROM jsonb_array_elements(p_measurements) LOOP
  IF jsonb_typeof(measurement) IS DISTINCT FROM 'object'
     OR (measurement - ARRAY['kind','ms','token']) <> '{}'::jsonb
     OR jsonb_typeof(measurement->'kind') IS DISTINCT FROM 'string'
     OR (measurement->>'kind' IN ('active','passive_foreground','idle')) IS DISTINCT FROM true
     OR jsonb_typeof(measurement->'ms') IS DISTINCT FROM 'number'
     OR (measurement->>'ms' ~ '^[1-9][0-9]{0,9}$') IS DISTINCT FROM true
     OR jsonb_typeof(measurement->'token') IS DISTINCT FROM 'string'
     OR (measurement->>'token' ~ '^[A-Za-z0-9_-]{22}$') IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'dwell_invalid_payload';
  END IF;
  IF (measurement->>'ms')::numeric > 2147483647 THEN RAISE EXCEPTION 'dwell_invalid_payload'; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value->>'kind') FROM jsonb_array_elements(p_measurements)) <> expected
    OR (SELECT count(DISTINCT value->>'token') FROM jsonb_array_elements(p_measurements)) <> expected THEN
  RAISE EXCEPTION 'dwell_invalid_payload';
 END IF;

 -- A disable and admission serialize. The existing flag is the collection
 -- boundary; this function does not enable it or invent a new consent policy.
 PERFORM 1 FROM public.feature_flags WHERE flag='discovery_dwell_telemetry_enabled' AND enabled FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','disabled'); END IF;
 PERFORM 1 FROM public.profiles WHERE id=p_user_id AND account_status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','account_unavailable'); END IF;
 SELECT * INTO exposure FROM public.rank_events
  WHERE id=p_exposure_id AND user_id=p_user_id AND item_id=p_item_id
   AND surface='discovery' AND event_type IS NULL AND outcome<>'analytics'
   AND (recommendation_id=p_recommendation_id OR features->>'recommendationId'=p_recommendation_id)
  FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;

 -- Sort arbiters consistently for concurrent multi-kind batches. DO NOTHING
 -- waits for a competing unique-key writer; the following statement verifies
 -- its committed value. Any mismatch raises and rolls back this whole call,
 -- including new kinds which did not conflict themselves.
 INSERT INTO public.rank_events(
  event_type,item_id,item_kind,position,surface,user_id,session_id,served_at,
  outcome,outcome_at,recommendation_id,dwell_ms,dwell_kind,schema_version,privacy_class,features
 ) SELECT 'place_dwell',exposure.item_id,exposure.item_kind,exposure.position,
   'discovery',p_user_id,exposure.session_id,exposure.served_at,'analytics',now(),
   value->>'token',(value->>'ms')::integer,value->>'kind',1,'raw_behavioral_event',
   jsonb_build_object('recommendationId',p_recommendation_id)
  FROM jsonb_array_elements(p_measurements)
  ORDER BY value->>'token'
 ON CONFLICT (recommendation_id,outcome) DO NOTHING;
 GET DIAGNOSTICS landed = ROW_COUNT;

 FOR measurement IN SELECT value FROM jsonb_array_elements(p_measurements) ORDER BY value->>'token' LOOP
  SELECT * INTO receipt FROM public.rank_events
   WHERE recommendation_id=measurement->>'token' AND outcome='analytics' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dwell_receipt_unverified'; END IF;
  IF receipt.user_id IS DISTINCT FROM p_user_id OR receipt.item_id IS DISTINCT FROM exposure.item_id
     OR receipt.surface IS DISTINCT FROM 'discovery' OR receipt.event_type IS DISTINCT FROM 'place_dwell'
     OR receipt.item_kind IS DISTINCT FROM exposure.item_kind
     OR receipt.position IS DISTINCT FROM exposure.position
     OR receipt.served_at IS DISTINCT FROM exposure.served_at
     OR receipt.schema_version IS DISTINCT FROM 1 OR receipt.privacy_class IS DISTINCT FROM 'raw_behavioral_event'
     OR receipt.session_id IS DISTINCT FROM exposure.session_id
     OR receipt.dwell_kind IS DISTINCT FROM measurement->>'kind'
     OR receipt.dwell_ms IS DISTINCT FROM (measurement->>'ms')::integer
     OR receipt.features IS DISTINCT FROM jsonb_build_object('recommendationId',p_recommendation_id) THEN
   RAISE EXCEPTION 'dwell_receipt_conflict';
  END IF;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'recorded',landed,'duplicates',expected-landed);
END
$fn$;
REVOKE ALL ON FUNCTION public.admit_discovery_dwell(uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admit_discovery_dwell(uuid,uuid,text,text,jsonb) TO service_role;
COMMENT ON FUNCTION public.admit_discovery_dwell(uuid,uuid,text,text,jsonb) IS
 'Service-only bounded dwell admission. Current collection flag, active owner and canonical served exposure are checked and locked. Existing unique tokens arbitrate retries; every exact committed payload is verified before receipt. A conflicting or silently refused mixed batch raises, rolling back every new kind. No policy activation.';
DO $post$
BEGIN
 IF has_function_privilege('anon','public.admit_discovery_dwell(uuid,uuid,text,text,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.admit_discovery_dwell(uuid,uuid,text,text,jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.admit_discovery_dwell(uuid,uuid,text,text,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION '4033 dwell admission must remain service-only';
 END IF;
END
$post$;
COMMIT;
