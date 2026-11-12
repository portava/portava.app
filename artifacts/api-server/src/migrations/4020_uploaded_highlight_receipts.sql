BEGIN;
ALTER TABLE public.highlights ADD COLUMN IF NOT EXISTS media_thumbnail_url text;
-- A camera-upload receipt uses the same per-owner operations ledger as a shared post.
-- Keep the original kernel's lifecycle events when it is enabled, including on retries.
CREATE FUNCTION public.submit_uploaded_highlight(p_command jsonb,p_with_events boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE
  actor uuid := (p_command->>'actor_user_id')::uuid;
  operation uuid := (p_command->>'idempotency_key')::uuid;
  payload jsonb := p_command->'payload';
  previous public.post_destination_operations%ROWTYPE;
  fingerprint text;
  receipt jsonb;
  highlight uuid;
  audience public.highlights.visibility%TYPE := payload->>'visibility';
  life text := payload->>'lifetime_class';
  hours int := (payload->>'expires_in_hours')::int;
  thumb text := payload->>'verified_thumbnail_url';
BEGIN
  IF p_with_events IS NULL OR actor IS NULL OR operation IS NULL OR p_command->>'type' IS DISTINCT FROM 'CREATE_HIGHLIGHT'
     OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR coalesce(payload->>'media_url','')='' OR coalesce(payload->>'media_type','')=''
     OR audience IS NULL OR audience NOT IN ('public','private','travelers_nearby','circle_only','trip_only')
     OR (life IS NOT NULL AND life NOT IN ('LIVE','DAY','TRIP','SEASONAL','PERMANENT'))
     OR (life='PERMANENT' AND hours IS NOT NULL) OR (life IS DISTINCT FROM 'PERMANENT' AND (hours IS NULL OR hours NOT IN (3,6,12,24,48))) THEN
    RETURN jsonb_build_object('ok',false,'reason','MEMORY_COMMAND_MALFORMED');
  END IF;
  -- Poster discovery is best effort. If the object becomes available during a
  -- retry that does not change the user's publication intent.
  fingerprint := encode(sha256(convert_to(jsonb_build_object('operation','upload_highlight','payload',payload-'verified_thumbnail_url')::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('post-destination:'||actor::text||':'||operation::text,0));
  SELECT * INTO previous FROM public.post_destination_operations WHERE owner_id=actor AND operation_id=operation;
  IF FOUND THEN
    IF previous.intent_hash<>fingerprint THEN RETURN jsonb_build_object('ok',false,'reason','MEMORY_IDEMPOTENCY_KEY_REUSED'); END IF;
    highlight=(previous.result_json#>>'{result,id}')::uuid;
    IF NOT EXISTS(SELECT 1 FROM public.highlights WHERE id=highlight AND owner_id=actor AND deleted_at IS NULL) THEN
      RETURN jsonb_build_object('ok',false,'reason','HIGHLIGHT_NOT_FOUND');
    END IF;
    RETURN previous.result_json||jsonb_build_object('duplicate',true);
  END IF;
  IF p_with_events THEN
    receipt=public.highlight_create_execute(p_command);
    IF receipt->>'ok' IS DISTINCT FROM 'true' THEN RETURN receipt; END IF;
    highlight=(receipt#>>'{result,id}')::uuid;
  ELSE
    -- A kernel receipt from an older app can predate this wrapper.
    SELECT highlight_id INTO highlight FROM public.memory_command_receipts
      WHERE actor_user_id=actor AND idempotency_key=operation::text AND command_type='CREATE_HIGHLIGHT';
    IF highlight IS NULL THEN
      INSERT INTO public.highlights(owner_id,media_url,media_type,video_duration_seconds,caption,location_name,location_city,
        location_country,visibility,expires_at,lifetime_class,filter_id,filter_intensity)
      VALUES (actor,payload->>'media_url',payload->>'media_type',(payload->>'video_duration_seconds')::double precision,
        payload->>'caption',payload->>'location_name',payload->>'location_city',payload->>'location_country',audience,
        CASE WHEN life='PERMANENT' THEN NULL ELSE now()+make_interval(hours=>hours) END,life,
        coalesce(payload->>'filter_id','original'),coalesce((payload->>'filter_intensity')::int,100))
      RETURNING id INTO highlight;
    END IF;
    receipt=jsonb_build_object('ok',true,'result',jsonb_build_object('id',highlight),'highlight_id',highlight,'contract_version',1);
  END IF;
  IF highlight IS NULL OR NOT EXISTS (SELECT 1 FROM public.highlights WHERE id=highlight AND owner_id=actor AND deleted_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','HIGHLIGHT_NOT_FOUND');
  END IF;
  IF thumb IS NOT NULL THEN UPDATE public.highlights SET media_thumbnail_url=thumb WHERE id=highlight AND owner_id=actor; END IF;
  INSERT INTO public.post_destination_operations(owner_id,operation_id,intent_hash,result_json) VALUES(actor,operation,fingerprint,receipt);
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.submit_uploaded_highlight(jsonb,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.submit_uploaded_highlight(jsonb,boolean) TO service_role;
COMMIT;
