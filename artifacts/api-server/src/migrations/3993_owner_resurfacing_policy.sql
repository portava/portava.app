BEGIN;

INSERT INTO public.feature_flags(flag, enabled, description)
  VALUES ('memory_resurfacing_policy_enabled', false, '3993 owner-scoped resurfacing command boundary; requires memory_kernel_enabled')
  ON CONFLICT (flag) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.memory_resurfacing_policy_heads (
  owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  command_sequence bigint NOT NULL DEFAULT 0 CHECK (command_sequence >= 0)
);
ALTER TABLE public.memory_resurfacing_policy_heads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_resurfacing_policy_heads FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.memory_resurfacing_policy_heads TO service_role;
COMMENT ON TABLE public.memory_resurfacing_policy_heads IS
  'Owner-scoped SET_RESURFACING_POLICY serialization. command_sequence orders accepted commands only; it is not whole-policy optimistic concurrency. Graph copies and deletion cascades retain their existing contracts.';

ALTER TABLE public.memory_domain_events ADD COLUMN IF NOT EXISTS policy_owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.memory_event_outbox ADD COLUMN IF NOT EXISTS policy_owner_id uuid;
ALTER TABLE public.memory_command_receipts ADD COLUMN IF NOT EXISTS policy_owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.memory_command_receipts ADD COLUMN IF NOT EXISTS policy_intent jsonb;
ALTER TABLE public.memory_command_audit ADD COLUMN IF NOT EXISTS policy_owner_id uuid;
ALTER TABLE public.memory_domain_events DROP CONSTRAINT memory_domain_events_one_subject;
ALTER TABLE public.memory_domain_events ADD CONSTRAINT memory_domain_events_one_subject CHECK (num_nonnulls(memory_id, highlight_id, policy_owner_id) = 1);
ALTER TABLE public.memory_event_outbox DROP CONSTRAINT memory_event_outbox_one_subject;
ALTER TABLE public.memory_event_outbox ADD CONSTRAINT memory_event_outbox_one_subject CHECK (num_nonnulls(memory_id, highlight_id, policy_owner_id) = 1);
ALTER TABLE public.memory_command_receipts DROP CONSTRAINT memory_command_receipts_one_subject;
ALTER TABLE public.memory_command_receipts ADD CONSTRAINT memory_command_receipts_one_subject CHECK (num_nonnulls(memory_id, highlight_id, policy_owner_id) = 1) NOT VALID;
COMMENT ON CONSTRAINT memory_command_receipts_one_subject ON public.memory_command_receipts IS
  'All new/updated receipts have exactly one subject. NOT VALID preserves pre-3993 zero-subject historical rows without endorsing new ones. Rejections write audit, never receipts.';
ALTER TABLE public.memory_command_receipts ADD CONSTRAINT memory_command_receipts_policy_subject CHECK (
  (command_type = 'SET_RESURFACING_POLICY') = (policy_owner_id IS NOT NULL)
  AND (policy_owner_id IS NULL OR policy_intent IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS memory_domain_events_policy_sequence ON public.memory_domain_events(policy_owner_id, sequence);
ALTER TABLE public.memory_domain_events DROP CONSTRAINT memory_domain_events_type_vocabulary;
ALTER TABLE public.memory_domain_events ADD CONSTRAINT memory_domain_events_type_vocabulary CHECK (type IN (
  'memory.created', 'memory.confirmed', 'memory.corrected', 'memory.merged', 'memory.split',
  'memory.archived', 'memory.deleted', 'memory.visibility_changed', 'highlight.created',
  'highlight.published', 'highlight.expired', 'highlight.pinned', 'highlight.hidden', 'resurfacing.policy_changed'));
ALTER TABLE public.memory_domain_events ADD CONSTRAINT memory_domain_events_policy_subject
  CHECK ((type = 'resurfacing.policy_changed') = (policy_owner_id IS NOT NULL));
ALTER TABLE public.memory_event_outbox ADD CONSTRAINT memory_event_outbox_policy_subject
  CHECK ((type = 'resurfacing.policy_changed') = (policy_owner_id IS NOT NULL));

CREATE SCHEMA IF NOT EXISTS memory_resurfacing_policy_private;
REVOKE ALL ON SCHEMA memory_resurfacing_policy_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA memory_resurfacing_policy_private TO service_role;
CREATE FUNCTION memory_resurfacing_policy_private.lock_owner(p_owner_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  PERFORM id FROM auth.users WHERE id = p_owner_id FOR KEY SHARE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found USING MESSAGE = 'Policy owner unavailable'; END IF;
  PERFORM id FROM public.profiles WHERE id = p_owner_id FOR KEY SHARE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found USING MESSAGE = 'Policy profile unavailable'; END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION memory_resurfacing_policy_private.lock_owner(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION memory_resurfacing_policy_private.lock_owner(uuid) TO service_role;
COMMENT ON FUNCTION memory_resurfacing_policy_private.lock_owner(uuid) IS
  'Service-only ancestor locks for account-erasure ordering; narrowly definer-owned to avoid granting auth.users privileges to the invoker. The command subtransaction rolls back both locks on refusal.';

CREATE OR REPLACE FUNCTION public.memory_keep_private_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE current_visibility text;
BEGIN
  IF TG_TABLE_NAME = 'memory_resurfacing_preferences' THEN
    IF NEW.control = 'KEEP_PRIVATE_FOREVER' THEN
      SELECT visibility INTO current_visibility FROM public.memories WHERE id = NEW.memory_id FOR UPDATE;
      IF current_visibility IS DISTINCT FROM 'only_me' THEN
        RAISE EXCEPTION 'memory_kept_private: make this Memory only_me first' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF NEW.visibility IS DISTINCT FROM 'only_me' AND EXISTS (
    SELECT 1 FROM public.memory_resurfacing_preferences WHERE memory_id = NEW.id AND control = 'KEEP_PRIVATE_FOREVER'
  ) THEN
    RAISE EXCEPTION 'memory_kept_private: clear the control before widening' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER memory_keep_private_preference BEFORE INSERT OR UPDATE ON public.memory_resurfacing_preferences
  FOR EACH ROW EXECUTE FUNCTION public.memory_keep_private_guard();
CREATE TRIGGER memory_keep_private_visibility BEFORE UPDATE OF visibility ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.memory_keep_private_guard();
REVOKE ALL ON FUNCTION public.memory_keep_private_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_keep_private_guard() TO service_role;

CREATE OR REPLACE FUNCTION public.memory_resurfacing_policy_execute(p_command jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  actor_id uuid;
  command_id uuid;
  correlation_id uuid;
  target_id uuid;
  target_kind text;
  control_name text;
  turn_on boolean;
  confirmed boolean;
  operation_key text;
  intent jsonb;
  receipt public.memory_command_receipts%ROWTYPE;
  refusal text;
  visibility_now text;
  stored_at timestamptz;
  changed_rows integer;
  event_id uuid;
  command_sequence bigint;
  result_body jsonb;
BEGIN
  BEGIN
    actor_id := (p_command->>'actor_user_id')::uuid;
    command_id := (p_command->>'command_id')::uuid;
    correlation_id := (p_command->>'correlation_id')::uuid;
    target_id := (p_command#>>'{payload,target,id}')::uuid;
    operation_key := btrim(p_command->>'idempotency_key');
    target_kind := p_command#>>'{payload,target,kind}';
    control_name := p_command#>>'{payload,control}';
    turn_on := (p_command#>>'{payload,on}')::boolean;
    confirmed := p_command#>'{payload,confirmed}' = 'true'::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED', 'contract_version', 1);
  END;
  IF actor_id IS NULL OR command_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED', 'contract_version', 1);
  END IF;
  IF p_command->>'type' IS DISTINCT FROM 'SET_RESURFACING_POLICY'
    OR p_command->>'policy_owner_id' IS DISTINCT FROM actor_id::text
    OR p_command->>'memory_id' IS NOT NULL OR p_command->>'highlight_id' IS NOT NULL
    OR target_id IS NULL OR coalesce(length(operation_key), 0) NOT BETWEEN 1 AND 200
    OR jsonb_typeof(p_command#>'{payload,on}') IS DISTINCT FROM 'boolean'
    OR NOT coalesce((target_kind IN ('memory', 'highlight') AND control_name IN
      ('DO_NOT_RESURFACE', 'DO_NOT_INCLUDE_IN_RECAPS', 'KEEP_PRIVATE_FOREVER', 'RETAIN_BUT_DO_NOT_PERSONALIZE'))
      OR (target_kind = 'person' AND control_name = 'HIDE_PERSON_FROM_RESURFACING')
      OR (target_kind = 'trip' AND control_name = 'HIDE_TRIP'), false)
    OR (target_kind = 'highlight' AND control_name = 'KEEP_PRIVATE_FOREVER' AND NOT turn_on AND confirmed IS DISTINCT FROM true)
  THEN refusal := 'MEMORY_COMMAND_MALFORMED';
  ELSIF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_kernel_enabled' AND enabled = true)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_resurfacing_policy_enabled' AND enabled = true) THEN
    refusal := 'MEMORY_KERNEL_UNAVAILABLE';
  ELSIF (target_kind = 'memory' AND to_regclass('public.memory_resurfacing_preferences') IS NULL)
    OR (target_kind <> 'memory' AND to_regclass('public.highlight_resurfacing_preferences') IS NULL) THEN
    refusal := 'RESURFACING_NOT_DEPLOYED';
  END IF;
  IF refusal IS NULL THEN
    PERFORM memory_resurfacing_policy_private.lock_owner(actor_id);
    intent := jsonb_build_object('target', jsonb_build_object('kind', target_kind, 'id', target_id), 'control', control_name, 'on', turn_on);
    IF target_kind = 'highlight' AND control_name = 'KEEP_PRIVATE_FOREVER' AND NOT turn_on THEN
      intent := intent || jsonb_build_object('confirmed', true);
    END IF;
    INSERT INTO public.memory_resurfacing_policy_heads(owner_id) VALUES (actor_id) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM public.memory_resurfacing_policy_heads WHERE owner_id = actor_id FOR UPDATE;
    SELECT * INTO receipt FROM public.memory_command_receipts WHERE actor_user_id = actor_id AND idempotency_key = operation_key FOR UPDATE;
    IF FOUND THEN
      IF receipt.command_type IS DISTINCT FROM 'SET_RESURFACING_POLICY' OR receipt.policy_owner_id IS DISTINCT FROM actor_id
        OR receipt.policy_intent IS DISTINCT FROM intent THEN
        refusal := 'MEMORY_IDEMPOTENCY_KEY_REUSED';
      ELSE
        INSERT INTO public.memory_command_audit(command_id, command_type, policy_owner_id, actor_user_id, idempotency_key, outcome, event_id)
          VALUES (command_id, 'SET_RESURFACING_POLICY', actor_id, actor_id, operation_key, 'duplicate', receipt.event_id);
        RETURN jsonb_build_object('ok', true, 'duplicate', true, 'policy_owner_id', actor_id, 'event_id', receipt.event_id,
          'event_type', receipt.event_type, 'result', receipt.result_json, 'contract_version', 1);
      END IF;
    END IF;
    IF refusal IS NULL AND target_kind = 'memory' THEN
      SELECT visibility INTO visibility_now FROM public.memories WHERE id = target_id AND owner_id = actor_id AND state <> 'deleted' FOR UPDATE;
      IF NOT FOUND THEN refusal := 'MEMORY_NOT_FOUND';
      ELSIF turn_on AND control_name = 'KEEP_PRIVATE_FOREVER' AND visibility_now IS DISTINCT FROM 'only_me' THEN refusal := 'RESURFACING_NOT_PRIVATE';
      END IF;
    ELSIF refusal IS NULL AND target_kind = 'highlight' AND turn_on THEN
      PERFORM 1 FROM public.highlights WHERE id = target_id AND owner_id = actor_id AND deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN refusal := 'HIGHLIGHT_NOT_FOUND'; END IF;
    END IF;
  END IF;
  IF refusal IS NOT NULL THEN
    INSERT INTO public.memory_command_audit(command_id, command_type, policy_owner_id, actor_user_id, idempotency_key, outcome, reason)
      VALUES (command_id, 'SET_RESURFACING_POLICY', actor_id, actor_id, coalesce(operation_key, ''), 'rejected', refusal);
    RETURN jsonb_build_object('ok', false, 'reason', refusal, 'contract_version', 1);
  END IF;

  IF target_kind = 'memory' THEN
    IF turn_on THEN
      INSERT INTO public.memory_resurfacing_preferences(memory_id, owner_id, control) VALUES (target_id, actor_id, control_name) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS changed_rows = ROW_COUNT;
      SELECT created_at INTO stored_at FROM public.memory_resurfacing_preferences WHERE memory_id = target_id AND owner_id = actor_id AND control = control_name;
      IF NOT FOUND THEN RAISE EXCEPTION 'policy write unconfirmed'; END IF;
    ELSE
      DELETE FROM public.memory_resurfacing_preferences WHERE memory_id = target_id AND owner_id = actor_id AND control = control_name;
      GET DIAGNOSTICS changed_rows = ROW_COUNT;
    END IF;
  ELSE
    IF turn_on THEN
      SELECT created_at INTO stored_at FROM public.highlight_resurfacing_preferences
        WHERE owner_id = actor_id AND control = control_name AND subject_type = target_kind AND lower(subject_id) = target_id::text
        ORDER BY created_at LIMIT 1 FOR UPDATE;
      changed_rows := 0;
      IF NOT FOUND THEN
        INSERT INTO public.highlight_resurfacing_preferences(owner_id, control, subject_type, subject_id)
          VALUES (actor_id, control_name, target_kind, target_id::text) ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS changed_rows = ROW_COUNT;
      END IF;
      SELECT created_at INTO stored_at FROM public.highlight_resurfacing_preferences
        WHERE owner_id = actor_id AND control = control_name AND subject_type = target_kind AND lower(subject_id) = target_id::text
        ORDER BY created_at LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'policy write unconfirmed'; END IF;
    ELSE
      DELETE FROM public.highlight_resurfacing_preferences WHERE owner_id = actor_id AND control = control_name AND subject_type = target_kind AND lower(subject_id) = target_id::text;
      GET DIAGNOSTICS changed_rows = ROW_COUNT;
    END IF;
  END IF;
  UPDATE public.memory_resurfacing_policy_heads SET command_sequence = memory_resurfacing_policy_heads.command_sequence + 1
    WHERE owner_id = actor_id RETURNING memory_resurfacing_policy_heads.command_sequence INTO command_sequence;
  result_body := jsonb_build_object('control', control_name, 'subjectType', target_kind, 'subjectId', target_id,
    'createdAt', stored_at, 'cleared', NOT turn_on AND changed_rows > 0, 'changed', changed_rows > 0);
  INSERT INTO public.memory_domain_events(policy_owner_id, sequence, type, actor_user_id, causation_id, correlation_id, payload_json, schema_version, occurred_at)
    VALUES (actor_id, command_sequence, 'resurfacing.policy_changed', actor_id, command_id, correlation_id, intent, 1, now()) RETURNING memory_domain_events.event_id INTO event_id;
  INSERT INTO public.memory_event_outbox(event_id, policy_owner_id, type) VALUES (event_id, actor_id, 'resurfacing.policy_changed');
  INSERT INTO public.memory_command_receipts(actor_user_id, idempotency_key, command_id, command_type, policy_owner_id, policy_intent, event_id, event_type, result_json)
    VALUES (actor_id, operation_key, command_id, 'SET_RESURFACING_POLICY', actor_id, intent, event_id, 'resurfacing.policy_changed', result_body);
  INSERT INTO public.memory_command_audit(command_id, command_type, policy_owner_id, actor_user_id, idempotency_key, outcome, event_id)
    VALUES (command_id, 'SET_RESURFACING_POLICY', actor_id, actor_id, operation_key, 'accepted', event_id);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'policy_owner_id', actor_id, 'event_id', event_id,
    'event_type', 'resurfacing.policy_changed', 'result', result_body, 'sequence', command_sequence, 'contract_version', 1);
EXCEPTION WHEN lock_not_available OR no_data_found THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_KERNEL_UNAVAILABLE', 'contract_version', 1);
END;
$fn$;
REVOKE ALL ON FUNCTION public.memory_resurfacing_policy_execute(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_resurfacing_policy_execute(jsonb) TO service_role;

DROP FUNCTION public.memory_outbox_claim(integer, integer, integer);
CREATE FUNCTION public.memory_outbox_claim(p_limit integer DEFAULT 100, p_lease_seconds integer DEFAULT 300, p_max_attempts integer DEFAULT 5)
RETURNS TABLE(id bigint, event_id uuid, memory_id uuid, highlight_id uuid, policy_owner_id uuid, type text, created_at timestamptz, attempts integer, locked_until timestamptz)
LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
  UPDATE public.memory_event_outbox queued
    SET locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)), attempts = queued.attempts + 1
    WHERE queued.id IN (
      SELECT pending.id FROM public.memory_event_outbox pending WHERE pending.published_at IS NULL
        AND (pending.locked_until IS NULL OR pending.locked_until < now()) AND pending.attempts < greatest(p_max_attempts, 1)
      ORDER BY pending.id LIMIT greatest(p_limit, 0) FOR UPDATE SKIP LOCKED
    )
    RETURNING queued.id, queued.event_id, queued.memory_id, queued.highlight_id, queued.policy_owner_id, queued.type, queued.created_at, queued.attempts, queued.locked_until;
$fn$;
REVOKE ALL ON FUNCTION public.memory_outbox_claim(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_outbox_claim(integer, integer, integer) TO service_role;

DO $check$
BEGIN
  IF has_table_privilege('authenticated', 'public.memory_resurfacing_policy_heads', 'SELECT')
    OR has_function_privilege('authenticated', 'public.memory_resurfacing_policy_execute(jsonb)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'memory_resurfacing_policy_private.lock_owner(uuid)', 'EXECUTE')
    OR has_function_privilege('anon', 'memory_resurfacing_policy_private.lock_owner(uuid)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.memory_outbox_claim(integer,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '3993: client access to service-only owner policy boundary';
  END IF;
END;
$check$;
COMMIT;
