BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.memory_graph_mirror_memory(uuid)') IS NULL
     OR to_regclass('public.memory_corrections') IS NULL
     OR to_regclass('public.memory_command_receipts') IS NULL
     OR to_regclass('public.memory_command_audit') IS NULL
     OR to_regclass('public.memory_domain_events') IS NULL
     OR to_regclass('public.memory_event_outbox') IS NULL THEN
    RAISE EXCEPTION '3992 requires the Memory command/event infrastructure, corrections migration 3673 and graph migration 3674';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.memory_graph_mirror_memory(p_memory_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  memory_row record;
  place_ref text;
  desired text[];
  deleted_count integer := 0;
  inserted_count integer := 0;
BEGIN
  SELECT id, owner_id, state, trip_id, event_id, place_id, canonical_location_id
    INTO memory_row FROM public.memories WHERE id = p_memory_id FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND OR memory_row.state IN ('deleted', 'removed') THEN
    DELETE FROM public.memory_relations
      WHERE source_type = 'MEMORY' AND source_id = p_memory_id AND source_mode = 'LEGACY_IMPORTED';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.memory_corrections
    WHERE memory_id = memory_row.id AND field = 'place') THEN
    place_ref := nullif(coalesce(memory_row.canonical_location_id::text, nullif(memory_row.place_id, '')), '');
  END IF;
  desired := ARRAY[]::text[];
  IF memory_row.trip_id IS NOT NULL THEN desired := desired || ('TRIP|' || memory_row.trip_id::text); END IF;
  IF memory_row.event_id IS NOT NULL THEN desired := desired || ('EVENT|' || memory_row.event_id::text); END IF;
  IF place_ref IS NOT NULL THEN desired := desired || ('PLACE|' || place_ref); END IF;
  desired := desired || coalesce(
    (SELECT array_agg('PERSON|' || tagged.tagged_user_id::text ORDER BY tagged.tagged_user_id)
      FROM public.memory_tags tagged WHERE tagged.memory_id = memory_row.id AND tagged.status = 'approved'),
    ARRAY[]::text[]);

  DELETE FROM public.memory_relations relation
    WHERE relation.source_type = 'MEMORY' AND relation.source_id = memory_row.id AND relation.source_mode = 'LEGACY_IMPORTED'
      AND (relation.relation_type <> 'RELATED' OR NOT ((relation.target_type || '|' || relation.target_id) = ANY (desired)));
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  INSERT INTO public.memory_relations
    (owner_id, source_type, source_id, target_type, target_id, relation_type, confidence,
      source_mode, detector_version, reason_code)
  SELECT memory_row.owner_id, 'MEMORY', memory_row.id, edge.target_type, edge.target_id, 'RELATED',
    0.500, 'LEGACY_IMPORTED', 'legacy-mirror@1',
    CASE edge.target_type WHEN 'TRIP' THEN 'LEGACY_TRIP_ID' WHEN 'EVENT' THEN 'LEGACY_EVENT_ID'
      WHEN 'PLACE' THEN 'LEGACY_PLACE' ELSE 'LEGACY_APPROVED_TAG' END
    FROM (SELECT split_part(entry, '|', 1) AS target_type, substr(entry, strpos(entry, '|') + 1) AS target_id
      FROM unnest(desired) AS entry) edge
    ON CONFLICT ON CONSTRAINT memory_relations_unique_edge DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN deleted_count + inserted_count;
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_graph_mirror_memory(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_graph_mirror_memory(uuid) TO service_role;

CREATE FUNCTION public.memory_graph_revoke_corrected_place()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  DELETE FROM public.memory_relations
    WHERE source_type = 'MEMORY' AND source_id = NEW.memory_id
      AND target_type = 'PLACE' AND source_mode = 'LEGACY_IMPORTED';
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_graph_revoke_corrected_place() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER memory_graph_revoke_corrected_place
  AFTER INSERT ON public.memory_corrections
  FOR EACH ROW WHEN (NEW.field = 'place') EXECUTE FUNCTION public.memory_graph_revoke_corrected_place();

CREATE TABLE public.memory_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_key uuid NOT NULL,
  request_hash text NOT NULL,
  source text NOT NULL DEFAULT 'existing_legacy_memories' CHECK (source = 'existing_legacy_memories'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'aborted')),
  total integer NOT NULL CHECK (total BETWEEN 1 AND 200),
  checkpoint integer NOT NULL DEFAULT 0 CHECK (checkpoint >= 0 AND checkpoint <= total),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code = 'MEMORY_IMPORT_STEP_FAILED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, request_key),
  FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE
);

CREATE TABLE public.memory_import_batch_items (
  batch_id uuid NOT NULL REFERENCES public.memory_import_batches(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 200),
  memory_id uuid REFERENCES public.memories(id) ON DELETE SET NULL,
  command_id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'revoked')),
  PRIMARY KEY (batch_id, ordinal),
  UNIQUE (batch_id, memory_id),
  CHECK ((memory_id IS NULL) = (status = 'revoked'))
);
CREATE INDEX memory_import_batch_items_memory_idx ON public.memory_import_batch_items(memory_id)
  WHERE memory_id IS NOT NULL;
ALTER TABLE public.memory_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_import_batch_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_import_batches, public.memory_import_batch_items FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.memory_import_batches_revoke_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.state IN ('deleted', 'removed') OR NEW.source_mode <> 'LEGACY_IMPORTED' THEN
    UPDATE public.memory_import_batch_items SET memory_id = NULL, status = 'revoked'
      WHERE memory_id = OLD.id;
    DELETE FROM public.memory_relations WHERE source_type = 'MEMORY' AND source_id = OLD.id
      AND source_mode = 'LEGACY_IMPORTED';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER memory_import_batches_revoke
  BEFORE DELETE OR UPDATE OF owner_id, state, source_mode ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.memory_import_batches_revoke_source();

CREATE FUNCTION public.memory_import_batches_contract()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog, pg_temp
AS $fn$
  SELECT CASE WHEN
    to_regprocedure('public.memory_graph_mirror_memory(uuid)') IS NOT NULL
    AND to_regclass('public.memory_corrections') IS NOT NULL
    AND to_regclass('public.memory_import_batches') IS NOT NULL
    AND to_regclass('public.memory_import_batch_items') IS NOT NULL
    AND to_regclass('public.memory_command_receipts') IS NOT NULL
    AND to_regclass('public.memory_command_audit') IS NOT NULL
    AND to_regclass('public.memory_domain_events') IS NOT NULL
    AND to_regclass('public.memory_event_outbox') IS NOT NULL
    AND (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O', 'A')
      AND ((tgrelid = 'public.memories'::regclass AND tgname IN
        ('memory_graph_mirror_memories', 'memory_graph_erase_memories', 'memory_import_batches_revoke'))
        OR (tgrelid = 'public.memory_tags'::regclass AND tgname = 'memory_graph_mirror_tags'))) = 4
    AND (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O', 'A')
      AND tgrelid = to_regclass('public.memory_corrections')
      AND ((tgname = 'memory_corrections_erasure_only' AND (tgtype & 7) = 7
        AND tgfoid = to_regprocedure('public.memory_corrections_guard()'))
        OR (tgname = 'memory_corrections_no_update' AND (tgtype & 19) = 19
          AND tgfoid = to_regprocedure('public.intel_append_only()'))
        OR (tgname = 'memory_graph_revoke_corrected_place' AND tgtype = 5
          AND tgfoid = to_regprocedure('public.memory_graph_revoke_corrected_place()')))) = 3
    THEN 1 ELSE 0 END;
$fn$;

CREATE FUNCTION public.memory_import_batches_enabled()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE enabled_count integer;
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag IN ('memory_import_batches_enabled', 'memory_kernel_enabled')
    ORDER BY flag FOR SHARE;
  SELECT count(*) INTO enabled_count FROM public.feature_flags
    WHERE flag IN ('memory_import_batches_enabled', 'memory_kernel_enabled') AND enabled IS TRUE;
  RETURN enabled_count = 2;
END
$fn$;

CREATE FUNCTION public.memory_import_batches_get(p_owner_id uuid, p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE batch public.memory_import_batches%ROWTYPE; progress jsonb;
BEGIN
  SELECT * INTO batch FROM public.memory_import_batches WHERE id = p_batch_id AND owner_id = p_owner_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  SELECT jsonb_build_object('completed', count(*) FILTER (WHERE status = 'completed'),
    'revoked', count(*) FILTER (WHERE status = 'revoked')) INTO progress
    FROM public.memory_import_batch_items WHERE batch_id = batch.id;
  RETURN jsonb_build_object('ok', true, 'batch', jsonb_build_object(
    'id', batch.id, 'source', batch.source, 'status', batch.status, 'total', batch.total,
    'checkpoint', batch.checkpoint, 'attempts', batch.attempts, 'lastErrorCode', batch.last_error_code,
    'completed', progress->'completed', 'revoked', progress->'revoked'));
END
$fn$;

CREATE FUNCTION public.memory_import_batches_create(p_owner_id uuid, p_key uuid, p_memory_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE batch public.memory_import_batches%ROWTYPE; ids uuid[]; fingerprint text; owned_count integer;
BEGIN
  IF public.memory_import_batches_contract() <> 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'schema_unavailable');
  END IF;
  IF NOT public.memory_import_batches_enabled() THEN RETURN jsonb_build_object('ok', false, 'reason', 'feature_disabled'); END IF;
  IF p_owner_id IS NULL OR p_key IS NULL OR p_memory_ids IS NULL OR cardinality(p_memory_ids) NOT BETWEEN 1 AND 200
     OR array_position(p_memory_ids, NULL) IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  SELECT array_agg(DISTINCT selected ORDER BY selected) INTO ids FROM unnest(p_memory_ids) selected;
  IF cardinality(ids) <> cardinality(p_memory_ids) THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload'); END IF;
  fingerprint := md5(array_to_string(ids, ','));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_key::text, 3992));
  SELECT * INTO batch FROM public.memory_import_batches WHERE owner_id = p_owner_id AND request_key = p_key FOR UPDATE;
  IF FOUND THEN
    IF batch.request_hash <> fingerprint THEN RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_conflict'); END IF;
    RETURN public.memory_import_batches_get(p_owner_id, batch.id) || jsonb_build_object('duplicate', true);
  END IF;
  PERFORM 1 FROM public.memories WHERE id = ANY(ids) ORDER BY id FOR UPDATE;
  SELECT count(*) INTO owned_count FROM public.memories WHERE id = ANY(ids) AND owner_id = p_owner_id
    AND source_mode = 'LEGACY_IMPORTED' AND state NOT IN ('deleted', 'removed');
  IF owned_count <> cardinality(ids) THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  INSERT INTO public.memory_import_batches(owner_id, request_key, request_hash, total)
    VALUES (p_owner_id, p_key, fingerprint, cardinality(ids)) RETURNING * INTO batch;
  INSERT INTO public.memory_import_batch_items(batch_id, ordinal, memory_id)
    SELECT batch.id, position::integer, memory_id FROM unnest(ids) WITH ORDINALITY selected(memory_id, position);
  RETURN public.memory_import_batches_get(p_owner_id, batch.id) || jsonb_build_object('duplicate', false);
END
$fn$;

CREATE FUNCTION public.memory_import_batches_reject_command(p_command jsonb, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.memory_command_audit(command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES((p_command->>'command_id')::uuid, 'BACKFILL_LEGACY_MEMORY', (p_command->>'memory_id')::uuid,
      (p_command->>'actor_user_id')::uuid, p_command->>'idempotency_key', 'rejected', p_reason);
  RETURN jsonb_build_object('ok', false, 'reason', p_reason, 'contract_version', 1);
END
$fn$;

CREATE FUNCTION public.memory_import_legacy_execute(p_command jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  actor_id uuid; memory_id uuid; batch_id uuid; command_id uuid; operation_key text; position integer;
  batch public.memory_import_batches%ROWTYPE; item public.memory_import_batch_items%ROWTYPE;
  receipt public.memory_command_receipts%ROWTYPE; memory_row public.memories%ROWTYPE;
  event_id uuid; event_sequence bigint; changed integer; mismatch boolean; result jsonb;
BEGIN
  IF public.memory_import_batches_contract() <> 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_KERNEL_UNAVAILABLE', 'contract_version', 1);
  END IF;
  IF NOT public.memory_import_batches_enabled() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_KERNEL_UNAVAILABLE', 'contract_version', 1);
  END IF;
  BEGIN
    actor_id := (p_command->>'actor_user_id')::uuid;
    memory_id := (p_command->>'memory_id')::uuid;
    command_id := (p_command->>'command_id')::uuid;
    operation_key := p_command->>'idempotency_key';
    batch_id := (p_command->'payload'->>'batch_id')::uuid;
    position := (p_command->'payload'->>'ordinal')::integer;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED', 'contract_version', 1);
  END;
  IF actor_id IS NULL OR memory_id IS NULL OR command_id IS NULL OR batch_id IS NULL OR position IS NULL
     OR p_command->>'type' IS DISTINCT FROM 'BACKFILL_LEGACY_MEMORY'
     OR operation_key IS DISTINCT FROM ('import:' || batch_id::text || ':' || position::text) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED', 'contract_version', 1);
  END IF;
  SELECT * INTO batch FROM public.memory_import_batches WHERE id = batch_id AND owner_id = actor_id FOR UPDATE;
  IF NOT FOUND OR batch.status = 'aborted' THEN
    RETURN public.memory_import_batches_reject_command(p_command, 'MEMORY_NOT_FOUND');
  END IF;
  SELECT * INTO memory_row FROM public.memories WHERE id = memory_id FOR UPDATE;
  IF NOT FOUND OR memory_row.owner_id <> actor_id OR memory_row.source_mode <> 'LEGACY_IMPORTED'
     OR memory_row.state IN ('deleted', 'removed') THEN
    RETURN public.memory_import_batches_reject_command(p_command, 'MEMORY_NOT_FOUND');
  END IF;
  SELECT * INTO item FROM public.memory_import_batch_items WHERE memory_import_batch_items.batch_id = batch.id
    AND ordinal = position FOR UPDATE;
  IF NOT FOUND OR item.memory_id IS DISTINCT FROM memory_id OR item.command_id <> command_id THEN
    RETURN public.memory_import_batches_reject_command(p_command, 'MEMORY_NOT_FOUND');
  END IF;
  IF EXISTS (SELECT 1 FROM public.memory_corrections WHERE memory_corrections.memory_id = memory_row.id
    AND field = 'place') THEN
    RETURN public.memory_import_batches_reject_command(p_command, 'MEMORY_KERNEL_UNAVAILABLE');
  END IF;
  SELECT * INTO receipt FROM public.memory_command_receipts
    WHERE actor_user_id = actor_id AND idempotency_key = operation_key FOR UPDATE;
  IF FOUND THEN
    IF receipt.command_type <> 'BACKFILL_LEGACY_MEMORY' OR receipt.memory_id IS DISTINCT FROM memory_id
       OR receipt.command_id <> command_id THEN
      RETURN public.memory_import_batches_reject_command(p_command, 'MEMORY_IDEMPOTENCY_KEY_REUSED');
    END IF;
    INSERT INTO public.memory_command_audit(command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, event_id)
      VALUES(command_id, 'BACKFILL_LEGACY_MEMORY', memory_id, actor_id, operation_key, 'duplicate', receipt.event_id);
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'memory_id', memory_id, 'event_id', receipt.event_id,
      'event_type', receipt.event_type, 'result', receipt.result_json, 'contract_version', 1);
  END IF;
  IF batch.status = 'completed' OR position <> batch.checkpoint + 1 OR item.status <> 'pending' THEN
    RETURN public.memory_import_batches_reject_command(p_command, 'MEMORY_COMMAND_MALFORMED');
  END IF;
  PERFORM 1 FROM public.memory_tags WHERE memory_tags.memory_id = memory_row.id ORDER BY tagged_user_id FOR SHARE;
  changed := public.memory_graph_mirror_memory(memory_row.id);
  WITH expected AS (
    SELECT 'TRIP'::text AS target_type, memory_row.trip_id::text AS target_id WHERE memory_row.trip_id IS NOT NULL
    UNION SELECT 'EVENT', memory_row.event_id::text WHERE memory_row.event_id IS NOT NULL
    UNION SELECT 'PLACE', nullif(coalesce(memory_row.canonical_location_id::text, nullif(memory_row.place_id, '')), '')
      WHERE nullif(coalesce(memory_row.canonical_location_id::text, nullif(memory_row.place_id, '')), '') IS NOT NULL
    UNION SELECT 'PERSON', tagged_user_id::text FROM public.memory_tags
      WHERE memory_tags.memory_id = memory_row.id AND status = 'approved'
  ), actual AS (
    SELECT target_type, target_id FROM public.memory_relations
      WHERE source_type = 'MEMORY' AND source_id = memory_row.id AND source_mode = 'LEGACY_IMPORTED'
  ) SELECT EXISTS(SELECT * FROM expected EXCEPT SELECT * FROM actual)
      OR EXISTS(SELECT * FROM actual EXCEPT SELECT * FROM expected) INTO mismatch;
  IF mismatch OR EXISTS(SELECT 1 FROM public.memory_relations
    WHERE source_type = 'MEMORY' AND source_id = memory_row.id AND source_mode = 'LEGACY_IMPORTED'
      AND (owner_id <> actor_id OR relation_type <> 'RELATED' OR confidence IS DISTINCT FROM 0.500
        OR detector_version IS DISTINCT FROM 'legacy-mirror@1')) THEN
    RAISE EXCEPTION 'MEMORY_IMPORT_GRAPH_PARITY_FAILED';
  END IF;
  SELECT coalesce(max(sequence), 0) + 1 INTO event_sequence FROM public.memory_domain_events
    WHERE memory_domain_events.memory_id = memory_row.id;
  INSERT INTO public.memory_domain_events(memory_id, sequence, type, actor_user_id, causation_id,
    correlation_id, payload_json, schema_version, occurred_at)
    VALUES(memory_row.id, event_sequence, 'memory.corrected', actor_id, command_id, batch.id,
      jsonb_build_object('command_type', 'BACKFILL_LEGACY_MEMORY', 'reason_code', 'LEGACY_GRAPH_BACKFILL',
        'source_mode', 'LEGACY_IMPORTED', 'engine_version', 'legacy-mirror@1'), 1, now())
    RETURNING memory_domain_events.event_id INTO event_id;
  INSERT INTO public.memory_event_outbox(event_id, memory_id, type) VALUES(event_id, memory_row.id, 'memory.corrected');
  result := jsonb_build_object('changed', changed, 'source_mode', 'LEGACY_IMPORTED');
  INSERT INTO public.memory_command_receipts(actor_user_id, idempotency_key, command_id, command_type,
    memory_id, event_id, event_type, result_json)
    VALUES(actor_id, operation_key, command_id, 'BACKFILL_LEGACY_MEMORY', memory_row.id, event_id, 'memory.corrected', result);
  INSERT INTO public.memory_command_audit(command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, event_id)
    VALUES(command_id, 'BACKFILL_LEGACY_MEMORY', memory_row.id, actor_id, operation_key, 'accepted', event_id);
  UPDATE public.memory_import_batch_items SET status = 'completed' WHERE memory_import_batch_items.batch_id = batch.id AND ordinal = position;
  UPDATE public.memory_import_batches SET checkpoint = position,
    status = CASE WHEN position = total THEN 'completed' ELSE 'running' END, updated_at = now() WHERE id = batch.id;
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'memory_id', memory_row.id, 'event_id', event_id,
    'event_type', 'memory.corrected', 'result', result, 'contract_version', 1);
END
$fn$;

CREATE FUNCTION public.memory_import_batches_step(p_owner_id uuid, p_batch_id uuid, p_checkpoint integer, p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE batch public.memory_import_batches%ROWTYPE; item record; outcome jsonb; current_memory uuid;
BEGIN
  IF public.memory_import_batches_contract() <> 1 THEN RETURN jsonb_build_object('ok', false, 'reason', 'schema_unavailable'); END IF;
  IF NOT public.memory_import_batches_enabled() THEN RETURN jsonb_build_object('ok', false, 'reason', 'feature_disabled'); END IF;
  IF p_checkpoint IS NULL OR p_checkpoint < 0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  SELECT * INTO batch FROM public.memory_import_batches WHERE id = p_batch_id AND owner_id = p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF p_checkpoint > batch.checkpoint THEN RETURN jsonb_build_object('ok', false, 'reason', 'checkpoint_conflict'); END IF;
  IF p_checkpoint < batch.checkpoint OR batch.status IN ('completed', 'aborted') THEN
    RETURN public.memory_import_batches_get(p_owner_id, batch.id) || jsonb_build_object('duplicate', true);
  END IF;
  UPDATE public.memory_import_batches SET status = 'running', attempts = attempts + 1, last_error_code = NULL,
    updated_at = now() WHERE id = batch.id;
  BEGIN
    PERFORM 1 FROM public.memories WHERE id IN (SELECT memory_id FROM public.memory_import_batch_items
      WHERE batch_id = batch.id AND ordinal > batch.checkpoint ORDER BY ordinal LIMIT p_limit)
      ORDER BY id FOR UPDATE;
    FOR item IN SELECT * FROM public.memory_import_batch_items WHERE batch_id = batch.id
      AND ordinal > batch.checkpoint ORDER BY ordinal LIMIT p_limit LOOP
      SELECT id INTO current_memory FROM public.memories WHERE id = item.memory_id AND owner_id = p_owner_id
        AND source_mode = 'LEGACY_IMPORTED' AND state NOT IN ('deleted', 'removed');
      IF current_memory IS NULL OR item.status = 'revoked' THEN
        UPDATE public.memory_import_batch_items SET memory_id = NULL, status = 'revoked'
          WHERE batch_id = batch.id AND ordinal = item.ordinal;
        UPDATE public.memory_import_batches SET checkpoint = item.ordinal WHERE id = batch.id;
      ELSE
        outcome := public.memory_import_legacy_execute(jsonb_build_object('command_id', item.command_id,
          'memory_id', item.memory_id, 'actor_user_id', p_owner_id, 'type', 'BACKFILL_LEGACY_MEMORY',
          'idempotency_key', 'import:' || batch.id::text || ':' || item.ordinal::text,
          'payload', jsonb_build_object('batch_id', batch.id, 'ordinal', item.ordinal)));
        IF outcome->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'MEMORY_IMPORT_COMMAND_REJECTED'; END IF;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.memory_import_batches SET last_error_code = 'MEMORY_IMPORT_STEP_FAILED', updated_at = now() WHERE id = batch.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'step_failed');
  END;
  UPDATE public.memory_import_batches SET status = CASE WHEN checkpoint = total THEN 'completed' ELSE 'running' END,
    updated_at = now() WHERE id = batch.id;
  RETURN public.memory_import_batches_get(p_owner_id, batch.id) || jsonb_build_object('duplicate', false);
END
$fn$;

CREATE FUNCTION public.memory_import_batches_abort(p_owner_id uuid, p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE batch public.memory_import_batches%ROWTYPE;
BEGIN
  SELECT * INTO batch FROM public.memory_import_batches WHERE id = p_batch_id AND owner_id = p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF batch.status NOT IN ('completed', 'aborted') THEN
    UPDATE public.memory_import_batches SET status = 'aborted', updated_at = now() WHERE id = batch.id;
  END IF;
  RETURN public.memory_import_batches_get(p_owner_id, batch.id);
END
$fn$;

REVOKE ALL ON FUNCTION public.memory_import_batches_revoke_source() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.memory_import_batches_contract() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.memory_import_batches_enabled() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.memory_import_batches_reject_command(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.memory_import_batches_get(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.memory_import_batches_create(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.memory_import_legacy_execute(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.memory_import_batches_step(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.memory_import_batches_abort(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.memory_import_batches_contract(), public.memory_import_batches_get(uuid, uuid),
  public.memory_import_batches_create(uuid, uuid, uuid[]), public.memory_import_legacy_execute(jsonb),
  public.memory_import_batches_step(uuid, uuid, integer, integer), public.memory_import_batches_abort(uuid, uuid)
  TO service_role;

INSERT INTO public.feature_flags(flag, enabled, description) VALUES ('memory_import_batches_enabled', false,
  'Explicit owner-scoped existing LEGACY_IMPORTED Memory graph backfill; requires memory_kernel_enabled. No automatic scheduler or activation.')
  ON CONFLICT (flag) DO NOTHING;

COMMIT;
