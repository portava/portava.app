-- 2782_trip_transport_segments.sql
--
-- Trips spec §15.1 TransportSegment. census-trips TR18, TR229, TR283–TR287,
-- TR302 (transport uncertainty), TR147 (party size vs capacity).
--
-- WHAT WAS TRUE BEFORE THIS FILE
-- ==============================
-- "grep -rli TransportSegment → nothing" (TR18). trip_plan_items.category
-- admitted 'transport' as a LABEL on an ordinary item; trip_reservations had
-- a 'transport' TYPE with pending_confirm | confirmed | dismissed — an import
-- state, not an execution state. No mode, no planned departure/arrival pair,
-- no party size, no reliability, no fallback reference, no state machine.
--
-- WHAT THIS FILE BUILDS
-- =====================
--   trip_transport_segments — §15.1's object: mode, the planned pair, the
--   actual pair, from/to (place ids or labels), party_size, reliability
--   (0..1), cost, booking_ref, fallback_of (a segment that stands in for
--   another), and state PLANNED → BOOKED → WAITING → IN_PROGRESS → COMPLETED
--   with DISRUPTED reachable from every non-terminal state and CANCELLED from
--   PLANNED/BOOKED/DISRUPTED. Optionally attached to a leg and a stage.
--   Kernel (transform, 2764's method): ADD_TRANSPORT_SEGMENT,
--   UPDATE_TRANSPORT_SEGMENT, SET_TRANSPORT_STATE, REMOVE_TRANSPORT_SEGMENT —
--   family 'transport', events trip.transport_segment_added / _updated /
--   _state_changed / _removed; an illegal transition is
--   TRIP_TRANSPORT_INVALID_TRANSITION, an unknown segment
--   TRIP_TRANSPORT_NOT_FOUND. Crew capability.
--   RLS: crew SELECT; no client writes.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_transport_segments') IS NOT NULL THEN
    RAISE EXCEPTION '2782: trip_transport_segments already exists; this migration is not idempotent by design';
  END IF;
  IF to_regclass('public.trip_legs') IS NULL OR to_regclass('public.trip_stages') IS NULL THEN
    RAISE EXCEPTION '2782: requires 2760/2761 (trip_stages, trip_legs)';
  END IF;
END
$pre$;

CREATE TABLE public.trip_transport_segments (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id              uuid        NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  leg_id               uuid        NULL REFERENCES public.trip_legs(id) ON DELETE SET NULL,
  stage_id             uuid        NULL REFERENCES public.trip_stages(id) ON DELETE SET NULL,
  mode                 text        NOT NULL,
  state                text        NOT NULL DEFAULT 'planned',
  from_place_id        uuid        NULL,
  to_place_id          uuid        NULL,
  from_label           text        NULL,
  to_label             text        NULL,
  planned_departure_at timestamptz NULL,
  planned_arrival_at   timestamptz NULL,
  actual_departure_at  timestamptz NULL,
  actual_arrival_at    timestamptz NULL,
  party_size           integer     NULL,
  reliability          numeric(4,3) NULL,
  cost_minor           bigint      NULL,
  currency             text        NULL,
  booking_ref          text        NULL,
  fallback_of          uuid        NULL REFERENCES public.trip_transport_segments(id) ON DELETE SET NULL,
  disruption_note      text        NULL,
  created_by           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_transport_mode_known  CHECK (mode IN ('walk','bike','car','taxi','rideshare','bus','tram','metro','train','ferry','flight','other')),
  CONSTRAINT trip_transport_state_known CHECK (state IN ('planned','booked','waiting','in_progress','completed','disrupted','cancelled')),
  CONSTRAINT trip_transport_planned_ordered CHECK (planned_departure_at IS NULL OR planned_arrival_at IS NULL OR planned_arrival_at >= planned_departure_at),
  CONSTRAINT trip_transport_actual_ordered  CHECK (actual_departure_at IS NULL OR actual_arrival_at IS NULL OR actual_arrival_at >= actual_departure_at),
  CONSTRAINT trip_transport_party_positive  CHECK (party_size IS NULL OR party_size > 0),
  CONSTRAINT trip_transport_reliability_unit CHECK (reliability IS NULL OR (reliability >= 0 AND reliability <= 1)),
  CONSTRAINT trip_transport_currency_iso    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT trip_transport_not_own_fallback CHECK (fallback_of IS NULL OR fallback_of <> id)
);
COMMENT ON TABLE public.trip_transport_segments IS
  'Trips spec §15.1 TransportSegment: mode, planned/actual departure-arrival pairs, endpoints, party_size, reliability (0..1), cost, booking_ref, fallback_of, and the state machine planned → booked → waiting → in_progress → completed, disrupted from any non-terminal state, cancelled from planned/booked/disrupted. Written only by public.trip_kernel_execute (ADD_/UPDATE_/REMOVE_TRANSPORT_SEGMENT, SET_TRANSPORT_STATE); RLS: crew SELECT only.';
CREATE INDEX idx_trip_transport_segments_trip ON public.trip_transport_segments (trip_id, planned_departure_at);
CREATE INDEX idx_trip_transport_segments_state ON public.trip_transport_segments (trip_id) WHERE state IN ('disrupted', 'waiting', 'in_progress');

ALTER TABLE public.trip_transport_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_transport_segments_crew_select ON public.trip_transport_segments
  FOR SELECT TO authenticated USING (authz.is_trip_crew(trip_id));
REVOKE ALL ON public.trip_transport_segments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_transport_segments TO authenticated;

-- ── the kernel transform ─────────────────────────────────────────────────────
DO $tx$
DECLARE d text; n int; before_len int; branches_before int; branches_after int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2782: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF position('ADD_TRANSPORT_SEGMENT' in d) > 0 THEN
    RAISE EXCEPTION '2782: the transport family is already present; this migration is not idempotent by design';
  END IF;

  n := (length(d) - length(replace(d, '  v_uid        uuid;', ''))) / length('  v_uid        uuid;');
  IF n <> 1 THEN RAISE EXCEPTION '2782: anchor v_uid occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_uid        uuid;',
                  '  v_uid        uuid;' || E'\n' ||
                  '  v_segment_id uuid;' || E'\n' ||
                  '  v_segment    public.trip_transport_segments%ROWTYPE;');

  n := (length(d) - length(replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''', ''))) / length(E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');
  IF n <> 1 THEN RAISE EXCEPTION '2782: anchor SET_TRIP_COVER occurs % times, expected 1', n; END IF;
  d := replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''',
                  E'    WHEN ''ADD_TRANSPORT_SEGMENT'' THEN ''crew'' WHEN ''UPDATE_TRANSPORT_SEGMENT'' THEN ''crew''' || E'\n' ||
                  E'    WHEN ''SET_TRANSPORT_STATE'' THEN ''crew'' WHEN ''REMOVE_TRANSPORT_SEGMENT'' THEN ''crew''' || E'\n' ||
                  E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');

  n := (length(d) - length(replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', ''))) / length(E'      WHEN ''REMOVE_PLAN'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2782: anchor REMOVE_PLAN branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', $branches$      WHEN 'ADD_TRANSPORT_SEGMENT' THEN
        IF coalesce(v_payload->>'mode', '') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'mode required', 'contract_version', 2);
        END IF;
        IF (v_payload->>'leg_id') IS NOT NULL THEN
          PERFORM 1 FROM public.trip_legs WHERE id = (v_payload->>'leg_id')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_LEG_NOT_FOUND', 'contract_version', 2); END IF;
        END IF;
        IF (v_payload->>'stage_id') IS NOT NULL THEN
          PERFORM 1 FROM public.trip_stages WHERE id = (v_payload->>'stage_id')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2); END IF;
        END IF;
        IF (v_payload->>'fallback_of') IS NOT NULL THEN
          PERFORM 1 FROM public.trip_transport_segments WHERE id = (v_payload->>'fallback_of')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_TRANSPORT_NOT_FOUND', 'detail', 'fallback_of', 'contract_version', 2); END IF;
        END IF;
        BEGIN
          INSERT INTO public.trip_transport_segments
            (trip_id, leg_id, stage_id, mode, state, from_place_id, to_place_id, from_label, to_label,
             planned_departure_at, planned_arrival_at, party_size, reliability, cost_minor, currency, booking_ref, fallback_of, created_by)
          VALUES (v_trip_id, (v_payload->>'leg_id')::uuid, (v_payload->>'stage_id')::uuid, v_payload->>'mode',
                  coalesce(v_payload->>'state', 'planned'),
                  (v_payload->>'from_place_id')::uuid, (v_payload->>'to_place_id')::uuid,
                  v_payload->>'from_label', v_payload->>'to_label',
                  (v_payload->>'planned_departure_at')::timestamptz, (v_payload->>'planned_arrival_at')::timestamptz,
                  (v_payload->>'party_size')::integer, (v_payload->>'reliability')::numeric,
                  (v_payload->>'cost_minor')::bigint, v_payload->>'currency', v_payload->>'booking_ref',
                  (v_payload->>'fallback_of')::uuid, v_actor)
          RETURNING * INTO v_segment;
        EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation
                    OR invalid_text_representation OR invalid_datetime_format OR numeric_value_out_of_range THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'transport';
        v_event_type := 'trip.transport_segment_added';
        v_result     := to_jsonb(v_segment);

      WHEN 'UPDATE_TRANSPORT_SEGMENT', 'SET_TRANSPORT_STATE', 'REMOVE_TRANSPORT_SEGMENT' THEN
        BEGIN
          v_segment_id := (v_payload->>'segment_id')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'segment_id must be a uuid', 'contract_version', 2);
        END;
        IF v_segment_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'segment_id required', 'contract_version', 2);
        END IF;
        SELECT * INTO v_segment FROM public.trip_transport_segments WHERE id = v_segment_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_TRANSPORT_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_family := 'transport';
        IF v_type = 'REMOVE_TRANSPORT_SEGMENT' THEN
          DELETE FROM public.trip_transport_segments WHERE id = v_segment_id;
          v_event_type := 'trip.transport_segment_removed';
          v_result     := jsonb_build_object('id', v_segment_id, 'state', v_segment.state);
        ELSIF v_type = 'SET_TRANSPORT_STATE' THEN
          v_new_status := v_payload->>'state';
          v_status     := v_segment.state;
          -- §15.1: the machine, as arrows. Anything not listed is refused by name.
          IF v_new_status IS NULL
             OR NOT ((v_status = 'planned'     AND v_new_status IN ('booked','waiting','in_progress','disrupted','cancelled'))
                  OR (v_status = 'booked'      AND v_new_status IN ('waiting','in_progress','disrupted','cancelled'))
                  OR (v_status = 'waiting'     AND v_new_status IN ('in_progress','disrupted'))
                  OR (v_status = 'in_progress' AND v_new_status IN ('completed','disrupted'))
                  OR (v_status = 'disrupted'   AND v_new_status IN ('waiting','in_progress','cancelled'))) THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_TRANSPORT_INVALID_TRANSITION',
                                      'from', v_status, 'to', v_new_status, 'contract_version', 2);
          END IF;
          BEGIN
            UPDATE public.trip_transport_segments
               SET state = v_new_status,
                   actual_departure_at = CASE WHEN v_new_status = 'in_progress' THEN coalesce((v_payload->>'at')::timestamptz, now()) ELSE actual_departure_at END,
                   actual_arrival_at   = CASE WHEN v_new_status = 'completed'   THEN coalesce((v_payload->>'at')::timestamptz, now()) ELSE actual_arrival_at END,
                   disruption_note     = CASE WHEN v_new_status = 'disrupted'   THEN v_payload->>'note' ELSE disruption_note END,
                   updated_at = now()
             WHERE id = v_segment_id
            RETURNING * INTO v_segment;
          EXCEPTION WHEN check_violation OR invalid_datetime_format THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
          END;
          v_event_type := 'trip.transport_segment_state_changed';
          v_result     := to_jsonb(v_segment) || jsonb_build_object('from', v_status);
        ELSE
          v_patch := coalesce(v_payload->'patch', '{}'::jsonb);
          IF jsonb_typeof(v_patch) <> 'object' OR v_patch ? 'state' THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'patch must be an object; state moves through SET_TRANSPORT_STATE', 'contract_version', 2);
          END IF;
          IF v_patch ? 'fallback_of' AND (v_patch->>'fallback_of') IS NOT NULL THEN
            PERFORM 1 FROM public.trip_transport_segments WHERE id = (v_patch->>'fallback_of')::uuid AND trip_id = v_trip_id;
            IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_TRANSPORT_NOT_FOUND', 'detail', 'fallback_of', 'contract_version', 2); END IF;
          END IF;
          BEGIN
            UPDATE public.trip_transport_segments SET
              mode                 = CASE WHEN v_patch ? 'mode'                 THEN v_patch->>'mode'                                  ELSE mode END,
              from_place_id        = CASE WHEN v_patch ? 'from_place_id'        THEN (v_patch->>'from_place_id')::uuid                 ELSE from_place_id END,
              to_place_id          = CASE WHEN v_patch ? 'to_place_id'          THEN (v_patch->>'to_place_id')::uuid                   ELSE to_place_id END,
              from_label           = CASE WHEN v_patch ? 'from_label'           THEN v_patch->>'from_label'                            ELSE from_label END,
              to_label             = CASE WHEN v_patch ? 'to_label'             THEN v_patch->>'to_label'                              ELSE to_label END,
              planned_departure_at = CASE WHEN v_patch ? 'planned_departure_at' THEN (v_patch->>'planned_departure_at')::timestamptz   ELSE planned_departure_at END,
              planned_arrival_at   = CASE WHEN v_patch ? 'planned_arrival_at'   THEN (v_patch->>'planned_arrival_at')::timestamptz     ELSE planned_arrival_at END,
              party_size           = CASE WHEN v_patch ? 'party_size'           THEN (v_patch->>'party_size')::integer                 ELSE party_size END,
              reliability          = CASE WHEN v_patch ? 'reliability'          THEN (v_patch->>'reliability')::numeric                ELSE reliability END,
              cost_minor           = CASE WHEN v_patch ? 'cost_minor'           THEN (v_patch->>'cost_minor')::bigint                  ELSE cost_minor END,
              currency             = CASE WHEN v_patch ? 'currency'             THEN v_patch->>'currency'                              ELSE currency END,
              booking_ref          = CASE WHEN v_patch ? 'booking_ref'          THEN v_patch->>'booking_ref'                           ELSE booking_ref END,
              fallback_of          = CASE WHEN v_patch ? 'fallback_of'          THEN (v_patch->>'fallback_of')::uuid                   ELSE fallback_of END,
              leg_id               = CASE WHEN v_patch ? 'leg_id'               THEN (v_patch->>'leg_id')::uuid                        ELSE leg_id END,
              stage_id             = CASE WHEN v_patch ? 'stage_id'             THEN (v_patch->>'stage_id')::uuid                      ELSE stage_id END,
              updated_at           = now()
            WHERE id = v_segment_id
            RETURNING * INTO v_segment;
          EXCEPTION WHEN check_violation OR foreign_key_violation OR invalid_text_representation
                      OR invalid_datetime_format OR numeric_value_out_of_range THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
          END;
          v_event_type := 'trip.transport_segment_updated';
          v_result     := to_jsonb(v_segment);
        END IF;

      WHEN 'REMOVE_PLAN' THEN$branches$);

  EXECUTE d;

  branches_after := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF branches_after <> branches_before + 2 THEN
    RAISE EXCEPTION '2782: expected exactly 2 new command branches, found % -> %', branches_before, branches_after;
  END IF;
  IF length(d) <= before_len THEN RAISE EXCEPTION '2782: the definition did not grow'; END IF;
END
$tx$;

DO $post$
DECLARE d text; n int; r record;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF position('ADD_TRANSPORT_SEGMENT' in d) = 0 THEN RAISE EXCEPTION '2782: ADD_TRANSPORT_SEGMENT missing after apply'; END IF;
  IF position('SET_TRANSPORT_STATE' in d) = 0 THEN RAISE EXCEPTION '2782: SET_TRANSPORT_STATE missing'; END IF;
  IF position('trip.transport_segment_state_changed' in d) = 0 THEN RAISE EXCEPTION '2782: state-changed event missing'; END IF;
  IF position('TRIP_TRANSPORT_INVALID_TRANSITION' in d) = 0 THEN RAISE EXCEPTION '2782: transition refusal missing'; END IF;
  IF position('TRIP_TRANSPORT_NOT_FOUND' in d) = 0 THEN RAISE EXCEPTION '2782: not-found refusal missing'; END IF;
  n := (length(d) - length(replace(d, E'v_family     := ''transport'';', ''))) / length(E'v_family     := ''transport'';');
  n := n + (length(d) - length(replace(d, E'v_family := ''transport'';', ''))) / length(E'v_family := ''transport'';');
  IF n <> 2 THEN RAISE EXCEPTION '2782: expected 2 transport-family assignments, found %', n; END IF;
  IF position('TRIP_VERSION_CONFLICT' in d) = 0 THEN RAISE EXCEPTION '2782: version conflict lost'; END IF;
  IF position('trip_command_receipts' in d) = 0 THEN RAISE EXCEPTION '2782: idempotency receipt lost'; END IF;
  IF position('CREATE_SUBGROUP' in d) = 0 THEN RAISE EXCEPTION '2782: 2780 subgroup family lost'; END IF;
  SELECT relrowsecurity INTO r FROM pg_class WHERE oid = 'public.trip_transport_segments'::regclass;
  IF NOT r.relrowsecurity THEN RAISE EXCEPTION '2782: RLS not enabled'; END IF;
  IF has_table_privilege('authenticated', 'public.trip_transport_segments', 'INSERT') THEN RAISE EXCEPTION '2782: authenticated can INSERT'; END IF;
END
$post$;

COMMIT;
