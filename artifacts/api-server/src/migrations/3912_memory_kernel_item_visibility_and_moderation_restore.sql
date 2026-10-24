-- 3912_memory_kernel_item_visibility_and_moderation_restore.sql
--
-- WHAT: CREATE OR REPLACE public.memory_kernel_execute(jsonb) — 3911's function,
-- byte for byte, plus TWO commands, so that the last two canonical Memory writes
-- outside the kernel cross it (census-highlights-memories §CB.5, §CC):
--
--   1. CHANGE_ITEM_VISIBILITY — a photo's own audience (§10, migration 3672):
--      `memory_items.visibility` NULL (inherits the Memory's) or 'only_me'.
--      Before, PUT /memories/:id/items/:itemId/visibility updated the column
--      directly (services/memory/memoryItemVisibility.ts), with no event, so a
--      photo hidden after a public derivative was built was never re-derived.
--      Now the owner-checked write and `memory.visibility_changed` are one
--      transaction, and a hidden photo's event states the narrower audience
--      ('only_me'), which is what tells a §18 consumer to re-derive.
--   2. MODERATION_RESTORE_MEMORY — the restore an upheld appeal performs
--      (services/appeals/resolveAppeal.ts). Before, it set `state='published'`
--      directly on ANY Memory of the appellant's, including one its owner had
--      deleted. Now: the actor is the moderator and must hold the `admin` role;
--      the command must name the Memory's owner; and it reverses a moderation
--      removal (`removed` -> `published`) and nothing else. Every other state
--      is refused as MEMORY_LIFECYCLE_INVALID_TRANSITION, and the appeal route
--      answers that as a restoration a moderator must decide by hand. It emits
--      `memory.corrected` (§17 names no restore event), DELETED -> ACTIVE.
--
-- Every other branch, reason, receipt, lifecycle rule and event write is
-- 3911's. The signature, SECURITY INVOKER, the pinned search_path and the
-- grants (service_role only) are unchanged. No table, column, row or flag is
-- created, altered or read by applying this file; the postconditions read the
-- catalog and call the function once with an empty command, which writes nothing.
--
-- WRITTEN, NOT APPLIED. Requires 3911 (this replaces its definition; the
-- precondition refuses a 2711-era function so 3911's writes cannot be lost),
-- 3672 (memory_items.visibility) and profiles.role.
--
-- ORDER-INDEPENDENT WITH THE API. Against a kernel without these commands the
-- API's dispatch is answered MEMORY_COMMAND_UNKNOWN_TYPE, and the routes then
-- run their pre-3912 writes, exactly as today (the compat arms). After 3912 the
-- arms never run.
--
-- Rollback: db/rollback/2026-10-24-3912-memory-kernel-item-visibility-and-moderation-restore-rollback.sql
-- re-creates 3911's definition verbatim.

BEGIN;

DO $pre$
DECLARE
  def text;
BEGIN
  IF to_regprocedure('public.memory_kernel_execute(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3912): public.memory_kernel_execute(jsonb) does not exist (2711)';
  END IF;
  def := pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure);
  IF position('INSERT INTO public.memory_tags' IN def) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3912): memory_kernel_execute is not 3911''s (apply 3911 first; 3912 carries its writes forward)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memory_items' AND column_name = 'visibility') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3912): memory_items.visibility does not exist (3672)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'role') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3912): profiles.role does not exist';
  END IF;
END $pre$;

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
  v_tag_ids    uuid[] := '{}'::uuid[];  -- 3911: the participants a CREATE names
  v_tags_written uuid[] := '{}'::uuid[]; -- 3911: the ones it tagged
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
                    'REMOVE_PERSON', 'CHANGE_PLACE', 'CHANGE_VISIBILITY',
                    -- 3912: a photo's own audience, and a moderator's restore of a moderation removal.
                    'CHANGE_ITEM_VISIBILITY', 'MODERATION_RESTORE_MEMORY') THEN
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
    ELSIF v_type = 'MODERATION_RESTORE_MEMORY' THEN
      -- 3912. The ONE command whose actor is not the owner: the moderator who
      -- upheld the owner's appeal. The actor must hold the `admin` role
      -- (lib/requireAdmin.ts's default), and the command must name the
      -- Memory's owner (the appellant): a wrong owner is the old route's
      -- zero-row answer, MEMORY_NOT_FOUND. The event and the audit row name the
      -- moderator, never the owner, because the moderator did it.
      IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_actor AND p.role = 'admin') THEN
        INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
        VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_AUTH_NOT_MODERATOR');
        RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_AUTH_NOT_MODERATOR', 'contract_version', 1);
      END IF;
      IF (v_payload->>'owner_id') IS DISTINCT FROM v_owner::text THEN
        INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
        VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_NOT_FOUND');
        RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_NOT_FOUND', 'contract_version', 1);
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
      WHEN 'MODERATION_RESTORE_MEMORY' THEN 'published'
      ELSE v_patch->>'state'
    END;

    -- 3912. A moderation restore reverses a moderation removal and nothing
    -- else: `removed` -> `published` is the one arrow out of a terminal state,
    -- and only this command draws it. An owner's deletion stays terminal, so an
    -- upheld appeal can never bring back a Memory its owner deleted (and §21
    -- already purged); every state but `removed` is refused by name.
    IF v_type = 'MODERATION_RESTORE_MEMORY' AND v_state IS DISTINCT FROM 'removed' THEN
      INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
      VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_LIFECYCLE_INVALID_TRANSITION');
      RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_LIFECYCLE_INVALID_TRANSITION',
                                'from', v_state, 'to', v_target, 'contract_version', 1);
    END IF;

    IF v_type = 'MODERATION_RESTORE_MEMORY' THEN
      v_from := 'DELETED';
      v_to   := 'ACTIVE';
    ELSIF v_target IS NOT NULL THEN
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

  -- ── 3911: the participants a CREATE names, validated before the first write ──
  -- Before 3911 the routes inserted these tags AFTER this function returned,
  -- outside its transaction, so a create's participants had no event, no
  -- receipt and no outbox row (census-highlights-memories §CA.4 / §CB). The
  -- owner names people at creation; each becomes a PENDING tag (consent is the
  -- tagged person's own ADD_PERSON, unchanged). The actor never tags itself,
  -- an id with no profile is skipped rather than failing the create (the old
  -- route's insert failed the whole batch on one unknown id; profiles.id
  -- references auth.users, which service_role cannot read), and a malformed
  -- list is refused BY NAME before anything is written.
  IF v_type = 'CREATE_MEMORY' AND v_payload ? 'tagged_user_ids' THEN
    IF jsonb_typeof(v_payload->'tagged_user_ids') <> 'array'
       OR jsonb_array_length(v_payload->'tagged_user_ids') > 1000
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_payload->'tagged_user_ids') e
                   WHERE jsonb_typeof(e) <> 'string'
                      OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
      VALUES (v_cmd_id, v_type, NULL, v_actor, v_key, 'rejected', 'MEMORY_COMMAND_MALFORMED');
      RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED',
                                'detail', 'tagged_user_ids must be an array of at most 1000 uuids', 'contract_version', 1);
    END IF;
    SELECT coalesce(array_agg(DISTINCT x::uuid), '{}'::uuid[]) INTO v_tag_ids
      FROM jsonb_array_elements_text(v_payload->'tagged_user_ids') x
     WHERE x::uuid IS DISTINCT FROM v_actor;
  END IF;

  -- ══ APPLY. Every branch has validated fully; the first write happens here. ══
  CASE v_type

    WHEN 'CREATE_MEMORY' THEN
      INSERT INTO public.memories (
        owner_id, title, caption, visibility, allowed_user_ids, hidden_user_ids,
        trip_id, event_id, place_id, location_city, location_country,
        location_lat, location_lng, canonical_location_id, starts_at, ends_at, state,
        place_display_name_at_occurrence)
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
        coalesce(v_write->>'state', 'published'),
        -- 3911 (3804): the occurrence-time place text, as the writer sent it;
        -- 3804's own trigger records a catalog place's name and never rewrites one.
        v_write->>'place_display_name_at_occurrence')
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

      -- 3911 (3803): the §4 MemoryType the writer named. Named exactly when the
      -- write names it, as the pre-kernel insert did, so an unnamed type keeps
      -- the column's DEFAULT. Before 3911 the route wrote it after this function
      -- returned, by a direct UPDATE no event recorded.
      IF v_write ? 'memory_type' THEN
        UPDATE public.memories SET memory_type = v_write->>'memory_type'
         WHERE id = v_row.id
        RETURNING * INTO v_row;
      END IF;

      -- 3911: the participants, in the creating transaction.
      IF cardinality(v_tag_ids) > 0 THEN
        WITH ins AS (
          INSERT INTO public.memory_tags (memory_id, tagged_user_id, status)
          SELECT v_row.id, t, 'pending'
            FROM unnest(v_tag_ids) AS t
           WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = t)
          ON CONFLICT DO NOTHING
          RETURNING tagged_user_id)
        SELECT coalesce(array_agg(tagged_user_id ORDER BY tagged_user_id), '{}'::uuid[])
          INTO v_tags_written FROM ins;
      END IF;

      v_memory_id  := v_row.id;
      v_event_type := 'memory.created';
      v_to := CASE v_row.state
        WHEN 'draft' THEN 'CANDIDATE' WHEN 'published' THEN 'ACTIVE'
        WHEN 'archived' THEN 'ARCHIVED' ELSE 'DELETED' END;
      v_result := to_jsonb(v_row);

    WHEN 'UPDATE_MEMORY', 'CONFIRM_MEMORY', 'ARCHIVE_MEMORY', 'CHANGE_PLACE', 'CHANGE_VISIBILITY', 'MODERATION_RESTORE_MEMORY' THEN
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
        -- 3911: the §4 type and the §9 occurrence text, in the command's own transaction.
        memory_type           = CASE WHEN v_patch ? 'memory_type'           THEN v_patch->>'memory_type'                          ELSE memory_type END,
        place_display_name_at_occurrence = CASE WHEN v_patch ? 'place_display_name_at_occurrence' THEN v_patch->>'place_display_name_at_occurrence' ELSE place_display_name_at_occurrence END,
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
      -- hard-erased when the account goes. §21's lifecycle runs after this
      -- command returns (services/memory/memoryDeletionLifecycle.ts).
      UPDATE public.memories SET state = 'deleted', updated_at = now()
       WHERE id = v_memory_id
      RETURNING * INTO v_row;
      v_event_type := 'memory.deleted';
      v_result := jsonb_build_object('id', v_memory_id);

    WHEN 'ADD_MEDIA' THEN
      INSERT INTO public.memory_items (memory_id, media_url, media_type, caption, position, source_post_id)
      VALUES (v_memory_id,
              v_write->>'media_url',
              coalesce(v_write->>'media_type', 'image/jpeg'),
              v_write->>'caption',
              coalesce((v_write->>'position')::integer, 0),
              -- 3911 (3999): the post a copied photo came from, in the same INSERT;
              -- 3999's own-media guard trigger still decides whether it may be.
              (v_write->>'source_post_id')::uuid)
      RETURNING * INTO v_item;
      v_event_type := 'memory.corrected';
      v_result := to_jsonb(v_item);

    WHEN 'CHANGE_ITEM_VISIBILITY' THEN
      -- 3912: §10 "Media visibility is independent from Memory visibility"
      -- (3672). One photo's own audience: NULL (inherits the Memory's) or
      -- 'only_me'. Before 3912 the route wrote it directly, with no event, so a
      -- photo hidden after a public derivative was built was never re-derived.
      v_item_id := (v_payload->>'item_id')::uuid;
      IF v_item_id IS NULL OR NOT (v_payload ? 'item_visibility')
         OR (jsonb_typeof(v_payload->'item_visibility') <> 'null' AND (v_payload->>'item_visibility') IS DISTINCT FROM 'only_me') THEN
        INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
        VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_COMMAND_MALFORMED');
        RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED',
                                  'detail', 'item_id and item_visibility (only_me or null) are required', 'contract_version', 1);
      END IF;
      UPDATE public.memory_items SET visibility = v_payload->>'item_visibility'
       WHERE id = v_item_id AND memory_id = v_memory_id
      RETURNING * INTO v_item;
      IF NOT FOUND THEN
        INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, actor_user_id, idempotency_key, outcome, reason)
        VALUES (v_cmd_id, v_type, v_memory_id, v_actor, v_key, 'rejected', 'MEMORY_ITEM_NOT_FOUND');
        RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_ITEM_NOT_FOUND', 'contract_version', 1);
      END IF;
      v_event_type := 'memory.visibility_changed';
      v_result := jsonb_build_object('id', v_item_id, 'visibility', v_payload->'item_visibility');

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
                           THEN coalesce(v_patch->>'visibility', v_write->>'visibility')
                           -- 3912: a photo made owner-only states that narrower audience, so a
                           -- §18 consumer re-derives what served it; un-hiding states none (a widening).
                           WHEN v_type = 'CHANGE_ITEM_VISIBILITY' THEN v_payload->>'item_visibility'
                           ELSE NULL END,
      'refs', jsonb_build_object(
        'memory_id',      v_memory_id,
        'actor_user_id',  v_actor,
        'item_id',        v_payload->>'item_id',
        'tagged_user_id', v_payload->>'tagged_user_id')
        -- 3911: the people a CREATE tagged, as ids only (§23), like ADD_PERSON's ref.
        -- Concatenated only when the command named them, so every other event's
        -- refs keep 2711's exact shape.
        || CASE WHEN v_type = 'CREATE_MEMORY' AND v_payload ? 'tagged_user_ids'
                THEN jsonb_build_object('tagged_user_ids', to_jsonb(v_tags_written)) ELSE '{}'::jsonb END),
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
    'sequence', v_seq, 'result', v_result, 'contract_version', 1,
    -- 3911: which participants the create tagged, so a caller never re-inserts them.
    'tagged_user_ids', CASE WHEN v_type = 'CREATE_MEMORY' AND v_payload ? 'tagged_user_ids' THEN to_jsonb(v_tags_written) ELSE NULL END);
END;
$fn$;


COMMENT ON FUNCTION public.memory_kernel_execute(jsonb) IS
  'Memory Command Bus write path (Highlights/Memories spec §5/§17/§19/§23/§24). Applies ONE MemoryCommand: honours the idempotency receipt, locks and re-checks the Memory''s owner (for MODERATION_RESTORE_MEMORY, the moderator''s admin role and the named owner), enforces the §5 lifecycle machine, applies the state change — for a create, its participants (pending tags), its §4 type and its occurrence-time place text; for an edit, the type and occurrence text it names; for ADD_MEDIA, the source post; for CHANGE_ITEM_VISIBILITY, one photo''s own audience; for MODERATION_RESTORE_MEMORY, removed -> published only — then writes memory_domain_events + memory_event_outbox + memory_command_receipts + memory_command_audit in the SAME transaction (2711, extended by 3911 and 3912). Rejections are RETURNED with a §24 reason code and still write an audit row; failures RAISE and roll everything back. service_role only; application authorization runs before the call.';

REVOKE ALL ON FUNCTION public.memory_kernel_execute(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_kernel_execute(jsonb) TO service_role;

-- ── Postconditions (catalog reads, and one call that writes nothing) ─────────
DO $post$
DECLARE
  v   jsonb;
  def text := pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure);
BEGIN
  IF has_function_privilege('anon', 'public.memory_kernel_execute(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_kernel_execute(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3912): a client role can EXECUTE memory_kernel_execute';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.memory_kernel_execute(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3912): service_role cannot EXECUTE memory_kernel_execute';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.memory_kernel_execute(jsonb)'::regprocedure)
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.memory_kernel_execute(jsonb)'::regprocedure
                     AND proconfig @> ARRAY['search_path=public, pg_catalog']) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3912): memory_kernel_execute must stay SECURITY INVOKER with its pinned search_path';
  END IF;
  IF position('INSERT INTO public.memory_tags' IN def) = 0
     OR position('jsonb_build_object(''tagged_user_ids'', to_jsonb(v_tags_written))' IN def) = 0
     OR position('THEN v_patch->>''memory_type''' IN def) = 0
     OR position('SET memory_type = v_write->>''memory_type''' IN def) = 0
     OR position('THEN v_patch->>''place_display_name_at_occurrence''' IN def) = 0
     OR position('(v_write->>''source_post_id'')::uuid' IN def) = 0
     OR position('UPDATE public.memory_items SET visibility = v_payload->>''item_visibility''' IN def) = 0
     OR position('p.role = ''admin''' IN def) = 0
     OR position('IF v_type = ''MODERATION_RESTORE_MEMORY'' AND v_state IS DISTINCT FROM ''removed'' THEN' IN def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3912): memory_kernel_execute does not carry the 3911 and 3912 writes';
  END IF;
  -- 2711's malformed-command contract is unchanged: refused, and nothing written.
  v := public.memory_kernel_execute('{}'::jsonb);
  IF (v->>'reason') IS DISTINCT FROM 'MEMORY_COMMAND_MALFORMED' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3912): memory_kernel_execute({}) returned %', v;
  END IF;
END $post$;

COMMIT;
