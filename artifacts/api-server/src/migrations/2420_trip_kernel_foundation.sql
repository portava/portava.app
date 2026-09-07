-- 2420_trip_kernel_foundation.sql
--
-- Trip Kernel foundation: the aggregate version, the event store, the command
-- receipt (idempotency) table, the outbox, and the ONE function that applies a
-- TripCommand to canonical state in a single transaction.
--
-- Spec: docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt
--   §4.1  TripCommand envelope; the command service validates schema, actor
--         capability, aggregate version; "Successful commands write canonical
--         state plus an immutable domain event in the same database transaction"
--   §4.3  TripEvent envelope (eventId, tripId, aggregateVersion, sequence, type,
--         actorUserId, causationId, correlationId, payload, occurredAt,
--         recordedAt, schemaVersion)
--   §4.4  "State transaction writes domain event + outbox row"
--   §5.1  trips.version; trip_events(event_id, trip_id, aggregate_version,
--         sequence, type, payload_json, occurred_at)
--   §18.4 "Server aggregate version is canonical"
--   §22.4 "Duplicate command with the same idempotency key cannot produce
--         duplicate state transition"
--   §24 Phase 1 "Add trip versioning, command service, policy layer,
--         idempotency, event/outbox tables"
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2420.
-- Depends on 2337 (authz.is_accepted_trip_member(uuid, uuid)), which is the
-- application's membership rule expressed in SQL. Idempotent: every statement
-- is IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS-then-CREATE.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS CHANGES FOR A USER: NOTHING, UNTIL A FLAG IS FLIPPED
-- ══════════════════════════════════════════════════════════════════════════════
-- Nothing in the application calls trip_kernel_execute unless the feature flag
-- `trip_kernel_enabled` (seeded FALSE here) is true. With the flag false every
-- existing write path is byte-for-byte what it was: trips.version sits at its
-- default, the three new tables stay empty, and no reader is changed. The new
-- column has a default, so no existing INSERT into trips breaks.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY A FUNCTION, AND WHY IT IS SERVICE-ROLE ONLY
-- ══════════════════════════════════════════════════════════════════════════════
-- supabase-js has no transactions. The only way to make "state + event + outbox
-- + receipt + version bump" atomic from the API server is to put the five
-- writes in one SQL function and call it once. That function is the kernel's
-- write path.
--
-- It is NOT callable by anon or authenticated. Application authorization
-- (canEditPlan / canEditPlanItem, lib/http.ts) runs in TypeScript BEFORE the
-- call, exactly as every other service-role write in routes/trips-expansion
-- and routes/tripReservations already does, and the function re-checks the
-- actor's crew membership as defence in depth (§6.2 "service role is not
-- business authorization"). A SECURITY DEFINER function callable from a user
-- JWT that trusted a "pre-authorized" claim would be a hole, so the grant is
-- the boundary: REVOKE from PUBLIC/anon/authenticated is explicit because
-- Supabase's ALTER DEFAULT PRIVILEGES would otherwise hand EXECUTE to all three
-- at CREATE FUNCTION time. The postcondition block asserts this.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- TABLE ACCESS
-- ══════════════════════════════════════════════════════════════════════════════
--   trip_events            RLS on. ONE policy: SELECT for accepted crew via
--                          authz.is_trip_crew(trip_id) — the same predicate the
--                          API uses (requireTripMember). Client roles hold SELECT
--                          only; INSERT/UPDATE/DELETE/TRUNCATE revoked. A trigger
--                          refuses UPDATE for every role — events are immutable.
--                          DELETE is left to the trips(id) ON DELETE CASCADE so
--                          account/trip deletion still works (the aggregate's
--                          history dies with the aggregate; see
--                          lib/deletionDispositions.ts).
--   trip_command_receipts  RLS on, zero policies, zero client grants. Holds the
--                          full result row for idempotent replay; service only.
--   trip_outbox            RLS on, zero policies, zero client grants. No consumer
--                          exists yet (§4.4's worker is NOT built by this lane);
--                          the row is written so a worker has something to read.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ══════════════════════════════════════════════════════════════════════════════
--   * No temporal/spatial validation (§7). The command service's "temporal/
--     spatial consistency" and "dependent commitments" checks need the
--     Temporal Freedom Engine and a commitment model, neither of which exists.
--     The function validates schema, actor capability, aggregate version, plan
--     state transition and command type. That is four of §4.1's six checks.
--   * No outbox worker, no projection worker (§4.4, §19.4).
--   * No change to trip_plan_items' status vocabulary. The plan-state check
--     enforces only what §3.3 draws no arrow out of: a `done` or `cancelled`
--     item cannot change status. tentative <-> confirmed stays permitted in
--     both directions (an owner decision — §3.3 has no PROPOSED <- CONFIRMED
--     arrow, but the product has always allowed un-confirming).
--   * Event payloads omit `lat`/`lng` (§5.3 "minimize payloads"; 0010's rule
--     that coordinates are never in a public-safe label). The receipt keeps the
--     full row because replaying an idempotent command must return the same
--     body, and receipts have no client grant.

BEGIN;

-- ── 1. Aggregate version (§5.1, §18.4) ────────────────────────────────────────
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.trips.version IS
  'Trip aggregate version (Trips spec §5.1/§18.4). Incremented ONLY by public.trip_kernel_execute; one increment per accepted command. Direct writers do not bump it, which is how a reader can tell kernel history from legacy history.';

-- ── 2. Event store (§4.3, §5.1) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trip_events (
  event_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id           uuid        NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  aggregate_version bigint      NOT NULL,
  sequence          bigint      NOT NULL,
  type              text        NOT NULL,
  actor_user_id     uuid        NULL,
  causation_id      uuid        NULL,   -- the command_id that produced this event
  correlation_id    uuid        NULL,
  payload_json      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  schema_version    integer     NOT NULL DEFAULT 1,
  occurred_at       timestamptz NOT NULL,                 -- client-observed instant when supplied
  recorded_at       timestamptz NOT NULL DEFAULT now(),   -- when the database wrote it
  CONSTRAINT trip_events_trip_sequence_unique UNIQUE (trip_id, sequence),
  CONSTRAINT trip_events_type_namespaced CHECK (type LIKE 'trip.%'),
  CONSTRAINT trip_events_positive CHECK (aggregate_version > 0 AND sequence > 0)
);
COMMENT ON TABLE public.trip_events IS
  'Immutable Trip domain events (Trips spec §4.2/§4.3/§5.1). Written only by public.trip_kernel_execute in the same transaction as the canonical state change. UPDATE is refused by trigger; DELETE follows the trip (cascade).';
CREATE INDEX IF NOT EXISTS idx_trip_events_trip_version ON public.trip_events (trip_id, aggregate_version);

CREATE OR REPLACE FUNCTION public.trip_events_refuse_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RAISE EXCEPTION 'trip_events is append-only: UPDATE refused (event_id=%)', OLD.event_id
    USING ERRCODE = 'restrict_violation';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_trip_events_append_only ON public.trip_events;
CREATE TRIGGER trg_trip_events_append_only
  BEFORE UPDATE ON public.trip_events
  FOR EACH ROW EXECUTE FUNCTION public.trip_events_refuse_update();

-- ── 3. Command receipts — idempotency (§4.1, §22.4) ───────────────────────────
CREATE TABLE IF NOT EXISTS public.trip_command_receipts (
  trip_id           uuid        NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  idempotency_key   text        NOT NULL,
  command_id        uuid        NOT NULL,
  command_type      text        NOT NULL,
  actor_user_id     uuid        NOT NULL,
  event_id          uuid        NOT NULL REFERENCES public.trip_events(event_id) ON DELETE CASCADE,
  result_version    bigint      NOT NULL,
  result_json       jsonb       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, idempotency_key),
  CONSTRAINT trip_command_receipts_key_len CHECK (char_length(idempotency_key) BETWEEN 1 AND 200)
);
COMMENT ON TABLE public.trip_command_receipts IS
  'One row per accepted TripCommand, keyed (trip_id, idempotency_key). A second command with the same key returns this row and performs no transition (Trips spec §22.4). Service-role only.';

-- ── 4. Outbox (§4.4) ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trip_outbox (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id      uuid        NOT NULL REFERENCES public.trip_events(event_id) ON DELETE CASCADE,
  trip_id       uuid        NOT NULL,
  type          text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz NULL,
  attempts      integer     NOT NULL DEFAULT 0
);
COMMENT ON TABLE public.trip_outbox IS
  'Outbox rows written in the same transaction as trip_events (Trips spec §4.4). NO WORKER CONSUMES THIS YET — rows accumulate with published_at NULL until one exists.';
CREATE INDEX IF NOT EXISTS idx_trip_outbox_unpublished ON public.trip_outbox (id) WHERE published_at IS NULL;

-- ── 5. RLS and grants ─────────────────────────────────────────────────────────
ALTER TABLE public.trip_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_outbox           ENABLE ROW LEVEL SECURITY;

-- Supabase's ALTER DEFAULT PRIVILEGES hands anon/authenticated the full DML set
-- (plus TRUNCATE, which RLS never polices) at CREATE TABLE. Take it all back,
-- then grant exactly what is meant.
REVOKE ALL ON public.trip_events           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.trip_command_receipts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.trip_outbox           FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_events TO authenticated;

DROP POLICY IF EXISTS trip_events_crew_select ON public.trip_events;
CREATE POLICY trip_events_crew_select ON public.trip_events
  FOR SELECT USING (authz.is_trip_crew(trip_id));

-- ── 6. Feature flag, seeded FALSE ─────────────────────────────────────────────
-- NOTE: the feature_flags PK column is `flag` (0037_feature_flags.sql).
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('trip_kernel_enabled', false,
   'Trip Kernel (Trips spec §4): plan-item writes in routes/trips.ts and the route-plan link write go through public.trip_kernel_execute (aggregate version, domain event, outbox row, idempotency receipt). FALSE = every write path is exactly what it was.')
ON CONFLICT (flag) DO NOTHING;

-- ── 7. The kernel write path ──────────────────────────────────────────────────
-- p_command is the §4.1 TripCommand envelope in snake_case:
--   command_id uuid · trip_id uuid · actor_user_id uuid · expected_trip_version bigint?
--   idempotency_key text · type text · payload jsonb · client_observed_at timestamptz?
--   correlation_id uuid?
-- Returns jsonb: { ok, duplicate, version, event_id, sequence, result } on
-- success, { ok:false, reason, ... } on a rejection. Rejections are RETURNED,
-- never RAISED, and every rejection happens before the first write, so a
-- rejected command leaves no partial state.
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

  -- Lock the aggregate. Everything below is serialized per trip.
  SELECT version INTO v_current FROM public.trips WHERE id = v_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_NOT_FOUND');
  END IF;

  -- Idempotency (§22.4): same key => same answer, no second transition.
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

  -- Actor capability (§4.1) — defence in depth; the route already authorized.
  IF NOT authz.is_accepted_trip_member(v_trip_id, v_actor) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_CREW');
  END IF;

  -- Aggregate version (§4.1, §18.3 "optimistic concurrency; explicit conflict").
  IF v_expected IS NOT NULL AND v_expected <> v_current THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_VERSION_CONFLICT',
                              'current_version', v_current, 'expected_version', v_expected);
  END IF;

  -- Apply. Each branch validates fully BEFORE its first write.
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
        -- §3.3 draws no arrow out of COMPLETED or CANCELLED.
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
      -- Validate the whole set before the first write: every id must be a live
      -- item on THIS trip, so a rejected reorder writes nothing.
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

  -- Version, event, outbox, receipt — same transaction as the state change (§4.1, §4.4).
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
REVOKE ALL ON FUNCTION public.trip_events_refuse_update() FROM PUBLIC, anon, authenticated;

-- ── 8. Postconditions ─────────────────────────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'version') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trips.version missing';
  END IF;

  SELECT count(*) INTO n FROM pg_tables
   WHERE schemaname = 'public' AND tablename IN ('trip_events', 'trip_command_receipts', 'trip_outbox') AND rowsecurity;
  IF n <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected RLS on 3 kernel tables, found %', n;
  END IF;

  -- Client roles: SELECT on trip_events only; nothing on receipts/outbox.
  IF has_table_privilege('anon', 'public.trip_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trip_events', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.trip_command_receipts', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.trip_command_receipts', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.trip_outbox', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.trip_outbox', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a client role holds a grant on a kernel table it must not';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.trip_events', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated cannot SELECT trip_events';
  END IF;

  -- The kernel function is service-role only.
  IF has_function_privilege('anon', 'public.trip_kernel_execute(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trip_kernel_execute(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a client role can EXECUTE trip_kernel_execute';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.trip_kernel_execute(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role cannot EXECUTE trip_kernel_execute';
  END IF;

  -- The flag exists and is FALSE.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trip_kernel_enabled' AND enabled = false) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trip_kernel_enabled is missing or not false';
  END IF;

  -- The membership helper this function depends on exists (2337).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'authz' AND p.proname = 'is_accepted_trip_member') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authz.is_accepted_trip_member (2337) is absent';
  END IF;

  -- A malformed command is rejected, not raised.
  IF (public.trip_kernel_execute('{}'::jsonb)->>'reason') IS DISTINCT FROM 'TRIP_COMMAND_MALFORMED' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trip_kernel_execute({}) did not return TRIP_COMMAND_MALFORMED';
  END IF;
END $$;

COMMIT;
