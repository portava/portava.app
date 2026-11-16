-- H39: accepted episode candidates retain their suggested origin. Extend the
-- existing canonical kernel; no second Memory writer or speculative backfill.
BEGIN;
DO $upgrade$
DECLARE
  definition text := pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure);
  anchor text;
  addition text;
BEGIN
  IF position('4036 candidate origin' IN definition) > 0 THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='memories' AND column_name='source_mode') THEN
    RAISE EXCEPTION '4036 requires the canonical3674 source_mode column';
  END IF;
  anchor := '  v_select := v_payload->>''select'';';
  addition := $guard$
  -- 4036 candidate origin: service-authored provenance, never a client label.
  IF (v_type='CREATE_MEMORY' AND v_write ? 'source_mode')
     OR (v_type='UPDATE_MEMORY' AND v_patch ? 'source_mode') THEN
    IF (CASE WHEN v_type='CREATE_MEMORY' THEN v_write ELSE v_patch END)->>'source_mode'
         IS DISTINCT FROM 'SUGGESTED' OR v_payload->>'candidate_episode_id' IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','MEMORY_COMMAND_MALFORMED','contract_version',1);
    END IF;
    -- Serialize this candidate BEFORE receipt lookup; simultaneous Keeps must
    -- replay the winner rather than collide on the receipt's unique key.
    PERFORM 1 FROM public.memory_episodes e
      WHERE e.id=(v_payload->>'candidate_episode_id')::uuid
        AND e.user_id=v_actor AND e.state='confirmed' FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'reason','MEMORY_COMMAND_MALFORMED','contract_version',1);
    END IF;
    IF v_type='CREATE_MEMORY' AND v_key IS DISTINCT FROM 'memory-candidate:'||(v_payload->>'candidate_episode_id') THEN
      RETURN jsonb_build_object('ok',false,'reason','MEMORY_COMMAND_MALFORMED','contract_version',1);
    END IF;
    IF v_type='UPDATE_MEMORY' AND NOT (
      EXISTS (SELECT 1 FROM public.memory_evidence e
        WHERE e.user_id=v_actor AND e.episode_id=(v_payload->>'candidate_episode_id')::uuid
          AND e.source_table='memories' AND e.source_id=v_memory_id::text
          AND e.truth_level='asserted' AND e.source_ref->>'confirmed_by'='owner')
      OR EXISTS (SELECT 1 FROM public.memory_command_receipts r
        WHERE r.actor_user_id=v_actor AND r.memory_id=v_memory_id AND r.command_type='CREATE_MEMORY'
          AND r.idempotency_key='memory-candidate:'||(v_payload->>'candidate_episode_id'))
    ) THEN
      RETURN jsonb_build_object('ok',false,'reason','MEMORY_COMMAND_MALFORMED','contract_version',1);
    END IF;
  END IF;
$guard$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION '4036 kernel envelope anchor changed: review before applying';
  END IF;
  definition := replace(definition,anchor,anchor||E'\n'||addition);
  anchor := '      IF v_write ? ''memory_type'' THEN';
  addition := $create$
      IF v_write ? 'source_mode' THEN
        UPDATE public.memories SET source_mode=v_write->>'source_mode' WHERE id=v_row.id
          RETURNING * INTO v_row;
      END IF;
$create$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION '4036 kernel create anchor changed: review before applying';
  END IF;
  definition := replace(definition,anchor,addition||E'\n'||anchor);
  anchor := '        memory_type           = CASE WHEN v_patch ? ''memory_type''';
  addition := '        source_mode           = CASE WHEN v_patch ? ''source_mode'' AND source_mode=''USER_CREATED'' THEN v_patch->>''source_mode'' ELSE source_mode END,';
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION '4036 kernel update anchor changed: review before applying';
  END IF;
  EXECUTE replace(definition,anchor,addition||E'\n'||anchor);
END;$upgrade$;

-- The API checks this before claiming a candidate, so an old deployment cannot
-- silently discard the origin. This reads the current kernel, not a saved flag.
CREATE OR REPLACE FUNCTION public.memory_candidate_origin_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public
AS $fn$
  SELECT position('4036 candidate origin' IN pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure))>0;
$fn$;
REVOKE ALL ON FUNCTION public.memory_candidate_origin_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.memory_candidate_origin_ready() TO service_role;

-- Reconcile only explicit, owner-confirmed candidate links that still carry
-- the wrong new-row default. Preserve imported and unrelated histories. Every
-- correction uses the existing kernel, event, outbox and stable receipt key.
DO $reconcile$
DECLARE item record; result jsonb;
BEGIN
  FOR item IN
    SELECT DISTINCT ON (m.id) m.id, m.owner_id, e.episode_id
      FROM public.memories m
      JOIN public.memory_evidence e ON e.source_table='memories' AND e.source_id=m.id::text
        AND e.user_id=m.owner_id AND e.truth_level='asserted' AND e.source_ref->>'confirmed_by'='owner'
      JOIN public.memory_episodes ep ON ep.id=e.episode_id AND ep.user_id=m.owner_id AND ep.state='confirmed'
      WHERE m.source_mode='USER_CREATED' AND m.state IN ('draft','published','archived')
      ORDER BY m.id,e.episode_id
  LOOP
    result := public.memory_kernel_execute(jsonb_build_object(
      'command_id',pg_catalog.gen_random_uuid(),'type','UPDATE_MEMORY',
      'memory_id',item.id,'actor_user_id',item.owner_id,
      'idempotency_key','memory-candidate-origin:'||item.episode_id::text,
      'payload',jsonb_build_object('candidate_episode_id',item.episode_id,
        'patch',jsonb_build_object('source_mode','SUGGESTED'))));
    IF result->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS (
      SELECT 1 FROM public.memories WHERE id=item.id AND source_mode='SUGGESTED'
    ) THEN RAISE EXCEPTION '4036 explicit candidate origin reconciliation refused'; END IF;
  END LOOP;
END;$reconcile$;
DO $post$
BEGIN
  IF NOT public.memory_candidate_origin_ready()
     OR (SELECT prosecdef FROM pg_proc WHERE oid='public.memory_kernel_execute(jsonb)'::regprocedure)
     OR has_function_privilege('authenticated','public.memory_candidate_origin_ready()','EXECUTE')
     OR has_function_privilege('anon','public.memory_candidate_origin_ready()','EXECUTE') THEN
    RAISE EXCEPTION '4036 origin contract or invoker boundary missing';
  END IF;
END;$post$;
COMMIT;
