-- Rollback for 2500_trip_kernel_join_via_link_and_host.sql
-- NOT applied anywhere as of 2026-09-07: not to portava-ci (hwokxgbmezheskbzskfr),
-- not to travel-buddy production (ajrurzioarfkagpuxfnb). Probed on portava-ci
-- inside a rolled-back transaction only.
--
-- WHAT 2500 DID
-- =============
--   * CREATE OR REPLACE FUNCTION trip_kernel_execute(jsonb) — contract v2 body
--     + JOIN_VIA_LINK (capability link_holder) + ADD_PARTICIPANT /
--     SET_PARTICIPANT_ROLE capability 'owner' -> 'host'
--   * COMMENT ON FUNCTION (text only)
--   * UPDATE feature_flags.description for trip_kernel_enabled (text only)
--   No table, column, constraint, grant or flag VALUE changed.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores the 2450 (contract v2) function body VERBATIM — generated from
-- artifacts/api-server/src/migrations/2450_trip_kernel_trip_and_participant_families.sql
-- section 2; if that file and this one ever disagree, 2450 is authoritative —
-- and the 2450 COMMENT and flag description.
--
-- Nothing a user can observe changes while trip_kernel_enabled is FALSE (its
-- seeded value; 2500 does not touch it). If the flag was ever TRUE on this
-- database, the invite-link join in routes/trips-expansion.ts will find the
-- v2 function refusing JOIN_VIA_LINK with TRIP_COMMAND_UNKNOWN_TYPE (a 400,
-- after the slot was claimed and then released by the route's compensation)
-- and a co-host's join-request approval will be refused TRIP_AUTH_NOT_OWNER —
-- so flip the flag FIRST.
--
-- Data: NOTHING is deleted. Events of type trip.participant_joined with
-- payload.via = 'invite_link' and receipts with command_type = 'JOIN_VIA_LINK'
-- are valid v2 rows (no constraint names the command type) and stay as the
-- durable record of joins that happened. Canonical rows are not touched.
--
-- Idempotent: CREATE OR REPLACE.

BEGIN;

-- 1. Contract v2 function body (2450 §2), verbatim.
CREATE OR REPLACE FUNCTION public.trip_kernel_execute(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_trip_id    uuid;
  v_actor      uuid;
  v_actor_role text;
  v_cmd_id     uuid;
  v_corr       uuid;
  v_key        text;
  v_type       text;
  v_payload    jsonb;
  v_patch      jsonb;
  v_expected   bigint;
  v_observed   timestamptz;
  v_current    bigint;
  v_next       bigint;
  v_seq        bigint;
  v_event_id   uuid;
  v_event_type text;
  v_result     jsonb;
  v_receipt    public.trip_command_receipts%ROWTYPE;
  v_row        public.trip_plan_items%ROWTYPE;
  v_trip       public.trips%ROWTYPE;
  v_member     public.trip_members%ROWTYPE;
  v_item_id    uuid;
  v_subject    uuid;
  v_status     text;
  v_new_status text;
  v_role       text;
  v_new_role   text;
  v_required   text;
  v_is_owner   boolean;
  v_start      date;
  v_end        date;
  v_n          integer;
  v_el         jsonb;
  v_k          text;
  v_family     text;
  c_trip_patch CONSTANT text[] := ARRAY[
    'title','destination_city','destination_country','destination_lat','destination_lng',
    'destination_place_id','start_date','end_date','status','visibility','trip_type','timezone',
    'travel_style','open_to_meet','cover_url','cover_media_type','cover_image_width',
    'cover_image_height','trip_notes','show_on_profile','show_in_discovery',
    'allow_friend_suggestions','allow_trip_crew_invites','allow_join_requests','show_exact_dates',
    'show_destination_city','delayed_posting_default','precise_location_visible',
    'plan_edit_permission','progress','show_header_publicly'];
BEGIN
  BEGIN
    v_trip_id    := (p_command->>'trip_id')::uuid;
    v_actor      := (p_command->>'actor_user_id')::uuid;
    v_actor_role := coalesce(p_command->>'actor_role', 'user');
    v_cmd_id     := (p_command->>'command_id')::uuid;
    v_corr       := (p_command->>'correlation_id')::uuid;
    v_key        := p_command->>'idempotency_key';
    v_type       := p_command->>'type';
    v_payload    := coalesce(p_command->'payload', '{}'::jsonb);
    v_expected   := (p_command->>'expected_trip_version')::bigint;
    v_observed   := (p_command->>'client_observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
  END;

  IF v_trip_id IS NULL OR v_cmd_id IS NULL OR v_type IS NULL
     OR v_key IS NULL OR char_length(v_key) < 1 OR char_length(v_key) > 200
     OR jsonb_typeof(v_payload) <> 'object'
     OR v_actor_role NOT IN ('user', 'admin', 'system')
     OR (v_actor IS NULL AND v_actor_role <> 'system') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
  END IF;

  -- Command type -> required actor capability. Unknown type is refused before
  -- any lock is taken.
  v_required := CASE v_type
    WHEN 'ADD_PLAN' THEN 'crew' WHEN 'UPDATE_PLAN' THEN 'crew' WHEN 'MOVE_PLAN' THEN 'crew'
    WHEN 'CONFIRM_PLAN' THEN 'crew' WHEN 'CANCEL_PLAN' THEN 'crew' WHEN 'COMPLETE_ACTIVITY' THEN 'crew'
    WHEN 'REMOVE_PLAN' THEN 'crew' WHEN 'REORDER_PLAN' THEN 'crew' WHEN 'LINK_PLAN_ROUTE_STOP' THEN 'crew'
    WHEN 'CREATE_TRIP' THEN 'none'
    WHEN 'UPDATE_TRIP' THEN 'owner' WHEN 'CANCEL_TRIP' THEN 'owner'
    WHEN 'COMPLETE_TRIP' THEN 'owner' WHEN 'ARCHIVE_TRIP' THEN 'owner'
    WHEN 'INVITE_PARTICIPANT' THEN 'owner' WHEN 'ADD_PARTICIPANT' THEN 'owner'
    WHEN 'SET_PARTICIPANT_ROLE' THEN 'owner' WHEN 'REMOVE_PARTICIPANT' THEN 'owner'
    WHEN 'ACCEPT_INVITE' THEN 'invited' WHEN 'DECLINE_INVITE' THEN 'invited'
    WHEN 'ADMIN_HIDE_TRIP' THEN 'admin'
    WHEN 'SET_TRIP_COVER' THEN 'system'
    ELSE NULL END;
  IF v_required IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_UNKNOWN_TYPE', 'type', v_type, 'contract_version', 2);
  END IF;

  -- actor_role must match the command's family: a user-role envelope cannot
  -- issue an admin or system command and vice versa (§6.2).
  IF (v_required = 'admin'  AND v_actor_role <> 'admin')
     OR (v_required = 'system' AND v_actor_role <> 'system')
     OR (v_required NOT IN ('admin', 'system') AND v_actor_role <> 'user') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_ROLE_NOT_PERMITTED',
                              'actor_role', v_actor_role, 'type', v_type, 'contract_version', 2);
  END IF;

  -- ── CREATE_TRIP: there is no aggregate to lock yet ─────────────────────────
  IF v_type = 'CREATE_TRIP' THEN
    PERFORM 1 FROM public.trips WHERE id = v_trip_id FOR UPDATE;
    IF FOUND THEN
      -- Replay of the creating command returns the receipt; any other command
      -- against an existing id is an identity collision, not a create.
      SELECT * INTO v_receipt FROM public.trip_command_receipts
       WHERE trip_id = v_trip_id AND idempotency_key = v_key;
      IF FOUND AND v_receipt.command_type = 'CREATE_TRIP' AND v_receipt.actor_user_id IS NOT DISTINCT FROM v_actor THEN
        RETURN jsonb_build_object('ok', true, 'duplicate', true, 'version', v_receipt.result_version,
                                  'event_id', v_receipt.event_id, 'result', v_receipt.result_json, 'contract_version', 2);
      END IF;
      RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_IDENTITY_ALREADY_EXISTS', 'contract_version', 2);
    END IF;
    IF v_payload ? 'status' AND (v_payload->>'status') NOT IN ('draft','planning','upcoming','active','completed','cancelled','archived') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'status not in trip_status', 'contract_version', 2);
    END IF;
    IF v_payload ? 'visibility' AND (v_payload->>'visibility') NOT IN ('public','buddies','private','invite') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'visibility not in trip_visibility', 'contract_version', 2);
    END IF;
    BEGIN
      IF v_payload ? 'owner_id' AND (v_payload->>'owner_id')::uuid IS DISTINCT FROM v_actor THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'owner_id must be the actor', 'contract_version', 2);
      END IF;
      v_start := (v_payload->>'start_date')::date;
      v_end   := (v_payload->>'end_date')::date;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
    END;
    IF v_start IS NOT NULL AND v_end IS NOT NULL AND v_start > v_end THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_TEMPORAL_RANGE_INVERTED',
                                'start_date', v_start, 'end_date', v_end, 'contract_version', 2);
    END IF;
    INSERT INTO public.trips (
      id, owner_id, title, destination_city, destination_country, start_date, end_date, status, visibility,
      cover_url, cover_media_type, cover_image_width, cover_image_height, trip_notes, show_header_publicly)
    VALUES (
      v_trip_id, v_actor,
      v_payload->>'title',
      v_payload->>'destination_city',
      v_payload->>'destination_country',
      v_start, v_end,
      coalesce(v_payload->>'status', 'planning')::trip_status,
      coalesce(v_payload->>'visibility', 'private')::trip_visibility,
      v_payload->>'cover_url',
      v_payload->>'cover_media_type',
      (v_payload->>'cover_image_width')::integer,
      (v_payload->>'cover_image_height')::integer,
      v_payload->>'trip_notes',
      coalesce((v_payload->>'show_header_publicly')::boolean, coalesce(v_payload->>'visibility', 'private') = 'public'))
    RETURNING * INTO v_trip;
    v_current    := 0;
    v_event_type := 'trip.created';
    v_result     := to_jsonb(v_trip);
    v_family     := 'trip';
  ELSE
    -- ── Every other command: lock the aggregate, then receipt, capability, version ──
    SELECT * INTO v_trip FROM public.trips WHERE id = v_trip_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_NOT_FOUND', 'contract_version', 2);
    END IF;
    v_current := v_trip.version;

    -- Idempotency (§22.4): same key => same answer, no second transition.
    SELECT * INTO v_receipt FROM public.trip_command_receipts
     WHERE trip_id = v_trip_id AND idempotency_key = v_key;
    IF FOUND THEN
      IF v_receipt.actor_user_id IS DISTINCT FROM v_actor OR v_receipt.actor_role IS DISTINCT FROM v_actor_role THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_IDEMPOTENCY_KEY_FOREIGN', 'contract_version', 2);
      END IF;
      RETURN jsonb_build_object(
        'ok', true, 'duplicate', true,
        'version', v_receipt.result_version, 'event_id', v_receipt.event_id,
        'result', v_receipt.result_json, 'contract_version', 2);
    END IF;

    -- Actor capability (§4.1, §6.1) — defence in depth; the route already authorized.
    v_is_owner := (v_trip.owner_id IS NOT DISTINCT FROM v_actor AND v_actor IS NOT NULL)
      OR EXISTS (SELECT 1 FROM public.trip_members m
                  WHERE m.trip_id = v_trip_id AND m.user_id = v_actor
                    AND m.role = 'owner' AND coalesce(m.status, 'accepted') = 'accepted');
    CASE v_required
      WHEN 'crew' THEN
        IF NOT authz.is_accepted_trip_member(v_trip_id, v_actor) THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_CREW', 'contract_version', 2);
        END IF;
      WHEN 'owner' THEN
        IF NOT v_is_owner THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_OWNER', 'contract_version', 2);
        END IF;
      WHEN 'invited' THEN
        SELECT * INTO v_member FROM public.trip_members
         WHERE trip_id = v_trip_id AND user_id = v_actor FOR UPDATE;
        IF NOT FOUND OR v_member.role <> 'invited' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_INVITED',
                                    'current_role', CASE WHEN FOUND THEN v_member.role::text ELSE NULL END,
                                    'contract_version', 2);
        END IF;
      WHEN 'admin' THEN
        IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_actor AND p.role = 'admin') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_ADMIN', 'contract_version', 2);
        END IF;
      ELSE
        NULL; -- 'system': the actor_role gate above is the whole check
    END CASE;

    -- Aggregate version (§4.1, §18.3 "optimistic concurrency; explicit conflict").
    IF v_expected IS NOT NULL AND v_expected <> v_current THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_VERSION_CONFLICT',
                                'current_version', v_current, 'expected_version', v_expected, 'contract_version', 2);
    END IF;

    -- Apply. Each branch validates fully BEFORE its first write.
    v_family := 'plan';
    CASE v_type
      -- ── Plan family — unchanged from 2420 ──────────────────────────────────
      WHEN 'ADD_PLAN' THEN
        IF coalesce(v_payload->>'title', '') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'title required', 'contract_version', 2);
        END IF;
        INSERT INTO public.trip_plan_items (
          trip_id, creator_id, title, category, status, source_type, source_id,
          day_date, starts_at, ends_at, location_name, lat, lng, location_is_private,
          notes, sort_order, lock_type, visibility)
        VALUES (
          v_trip_id, v_actor,
          v_payload->>'title',
          coalesce(v_payload->>'category', 'activity'),
          coalesce(v_payload->>'status', 'tentative'),
          coalesce(v_payload->>'source_type', 'manual'),
          v_payload->>'source_id',
          (v_payload->>'day_date')::date,
          (v_payload->>'starts_at')::timestamptz,
          (v_payload->>'ends_at')::timestamptz,
          v_payload->>'location_name',
          (v_payload->>'lat')::double precision,
          (v_payload->>'lng')::double precision,
          coalesce((v_payload->>'location_is_private')::boolean, false),
          v_payload->>'notes',
          coalesce((v_payload->>'sort_order')::integer, 0),
          coalesce(v_payload->>'lock_type', 'flexible'),
          coalesce(v_payload->>'visibility', 'members'))
        RETURNING * INTO v_row;
        v_event_type := 'trip.plan_added';
        v_result := to_jsonb(v_row);

      WHEN 'UPDATE_PLAN', 'MOVE_PLAN', 'CONFIRM_PLAN', 'CANCEL_PLAN', 'COMPLETE_ACTIVITY' THEN
        v_item_id := (v_payload->>'item_id')::uuid;
        v_patch   := coalesce(v_payload->'patch', '{}'::jsonb);
        IF v_item_id IS NULL OR jsonb_typeof(v_patch) <> 'object' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        SELECT status INTO v_status FROM public.trip_plan_items
         WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_patch ? 'status' THEN
          v_new_status := v_patch->>'status';
          -- §3.3 draws no arrow out of COMPLETED or CANCELLED.
          IF v_new_status IS DISTINCT FROM v_status AND v_status IN ('done', 'cancelled') THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_INVALID_TRANSITION',
                                      'from', v_status, 'to', v_new_status, 'contract_version', 2);
          END IF;
        END IF;
        UPDATE public.trip_plan_items SET
          title               = CASE WHEN v_patch ? 'title'               THEN v_patch->>'title'                                   ELSE title END,
          category            = CASE WHEN v_patch ? 'category'            THEN v_patch->>'category'                                ELSE category END,
          status              = CASE WHEN v_patch ? 'status'              THEN v_patch->>'status'                                  ELSE status END,
          day_date            = CASE WHEN v_patch ? 'day_date'            THEN (v_patch->>'day_date')::date                        ELSE day_date END,
          lock_type           = CASE WHEN v_patch ? 'lock_type'           THEN v_patch->>'lock_type'                               ELSE lock_type END,
          starts_at           = CASE WHEN v_patch ? 'starts_at'           THEN (v_patch->>'starts_at')::timestamptz                ELSE starts_at END,
          ends_at             = CASE WHEN v_patch ? 'ends_at'             THEN (v_patch->>'ends_at')::timestamptz                  ELSE ends_at END,
          location_name       = CASE WHEN v_patch ? 'location_name'       THEN v_patch->>'location_name'                           ELSE location_name END,
          lat                 = CASE WHEN v_patch ? 'lat'                 THEN (v_patch->>'lat')::double precision                 ELSE lat END,
          lng                 = CASE WHEN v_patch ? 'lng'                 THEN (v_patch->>'lng')::double precision                 ELSE lng END,
          location_is_private = CASE WHEN v_patch ? 'location_is_private' THEN coalesce((v_patch->>'location_is_private')::boolean, false) ELSE location_is_private END,
          notes               = CASE WHEN v_patch ? 'notes'               THEN v_patch->>'notes'                                   ELSE notes END,
          sort_order          = CASE WHEN v_patch ? 'sort_order'          THEN (v_patch->>'sort_order')::integer                   ELSE sort_order END,
          updated_at          = coalesce((v_payload->>'updated_at')::timestamptz, now())
        WHERE id = v_item_id
        RETURNING * INTO v_row;
        v_event_type := CASE v_type
          WHEN 'MOVE_PLAN'         THEN 'trip.plan_moved'
          WHEN 'CONFIRM_PLAN'      THEN 'trip.plan_confirmed'
          WHEN 'CANCEL_PLAN'       THEN 'trip.plan_cancelled'
          WHEN 'COMPLETE_ACTIVITY' THEN 'trip.plan_completed'
          ELSE                          'trip.plan_updated' END;
        v_result := to_jsonb(v_row);

      WHEN 'REMOVE_PLAN' THEN
        v_item_id := (v_payload->>'item_id')::uuid;
        IF v_item_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        UPDATE public.trip_plan_items
           SET removed_at = coalesce((v_payload->>'removed_at')::timestamptz, now())
         WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_event_type := 'trip.plan_removed';
        v_result := jsonb_build_object('id', v_item_id);

      WHEN 'REORDER_PLAN' THEN
        IF jsonb_typeof(v_payload->'items') <> 'array' OR jsonb_array_length(v_payload->'items') = 0 THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        SELECT count(*) INTO v_n
          FROM jsonb_array_elements(v_payload->'items') AS e
          JOIN public.trip_plan_items i
            ON i.id = (e->>'item_id')::uuid AND i.trip_id = v_trip_id AND i.removed_at IS NULL;
        IF v_n <> jsonb_array_length(v_payload->'items') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_NOT_FOUND', 'contract_version', 2);
        END IF;
        FOR v_el IN SELECT * FROM jsonb_array_elements(v_payload->'items') LOOP
          UPDATE public.trip_plan_items
             SET sort_order = (v_el->>'sort_order')::integer,
                 updated_at = coalesce((v_payload->>'updated_at')::timestamptz, now())
           WHERE id = (v_el->>'item_id')::uuid AND trip_id = v_trip_id;
        END LOOP;
        v_event_type := 'trip.plan_reordered';
        v_result := jsonb_build_object('items', v_payload->'items');

      WHEN 'LINK_PLAN_ROUTE_STOP' THEN
        v_item_id := (v_payload->>'item_id')::uuid;
        IF v_item_id IS NULL OR (v_payload->>'route_stop_id') IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        UPDATE public.trip_plan_items
           SET route_stop_id = (v_payload->>'route_stop_id')::uuid
         WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_event_type := 'trip.plan_route_stop_linked';
        v_result := jsonb_build_object('id', v_item_id, 'route_stop_id', v_payload->>'route_stop_id');

      -- ── Trip family ────────────────────────────────────────────────────────
      WHEN 'UPDATE_TRIP' THEN
        v_family := 'trip';
        v_patch  := coalesce(v_payload->'patch', '{}'::jsonb);
        IF jsonb_typeof(v_patch) <> 'object' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        -- Strict allow-list: an unknown column is a contract error, not a silent drop.
        FOR v_k IN SELECT jsonb_object_keys(v_patch) LOOP
          IF NOT (v_k = ANY (c_trip_patch)) THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
                                      'detail', 'UPDATE_TRIP does not accept column ' || v_k, 'contract_version', 2);
          END IF;
        END LOOP;
        IF v_patch ? 'status' AND (v_patch->>'status') NOT IN ('draft','planning','upcoming','active','completed','cancelled','archived') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'status not in trip_status', 'contract_version', 2);
        END IF;
        IF v_patch ? 'visibility' AND (v_patch->>'visibility') NOT IN ('public','buddies','private','invite') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'visibility not in trip_visibility', 'contract_version', 2);
        END IF;
        BEGIN
          v_start := CASE WHEN v_patch ? 'start_date' THEN (v_patch->>'start_date')::date ELSE v_trip.start_date END;
          v_end   := CASE WHEN v_patch ? 'end_date'   THEN (v_patch->>'end_date')::date   ELSE v_trip.end_date   END;
        EXCEPTION WHEN OTHERS THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
        END;
        IF v_start IS NOT NULL AND v_end IS NOT NULL AND v_start > v_end THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_TEMPORAL_RANGE_INVERTED',
                                    'start_date', v_start, 'end_date', v_end, 'contract_version', 2);
        END IF;
        v_status     := v_trip.status::text;
        v_new_status := coalesce(v_patch->>'status', v_status);
        -- §3.1: CANCELLED and ARCHIVED are terminal. lib/tripStatus.ts never
        -- computes a way out of them; the kernel refuses one it is handed.
        IF v_new_status <> v_status AND v_status IN ('cancelled', 'archived') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_LIFECYCLE_INVALID_TRANSITION',
                                    'from', v_status, 'to', v_new_status, 'contract_version', 2);
        END IF;
        UPDATE public.trips SET
          title                    = CASE WHEN v_patch ? 'title'                    THEN v_patch->>'title'                                  ELSE title END,
          destination_city         = CASE WHEN v_patch ? 'destination_city'         THEN v_patch->>'destination_city'                       ELSE destination_city END,
          destination_country      = CASE WHEN v_patch ? 'destination_country'      THEN v_patch->>'destination_country'                    ELSE destination_country END,
          destination_lat          = CASE WHEN v_patch ? 'destination_lat'          THEN (v_patch->>'destination_lat')::double precision    ELSE destination_lat END,
          destination_lng          = CASE WHEN v_patch ? 'destination_lng'          THEN (v_patch->>'destination_lng')::double precision    ELSE destination_lng END,
          destination_place_id     = CASE WHEN v_patch ? 'destination_place_id'     THEN v_patch->>'destination_place_id'                   ELSE destination_place_id END,
          start_date               = CASE WHEN v_patch ? 'start_date'               THEN v_start                                            ELSE start_date END,
          end_date                 = CASE WHEN v_patch ? 'end_date'                 THEN v_end                                              ELSE end_date END,
          status                   = v_new_status::trip_status,
          visibility               = CASE WHEN v_patch ? 'visibility'               THEN (v_patch->>'visibility')::trip_visibility          ELSE visibility END,
          trip_type                = CASE WHEN v_patch ? 'trip_type'                THEN v_patch->>'trip_type'                              ELSE trip_type END,
          timezone                 = CASE WHEN v_patch ? 'timezone'                 THEN v_patch->>'timezone'                               ELSE timezone END,
          travel_style             = CASE WHEN v_patch ? 'travel_style'             THEN v_patch->>'travel_style'                           ELSE travel_style END,
          open_to_meet             = CASE WHEN v_patch ? 'open_to_meet'             THEN (v_patch->>'open_to_meet')::boolean                ELSE open_to_meet END,
          cover_url                = CASE WHEN v_patch ? 'cover_url'                THEN v_patch->>'cover_url'                              ELSE cover_url END,
          cover_media_type         = CASE WHEN v_patch ? 'cover_media_type'         THEN v_patch->>'cover_media_type'                       ELSE cover_media_type END,
          cover_image_width        = CASE WHEN v_patch ? 'cover_image_width'        THEN (v_patch->>'cover_image_width')::integer           ELSE cover_image_width END,
          cover_image_height       = CASE WHEN v_patch ? 'cover_image_height'       THEN (v_patch->>'cover_image_height')::integer          ELSE cover_image_height END,
          trip_notes               = CASE WHEN v_patch ? 'trip_notes'               THEN v_patch->>'trip_notes'                             ELSE trip_notes END,
          show_on_profile          = CASE WHEN v_patch ? 'show_on_profile'          THEN (v_patch->>'show_on_profile')::boolean             ELSE show_on_profile END,
          show_in_discovery        = CASE WHEN v_patch ? 'show_in_discovery'        THEN (v_patch->>'show_in_discovery')::boolean           ELSE show_in_discovery END,
          allow_friend_suggestions = CASE WHEN v_patch ? 'allow_friend_suggestions' THEN (v_patch->>'allow_friend_suggestions')::boolean    ELSE allow_friend_suggestions END,
          allow_trip_crew_invites  = CASE WHEN v_patch ? 'allow_trip_crew_invites'  THEN (v_patch->>'allow_trip_crew_invites')::boolean     ELSE allow_trip_crew_invites END,
          allow_join_requests      = CASE WHEN v_patch ? 'allow_join_requests'      THEN (v_patch->>'allow_join_requests')::boolean         ELSE allow_join_requests END,
          show_exact_dates         = CASE WHEN v_patch ? 'show_exact_dates'         THEN (v_patch->>'show_exact_dates')::boolean            ELSE show_exact_dates END,
          show_destination_city    = CASE WHEN v_patch ? 'show_destination_city'    THEN (v_patch->>'show_destination_city')::boolean       ELSE show_destination_city END,
          delayed_posting_default  = CASE WHEN v_patch ? 'delayed_posting_default'  THEN (v_patch->>'delayed_posting_default')::boolean     ELSE delayed_posting_default END,
          precise_location_visible = CASE WHEN v_patch ? 'precise_location_visible' THEN (v_patch->>'precise_location_visible')::boolean    ELSE precise_location_visible END,
          plan_edit_permission     = CASE WHEN v_patch ? 'plan_edit_permission'     THEN v_patch->>'plan_edit_permission'                   ELSE plan_edit_permission END,
          progress                 = CASE WHEN v_patch ? 'progress'                 THEN (v_patch->>'progress')::integer                    ELSE progress END,
          show_header_publicly     = CASE WHEN v_patch ? 'show_header_publicly'     THEN (v_patch->>'show_header_publicly')::boolean        ELSE show_header_publicly END,
          updated_at               = coalesce((v_payload->>'updated_at')::timestamptz, now())
        WHERE id = v_trip_id
        RETURNING * INTO v_trip;
        v_event_type := CASE WHEN v_new_status = 'completed' AND v_status <> 'completed'
                             THEN 'trip.trip_completed' ELSE 'trip.updated' END;
        v_result := to_jsonb(v_trip);
        -- The event records WHICH columns changed and the lifecycle edge, not the
        -- whole patch twice; the full row is in the receipt for replay.
        v_payload := jsonb_build_object(
          'changed', (SELECT coalesce(jsonb_agg(k ORDER BY k), '[]'::jsonb) FROM jsonb_object_keys(v_patch) k),
          'status_from', v_status, 'status_to', v_new_status);

      WHEN 'CANCEL_TRIP', 'COMPLETE_TRIP', 'ARCHIVE_TRIP' THEN
        v_family     := 'trip';
        v_status     := v_trip.status::text;
        v_new_status := CASE v_type WHEN 'CANCEL_TRIP' THEN 'cancelled' WHEN 'COMPLETE_TRIP' THEN 'completed' ELSE 'archived' END;
        -- Already there is not a transition (the routes answer idempotent=true
        -- BEFORE issuing a command); ARCHIVED is terminal for every edge and
        -- CANCELLED refuses COMPLETE. CANCELLED -> ARCHIVED is allowed: the
        -- product archives cancelled trips today.
        IF v_status = v_new_status
           OR v_status = 'archived'
           OR (v_type = 'COMPLETE_TRIP' AND v_status = 'cancelled') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_LIFECYCLE_INVALID_TRANSITION',
                                    'from', v_status, 'to', v_new_status, 'contract_version', 2);
        END IF;
        UPDATE public.trips
           SET status = v_new_status::trip_status,
               updated_at = coalesce((v_payload->>'updated_at')::timestamptz, now())
         WHERE id = v_trip_id
        RETURNING * INTO v_trip;
        v_event_type := CASE v_type WHEN 'CANCEL_TRIP' THEN 'trip.trip_cancelled'
                                    WHEN 'COMPLETE_TRIP' THEN 'trip.trip_completed'
                                    ELSE 'trip.trip_archived' END;
        v_result := to_jsonb(v_trip);
        v_payload := v_payload || jsonb_build_object('status_from', v_status, 'status_to', v_new_status);

      WHEN 'SET_TRIP_COVER' THEN
        v_family := 'trip';
        IF coalesce(v_payload->>'cover_url', '') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'cover_url required', 'contract_version', 2);
        END IF;
        IF v_payload ? 'cover_media_type' AND (v_payload->>'cover_media_type') NOT IN ('image', 'video') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'cover_media_type not in (image, video)', 'contract_version', 2);
        END IF;
        UPDATE public.trips
           SET cover_url        = v_payload->>'cover_url',
               cover_media_type = CASE WHEN v_payload ? 'cover_media_type' THEN v_payload->>'cover_media_type' ELSE cover_media_type END
         WHERE id = v_trip_id
        RETURNING * INTO v_trip;
        v_event_type := 'trip.cover_set';
        v_result := to_jsonb(v_trip);

      -- ── Admin family ───────────────────────────────────────────────────────
      WHEN 'ADMIN_HIDE_TRIP' THEN
        v_family := 'trip';
        v_status := v_trip.visibility::text;   -- visibility BEFORE the write
        UPDATE public.trips
           SET visibility = 'private',
               updated_at = coalesce((v_payload->>'updated_at')::timestamptz, now())
         WHERE id = v_trip_id
        RETURNING * INTO v_trip;
        v_event_type := 'trip.hidden_by_admin';
        v_result := to_jsonb(v_trip);
        v_payload := jsonb_build_object('visibility_from', v_status, 'reason', left(coalesce(v_payload->>'reason', ''), 500));

      -- ── Participant family ─────────────────────────────────────────────────
      WHEN 'INVITE_PARTICIPANT', 'ADD_PARTICIPANT' THEN
        v_family  := 'participant';
        v_subject := (v_payload->>'user_id')::uuid;
        v_new_role := CASE v_type WHEN 'INVITE_PARTICIPANT' THEN 'invited' ELSE coalesce(v_payload->>'role', 'member') END;
        IF v_subject IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'user_id required', 'contract_version', 2);
        END IF;
        IF v_subject = v_actor THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'the actor cannot add or invite themselves', 'contract_version', 2);
        END IF;
        IF v_new_role NOT IN ('member', 'invited') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'role must be member or invited', 'contract_version', 2);
        END IF;
        IF v_payload ? 'status' AND (v_payload->>'status') NOT IN ('invited','accepted','declined','removed','left') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'status not in trip_members_status_check', 'contract_version', 2);
        END IF;
        SELECT * INTO v_member FROM public.trip_members WHERE trip_id = v_trip_id AND user_id = v_subject FOR UPDATE;
        IF FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PARTICIPANT_ALREADY_EXISTS',
                                    'current_role', v_member.role::text, 'contract_version', 2);
        END IF;
        -- enforce_trip_max_members RAISEs P0001 'trip_full' from inside the
        -- INSERT; a subtransaction turns that into a returned rejection.
        BEGIN
          IF v_type = 'INVITE_PARTICIPANT' THEN
            -- Legacy row shape, exactly: role 'invited', status left at its default.
            INSERT INTO public.trip_members (trip_id, user_id, role)
            VALUES (v_trip_id, v_subject, 'invited')
            RETURNING * INTO v_member;
          ELSE
            INSERT INTO public.trip_members (trip_id, user_id, role, status, joined_at, invite_link_id)
            VALUES (v_trip_id, v_subject, v_new_role::member_role,
                    coalesce(v_payload->>'status', 'accepted'),
                    (v_payload->>'joined_at')::timestamptz,
                    (v_payload->>'invite_link_id')::uuid)
            RETURNING * INTO v_member;
          END IF;
        EXCEPTION
          WHEN raise_exception THEN
            IF SQLERRM = 'trip_full' THEN
              RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PARTICIPANT_CAPACITY_REACHED', 'contract_version', 2);
            END IF;
            RAISE;
        END;
        v_event_type := CASE v_type WHEN 'INVITE_PARTICIPANT' THEN 'trip.participant_invited' ELSE 'trip.participant_added' END;
        v_result := jsonb_build_object('trip_id', v_trip_id, 'user_id', v_subject, 'role', v_member.role::text, 'status', v_member.status);

      WHEN 'SET_PARTICIPANT_ROLE' THEN
        v_family   := 'participant';
        v_subject  := (v_payload->>'user_id')::uuid;
        v_new_role := v_payload->>'role';
        IF v_subject IS NULL OR v_new_role IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'user_id and role required', 'contract_version', 2);
        END IF;
        IF v_new_role NOT IN ('member', 'invited') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'role must be member or invited', 'contract_version', 2);
        END IF;
        SELECT * INTO v_member FROM public.trip_members WHERE trip_id = v_trip_id AND user_id = v_subject FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PARTICIPANT_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_member.role = 'owner' OR v_subject IS NOT DISTINCT FROM v_trip.owner_id THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PARTICIPANT_IS_OWNER', 'contract_version', 2);
        END IF;
        v_role := v_member.role::text;
        UPDATE public.trip_members SET role = v_new_role::member_role
         WHERE trip_id = v_trip_id AND user_id = v_subject
        RETURNING * INTO v_member;
        v_event_type := 'trip.participant_role_set';
        v_result := jsonb_build_object('trip_id', v_trip_id, 'user_id', v_subject, 'role', v_member.role::text, 'status', v_member.status);
        v_payload := v_payload || jsonb_build_object('role_from', v_role, 'role_to', v_new_role);

      WHEN 'REMOVE_PARTICIPANT' THEN
        v_family  := 'participant';
        v_subject := (v_payload->>'user_id')::uuid;
        IF v_subject IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'user_id required', 'contract_version', 2);
        END IF;
        IF v_subject = v_actor THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'the owner cannot remove themselves', 'contract_version', 2);
        END IF;
        SELECT * INTO v_member FROM public.trip_members WHERE trip_id = v_trip_id AND user_id = v_subject FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PARTICIPANT_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_member.role = 'owner' OR v_subject IS NOT DISTINCT FROM v_trip.owner_id THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PARTICIPANT_IS_OWNER', 'contract_version', 2);
        END IF;
        DELETE FROM public.trip_members WHERE trip_id = v_trip_id AND user_id = v_subject;
        v_event_type := 'trip.participant_removed';
        v_result := jsonb_build_object('trip_id', v_trip_id, 'user_id', v_subject, 'role', v_member.role::text);
        -- role at removal lets a consumer tell "invite cancelled" from "member removed".
        v_payload := v_payload || jsonb_build_object('role_at_removal', v_member.role::text);

      WHEN 'ACCEPT_INVITE' THEN
        -- v_member is the actor's own 'invited' row, locked by the capability check.
        v_family := 'participant';
        UPDATE public.trip_members SET role = 'member'
         WHERE trip_id = v_trip_id AND user_id = v_actor
        RETURNING * INTO v_member;
        v_event_type := 'trip.participant_joined';
        v_result := jsonb_build_object('trip_id', v_trip_id, 'user_id', v_actor, 'role', v_member.role::text, 'status', v_member.status);

      WHEN 'DECLINE_INVITE' THEN
        -- Legacy deletes the row (a re-invite after a decline must find no row);
        -- the kernel does the same and the event is the durable record.
        v_family := 'participant';
        DELETE FROM public.trip_members WHERE trip_id = v_trip_id AND user_id = v_actor;
        v_event_type := 'trip.participant_declined';
        v_result := jsonb_build_object('trip_id', v_trip_id, 'user_id', v_actor);

      ELSE
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_UNKNOWN_TYPE', 'type', v_type, 'contract_version', 2);
    END CASE;
  END IF;

  -- Version, event, outbox, receipt — same transaction as the state change (§4.1, §4.4).
  v_next := v_current + 1;
  UPDATE public.trips SET version = v_next WHERE id = v_trip_id;

  SELECT coalesce(max(sequence), 0) + 1 INTO v_seq FROM public.trip_events WHERE trip_id = v_trip_id;

  -- §5.3 minimise payloads: no coordinates and no scheduler bookkeeping in the
  -- crew-readable event. The receipt keeps the full row for idempotent replay.
  INSERT INTO public.trip_events (
    trip_id, aggregate_version, sequence, type, actor_user_id, actor_role, causation_id, correlation_id,
    payload_json, schema_version, occurred_at)
  VALUES (
    v_trip_id, v_next, v_seq, v_event_type, v_actor, v_actor_role, v_cmd_id, v_corr,
    jsonb_build_object(
      'command_type', v_type,
      'family', v_family,
      'payload', (v_payload - 'lat' - 'lng' - 'destination_lat' - 'destination_lng'),
      'result', (v_result - 'lat' - 'lng' - 'destination_lat' - 'destination_lng'
                          - 'reminder_sent_at' - 'reminder_retry_count' - 'reminder_delivered_at')),
    1, coalesce(v_observed, now()))
  RETURNING event_id INTO v_event_id;

  INSERT INTO public.trip_outbox (event_id, trip_id, type) VALUES (v_event_id, v_trip_id, v_event_type);

  INSERT INTO public.trip_command_receipts (
    trip_id, idempotency_key, command_id, command_type, actor_user_id, actor_role, event_id, result_version, result_json)
  VALUES (v_trip_id, v_key, v_cmd_id, v_type, v_actor, v_actor_role, v_event_id, v_next, v_result);

  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false,
    'version', v_next, 'event_id', v_event_id, 'sequence', v_seq, 'result', v_result, 'contract_version', 2);
END;
$fn$;

COMMENT ON FUNCTION public.trip_kernel_execute(jsonb) IS
  'Trip Kernel write path, contract v2 (migrations 2420 + 2450;

REVOKE ALL ON FUNCTION public.trip_kernel_execute(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_kernel_execute(jsonb) TO service_role;

UPDATE public.feature_flags
   SET description = 'Trip Kernel (Trips spec §4), contract v2: plan-item, trip (create/patch), participant (invite/accept/decline/add/role/remove) and route-plan-link writes in routes/trips.ts and routes/routePlan.ts go through public.trip_kernel_execute (aggregate version, domain event, outbox row, idempotency receipt). FALSE = every write path is exactly what it was.'
 WHERE flag = 'trip_kernel_enabled';

-- 2. Postcondition: the 2500 body is gone, v2 still answers.
DO $$
DECLARE r jsonb; def text;
BEGIN
  def := pg_get_functiondef('public.trip_kernel_execute(jsonb)'::regprocedure);
  IF position('JOIN_VIA_LINK' in def) > 0 OR position('TRIP_AUTH_NOT_HOST' in def) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: the 2500 body is still installed';
  END IF;
  r := public.trip_kernel_execute(jsonb_build_object(
         'command_id', gen_random_uuid(), 'trip_id', gen_random_uuid(), 'actor_user_id', gen_random_uuid(),
         'idempotency_key', 'rb-2500-1', 'type', 'JOIN_VIA_LINK', 'payload', '{}'::jsonb));
  IF r->>'reason' IS DISTINCT FROM 'TRIP_COMMAND_UNKNOWN_TYPE' THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: JOIN_VIA_LINK => % (expected TRIP_COMMAND_UNKNOWN_TYPE)', r;
  END IF;
  IF has_function_privilege('anon', 'public.trip_kernel_execute(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trip_kernel_execute(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: a client role can EXECUTE trip_kernel_execute';
  END IF;
END $$;

COMMIT;
