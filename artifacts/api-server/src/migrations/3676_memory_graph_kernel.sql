-- 3676_memory_graph_kernel.sql
-- Highlights/Memories spec §17 MERGE_MEMORY / SPLIT_MEMORY and their events
-- memory.merged / memory.split; §5 MERGED; §19 idempotency; §22 stable IDs and
-- URLs; §23 owner-only; §25 "Merge two Memories then split differently".
-- Census H134, H135, H150, H151, H194. Decision: docs/architecture/
-- memories-graph-model-decision.md §3.2 to §3.5.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane H 3670-3689).
-- APPLIED TO NO DATABASE by the lane that wrote it. One function. No table, no
-- row, no flag: the routes that call it are behind memory_merge_split_enabled
-- (3674, seeded FALSE).
--
-- THE 2711 SHAPE, A THIRD KERNEL FUNCTION. memory_kernel_execute (2711) and
-- highlight_kernel_execute (2993) are one function per aggregate; merge and split
-- change SEVERAL Memories at once, so they get their own function rather than a
-- CREATE OR REPLACE of 2711's (which every Memory write depends on). The four
-- kernel tables are the same: the canonical change, the domain event(s), the
-- outbox row(s), the idempotency receipt and the audit row commit together or
-- not at all. Rejections are RETURNED with a §24 reason code and an audit row.
--
-- MERGE (survivor = memory_id, payload.absorbed_memory_ids):
--   refusals  MEMORY_COMMAND_MALFORMED, MEMORY_MERGE_INVALID (survivor among the
--             absorbed, duplicates, none, more than 20), MEMORY_NOT_FOUND (any
--             absent or deleted), MEMORY_AUTH_NOT_OWNER, MEMORY_LIFECYCLE_TERMINAL
--             (any removed), MEMORY_MERGE_AUDIENCE_MISMATCH (state, visibility,
--             allow-list, hide-list as sets, and trip_id under trip_crew must be
--             identical: a merge never moves content to a wider audience, and
--             never publishes a draft).
--   locks     every Memory FOR UPDATE in id order (two overlapping merges cannot
--             deadlock).
--   moves     items (appended after the survivor's last position, each keeping
--             its 3672 visibility); tags (LEAST consent wins: removed < pending
--             < approved, so a person who withdrew from any part is withdrawn
--             from the whole, and nobody is upgraded to approved); likes and
--             saves (deduplicated); resurfacing controls (3671, the union);
--             candidate evidence links (2320, re-pointed: memory_evidence is
--             append-only, so the link is copied to the survivor and the old link
--             deleted, which DELETE-free 2320 permits); earlier redirects into an
--             absorbed Memory (one hop always).
--   then      absorbed state = 'deleted' (every reader already treats it as gone),
--             a memory_id_redirects row per absorbed id, memory.merged on the
--             survivor with ids and counts only.
--   The route then runs §21's deletion lifecycle for each absorbed Memory
--   (derivatives rebuilt without it, H-5; its place corrections purged, H-13).
--
-- SPLIT (source = memory_id, payload.item_ids, optional payload.title):
--   refusals  MEMORY_COMMAND_MALFORMED, MEMORY_SPLIT_INVALID (no items, more
--             than 200, duplicates, or ALL the source's items: a split never
--             empties the source), MEMORY_NOT_FOUND, MEMORY_AUTH_NOT_OWNER,
--             MEMORY_LIFECYCLE_TERMINAL, MEMORY_ITEM_NOT_FOUND (an item that is
--             not the source's).
--   creates   a NEW Memory that is a copy of the source ROW (every column, so the
--             audience, the place, the times and location_precision (2338) can
--             never be dropped to a wider default), with a new id, source_mode
--             USER_CREATED and fresh timestamps; the listed items move to it.
--   carries   the source's place corrections (3673; the owner's negative
--             constraints still hold) and resurfacing controls (3671).
--   NOT       tags: a split never names a person on a Memory they were not
--             tagged on.
--   records   a DERIVED_FROM edge new -> source (USER_CREATED), memory.split on
--             the source and on the new Memory (ids only).
--
-- Rollback: db/rollback/2026-10-10-3676-memory-graph-kernel-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.memory_command_receipts') IS NULL OR to_regclass('public.memory_command_audit') IS NULL
     OR to_regclass('public.memory_domain_events') IS NULL OR to_regclass('public.memory_event_outbox') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3676): the 2710 kernel tables are missing.';
  END IF;
  IF to_regclass('public.memory_id_redirects') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                      AND table_name = 'memories' AND column_name = 'source_mode') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3676): 3674 is not applied.';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.memory_graph_kernel_execute(p_command jsonb)
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
  v_observed   timestamptz;
  v_receipt    public.memory_command_receipts%ROWTYPE;
  v_reason     text;
  v_detail     text;
  v_absorbed   uuid[];
  v_all        uuid[];
  v_items      uuid[];
  v_n          integer;
  v_total      integer;
  v_offset     integer;
  v_moved      integer := 0;
  v_tags       integer := 0;
  v_likes      integer := 0;
  v_saves      integer := 0;
  v_controls   integer := 0;
  v_links      integer := 0;
  v_new_id     uuid;
  v_src        public.memories%ROWTYPE;
  v_event_id   uuid;
  v_event2     uuid;
  v_event_type text;
  v_seq        bigint;
  v_result     jsonb;
  v_payload_ev jsonb;
BEGIN
  -- ── envelope (2711's) ──────────────────────────────────────────────────────
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
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 1);
  END;

  IF v_actor IS NULL OR v_cmd_id IS NULL OR v_type IS NULL OR v_key IS NULL
     OR char_length(v_key) < 1 OR char_length(v_key) > 200
     OR jsonb_typeof(v_payload) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED', 'contract_version', 1);
  END IF;

  IF v_type NOT IN ('MERGE_MEMORY', 'SPLIT_MEMORY') THEN
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_COMMAND_UNKNOWN_TYPE');
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_UNKNOWN_TYPE', 'detail', v_type, 'contract_version', 1);
  END IF;

  -- ── idempotency (§19): same key, same actor => the ORIGINAL answer ─────────
  SELECT * INTO v_receipt FROM public.memory_command_receipts
   WHERE actor_user_id = v_actor AND idempotency_key = v_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.command_type IS DISTINCT FROM v_type THEN
      INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
      VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_IDEMPOTENCY_KEY_REUSED');
      RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_IDEMPOTENCY_KEY_REUSED',
                                'detail', format('key already used for %s', v_receipt.command_type), 'contract_version', 1);
    END IF;
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, event_id)
    VALUES (v_cmd_id, v_type, v_receipt.memory_id, v_actor, v_key, 'duplicate', v_receipt.event_id);
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'memory_id', v_receipt.memory_id,
                              'event_id', v_receipt.event_id, 'event_type', v_receipt.event_type,
                              'result', v_receipt.result_json, 'contract_version', 1);
  END IF;

  -- ── payload ────────────────────────────────────────────────────────────────
  v_reason := NULL;
  IF v_memory_id IS NULL THEN
    v_reason := 'MEMORY_COMMAND_MALFORMED'; v_detail := 'memory_id required';
  ELSIF v_type = 'MERGE_MEMORY' THEN
    BEGIN
      IF jsonb_typeof(v_payload->'absorbed_memory_ids') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'not an array'; END IF;
      SELECT coalesce(array_agg(x::uuid), '{}') INTO v_absorbed FROM jsonb_array_elements_text(v_payload->'absorbed_memory_ids') x;
    EXCEPTION WHEN OTHERS THEN
      v_reason := 'MEMORY_COMMAND_MALFORMED'; v_detail := 'absorbed_memory_ids must be an array of uuids';
    END;
    IF v_reason IS NULL AND (cardinality(v_absorbed) < 1 OR cardinality(v_absorbed) > 20
        OR v_memory_id = ANY (v_absorbed)
        OR (SELECT count(DISTINCT a) FROM unnest(v_absorbed) a) <> cardinality(v_absorbed)) THEN
      v_reason := 'MEMORY_MERGE_INVALID'; v_detail := '1-20 distinct absorbed Memories, none of them the survivor';
    END IF;
  ELSE
    BEGIN
      IF jsonb_typeof(v_payload->'item_ids') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'not an array'; END IF;
      SELECT coalesce(array_agg(x::uuid), '{}') INTO v_items FROM jsonb_array_elements_text(v_payload->'item_ids') x;
      IF v_payload ? 'title' AND jsonb_typeof(v_payload->'title') NOT IN ('string', 'null') THEN RAISE EXCEPTION 'bad title'; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_reason := 'MEMORY_COMMAND_MALFORMED'; v_detail := 'item_ids must be an array of uuids; title a string';
    END;
    IF v_reason IS NULL AND (cardinality(v_items) < 1 OR cardinality(v_items) > 200
        OR (SELECT count(DISTINCT i) FROM unnest(v_items) i) <> cardinality(v_items)) THEN
      v_reason := 'MEMORY_SPLIT_INVALID'; v_detail := '1-200 distinct item ids';
    END IF;
  END IF;
  IF v_reason IS NOT NULL THEN
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', v_reason);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'detail', v_detail, 'contract_version', 1);
  END IF;

  -- ── lock, then check owner / state / audience (§23, §5) ───────────────────
  v_all := CASE WHEN v_type = 'MERGE_MEMORY' THEN v_absorbed || v_memory_id ELSE ARRAY[v_memory_id] END;
  PERFORM 1 FROM public.memories WHERE id = ANY (v_all) ORDER BY id FOR UPDATE;

  SELECT count(*) INTO v_n FROM public.memories WHERE id = ANY (v_all) AND state <> 'deleted';
  IF v_n <> cardinality(v_all) THEN
    v_reason := 'MEMORY_NOT_FOUND';
  ELSIF EXISTS (SELECT 1 FROM public.memories WHERE id = ANY (v_all) AND owner_id IS DISTINCT FROM v_actor) THEN
    v_reason := 'MEMORY_AUTH_NOT_OWNER';
  ELSIF EXISTS (SELECT 1 FROM public.memories WHERE id = ANY (v_all) AND state = 'removed') THEN
    v_reason := 'MEMORY_LIFECYCLE_TERMINAL';
  ELSIF v_type = 'MERGE_MEMORY' AND (
      SELECT count(DISTINCT (m.state, m.visibility,
                             (SELECT coalesce(array_agg(DISTINCT u ORDER BY u), '{}') FROM unnest(m.allowed_user_ids) u),
                             (SELECT coalesce(array_agg(DISTINCT u ORDER BY u), '{}') FROM unnest(m.hidden_user_ids) u),
                             CASE WHEN m.visibility = 'trip_crew' THEN m.trip_id END))
        FROM public.memories m WHERE m.id = ANY (v_all)) <> 1 THEN
    v_reason := 'MEMORY_MERGE_AUDIENCE_MISMATCH';
  ELSIF v_type = 'SPLIT_MEMORY' THEN
    SELECT count(*) INTO v_total FROM public.memory_items WHERE memory_id = v_memory_id;
    SELECT count(*) INTO v_n FROM public.memory_items WHERE memory_id = v_memory_id AND id = ANY (v_items);
    IF v_n <> cardinality(v_items) THEN
      v_reason := 'MEMORY_ITEM_NOT_FOUND';
    ELSIF v_n = v_total THEN
      v_reason := 'MEMORY_SPLIT_INVALID'; v_detail := 'a split must leave at least one item on the source';
    END IF;
  END IF;
  IF v_reason IS NOT NULL THEN
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', v_reason);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'detail', v_detail, 'contract_version', 1);
  END IF;

  -- ══ APPLY. Everything has been validated; the first write is here. ═════════
  IF v_type = 'MERGE_MEMORY' THEN
    SELECT coalesce(max(position), -1) + 1 INTO v_offset FROM public.memory_items WHERE memory_id = v_memory_id;
    UPDATE public.memory_items i
       SET memory_id = v_memory_id, position = v_offset + o.rn - 1
      FROM (SELECT it.id, row_number() OVER (ORDER BY array_position(v_absorbed, it.memory_id), it.position, it.created_at, it.id) AS rn
              FROM public.memory_items it WHERE it.memory_id = ANY (v_absorbed)) o
     WHERE i.id = o.id;
    GET DIAGNOSTICS v_moved = ROW_COUNT;

    -- Least consent wins (removed 0 < pending 1 < approved 2).
    INSERT INTO public.memory_tags AS t (memory_id, tagged_user_id, status, created_at)
    SELECT DISTINCT ON (s.tagged_user_id) v_memory_id, s.tagged_user_id, s.status, s.created_at
      FROM public.memory_tags s WHERE s.memory_id = ANY (v_absorbed)
     ORDER BY s.tagged_user_id, CASE s.status WHEN 'removed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, s.created_at
    ON CONFLICT (memory_id, tagged_user_id) DO UPDATE
      SET status = CASE WHEN (CASE EXCLUDED.status WHEN 'removed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END)
                           < (CASE t.status WHEN 'removed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END)
                        THEN EXCLUDED.status ELSE t.status END;
    GET DIAGNOSTICS v_tags = ROW_COUNT;
    DELETE FROM public.memory_tags WHERE memory_id = ANY (v_absorbed);

    INSERT INTO public.memory_likes (memory_id, user_id, created_at)
    SELECT DISTINCT ON (l.user_id) v_memory_id, l.user_id, l.created_at
      FROM public.memory_likes l WHERE l.memory_id = ANY (v_absorbed) ORDER BY l.user_id, l.created_at
    ON CONFLICT (memory_id, user_id) DO NOTHING;
    GET DIAGNOSTICS v_likes = ROW_COUNT;
    DELETE FROM public.memory_likes WHERE memory_id = ANY (v_absorbed);

    INSERT INTO public.memory_saves (memory_id, user_id, created_at)
    SELECT DISTINCT ON (s.user_id) v_memory_id, s.user_id, s.created_at
      FROM public.memory_saves s WHERE s.memory_id = ANY (v_absorbed) ORDER BY s.user_id, s.created_at
    ON CONFLICT (memory_id, user_id) DO NOTHING;
    GET DIAGNOSTICS v_saves = ROW_COUNT;
    DELETE FROM public.memory_saves WHERE memory_id = ANY (v_absorbed);

    IF to_regclass('public.memory_resurfacing_preferences') IS NOT NULL THEN
      INSERT INTO public.memory_resurfacing_preferences (memory_id, owner_id, control, created_at)
      SELECT v_memory_id, p.owner_id, p.control, min(p.created_at)
        FROM public.memory_resurfacing_preferences p WHERE p.memory_id = ANY (v_absorbed)
       GROUP BY p.owner_id, p.control
      ON CONFLICT (memory_id, control) DO NOTHING;
      GET DIAGNOSTICS v_controls = ROW_COUNT;
    END IF;

    IF to_regclass('public.memory_evidence') IS NOT NULL THEN
      INSERT INTO public.memory_evidence (episode_id, user_id, truth_level, source_class, source_table, source_id, source_ref, observed_at, weight)
      SELECT e.episode_id, e.user_id, e.truth_level, e.source_class, e.source_table, v_memory_id::text, e.source_ref, e.observed_at, e.weight
        FROM public.memory_evidence e
       WHERE e.source_table = 'memories' AND e.user_id = v_actor
         AND e.source_id = ANY (SELECT a::text FROM unnest(v_absorbed) a)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_links = ROW_COUNT;
      DELETE FROM public.memory_evidence e
       WHERE e.source_table = 'memories' AND e.user_id = v_actor
         AND e.source_id = ANY (SELECT a::text FROM unnest(v_absorbed) a);
    END IF;

    UPDATE public.memory_id_redirects SET new_memory_id = v_memory_id WHERE new_memory_id = ANY (v_absorbed);
    INSERT INTO public.memory_id_redirects (old_memory_id, new_memory_id, owner_id, reason, command_id)
    SELECT a, v_memory_id, v_actor, 'merged', v_cmd_id FROM unnest(v_absorbed) a;

    UPDATE public.memories SET state = 'deleted', updated_at = now() WHERE id = ANY (v_absorbed);
    UPDATE public.memories SET updated_at = now() WHERE id = v_memory_id;

    v_event_type := 'memory.merged';
    v_result := jsonb_build_object(
      'survivor_id', v_memory_id,
      'absorbed_memory_ids', to_jsonb(v_absorbed),
      'moved', jsonb_build_object('items', v_moved, 'tags', v_tags, 'likes', v_likes, 'saves', v_saves,
                                  'controls', v_controls, 'evidence_links', v_links));
    v_payload_ev := jsonb_build_object(
      'command_type', v_type, 'from_state', NULL, 'to_state', NULL,
      'refs', jsonb_build_object('memory_id', v_memory_id, 'actor_user_id', v_actor,
                                 'absorbed_memory_ids', to_jsonb(v_absorbed)),
      'counts', v_result->'moved');
  ELSE
    SELECT * INTO v_src FROM public.memories WHERE id = v_memory_id;
    v_new_id := gen_random_uuid();
    -- A copy of the WHOLE row: every audience, place, time and precision column
    -- comes along, including any a later migration adds.
    INSERT INTO public.memories
    SELECT (jsonb_populate_record(NULL::public.memories,
              to_jsonb(v_src) || jsonb_build_object(
                'id', v_new_id, 'created_at', now(), 'updated_at', now(), 'source_mode', 'USER_CREATED',
                'title', CASE WHEN v_payload ? 'title' THEN v_payload->'title' ELSE to_jsonb(v_src.title) END))).*;

    UPDATE public.memory_items SET memory_id = v_new_id WHERE memory_id = v_memory_id AND id = ANY (v_items);
    GET DIAGNOSTICS v_moved = ROW_COUNT;

    IF to_regclass('public.memory_corrections') IS NOT NULL THEN
      INSERT INTO public.memory_corrections (memory_id, owner_id, field, kind, place_id, canonical_location_id, source, created_at)
      SELECT v_new_id, c.owner_id, c.field, c.kind, c.place_id, c.canonical_location_id, c.source, c.created_at
        FROM public.memory_corrections c WHERE c.memory_id = v_memory_id;
    END IF;
    IF to_regclass('public.memory_resurfacing_preferences') IS NOT NULL THEN
      INSERT INTO public.memory_resurfacing_preferences (memory_id, owner_id, control, created_at)
      SELECT v_new_id, p.owner_id, p.control, p.created_at
        FROM public.memory_resurfacing_preferences p WHERE p.memory_id = v_memory_id
      ON CONFLICT (memory_id, control) DO NOTHING;
      GET DIAGNOSTICS v_controls = ROW_COUNT;
    END IF;

    INSERT INTO public.memory_relations
      (owner_id, source_type, source_id, target_type, target_id, relation_type, confidence,
       source_mode, detector_version, reason_code)
    VALUES (v_actor, 'MEMORY', v_new_id, 'MEMORY', v_memory_id::text, 'DERIVED_FROM', NULL,
            'USER_CREATED', 'memory-split@1', 'USER_SPLIT');

    UPDATE public.memories SET updated_at = now() WHERE id = v_memory_id;

    v_event_type := 'memory.split';
    v_result := jsonb_build_object('source_memory_id', v_memory_id, 'new_memory_id', v_new_id,
                                   'moved_item_ids', to_jsonb(v_items), 'controls', v_controls);
    v_payload_ev := jsonb_build_object(
      'command_type', v_type, 'from_state', NULL, 'to_state', NULL,
      'refs', jsonb_build_object('memory_id', v_memory_id, 'actor_user_id', v_actor,
                                 'new_memory_id', v_new_id, 'item_ids', to_jsonb(v_items)));
  END IF;

  -- ── event(s) + outbox + receipt + audit, same transaction ─────────────────
  SELECT coalesce(max(sequence), 0) + 1 INTO v_seq FROM public.memory_domain_events WHERE memory_id = v_memory_id;
  INSERT INTO public.memory_domain_events (memory_id, sequence, type, actor_user_id, causation_id, correlation_id, payload_json, schema_version, occurred_at)
  VALUES (v_memory_id, v_seq, v_event_type, v_actor, v_cmd_id, v_corr, v_payload_ev, 1, coalesce(v_observed, now()))
  RETURNING event_id INTO v_event_id;
  INSERT INTO public.memory_event_outbox (event_id, memory_id, type) VALUES (v_event_id, v_memory_id, v_event_type);

  IF v_type = 'SPLIT_MEMORY' THEN
    -- The new Memory's own stream starts here, so the consumer builds its projections.
    INSERT INTO public.memory_domain_events (memory_id, sequence, type, actor_user_id, causation_id, correlation_id, payload_json, schema_version, occurred_at)
    VALUES (v_new_id, 1, v_event_type, v_actor, v_cmd_id, v_corr, v_payload_ev, 1, coalesce(v_observed, now()))
    RETURNING event_id INTO v_event2;
    INSERT INTO public.memory_event_outbox (event_id, memory_id, type) VALUES (v_event2, v_new_id, v_event_type);
  END IF;

  INSERT INTO public.memory_command_receipts (actor_user_id, idempotency_key, command_id, command_type, memory_id, event_id, event_type, result_json)
  VALUES (v_actor, v_key, v_cmd_id, v_type, v_memory_id, v_event_id, v_event_type, v_result);
  INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, event_id)
  VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'accepted', v_event_id);

  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'memory_id', v_memory_id, 'event_id', v_event_id,
                            'event_type', v_event_type, 'sequence', v_seq, 'result', v_result, 'contract_version', 1);
END;
$fn$;

COMMENT ON FUNCTION public.memory_graph_kernel_execute(jsonb) IS
  'MERGE_MEMORY / SPLIT_MEMORY (Highlights/Memories spec §17; migration 3676). The 2711 shape: receipt-checked, owner/state/audience re-checked under FOR UPDATE locks, the canonical change plus memory.merged / memory.split events, outbox rows, receipt and audit in ONE transaction. Rejections are returned with a §24 reason code and an audit row. service_role only; the routes run their own owner check first.';

REVOKE ALL ON FUNCTION public.memory_graph_kernel_execute(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_graph_kernel_execute(jsonb) TO service_role;

-- ── Postconditions (catalog + a probe that writes nothing) ──────────────────
DO $post$
DECLARE v jsonb;
BEGIN
  IF to_regprocedure('public.memory_graph_kernel_execute(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3676): memory_graph_kernel_execute was not created';
  END IF;
  IF has_function_privilege('anon', 'public.memory_graph_kernel_execute(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_graph_kernel_execute(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3676): a client role can EXECUTE memory_graph_kernel_execute';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.memory_graph_kernel_execute(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3676): service_role cannot EXECUTE memory_graph_kernel_execute';
  END IF;
  -- A malformed envelope is RETURNED as a refusal and writes nothing (no audit
  -- row: it has no actor to attribute one to).
  v := public.memory_graph_kernel_execute('{}'::jsonb);
  IF (v->>'reason') IS DISTINCT FROM 'MEMORY_COMMAND_MALFORMED' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3676): memory_graph_kernel_execute({}) returned %', v;
  END IF;
  IF (SELECT count(*) FROM public.feature_flags WHERE flag = 'memory_merge_split_enabled' AND enabled = false) <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3676): memory_merge_split_enabled must exist and be FALSE';
  END IF;
END $post$;

COMMIT;
