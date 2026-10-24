-- Rollback for 3911_memory_kernel_create_participants_and_canonical_fields.sql
--
-- Re-creates 2711's memory_kernel_execute(jsonb) VERBATIM (copied from
-- artifacts/api-server/src/migrations/2711_memory_kernel_execute.sql) with its
-- grants. After this, CREATE no longer tags, and the type, the occurrence text
-- and the source post are written by the routes' follow-up writes again — which
-- the routes still carry, so nothing breaks. Then delete 3911's ledger row.

BEGIN;

CREATE OR REPLACE FUNCTION public.memory_kernel_execute(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_memory_id  uuid;
  v_actor      uuid;
  v_cmd_id     uuid;
  v_corr       uuid;
  v_key        text;
  v_type       text;
  v_payload    jsonb;
  v_patch      jsonb;
  v_write      jsonb;
  v_select     text;
  v_observed   timestamptz;
  v_seq        bigint;
  v_event_id   uuid;
  v_event_type text;
  v_result     jsonb;
  v_receipt    public.memory_command_receipts%ROWTYPE;
  v_row        public.memories%ROWTYPE;
  v_item       public.memory_items%ROWTYPE;
  v_owner      uuid;
  v_state      text;
  v_from       text;
  v_to         text;
  v_target     text;
  v_tagged     uuid;
  v_status     text;
  v_item_id    uuid;
BEGIN
  -- ── envelope ───────────────────────────────────────────────────────────────
  BEGIN
    v_memory_id := (p_command->>'memory_id')::uuid;
    v_actor     := (p_command->>'actor_user_id')::uuid;
    v_cmd_id    := (p_command->>'command_id')::uuid;
    v_corr      := (p_command->>'correlation_id')::uuid;
    v_key       := p_command->>'idempotency_key';
    v_type      := p_command->>'type';
    v_payload   := coalesce(p_command->'payload', '{}'::jsonb);
    v_observed  := (p_command->>'client_observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED',
                              'detail', SQLERRM, 'contract_version', 1);
  END;

  IF v_actor IS NULL OR v_cmd_id IS NULL OR v_type IS NULL OR v_key IS NULL
     OR char_length(v_key) < 1 OR char_length(v_key) > 200
     OR jsonb_typeof(v_payload) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED', 'contract_version', 1);
  END IF;

  IF v_type NOT IN ('CREATE_MEMORY', 'UPDATE_MEMORY', 'CONFIRM_MEMORY', 'ARCHIVE_MEMORY',
                    'DELETE_MEMORY', 'ADD_MEDIA', 'REMOVE_MEDIA', 'ADD_PERSON',
                    'REMOVE_PERSON', 'CHANGE_PLACE', 'CHANGE_VISIBILITY') THEN
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_COMMAND_UNKNOWN_TYPE');
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_UNKNOWN_TYPE',
                              'detail', v_type, 'contract_version', 1);
  END IF;

  v_patch  := coalesce(v_payload->'patch', '{}'::jsonb);
  v_write  := coalesce(v_payload->'write', '{}'::jsonb);
  v_select := v_payload->>'select';

  -- ── idempotency (§19). Same key, same actor => the ORIGINAL answer. ─────────
  SELECT * INTO v_receipt FROM public.memory_command_receipts
   WHERE actor_user_id = v_actor AND idempotency_key = v_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.command_type IS DISTINCT FROM v_type THEN
      INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
      VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_IDEMPOTENCY_KEY_REUSED');
      RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_IDEMPOTENCY_KEY_REUSED',
                                'detail', format('key already used for %s', v_receipt.command_type),
                                'contract_version', 1);
    END IF;
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, event_id)
    VALUES (v_cmd_id, v_type, v_receipt.memory_id, v_actor, v_key, 'duplicate', v_receipt.event_id);
    -- The ORIGINAL result_json. Not recomputed: recomputing is how a replay
    -- returns a body that describes a different world than the first call did.
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true,
      'memory_id', v_receipt.memory_id, 'event_id', v_receipt.event_id,
      'event_type', v_receipt.event_type, 'result', v_receipt.result_json,
      'contract_version', 1);
  END IF;

  -- ── the aggregate, its owner and its state (§23 canEditMemory) ─────────────
  IF v_type <> 'CREATE_MEMORY' THEN
    IF v_memory_id IS NULL THEN
      INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
      VALUES (v_cmd_id, v_type, NULL, v_actor, v_key, 'rejected', 'MEMORY_COMMAND_MALFORMED');
      RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED',
                                'detail', 'memory_id required', 'contract_version', 1);
    END IF;

    SELECT owner_id, state INTO v_owner, v_state
      FROM public.memories WHERE id = v_memory_id AND state <> 'deleted'
      FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
      VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_NOT_FOUND');
      RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_NOT_FOUND', 'contract_version', 1);
    END IF;

    v_tagged := (v_payload->>'tagged_user_id')::uuid;

    IF v_type IN ('ADD_PERSON', 'REMOVE_PERSON') THEN
      -- §17 REMOVE_PERSON. Appendix A line 776 walks the OWNER through removing
      -- a participant; §10 line 338 ("being tagged does not make another user a
      -- co-owner") is why the tagged person's presence is not a veto; §5 line
      -- 226 ("only after participant consent") is why APPROVAL is the tagged
      -- person's alone and an owner may not manufacture it.
      IF v_type = 'ADD_PERSON' AND v_tagged IS DISTINCT FROM v_actor THEN
        INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
        VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_AUTH_NOT_PARTICIPANT');
        RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_AUTH_NOT_PARTICIPANT', 'contract_version', 1);
      END IF;
      IF v_owner IS DISTINCT FROM v_actor AND v_tagged IS DISTINCT FROM v_actor THEN
        INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
        VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_AUTH_NOT_OWNER');
        RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_AUTH_NOT_OWNER', 'contract_version', 1);
      END IF;
    ELSIF v_owner IS DISTINCT FROM v_actor THEN
      INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
      VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_AUTH_NOT_OWNER');
      RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_AUTH_NOT_OWNER', 'contract_version', 1);
    END IF;

    -- ── §5 lifecycle ─────────────────────────────────────────────────────────
    v_target := CASE v_type
      WHEN 'DELETE_MEMORY'  THEN 'deleted'
      WHEN 'ARCHIVE_MEMORY' THEN 'archived'
      WHEN 'CONFIRM_MEMORY' THEN 'published'
      ELSE v_patch->>'state'
    END;

    IF v_target IS NOT NULL THEN
      v_from := CASE v_state
        WHEN 'draft' THEN 'CANDIDATE' WHEN 'published' THEN 'ACTIVE'
        WHEN 'archived' THEN 'ARCHIVED' WHEN 'deleted' THEN 'DELETED'
        WHEN 'removed' THEN 'DELETED' ELSE NULL END;
      v_to := CASE v_target
        WHEN 'draft' THEN 'CANDIDATE' WHEN 'published' THEN 'ACTIVE'
        WHEN 'archived' THEN 'ARCHIVED' WHEN 'deleted' THEN 'DELETED'
        WHEN 'removed' THEN 'DELETED' ELSE NULL END;

      IF v_from IS NULL THEN
        INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
        VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_LIFECYCLE_UNKNOWN_STATE');
        RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_LIFECYCLE_UNKNOWN_STATE',
                                  'from', v_state, 'to', v_target, 'contract_version', 1);
      END IF;
      IF v_state IN ('deleted', 'removed') THEN
        INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
        VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_LIFECYCLE_TERMINAL');
        RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_LIFECYCLE_TERMINAL',
                                  'from', v_state, 'to', v_target, 'contract_version', 1);
      END IF;
      IF NOT (
           (v_state = 'draft'     AND v_target IN ('draft', 'published', 'deleted'))
        OR (v_state = 'published' AND v_target IN ('published', 'archived', 'deleted'))
        OR (v_state = 'archived'  AND v_target IN ('archived', 'published', 'deleted'))
      ) THEN
        INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
        VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_LIFECYCLE_INVALID_TRANSITION');
        RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_LIFECYCLE_INVALID_TRANSITION',
                                  'from', v_state, 'to', v_target, 'contract_version', 1);
      END IF;
    ELSE
      v_from := CASE v_state
        WHEN 'draft' THEN 'CANDIDATE' WHEN 'published' THEN 'ACTIVE'
        WHEN 'archived' THEN 'ARCHIVED' ELSE 'DELETED' END;
      v_to := v_from;
    END IF;
  END IF;

  -- ══ APPLY. Every branch has validated fully; the first write happens here. ══
  CASE v_type

    WHEN 'CREATE_MEMORY' THEN
      INSERT INTO public.memories (
        owner_id, title, caption, visibility, allowed_user_ids, hidden_user_ids,
        trip_id, event_id, place_id, location_city, location_country,
        location_lat, location_lng, canonical_location_id, starts_at, ends_at, state)
      VALUES (
        v_actor,
        v_write->>'title',
        v_write->>'caption',
        coalesce(v_write->>'visibility', 'friends_only'),
        coalesce((SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(coalesce(v_write->'allowed_user_ids', '[]'::jsonb)) x), '{}'::uuid[]),
        coalesce((SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(coalesce(v_write->'hidden_user_ids', '[]'::jsonb)) x), '{}'::uuid[]),
        (v_write->>'trip_id')::uuid,
        (v_write->>'event_id')::uuid,
        v_write->>'place_id',
        v_write->>'location_city',
        v_write->>'location_country',
        (v_write->>'location_lat')::double precision,
        (v_write->>'location_lng')::double precision,
        (v_write->>'canonical_location_id')::uuid,
        (v_write->>'starts_at')::timestamptz,
        (v_write->>'ends_at')::timestamptz,
        coalesce(v_write->>'state', 'published'))
      RETURNING * INTO v_row;

      -- location_precision is named ONLY when the caller sent it, and the
      -- caller sends it only when `memory_location_precision_enabled` is on —
      -- which is the same contract routes/memories.ts already relies on, and
      -- exists because production may not have the column (migration 2338).
      -- Naming an absent column would fail the whole INSERT (PGRST204's SQL
      -- equivalent), which is why this is a separate, guarded UPDATE rather
      -- than a column in the list above.
      IF v_write ? 'location_precision' AND v_write->>'location_precision' IS NOT NULL THEN
        UPDATE public.memories SET location_precision = v_write->>'location_precision'
         WHERE id = v_row.id
        RETURNING * INTO v_row;
      END IF;

      v_memory_id  := v_row.id;
      v_event_type := 'memory.created';
      v_to := CASE v_row.state
        WHEN 'draft' THEN 'CANDIDATE' WHEN 'published' THEN 'ACTIVE'
        WHEN 'archived' THEN 'ARCHIVED' ELSE 'DELETED' END;
      v_result := to_jsonb(v_row);

    WHEN 'UPDATE_MEMORY', 'CONFIRM_MEMORY', 'ARCHIVE_MEMORY', 'CHANGE_PLACE', 'CHANGE_VISIBILITY' THEN
      UPDATE public.memories SET
        title                 = CASE WHEN v_patch ? 'title'                 THEN v_patch->>'title'                                ELSE title END,
        caption               = CASE WHEN v_patch ? 'caption'               THEN v_patch->>'caption'                              ELSE caption END,
        visibility            = CASE WHEN v_patch ? 'visibility'            THEN v_patch->>'visibility'                           ELSE visibility END,
        allowed_user_ids      = CASE WHEN v_patch ? 'allowed_user_ids'      THEN coalesce((SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(v_patch->'allowed_user_ids') x), '{}'::uuid[]) ELSE allowed_user_ids END,
        hidden_user_ids       = CASE WHEN v_patch ? 'hidden_user_ids'       THEN coalesce((SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(v_patch->'hidden_user_ids') x), '{}'::uuid[])  ELSE hidden_user_ids END,
        place_id              = CASE WHEN v_patch ? 'place_id'              THEN v_patch->>'place_id'                             ELSE place_id END,
        location_city         = CASE WHEN v_patch ? 'location_city'         THEN v_patch->>'location_city'                        ELSE location_city END,
        location_country      = CASE WHEN v_patch ? 'location_country'      THEN v_patch->>'location_country'                     ELSE location_country END,
        location_lat          = CASE WHEN v_patch ? 'location_lat'          THEN (v_patch->>'location_lat')::double precision     ELSE location_lat END,
        location_lng          = CASE WHEN v_patch ? 'location_lng'          THEN (v_patch->>'location_lng')::double precision     ELSE location_lng END,
        canonical_location_id = CASE WHEN v_patch ? 'canonical_location_id' THEN (v_patch->>'canonical_location_id')::uuid        ELSE canonical_location_id END,
        starts_at             = CASE WHEN v_patch ? 'starts_at'             THEN (v_patch->>'starts_at')::timestamptz             ELSE starts_at END,
        ends_at               = CASE WHEN v_patch ? 'ends_at'               THEN (v_patch->>'ends_at')::timestamptz               ELSE ends_at END,
        state                 = CASE WHEN v_target IS NOT NULL              THEN v_target                                         ELSE state END,
        updated_at            = coalesce((v_patch->>'updated_at')::timestamptz, now())
      WHERE id = v_memory_id
      RETURNING * INTO v_row;

      IF v_patch ? 'location_precision' AND v_patch->>'location_precision' IS NOT NULL THEN
        UPDATE public.memories SET location_precision = v_patch->>'location_precision'
         WHERE id = v_memory_id
        RETURNING * INTO v_row;
      END IF;

      v_event_type := CASE v_type
        WHEN 'CONFIRM_MEMORY'    THEN 'memory.confirmed'
        WHEN 'ARCHIVE_MEMORY'    THEN 'memory.archived'
        WHEN 'CHANGE_VISIBILITY' THEN 'memory.visibility_changed'
        ELSE                          'memory.corrected' END;
      v_result := to_jsonb(v_row);

    WHEN 'DELETE_MEMORY' THEN
      -- Soft delete, unchanged from the pre-lane behaviour: every read path
      -- filters state <> 'deleted', and executeAccountDeletion sweeps by
      -- owner_id with no state filter, so a soft-deleted Memory is still
      -- hard-erased when the account goes. §21's full lifecycle is NOT built.
      UPDATE public.memories SET state = 'deleted', updated_at = now()
       WHERE id = v_memory_id
      RETURNING * INTO v_row;
      v_event_type := 'memory.deleted';
      v_result := jsonb_build_object('id', v_memory_id);

    WHEN 'ADD_MEDIA' THEN
      INSERT INTO public.memory_items (memory_id, media_url, media_type, caption, position)
      VALUES (v_memory_id,
              v_write->>'media_url',
              coalesce(v_write->>'media_type', 'image/jpeg'),
              v_write->>'caption',
              coalesce((v_write->>'position')::integer, 0))
      RETURNING * INTO v_item;
      v_event_type := 'memory.corrected';
      v_result := to_jsonb(v_item);

    WHEN 'REMOVE_MEDIA' THEN
      v_item_id := (v_payload->>'item_id')::uuid;
      DELETE FROM public.memory_items
       WHERE id = v_item_id AND memory_id = v_memory_id
      RETURNING * INTO v_item;
      IF NOT FOUND THEN
        INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
        VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_ITEM_NOT_FOUND');
        RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_ITEM_NOT_FOUND', 'contract_version', 1);
      END IF;
      v_event_type := 'memory.corrected';
      v_result := jsonb_build_object('id', v_item_id);

    WHEN 'ADD_PERSON', 'REMOVE_PERSON' THEN
      v_status := v_payload->>'status';
      IF v_status IS NULL OR v_status NOT IN ('approved', 'removed', 'pending') THEN
        INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
        VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_COMMAND_MALFORMED');
        RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED',
                                  'detail', 'status must be approved|removed|pending', 'contract_version', 1);
      END IF;
      UPDATE public.memory_tags SET status = v_status
       WHERE memory_id = v_memory_id AND tagged_user_id = v_tagged;
      IF NOT FOUND THEN
        INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
        VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_TAG_NOT_FOUND');
        RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_TAG_NOT_FOUND', 'contract_version', 1);
      END IF;
      v_event_type := 'memory.corrected';
      v_result := jsonb_build_object('status', v_status);

  END CASE;

  -- ── Event + outbox + receipt + audit. Same transaction as the change. ──────
  SELECT coalesce(max(sequence), 0) + 1 INTO v_seq
    FROM public.memory_domain_events WHERE memory_id = v_memory_id;

  INSERT INTO public.memory_domain_events (
    memory_id, sequence, type, actor_user_id, causation_id, correlation_id,
    payload_json, schema_version, occurred_at)
  VALUES (
    v_memory_id, v_seq, v_event_type, v_actor, v_cmd_id, v_corr,
    -- §23 PRIVACY-FILTERED PAYLOAD. Ids, the command name and the §5 / §4
    -- vocabulary — never the title, caption, coordinates, allow/hide lists or
    -- media URL. A §18 consumer that needs the body reads the canonical row
    -- under its own authorization; it does not learn it by subscribing. The
    -- inverse of §28.6's mistake: the filter is in the event's SHAPE, not in
    -- the consumer's discipline.
    jsonb_build_object(
      'command_type', v_type,
      'from_state',   v_from,
      'to_state',     v_to,
      'visibility',   CASE WHEN v_type = 'CHANGE_VISIBILITY' OR v_type = 'CREATE_MEMORY'
                           THEN coalesce(v_patch->>'visibility', v_write->>'visibility') ELSE NULL END,
      'refs', jsonb_build_object(
        'memory_id',      v_memory_id,
        'actor_user_id',  v_actor,
        'item_id',        v_payload->>'item_id',
        'tagged_user_id', v_payload->>'tagged_user_id')),
    1, coalesce(v_observed, now()))
  RETURNING event_id INTO v_event_id;

  INSERT INTO public.memory_event_outbox (event_id, memory_id, type)
  VALUES (v_event_id, v_memory_id, v_event_type);

  -- Project the result through the caller's select list, so the response body
  -- is the one the route would have built itself. Absent => the whole row.
  IF v_select IS NOT NULL AND jsonb_typeof(v_result) = 'object' THEN
    v_result := coalesce(
      (SELECT jsonb_object_agg(e.key, e.value)
         FROM jsonb_each(v_result) AS e
        WHERE e.key = ANY (string_to_array(replace(v_select, ' ', ''), ','))),
      '{}'::jsonb);
  END IF;

  INSERT INTO public.memory_command_receipts (
    actor_user_id, idempotency_key, command_id, command_type, memory_id,
    event_id, event_type, result_json)
  VALUES (v_actor, v_key, v_cmd_id, v_type, v_memory_id, v_event_id, v_event_type, v_result);

  INSERT INTO public.memory_command_audit (
    command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, event_id)
  VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'accepted', v_event_id);

  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false,
    'memory_id', v_memory_id, 'event_id', v_event_id, 'event_type', v_event_type,
    'sequence', v_seq, 'result', v_result, 'contract_version', 1);
END;
$fn$;


REVOKE ALL ON FUNCTION public.memory_kernel_execute(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_kernel_execute(jsonb) TO service_role;

COMMIT;
