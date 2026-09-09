-- 2711_memory_kernel_execute.sql
--
-- WHAT: public.memory_kernel_execute(jsonb) — the ONE function that applies a
-- MemoryCommand to canonical state and writes the domain event, the outbox row,
-- the idempotency receipt and the command-audit row IN THE SAME TRANSACTION.
-- service_role only.
--
-- Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
--   §5   Memory lifecycle: CANDIDATE -> CONFIRMED -> ACTIVE -> ARCHIVED, with
--        REJECTED / MERGED / DELETED as the arrows off that spine (line 207).
--   §17  the command boundary, the seventeen commands, the fourteen events, and
--        "Use an outbox pattern: canonical mutation and event-outbox insert
--        occur in one database transaction." (line 478 ff.)
--   §19  server-side idempotency on the sync command (line 539).
--   §21  Archive and Delete are DIFFERENT operations (line 566).
--   §23  canEditMemory; "Participant membership alone does not grant full
--        Memory access"; "Writes to evidence truth levels and inference
--        provenance are server-controlled" (line 596 ff.).
--   §24  reason codes; "Do not log sensitive raw content unless strictly
--        necessary" (line 612 ff.).
--   Appendix A step 7 (line 776): the OWNER "removes one participant".
--
-- WHY A FUNCTION AT ALL
-- ====================
-- supabase-js has no transactions. Measured this session and recorded in
-- src/lib/memoryOutbox.ts: `void sc.from(t).insert(r)` with no .then/.catch/
-- await issues ZERO HTTP requests, and the client RESOLVES rather than rejects
-- on a database error, so a TypeScript "write the row, then write the event"
-- would produce exactly the two failures the outbox pattern exists to prevent —
-- a Memory changed with no event, or an event for a change that never landed —
-- and both would be invisible. Putting the five writes in one SQL function is
-- the only way to make them atomic from the API server. Same reasoning, same
-- shape as public.trip_kernel_execute (migration 2420).
--
-- WHY IT IS SERVICE-ROLE ONLY
-- ===========================
-- Application authorization (owner === user.id, tagged === user.id, the trip
-- owner check) runs in TypeScript BEFORE the call, as it always has. This
-- function re-checks the capability each command needs as defence in depth, but
-- the grant is the boundary: REVOKE from PUBLIC/anon/authenticated is explicit
-- because Supabase's ALTER DEFAULT PRIVILEGES would otherwise hand EXECUTE to
-- all three at CREATE FUNCTION time. SECURITY INVOKER, so the caller's own
-- privileges still apply — this function does not launder a user token into
-- table access it does not have.
--
-- WHAT IT REFUSES, AND HOW
-- ========================
-- Every rejection is RETURNED as { ok:false, reason, ... }, never RAISED, and
-- every rejection happens BEFORE the first canonical write — so a rejected
-- command leaves no partial state. The audit row for a rejection therefore
-- COMMITS, which is the point: §24's reason-code metrics have nothing to count
-- if only successes are recorded. A rejection and a failure are different
-- events and the caller can tell them apart: a failure RAISES, rolls the whole
-- transaction back, and reaches src/lib/memoryCommandBus.ts as
-- MEMORY_KERNEL_UNAVAILABLE.
--
-- §5 AS IMPLEMENTED HERE, INCLUDING THE JUDGMENT CALLS
-- ====================================================
-- The stored vocabulary is 0067_memories.sql's
-- CHECK (state IN ('draft','published','archived','deleted','removed')), which
-- predates the spec. The projection onto §5, and the transition table, are
-- identical to src/lib/memoryCommandBus.ts's — the two are the same rule stated
-- twice on purpose (defence in depth), and src/test/memoryCommandBus.test.ts
-- pins the TypeScript half arrow by arrow.
--
--   draft -> CANDIDATE · published -> ACTIVE · archived -> ARCHIVED
--   deleted -> DELETED · removed -> DELETED
--
--   ALLOWED  draft->published, draft->deleted, published->archived,
--            published->deleted, archived->published, archived->deleted,
--            and any self-transition.
--   REFUSED  anything out of 'deleted' or 'removed' (terminal — §5 draws no
--            arrow out of DELETED, and 'removed' is a MODERATION verdict: the
--            pre-lane PATCH handler gated only on `state <> 'deleted'`, so a
--            plain PATCH {"state":"published"} put moderator-removed content
--            back into the discovery feed. Stated honestly, as 2551 states its
--            own severity: NOTHING in this API server writes state='removed'
--            today, so this closes the door before the room is furnished);
--            published->draft and archived->draft (§5 draws no arrow back into
--            CANDIDATE, and §21 already names the operation for "take it out of
--            normal browsing": Archive. Measured before refusing it —
--            `updateMemory` in travel-buddy-standalone/src/services/memories.ts
--            has ZERO production callers in the client tree);
--            anything -> 'removed' (a moderation verb is not an owner's).
--   PERMITTED THOUGH §5 DRAWS NO ARROW, and why:
--            archived->published — §21 defines Archive as "remove from normal
--            browsing UNLESS EXPLICITLY REQUESTED", reversible by construction;
--            archived->deleted and draft->deleted — §21 lists "Delete Memory"
--            as an action on a Memory, not on an ACTIVE Memory, and an archived
--            or draft Memory its owner could never delete would put D6 account
--            deletion out of reach.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ==================================
--   * MERGE_MEMORY / SPLIT_MEMORY (§17): no memory_relations table (§3.4) and
--     no version chain. NOT declared — an unbacked command name is a claim the
--     code cannot keep.
--   * The five highlight commands (§17): routes/highlights.ts and
--     routes/stories.ts belong to another lane.
--   * SET_RESURFACING_POLICY (§17): §11's user controls have no storage.
--   * No aggregate version / optimistic concurrency: `memories` has no
--     current_version column (§3.1) and adding one is a separate change.
--   * §21's full deletion lifecycle (DELETION_REQUESTED -> PUBLIC_REVOKED ->
--     DERIVATIVES_PURGED -> RAW_EVIDENCE_PURGED -> DELETED): there is no
--     derivative registry (§18) to revoke against. DELETE_MEMORY stays the
--     existing soft delete and emits memory.deleted so that registry, when it
--     exists, has the one event it needs to start from.
--   * No outbox consumer and no projection worker.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2711.
--
-- MUST BE TRUE BEFORE APPLYING:
--   * 2710 has been applied (memory_domain_events, memory_event_outbox,
--     memory_command_receipts, memory_command_audit, and the flag).
--   * public.memories, public.memory_items and public.memory_tags exist with
--     the columns 0067_memories.sql defines.
--   * The flag `memory_kernel_enabled` is still FALSE. Applying this migration
--     does not flip it; nothing calls the function until an operator does.
--
-- REVERSIBLE BY:
--   DROP FUNCTION IF EXISTS public.memory_kernel_execute(jsonb);
--   (Safe while memory_kernel_enabled is false: nothing calls it. If the flag
--   has been flipped, set it false FIRST — routes/memories.ts answers 503
--   MEMORY_KERNEL_UNAVAILABLE for a missing function and will NOT silently fall
--   back to the direct write.)

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

COMMENT ON FUNCTION public.memory_kernel_execute(jsonb) IS
  'Memory Command Bus write path (Highlights/Memories spec §5/§17/§19/§23/§24). Applies ONE MemoryCommand: honours the idempotency receipt, locks and re-checks the Memory''s owner, enforces the §5 lifecycle machine, applies the state change, then writes memory_domain_events + memory_event_outbox + memory_command_receipts + memory_command_audit in the SAME transaction. Rejections are RETURNED with a §24 reason code and still write an audit row; failures RAISE and roll everything back. service_role only; application authorization runs before the call.';

REVOKE ALL ON FUNCTION public.memory_kernel_execute(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_kernel_execute(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.memory_domain_events_refuse_update() FROM PUBLIC, anon, authenticated;

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
  IF has_function_privilege('anon', 'public.memory_kernel_execute(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_kernel_execute(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a client role can EXECUTE memory_kernel_execute';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.memory_kernel_execute(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role cannot EXECUTE memory_kernel_execute';
  END IF;

  -- 2710 must be applied.
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'memory_event_outbox') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: migration 2710 has not been applied';
  END IF;

  -- A malformed command is REJECTED, not raised, and writes no event.
  v := public.memory_kernel_execute('{}'::jsonb);
  IF (v->>'reason') IS DISTINCT FROM 'MEMORY_COMMAND_MALFORMED' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_kernel_execute({}) returned %', v;
  END IF;
  IF EXISTS (SELECT 1 FROM public.memory_domain_events) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a malformed command wrote an event';
  END IF;

  -- An unknown command type is refused by name, and DOES leave an audit row —
  -- that asymmetry is the §24 requirement, asserted rather than assumed.
  v := public.memory_kernel_execute(jsonb_build_object(
        'command_id', gen_random_uuid(), 'actor_user_id', gen_random_uuid(),
        'idempotency_key', 'postcondition-probe', 'type', 'NOT_A_COMMAND',
        'payload', '{}'::jsonb));
  IF (v->>'reason') IS DISTINCT FROM 'MEMORY_COMMAND_UNKNOWN_TYPE' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: unknown type returned %', v;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memory_command_audit
                  WHERE idempotency_key = 'postcondition-probe'
                    AND outcome = 'rejected' AND reason = 'MEMORY_COMMAND_UNKNOWN_TYPE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a rejected command wrote no audit row';
  END IF;
  DELETE FROM public.memory_command_audit WHERE idempotency_key = 'postcondition-probe';

  -- The flag is still FALSE: applying this migration must not turn the kernel on.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_kernel_enabled' AND enabled = false) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_kernel_enabled is not false';
  END IF;
END $$;

COMMIT;
