-- H178: field bases at the existing Memory command writer. No new store.
-- Generated with Supabase CLI, moved to this repository's numbered chain.
-- Apply before coordinated API/client cutover. Old clients must reopen/update;
-- missing bases never fall back to blind writes. Other command flags unchanged.
BEGIN;
DO $patch$
DECLARE definition text; anchor text; replacement text;
  old_kernel_fingerprint text; old_source_fingerprint text; probe text;
BEGIN
  PERFORM set_config('search_path','pg_catalog,pg_temp',true);
  IF NOT public.memory_item_source_ready() OR NOT public.postcard_canonical_lifecycle_ready() THEN
    RAISE EXCEPTION '4042 requires intact 4041 source/retention contracts';
  END IF;
  definition := pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure);
  old_kernel_fingerprint := md5(definition);
  old_source_fingerprint := md5(pg_get_functiondef('public.memory_item_source_ready()'::regprocedure));
  IF position('insert_memory_media_item' IN definition)=0
     OR position('THEN v_patch->>''memory_type''' IN definition)=0
     OR position('THEN v_patch->>''place_display_name_at_occurrence''' IN definition)=0
     OR position('MEMORY_FIELD_CONFLICT' IN definition)>0 THEN
    RAISE EXCEPTION '4042 requires the 4041 Memory kernel, applied once';
  END IF;
  anchor := '  v_item       public.memory_items%ROWTYPE;';
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION '4042 declarations changed'; END IF;
  definition := replace(definition,anchor,$body$
  v_edit_before public.memories%ROWTYPE;
  v_edit_base public.memories%ROWTYPE;
  v_edit_after public.memories%ROWTYPE;
  v_expected jsonb;
  v_required text[];
  v_field text;
  v_edit boolean := false;
  v_edit_fields constant text[] := ARRAY['title','caption','visibility','allowed_user_ids','hidden_user_ids',
    'place_id','canonical_location_id','location_city','location_country','location_lat','location_lng',
    'location_precision','memory_type','place_display_name_at_occurrence','starts_at','ends_at','state'];
  v_item public.memory_items%ROWTYPE;
$body$);
  -- Serialize equal operation IDs even when the receipt does not exist yet.
  anchor := '  SELECT * INTO v_receipt FROM public.memory_command_receipts';
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION '4042 receipt anchor changed'; END IF;
  definition := replace(definition,anchor,$body$
  PERFORM pg_advisory_xact_lock(hashtextextended('memory-command:'||v_actor::text||':'||v_key,0));
  SELECT * INTO v_receipt FROM public.memory_command_receipts$body$);
  definition := replace(definition,'IF v_receipt.command_type IS DISTINCT FROM v_type THEN',
    'IF v_receipt.command_type IS DISTINCT FROM v_type OR (v_type <> ''CREATE_MEMORY'' AND v_receipt.memory_id IS DISTINCT FROM v_memory_id) THEN');
  anchor := '    -- ── §5 lifecycle ─────────────────────────────────────────────────────────';
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION '4042 edit guard anchor changed'; END IF;
  replacement := $body$
    -- H178: owner checked and row already locked. Replay precedes this check.
    v_edit := v_type IN ('UPDATE_MEMORY','CHANGE_PLACE','CHANGE_VISIBILITY')
      OR (v_type IN ('CONFIRM_MEMORY','ARCHIVE_MEMORY') AND v_payload ? 'patch');
    IF v_edit THEN
      v_expected := v_payload->'expected';
      IF jsonb_typeof(v_patch) IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_expected) IS DISTINCT FROM 'object' THEN
        INSERT INTO public.memory_command_audit(command_id,command_type,memory_id,actor_user_id,idempotency_key,outcome,reason)
          VALUES(v_cmd_id,v_type,v_memory_id,v_actor,v_key,'rejected','MEMORY_EDIT_BASE_REQUIRED');
        RETURN jsonb_build_object('ok',false,'reason','MEMORY_EDIT_BASE_REQUIRED','contract_version',1);
      END IF;
      IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_patch) k WHERE k <> 'updated_at' AND NOT k=ANY(v_edit_fields))
         OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_expected) k WHERE NOT k=ANY(v_edit_fields)) THEN
        INSERT INTO public.memory_command_audit(command_id,command_type,memory_id,actor_user_id,idempotency_key,outcome,reason)
          VALUES(v_cmd_id,v_type,v_memory_id,v_actor,v_key,'rejected','MEMORY_COMMAND_MALFORMED');
        RETURN jsonb_build_object('ok',false,'reason','MEMORY_COMMAND_MALFORMED','contract_version',1);
      END IF;
      SELECT array_agg(k) INTO v_required FROM jsonb_object_keys(v_patch) k WHERE k <> 'updated_at';
      v_required := coalesce(v_required,'{}'::text[]) || ARRAY['state'];
      -- Dependency groups protect semantic combinations without conflicting on
      -- unrelated facts. A title edit need not pin a concurrent caption edit.
      IF v_patch ?| ARRAY['visibility','allowed_user_ids','hidden_user_ids'] THEN
        v_required := v_required || ARRAY['visibility','allowed_user_ids','hidden_user_ids'];
      END IF;
      IF v_patch ?| ARRAY['place_id','canonical_location_id','location_city','location_country','location_lat','location_lng','place_display_name_at_occurrence'] THEN
        v_required := v_required || ARRAY['place_id','canonical_location_id','location_city','location_country','location_lat','location_lng'];
      END IF;
      IF v_patch ?| ARRAY['starts_at','ends_at'] THEN v_required := v_required || ARRAY['starts_at','ends_at']; END IF;
      IF NOT v_expected ?& v_required THEN
        INSERT INTO public.memory_command_audit(command_id,command_type,memory_id,actor_user_id,idempotency_key,outcome,reason)
          VALUES(v_cmd_id,v_type,v_memory_id,v_actor,v_key,'rejected','MEMORY_EDIT_BASE_REQUIRED');
        RETURN jsonb_build_object('ok',false,'reason','MEMORY_EDIT_BASE_REQUIRED','contract_version',1);
      END IF;
      SELECT * INTO v_edit_before FROM public.memories WHERE id=v_memory_id;
      -- Column types normalize equivalent offsets, UUIDs and exact fractional
      -- timestamps. Never round an owner's timestamp through JavaScript Date.
      SELECT * INTO v_edit_base FROM jsonb_populate_record(NULL::public.memories,v_expected);
      FOREACH v_field IN ARRAY v_required LOOP
        IF to_jsonb(v_edit_before)->v_field IS DISTINCT FROM to_jsonb(v_edit_base)->v_field THEN
          INSERT INTO public.memory_command_audit(command_id,command_type,memory_id,actor_user_id,idempotency_key,outcome,reason)
            VALUES(v_cmd_id,v_type,v_memory_id,v_actor,v_key,'rejected','MEMORY_FIELD_CONFLICT');
          RETURN jsonb_build_object('ok',false,'reason','MEMORY_FIELD_CONFLICT','contract_version',1);
        END IF;
      END LOOP;
      SELECT * INTO v_edit_after FROM jsonb_populate_record(v_edit_before,v_patch);
      IF v_patch ?| ARRAY['starts_at','ends_at'] AND v_edit_after.starts_at IS NOT NULL AND v_edit_after.ends_at IS NOT NULL
         AND v_edit_after.ends_at < v_edit_after.starts_at THEN
        INSERT INTO public.memory_command_audit(command_id,command_type,memory_id,actor_user_id,idempotency_key,outcome,reason)
          VALUES(v_cmd_id,v_type,v_memory_id,v_actor,v_key,'rejected','MEMORY_COMMAND_MALFORMED');
        RETURN jsonb_build_object('ok',false,'reason','MEMORY_COMMAND_MALFORMED','contract_version',1);
      END IF;
    END IF;
$body$;
  definition := replace(definition,anchor,replacement||E'\n'||anchor);
  anchor := '  -- ══ APPLY. Every branch has validated fully; the first write happens here. ══';
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION '4042 correction anchor changed'; END IF;
  replacement := $body$
  -- The correction and canonical fields share the event/receipt transaction.
  -- A failed guard writes none; any later failure rolls the entire edit back.
  IF v_edit AND (v_edit_before.place_id,v_edit_before.canonical_location_id)
      IS DISTINCT FROM (v_edit_after.place_id,v_edit_after.canonical_location_id) THEN
    INSERT INTO public.memory_corrections(memory_id,owner_id,field,kind,place_id,canonical_location_id,source)
      SELECT v_memory_id,v_actor,'place',r.kind,r.place_id,r.canonical_location_id,'memory_edit'
      FROM (VALUES
        ('reject',v_edit_before.place_id,NULL::uuid),
        ('reject',NULL::text,v_edit_before.canonical_location_id),
        ('assert',v_edit_after.place_id,v_edit_after.canonical_location_id)
      ) r(kind,place_id,canonical_location_id)
      WHERE r.kind='assert'
        OR (r.place_id IS NOT NULL AND r.place_id IS DISTINCT FROM v_edit_after.place_id)
        OR (r.canonical_location_id IS NOT NULL AND r.canonical_location_id IS DISTINCT FROM v_edit_after.canonical_location_id);
  END IF;
$body$;
  definition := replace(definition,anchor,replacement||E'\n'||anchor);
  EXECUTE definition;
  -- 4041 pins exact definitions. Carry only these reviewed changes forward;
  -- all other source, retention, FK and trigger fingerprints stay intact.
  probe := pg_get_functiondef('public.memory_item_source_ready()'::regprocedure);
  IF position(old_kernel_fingerprint IN probe)=0 THEN RAISE EXCEPTION '4042 source fingerprint anchor changed'; END IF;
  EXECUTE replace(probe,old_kernel_fingerprint,md5(pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure)));
  probe := pg_get_functiondef('public.postcard_canonical_lifecycle_ready()'::regprocedure);
  IF position(old_source_fingerprint IN probe)=0 THEN RAISE EXCEPTION '4042 retention fingerprint anchor changed'; END IF;
  EXECUTE replace(probe,old_source_fingerprint,md5(pg_get_functiondef('public.memory_item_source_ready()'::regprocedure)));
  IF NOT public.memory_item_source_ready() OR NOT public.postcard_canonical_lifecycle_ready() THEN
    RAISE EXCEPTION '4042 did not preserve source/retention readiness';
  END IF;
END;$patch$;

CREATE FUNCTION public.memory_field_edits_ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
  SELECT position('MEMORY_FIELD_CONFLICT' IN pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure))>0
    AND position('INSERT INTO public.memory_corrections' IN pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure))>0
    AND public.memory_item_source_ready();
$fn$;
REVOKE ALL ON FUNCTION public.memory_field_edits_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.memory_field_edits_ready() TO service_role;
DO $verify$ BEGIN
  IF NOT public.memory_field_edits_ready()
    OR has_function_privilege('authenticated','public.memory_kernel_execute(jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.memory_field_edits_ready()','EXECUTE') THEN
    RAISE EXCEPTION '4042 Memory edit contract or grants invalid';
  END IF;
END;$verify$;
COMMIT;
