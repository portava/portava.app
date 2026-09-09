-- Rollback for 2450_trip_kernel_trip_and_participant_families.sql
-- NOT applied anywhere as of 2026-09-07: not to portava-ci (hwokxgbmezheskbzskfr),
-- not to travel-buddy production (ajrurzioarfkagpuxfnb). Probed on portava-ci
-- inside a rolled-back transaction only.
--
-- WHAT 2450 DID
-- =============
--   * ALTER TABLE trip_events            ADD actor_role text NOT NULL DEFAULT 'user' (+ CHECK)
--   * ALTER TABLE trip_command_receipts  ADD actor_role text NOT NULL DEFAULT 'user' (+ CHECK),
--                                        actor_user_id DROP NOT NULL,
--                                        + CHECK trip_command_receipts_actor_present
--   * CREATE OR REPLACE FUNCTION trip_kernel_execute(jsonb) — contract v2
--     (trip, participant, admin and system families added to the plan family)
--   * UPDATE feature_flags.description for trip_kernel_enabled (text only)
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores the 2420 (contract v1) function body VERBATIM — the plan-item
-- family only — and drops the v2 columns and constraints. The v1 body below is
-- the one in artifacts/api-server/src/migrations/2420_trip_kernel_foundation.sql
-- section 7; if that file and this one ever disagree, 2420 is authoritative.
--
-- Nothing a user can observe changes while trip_kernel_enabled is FALSE (its
-- seeded value; 2450 does not touch it). If the flag was ever TRUE on this
-- database, the trip/participant handlers in routes/trips.ts will find the
-- v1 function refusing their command types with TRIP_COMMAND_UNKNOWN_TYPE
-- (a 400) until the flag is set back to false — so flip the flag FIRST.
--
-- Data loss: rows in trip_events / trip_command_receipts written with
-- actor_role <> 'user' cannot survive the NOT NULL restoration on
-- actor_user_id (system-role receipts have a NULL actor). This file deletes
-- exactly those receipts and reports how many; events keep their rows (the
-- actor_role column is dropped, the NULL actor_user_id was always allowed).
-- Canonical rows (trips, trip_members, trip_plan_items) are NOT touched.
--
-- Idempotent: every DROP is IF EXISTS.

BEGIN;

-- 1. Contract v1 function body (2420 §7), verbatim.
CREATE OR REPLACE FUNCTION public.trip_kernel_execute(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_trip_id    uuid;
  v_actor      uuid;
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
  v_item_id    uuid;
  v_status     text;
  v_new_status text;
  v_n          integer;
  v_el         jsonb;
BEGIN
  BEGIN
    v_trip_id  := (p_command->>'trip_id')::uuid;
    v_actor    := (p_command->>'actor_user_id')::uuid;
    v_cmd_id   := (p_command->>'command_id')::uuid;
    v_corr     := (p_command->>'correlation_id')::uuid;
    v_key      := p_command->>'idempotency_key';
    v_type     := p_command->>'type';
    v_payload  := coalesce(p_command->'payload', '{}'::jsonb);
    v_expected := (p_command->>'expected_trip_version')::bigint;
    v_observed := (p_command->>'client_observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM);
  END;

  IF v_trip_id IS NULL OR v_actor IS NULL OR v_cmd_id IS NULL OR v_type IS NULL
     OR v_key IS NULL OR char_length(v_key) < 1 OR char_length(v_key) > 200
     OR jsonb_typeof(v_payload) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED');
  END IF;

  SELECT version INTO v_current FROM public.trips WHERE id = v_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_NOT_FOUND');
  END IF;

  SELECT * INTO v_receipt FROM public.trip_command_receipts
   WHERE trip_id = v_trip_id AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_receipt.actor_user_id <> v_actor THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_IDEMPOTENCY_KEY_FOREIGN');
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true,
      'version', v_receipt.result_version, 'event_id', v_receipt.event_id,
      'result', v_receipt.result_json);
  END IF;

  IF NOT authz.is_accepted_trip_member(v_trip_id, v_actor) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_CREW');
  END IF;

  IF v_expected IS NOT NULL AND v_expected <> v_current THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_VERSION_CONFLICT',
                              'current_version', v_current, 'expected_version', v_expected);
  END IF;

  CASE v_type
    WHEN 'ADD_PLAN' THEN
      IF coalesce(v_payload->>'title', '') = '' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'title required');
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
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED');
      END IF;
      SELECT status INTO v_status FROM public.trip_plan_items
       WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_NOT_FOUND');
      END IF;
      IF v_patch ? 'status' THEN
        v_new_status := v_patch->>'status';
        IF v_new_status IS DISTINCT FROM v_status AND v_status IN ('done', 'cancelled') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_INVALID_TRANSITION',
                                    'from', v_status, 'to', v_new_status);
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
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED');
      END IF;
      UPDATE public.trip_plan_items
         SET removed_at = coalesce((v_payload->>'removed_at')::timestamptz, now())
       WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_NOT_FOUND');
      END IF;
      v_event_type := 'trip.plan_removed';
      v_result := jsonb_build_object('id', v_item_id);

    WHEN 'REORDER_PLAN' THEN
      IF jsonb_typeof(v_payload->'items') <> 'array' OR jsonb_array_length(v_payload->'items') = 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED');
      END IF;
      SELECT count(*) INTO v_n
        FROM jsonb_array_elements(v_payload->'items') AS e
        JOIN public.trip_plan_items i
          ON i.id = (e->>'item_id')::uuid AND i.trip_id = v_trip_id AND i.removed_at IS NULL;
      IF v_n <> jsonb_array_length(v_payload->'items') THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_NOT_FOUND');
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
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED');
      END IF;
      UPDATE public.trip_plan_items
         SET route_stop_id = (v_payload->>'route_stop_id')::uuid
       WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_NOT_FOUND');
      END IF;
      v_event_type := 'trip.plan_route_stop_linked';
      v_result := jsonb_build_object('id', v_item_id, 'route_stop_id', v_payload->>'route_stop_id');

    ELSE
      RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_UNKNOWN_TYPE', 'type', v_type);
  END CASE;

  v_next := v_current + 1;
  UPDATE public.trips SET version = v_next WHERE id = v_trip_id;

  SELECT coalesce(max(sequence), 0) + 1 INTO v_seq FROM public.trip_events WHERE trip_id = v_trip_id;

  INSERT INTO public.trip_events (
    trip_id, aggregate_version, sequence, type, actor_user_id, causation_id, correlation_id,
    payload_json, schema_version, occurred_at)
  VALUES (
    v_trip_id, v_next, v_seq, v_event_type, v_actor, v_cmd_id, v_corr,
    jsonb_build_object(
      'command_type', v_type,
      'payload', (v_payload - 'lat' - 'lng'),
      'result', (v_result - 'lat' - 'lng')),
    1, coalesce(v_observed, now()))
  RETURNING event_id INTO v_event_id;

  INSERT INTO public.trip_outbox (event_id, trip_id, type) VALUES (v_event_id, v_trip_id, v_event_type);

  INSERT INTO public.trip_command_receipts (
    trip_id, idempotency_key, command_id, command_type, actor_user_id, event_id, result_version, result_json)
  VALUES (v_trip_id, v_key, v_cmd_id, v_type, v_actor, v_event_id, v_next, v_result);

  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false,
    'version', v_next, 'event_id', v_event_id, 'sequence', v_seq, 'result', v_result);
END;
$fn$;

COMMENT ON FUNCTION public.trip_kernel_execute(jsonb) IS
  'Trip Kernel write path (Trips spec §4.1/§4.3/§4.4/§22.4). Applies one TripCommand: locks the trip, honours the idempotency receipt, re-checks crew membership, checks expected_trip_version, applies the state change, bumps trips.version, writes trip_events + trip_outbox + trip_command_receipts. service_role only; application authorization runs before the call.';

REVOKE ALL ON FUNCTION public.trip_kernel_execute(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_kernel_execute(jsonb) TO service_role;

-- 2. v2 columns and constraints. System-role receipts (NULL actor) cannot
--    satisfy the restored NOT NULL; delete exactly those and say how many.
DO $$
DECLARE n integer;
BEGIN
  DELETE FROM public.trip_command_receipts WHERE actor_user_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'rollback 2450: deleted % system-role receipt row(s) with NULL actor_user_id', n;
END $$;

ALTER TABLE public.trip_command_receipts DROP CONSTRAINT IF EXISTS trip_command_receipts_actor_present;
ALTER TABLE public.trip_command_receipts DROP CONSTRAINT IF EXISTS trip_command_receipts_actor_role_check;
ALTER TABLE public.trip_command_receipts ALTER COLUMN actor_user_id SET NOT NULL;
ALTER TABLE public.trip_command_receipts DROP COLUMN IF EXISTS actor_role;

ALTER TABLE public.trip_events DROP CONSTRAINT IF EXISTS trip_events_actor_role_check;
ALTER TABLE public.trip_events DROP COLUMN IF EXISTS actor_role;

-- 3. Flag description back to the 2420 text (the value is untouched by both files).
UPDATE public.feature_flags
   SET description = 'Trip Kernel (Trips spec §4): plan-item writes in routes/trips.ts and the route-plan link write go through public.trip_kernel_execute (aggregate version, domain event, outbox row, idempotency receipt). FALSE = every write path is exactly what it was.'
 WHERE flag = 'trip_kernel_enabled';

-- 4. Postcondition: v1 behaviour is back — a trip-family command is unknown again.
DO $$
DECLARE r jsonb;
BEGIN
  r := public.trip_kernel_execute(jsonb_build_object(
         'command_id', gen_random_uuid(), 'trip_id', gen_random_uuid(), 'actor_user_id', gen_random_uuid(),
         'idempotency_key', 'rb-1', 'type', 'UPDATE_TRIP', 'payload', '{}'::jsonb));
  -- v1 locks the trip before it looks at the type, so an unknown trip is TRIP_NOT_FOUND here;
  -- either answer proves the v2 dispatch is gone (v2 would answer TRIP_NOT_FOUND too — the
  -- discriminating probe is the contract_version key, which v1 never emits).
  IF r ? 'contract_version' THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: trip_kernel_execute still answers with contract_version (%)', r;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name IN ('trip_events', 'trip_command_receipts')
                AND column_name = 'actor_role') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: actor_role column still present';
  END IF;
END $$;

COMMIT;
