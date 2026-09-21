-- 2785_trip_disruptions_and_derived_events.sql
--
-- Trips spec §17.2 disruption switch, §4.2 domain events commitment_at_risk /
-- free_window_created / trip_disrupted, §8.4 at-risk commitments.
-- census-trips TR61, TR62, TR65, TR66 (the four §4.2 events with "zero
-- occurrences outside docs/"), TR319, TR420, TR448 (TRIP_DISRUPTION_* declared,
-- nothing emits).
--
-- WHAT THIS FILE BUILDS
-- =====================
--   trip_disruptions — §17.2's switch as a row: kind, severity, active |
--   resolved, who declared and resolved it, a note, and the ids of what it
--   affects (plans, commitments, transport segments — ids only, §5.3).
--   Commercial surfaces consult "is a critical disruption active" (§17.2,
--   TR319) through TripHealth; the row is what they consult.
--
--   trip_commitments.at_risk_reason / at_risk_at / at_risk_shortfall_minutes —
--   §8.4: a commitment the engines judge at risk carries the judgement, so a
--   reader does not need the engine to see it.
--
--   Kernel (transform, 2764's method), family 'disruption':
--     DECLARE_DISRUPTION  -> trip.trip_disrupted        (crew)
--     RESOLVE_DISRUPTION  -> trip.disruption_resolved   (crew; TRIP_DISRUPTION_NOT_FOUND / _NOT_ACTIVE)
--   family 'commitment':
--     MARK_COMMITMENT_AT_RISK -> trip.commitment_at_risk (crew; TRIP_COMMITMENT_NOT_FOUND)
--     CLEAR_COMMITMENT_RISK   -> trip.commitment_risk_cleared
--   family 'freedom':
--     OPEN_FREE_WINDOW    -> trip.free_window_created   (the event IS the
--                            record — a window is derived, and a command whose
--                            idempotency key is the window's identity makes
--                            re-detection a duplicate, not a second event)
--
-- Who issues the derived ones: services/trips/TripHealthProjection.ts and
-- TripFreedomProjection.ts, as actor_role 'system' (no user) with a
-- deterministic idempotency key, so the engine's judgement becomes a §4.2
-- event without a human in the loop and without churning the aggregate on
-- every read. They carry a new capability, 'engine': actor_role 'system', or
-- accepted crew under 'user' — a person may record what they know. Nothing
-- here is reachable while trip_kernel_enabled is false.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_disruptions') IS NOT NULL THEN
    RAISE EXCEPTION '2785: trip_disruptions already exists; this migration is not idempotent by design';
  END IF;
  IF to_regclass('public.trip_commitments') IS NULL THEN RAISE EXCEPTION '2785: requires 2761 (trip_commitments)'; END IF;
END
$pre$;

CREATE TABLE public.trip_disruptions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid        NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  kind          text        NOT NULL,
  severity      text        NOT NULL,
  state         text        NOT NULL DEFAULT 'active',
  declared_by   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  declared_at   timestamptz NOT NULL DEFAULT now(),
  resolved_by   uuid        NULL,
  resolved_at   timestamptz NULL,
  note          text        NULL,
  affected_json jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_disruptions_kind_known     CHECK (kind IN ('transport', 'weather', 'health', 'safety', 'lodging', 'venue', 'other')),
  CONSTRAINT trip_disruptions_severity_known CHECK (severity IN ('minor', 'major', 'critical')),
  CONSTRAINT trip_disruptions_state_known    CHECK (state IN ('active', 'resolved')),
  CONSTRAINT trip_disruptions_resolved_agrees CHECK ((state = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT trip_disruptions_affected_is_array CHECK (jsonb_typeof(affected_json) = 'array'),
  CONSTRAINT trip_disruptions_note_len CHECK (note IS NULL OR char_length(note) <= 500)
);
COMMENT ON TABLE public.trip_disruptions IS
  'Trips spec §17.2 disruption switch: an active disruption of a kind and severity, declared by crew, resolved by crew; affected_json holds ids only. TripHealth reads it (DISRUPTED when a major/critical one is active) and §17.2 suppresses commercial surfaces on it. Written only by public.trip_kernel_execute (DECLARE_/RESOLVE_DISRUPTION); RLS: crew SELECT.';
CREATE INDEX idx_trip_disruptions_active ON public.trip_disruptions (trip_id) WHERE state = 'active';

ALTER TABLE public.trip_commitments
  ADD COLUMN at_risk_reason            text        NULL,
  ADD COLUMN at_risk_at                timestamptz NULL,
  ADD COLUMN at_risk_shortfall_minutes integer     NULL,
  ADD CONSTRAINT trip_commitments_at_risk_agrees CHECK ((at_risk_reason IS NULL) = (at_risk_at IS NULL));
COMMENT ON COLUMN public.trip_commitments.at_risk_reason IS 'Trips spec §8.4: set by MARK_COMMITMENT_AT_RISK (an engine''s judgement, recorded as the §4.2 event trip.commitment_at_risk), cleared by CLEAR_COMMITMENT_RISK.';

ALTER TABLE public.trip_disruptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_disruptions_crew_select ON public.trip_disruptions
  FOR SELECT TO authenticated USING (authz.is_trip_crew(trip_id));
REVOKE ALL ON public.trip_disruptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_disruptions TO authenticated;

DO $tx$
DECLARE d text; n int; before_len int; branches_before int; branches_after int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2785: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF position('DECLARE_DISRUPTION' in d) > 0 THEN
    RAISE EXCEPTION '2785: the disruption family is already present; this migration is not idempotent by design';
  END IF;

  n := (length(d) - length(replace(d, '  v_segment    public.trip_transport_segments%ROWTYPE;', ''))) / length('  v_segment    public.trip_transport_segments%ROWTYPE;');
  IF n <> 1 THEN RAISE EXCEPTION '2785: anchor v_segment occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_segment    public.trip_transport_segments%ROWTYPE;',
                  '  v_segment    public.trip_transport_segments%ROWTYPE;' || E'\n' ||
                  '  v_disruption_id uuid;');

  n := (length(d) - length(replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''', ''))) / length(E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');
  IF n <> 1 THEN RAISE EXCEPTION '2785: anchor SET_TRIP_COVER occurs % times, expected 1', n; END IF;
  d := replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''',
                  E'    WHEN ''DECLARE_DISRUPTION'' THEN ''crew'' WHEN ''RESOLVE_DISRUPTION'' THEN ''crew''' || E'\n' ||
                  E'    WHEN ''MARK_COMMITMENT_AT_RISK'' THEN ''engine'' WHEN ''CLEAR_COMMITMENT_RISK'' THEN ''engine'' WHEN ''OPEN_FREE_WINDOW'' THEN ''engine''' || E'\n' ||
                  E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');

  -- The 'engine' capability: an engine (actor_role 'system', no user) or accepted crew.
  -- A derived event is the engine's judgement; a crew member may also record what they know.
  n := (length(d) - length(replace(d, E'     OR (v_required NOT IN (''admin'', ''system'') AND v_actor_role <> ''user'') THEN', ''))) / length(E'     OR (v_required NOT IN (''admin'', ''system'') AND v_actor_role <> ''user'') THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2785: anchor role gate occurs % times, expected 1', n; END IF;
  d := replace(d, E'     OR (v_required NOT IN (''admin'', ''system'') AND v_actor_role <> ''user'') THEN',
                  E'     OR (v_required NOT IN (''admin'', ''system'', ''engine'') AND v_actor_role <> ''user'')\n' ||
                  E'     OR (v_required = ''engine'' AND v_actor_role NOT IN (''user'', ''system'')) THEN');
  n := (length(d) - length(replace(d, E'      WHEN ''crew'' THEN\n        IF NOT authz.is_accepted_trip_member(v_trip_id, v_actor) THEN', ''))) / length(E'      WHEN ''crew'' THEN\n        IF NOT authz.is_accepted_trip_member(v_trip_id, v_actor) THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2785: anchor crew enforcement occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''crew'' THEN\n        IF NOT authz.is_accepted_trip_member(v_trip_id, v_actor) THEN',
$eng$      WHEN 'engine' THEN
        IF v_actor_role <> 'system' AND NOT authz.is_accepted_trip_member(v_trip_id, v_actor) THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_CREW', 'contract_version', 2);
        END IF;
      WHEN 'crew' THEN
        IF NOT authz.is_accepted_trip_member(v_trip_id, v_actor) THEN$eng$);

  n := (length(d) - length(replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', ''))) / length(E'      WHEN ''REMOVE_PLAN'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2785: anchor REMOVE_PLAN branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', $branches$      WHEN 'DECLARE_DISRUPTION' THEN
        IF coalesce(v_payload->>'kind', '') = '' OR coalesce(v_payload->>'severity', '') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'kind and severity are required', 'contract_version', 2);
        END IF;
        BEGIN
          INSERT INTO public.trip_disruptions (trip_id, kind, severity, declared_by, note, affected_json)
          VALUES (v_trip_id, v_payload->>'kind', v_payload->>'severity', v_actor, v_payload->>'note',
                  coalesce(v_payload->'affected', '[]'::jsonb))
          RETURNING id INTO v_disruption_id;
        EXCEPTION WHEN check_violation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'disruption';
        v_event_type := 'trip.trip_disrupted';
        v_result     := jsonb_build_object('id', v_disruption_id, 'kind', v_payload->>'kind', 'severity', v_payload->>'severity',
                                           'affected', coalesce(v_payload->'affected', '[]'::jsonb));

      WHEN 'RESOLVE_DISRUPTION' THEN
        BEGIN
          v_disruption_id := (v_payload->>'disruption_id')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'disruption_id must be a uuid', 'contract_version', 2);
        END;
        IF v_disruption_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'disruption_id required', 'contract_version', 2);
        END IF;
        SELECT state INTO v_status FROM public.trip_disruptions WHERE id = v_disruption_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_DISRUPTION_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_status <> 'active' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_DISRUPTION_NOT_ACTIVE', 'contract_version', 2);
        END IF;
        UPDATE public.trip_disruptions
           SET state = 'resolved', resolved_at = now(), resolved_by = v_actor, note = coalesce(v_payload->>'note', note), updated_at = now()
         WHERE id = v_disruption_id;
        v_family     := 'disruption';
        v_event_type := 'trip.disruption_resolved';
        v_result     := jsonb_build_object('id', v_disruption_id);

      WHEN 'MARK_COMMITMENT_AT_RISK', 'CLEAR_COMMITMENT_RISK' THEN
        BEGIN
          v_commit_id := (v_payload->>'commitment_id')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'commitment_id must be a uuid', 'contract_version', 2);
        END;
        IF v_commit_id IS NULL OR (v_type = 'MARK_COMMITMENT_AT_RISK' AND coalesce(v_payload->>'reason', '') = '') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'commitment_id (and reason, to mark) required', 'contract_version', 2);
        END IF;
        PERFORM 1 FROM public.trip_commitments WHERE id = v_commit_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMITMENT_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_type = 'MARK_COMMITMENT_AT_RISK' THEN
          BEGIN
            UPDATE public.trip_commitments
               SET at_risk_reason = v_payload->>'reason', at_risk_at = now(),
                   at_risk_shortfall_minutes = (v_payload->>'shortfall_minutes')::integer, updated_at = now()
             WHERE id = v_commit_id;
          EXCEPTION WHEN invalid_text_representation THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'shortfall_minutes must be an integer', 'contract_version', 2);
          END;
          v_event_type := 'trip.commitment_at_risk';
          v_result     := jsonb_build_object('id', v_commit_id, 'reason', v_payload->>'reason',
                                             'shortfall_minutes', (v_payload->>'shortfall_minutes')::integer,
                                             'source', coalesce(v_payload->>'source', 'engine'));
        ELSE
          UPDATE public.trip_commitments
             SET at_risk_reason = NULL, at_risk_at = NULL, at_risk_shortfall_minutes = NULL, updated_at = now()
           WHERE id = v_commit_id;
          v_event_type := 'trip.commitment_risk_cleared';
          v_result     := jsonb_build_object('id', v_commit_id);
        END IF;
        v_family := 'commitment';

      WHEN 'OPEN_FREE_WINDOW' THEN
        IF (v_payload->>'begins_at') IS NULL OR (v_payload->>'ends_at') IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'begins_at and ends_at are required', 'contract_version', 2);
        END IF;
        BEGIN
          IF (v_payload->>'ends_at')::timestamptz < (v_payload->>'begins_at')::timestamptz THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_TEMPORAL_RANGE_INVERTED', 'contract_version', 2);
          END IF;
        EXCEPTION WHEN invalid_datetime_format THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'freedom';
        v_event_type := 'trip.free_window_created';
        v_result     := jsonb_build_object('window_id', v_payload->>'window_id', 'begins_at', v_payload->>'begins_at', 'ends_at', v_payload->>'ends_at',
                                           'duration_minutes', (v_payload->>'duration_minutes')::integer, 'position', v_payload->>'position',
                                           'certified', coalesce((v_payload->>'certified')::boolean, false), 'source', coalesce(v_payload->>'source', 'engine'));

      WHEN 'REMOVE_PLAN' THEN$branches$);

  EXECUTE d;

  branches_after := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  -- 4 command branches plus the 'engine' capability branch, which sits at the
  -- same indentation inside the capability CASE and is counted by the same test.
  IF branches_after <> branches_before + 5 THEN
    RAISE EXCEPTION '2785: expected exactly 4 new command branches + 1 capability branch, found % -> %', branches_before, branches_after;
  END IF;
  IF length(d) <= before_len THEN RAISE EXCEPTION '2785: the definition did not grow'; END IF;
END
$tx$;

DO $post$
DECLARE d text; n int; r record;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF position('trip.trip_disrupted' in d) = 0 THEN RAISE EXCEPTION '2785: trip.trip_disrupted missing'; END IF;
  IF position('trip.commitment_at_risk' in d) = 0 THEN RAISE EXCEPTION '2785: trip.commitment_at_risk missing'; END IF;
  IF position('trip.free_window_created' in d) = 0 THEN RAISE EXCEPTION '2785: trip.free_window_created missing'; END IF;
  IF position('TRIP_DISRUPTION_NOT_ACTIVE' in d) = 0 THEN RAISE EXCEPTION '2785: not-active refusal missing'; END IF;
  IF position('WHEN ''engine'' THEN' in d) = 0 THEN RAISE EXCEPTION '2785: the engine capability is missing'; END IF;
  n := (length(d) - length(replace(d, 'THEN ''engine''', ''))) / length('THEN ''engine''');
  IF n <> 3 THEN RAISE EXCEPTION '2785: expected 3 engine-capability commands, found %', n; END IF;
  n := (length(d) - length(replace(d, E'v_family     := ''disruption'';', ''))) / length(E'v_family     := ''disruption'';');
  IF n <> 2 THEN RAISE EXCEPTION '2785: expected 2 disruption-family assignments, found %', n; END IF;
  IF position('v_family := ''commitment'';' in d) = 0 THEN RAISE EXCEPTION '2785: commitment family assignment missing'; END IF;
  IF position('v_family     := ''freedom'';' in d) = 0 THEN RAISE EXCEPTION '2785: freedom family assignment missing'; END IF;
  IF position('START_PLAN' in d) = 0 OR position('CREATE_SUBGROUP' in d) = 0 OR position('ADD_TRANSPORT_SEGMENT' in d) = 0 OR position('permissions_version = permissions_version + 1' in d) = 0 THEN
    RAISE EXCEPTION '2785: an earlier family was lost';
  END IF;
  IF position('trip_command_receipts' in d) = 0 OR position('TRIP_VERSION_CONFLICT' in d) = 0 THEN RAISE EXCEPTION '2785: kernel guarantees lost'; END IF;
  SELECT relrowsecurity INTO r FROM pg_class WHERE oid = 'public.trip_disruptions'::regclass;
  IF NOT r.relrowsecurity THEN RAISE EXCEPTION '2785: RLS not enabled'; END IF;
END
$post$;

COMMIT;
