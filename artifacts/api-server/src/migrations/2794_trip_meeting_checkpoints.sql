-- 2794_trip_meeting_checkpoints.sql
--
-- Trips spec §10.4 meeting checkpoints, §11.3 "Return / regroup", §14.3 the
-- meeting point as a chosen candidate with its explanation, §17.4 Safe Return
-- attached to a subgroup. census-trips TR177, TR198, TR262, TR329.
--
-- WHAT WAS TRUE BEFORE THIS FILE
-- ==============================
-- "route_stops.checkpoint_status and trip_plan_items.category = 'meeting_point'
-- both exist as labels; neither is a crew meeting-checkpoint with participants
-- and arrival state" (TR177). §14.3's service computed a meeting point on
-- demand and stored nothing, so the offline bundle carried none (§18.1) and
-- the map's meetup layer was a label on an ordinary plan item (TR262). Safe
-- Return attached to a trip and a plan, never to a subgroup (TR329).
--
-- WHAT THIS FILE BUILDS
-- =====================
--   trip_meeting_checkpoints              — a place the crew (or a subgroup)
--                                           agreed to meet: coordinates, a
--                                           label, an optional meet-by, why
--                                           (regroup | planned | safety), the
--                                           §14.3 explanation it was chosen
--                                           with, and a status (open | met |
--                                           cancelled).
--   trip_meeting_checkpoint_participants  — who is expected, each with an
--                                           arrival state (pending | en_route
--                                           | arrived | late | no_show) and
--                                           the instant they arrived.
--   safe_return_sessions.subgroup_id      — §17.4: a Safe Return attached to a
--                                           subgroup execution context; the
--                                           crew alert goes to that subgroup's
--                                           current members (services/safeReturn).
--   Kernel (transform, 2764's method): CREATE_MEETING_CHECKPOINT,
--   SET_MEETING_ARRIVAL, CLOSE_MEETING_CHECKPOINT — family 'meeting', events
--   trip.meeting_checkpoint_created / trip.meeting_arrival_set /
--   trip.meeting_checkpoint_closed. Every participant must be accepted crew
--   (TRIP_MEETING_PARTICIPANT_NOT_CREW); only a participant sets their own
--   arrival (TRIP_MEETING_NOT_PARTICIPANT); closing is the creator's or a
--   host's (TRIP_AUTH_NOT_HOST) and only from open
--   (TRIP_MEETING_INVALID_TRANSITION).
--
-- RLS: crew SELECT only; the kernel writes as the function owner. Nothing
-- here is reachable while trip_kernel_enabled is false, and every reader
-- (health, Today, the map, the offline bundle) is behind
-- trip_operational_projections_enabled.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_meeting_checkpoints') IS NOT NULL THEN
    RAISE EXCEPTION '2794: trip_meeting_checkpoints already exists; this migration is not idempotent by design';
  END IF;
  IF to_regclass('public.trip_subgroups') IS NULL OR to_regclass('public.trip_subgroup_members') IS NULL THEN
    RAISE EXCEPTION '2794: trip_subgroups / trip_subgroup_members missing -- apply 2780 first';
  END IF;
  IF to_regclass('public.safe_return_sessions') IS NULL THEN
    RAISE EXCEPTION '2794: safe_return_sessions (0167) missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.safe_return_sessions'::regclass AND attname = 'subgroup_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '2794: safe_return_sessions.subgroup_id already exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'authz' AND p.proname = 'is_trip_crew') THEN
    RAISE EXCEPTION '2794: authz.is_trip_crew is required for the RLS policy (2334)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'authz' AND p.proname = 'is_accepted_trip_member') THEN
    RAISE EXCEPTION '2794: authz.is_accepted_trip_member is required (2780 used it)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'trip_kernel_execute') THEN
    RAISE EXCEPTION '2794: trip_kernel_execute missing -- apply 2420..2786 first';
  END IF;
END
$pre$;

-- ── the tables ───────────────────────────────────────────────────────────────
CREATE TABLE public.trip_meeting_checkpoints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  subgroup_id   uuid NULL REFERENCES public.trip_subgroups(id) ON DELETE SET NULL,
  created_by    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label         text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  lat           double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng           double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  -- the public.places row the point was chosen from, when it was one; no FK,
  -- so a place's removal cannot unplace a checkpoint the crew already agreed
  place_id      uuid NULL,
  meet_at       timestamptz NULL,
  purpose       text NOT NULL DEFAULT 'regroup' CHECK (purpose IN ('regroup', 'planned', 'safety')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'met', 'cancelled')),
  -- §14.3: "explanation and alternative candidates rather than a magic coordinate"
  explanation   jsonb NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz NULL,
  CONSTRAINT trip_meeting_checkpoints_closed_when_done CHECK ((status = 'open') = (closed_at IS NULL))
);
COMMENT ON TABLE public.trip_meeting_checkpoints IS
  'Trips spec §10.4 / §11.3 / §14.3: a meeting checkpoint the crew or a subgroup agreed to — a chosen candidate with its explanation, a meet-by and a status. Written only by public.trip_kernel_execute (CREATE_MEETING_CHECKPOINT / CLOSE_MEETING_CHECKPOINT); RLS: crew SELECT only.';
COMMENT ON COLUMN public.trip_meeting_checkpoints.explanation IS
  'Trips spec §14.3: the meeting-point service''s explanation and alternative candidates the checkpoint was chosen with; never a coordinate the crew did not agree to.';
CREATE INDEX idx_trip_meeting_checkpoints_trip_open ON public.trip_meeting_checkpoints (trip_id) WHERE status = 'open';
CREATE INDEX idx_trip_meeting_checkpoints_subgroup ON public.trip_meeting_checkpoints (subgroup_id) WHERE subgroup_id IS NOT NULL;

CREATE TABLE public.trip_meeting_checkpoint_participants (
  checkpoint_id uuid NOT NULL REFERENCES public.trip_meeting_checkpoints(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  arrival_state text NOT NULL DEFAULT 'pending' CHECK (arrival_state IN ('pending', 'en_route', 'arrived', 'late', 'no_show')),
  arrived_at    timestamptz NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (checkpoint_id, user_id),
  CONSTRAINT trip_meeting_checkpoint_participants_arrived_dated CHECK ((arrival_state = 'arrived') = (arrived_at IS NOT NULL))
);
COMMENT ON TABLE public.trip_meeting_checkpoint_participants IS
  'Trips spec §10.4: who is expected at a meeting checkpoint and their arrival state (pending | en_route | arrived | late | no_show). Written only by public.trip_kernel_execute (CREATE_MEETING_CHECKPOINT / SET_MEETING_ARRIVAL); a participant sets their own state only.';

-- ── §17.4: Safe Return attached to a subgroup execution context ──────────────
ALTER TABLE public.safe_return_sessions
  ADD COLUMN subgroup_id uuid NULL REFERENCES public.trip_subgroups(id) ON DELETE SET NULL,
  ADD CONSTRAINT safe_return_sessions_subgroup_needs_trip CHECK (subgroup_id IS NULL OR trip_id IS NOT NULL);
COMMENT ON COLUMN public.safe_return_sessions.subgroup_id IS
  'Trips spec §17.4: the subgroup execution context this Safe Return is attached to (solo = NULL trip; full crew = trip without subgroup). With notify_trip_crew_enabled the crew alert goes to this subgroup''s current members only (services/safeReturn/SafeReturnNotificationService.ts).';
CREATE INDEX idx_safe_return_sessions_subgroup ON public.safe_return_sessions (subgroup_id) WHERE subgroup_id IS NOT NULL;

-- ── RLS: crew SELECT only ────────────────────────────────────────────────────
ALTER TABLE public.trip_meeting_checkpoints             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_meeting_checkpoint_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_meeting_checkpoints_crew_select ON public.trip_meeting_checkpoints
  FOR SELECT TO authenticated USING (authz.is_trip_crew(trip_id));
CREATE POLICY trip_meeting_checkpoint_participants_crew_select ON public.trip_meeting_checkpoint_participants
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.trip_meeting_checkpoints c
                  WHERE c.id = trip_meeting_checkpoint_participants.checkpoint_id AND authz.is_trip_crew(c.trip_id)));
REVOKE ALL ON public.trip_meeting_checkpoints, public.trip_meeting_checkpoint_participants FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_meeting_checkpoints, public.trip_meeting_checkpoint_participants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trip_meeting_checkpoints, public.trip_meeting_checkpoint_participants TO service_role;

-- ── the kernel transform ─────────────────────────────────────────────────────
DO $tx$
DECLARE d text; n int; before_len int; branches_before int; branches_after int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2794: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF position('CREATE_MEETING_CHECKPOINT' in d) > 0 THEN
    RAISE EXCEPTION '2794: the meeting family is already present; this migration is not idempotent by design';
  END IF;

  -- declarations (2780 declared v_subgroup_id, v_member_ids and v_uid; they are reused)
  n := (length(d) - length(replace(d, '  v_uid        uuid;', ''))) / length('  v_uid        uuid;');
  IF n <> 1 THEN RAISE EXCEPTION '2794: anchor v_uid occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_uid        uuid;',
                  '  v_uid        uuid;' || E'\n' ||
                  '  v_checkpoint_id uuid;' || E'\n' ||
                  '  v_cp_lat     double precision;' || E'\n' ||
                  '  v_cp_lng     double precision;' || E'\n' ||
                  '  v_cp         record;');

  -- capability dispatch
  n := (length(d) - length(replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''', ''))) / length(E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');
  IF n <> 1 THEN RAISE EXCEPTION '2794: anchor SET_TRIP_COVER occurs % times, expected 1', n; END IF;
  d := replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''',
                  E'    WHEN ''CREATE_MEETING_CHECKPOINT'' THEN ''crew'' WHEN ''SET_MEETING_ARRIVAL'' THEN ''crew'' WHEN ''CLOSE_MEETING_CHECKPOINT'' THEN ''crew''' || E'\n' ||
                  E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');

  -- the family
  n := (length(d) - length(replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', ''))) / length(E'      WHEN ''REMOVE_PLAN'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2794: anchor REMOVE_PLAN branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', $branches$      WHEN 'CREATE_MEETING_CHECKPOINT' THEN
        IF coalesce(v_payload->>'label', '') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'label required', 'contract_version', 2);
        END IF;
        BEGIN
          v_cp_lat := (v_payload->>'lat')::double precision;
          v_cp_lng := (v_payload->>'lng')::double precision;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'lat and lng must be numbers', 'contract_version', 2);
        END;
        IF v_cp_lat IS NULL OR v_cp_lng IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'lat and lng required: a checkpoint is a chosen candidate (§14.3), carry the explanation it was chosen with', 'contract_version', 2);
        END IF;
        IF coalesce(v_payload->>'purpose', 'regroup') NOT IN ('regroup', 'planned', 'safety') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'purpose must be regroup | planned | safety', 'contract_version', 2);
        END IF;
        -- 2794 / §9.2: a subgroup checkpoint names an active subgroup of this trip the actor is in.
        v_subgroup_id := NULL;
        IF (v_payload->>'subgroup_id') IS NOT NULL THEN
          BEGIN
            v_subgroup_id := (v_payload->>'subgroup_id')::uuid;
          EXCEPTION WHEN invalid_text_representation THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'subgroup_id must be a uuid', 'contract_version', 2);
          END;
          PERFORM 1 FROM public.trip_subgroups g WHERE g.id = v_subgroup_id AND g.trip_id = v_trip_id AND g.state = 'active';
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_SUBGROUP_NOT_FOUND', 'contract_version', 2);
          END IF;
          PERFORM 1 FROM public.trip_subgroup_members m WHERE m.subgroup_id = v_subgroup_id AND m.user_id = v_actor AND m.left_at IS NULL;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_SUBGROUP_NOT_MEMBER', 'contract_version', 2);
          END IF;
        END IF;
        -- participants: the ones named; else the subgroup's current members; else the whole accepted crew
        BEGIN
          v_member_ids := ARRAY(SELECT DISTINCT (x)::uuid FROM jsonb_array_elements_text(coalesce(v_payload->'participant_ids', '[]'::jsonb)) AS x);
        EXCEPTION WHEN invalid_text_representation OR wrong_object_type THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'participant_ids must be an array of uuids', 'contract_version', 2);
        END;
        IF coalesce(array_length(v_member_ids, 1), 0) = 0 THEN
          IF v_subgroup_id IS NOT NULL THEN
            v_member_ids := ARRAY(SELECT m.user_id FROM public.trip_subgroup_members m WHERE m.subgroup_id = v_subgroup_id AND m.left_at IS NULL);
          ELSE
            v_member_ids := ARRAY(SELECT m.user_id FROM public.trip_members m
                                   WHERE m.trip_id = v_trip_id AND m.role IN ('owner', 'co_host', 'member') AND coalesce(m.status, 'accepted') = 'accepted');
            v_member_ids := array_append(v_member_ids, (SELECT t.owner_id FROM public.trips t WHERE t.id = v_trip_id));
          END IF;
        END IF;
        v_member_ids := ARRAY(SELECT DISTINCT u FROM unnest(array_append(v_member_ids, v_actor)) AS u WHERE u IS NOT NULL);
        FOREACH v_uid IN ARRAY v_member_ids LOOP
          IF NOT authz.is_accepted_trip_member(v_trip_id, v_uid) THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_MEETING_PARTICIPANT_NOT_CREW', 'user_id', v_uid, 'contract_version', 2);
          END IF;
        END LOOP;
        BEGIN
          INSERT INTO public.trip_meeting_checkpoints (trip_id, subgroup_id, created_by, label, lat, lng, place_id, meet_at, purpose, explanation)
          VALUES (v_trip_id, v_subgroup_id, v_actor, v_payload->>'label', v_cp_lat, v_cp_lng,
                  NULLIF(v_payload->>'place_id', '')::uuid, NULLIF(v_payload->>'meet_at', '')::timestamptz,
                  coalesce(v_payload->>'purpose', 'regroup'), v_payload->'explanation')
          RETURNING id INTO v_checkpoint_id;
        EXCEPTION WHEN check_violation OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
        END;
        INSERT INTO public.trip_meeting_checkpoint_participants (checkpoint_id, user_id)
        SELECT v_checkpoint_id, u FROM unnest(v_member_ids) AS u;
        v_family     := 'meeting';
        v_event_type := 'trip.meeting_checkpoint_created';
        v_result     := jsonb_build_object('id', v_checkpoint_id, 'label', v_payload->>'label', 'lat', v_cp_lat, 'lng', v_cp_lng,
                                           'meet_at', NULLIF(v_payload->>'meet_at', ''), 'purpose', coalesce(v_payload->>'purpose', 'regroup'),
                                           'subgroup_id', v_subgroup_id, 'participant_ids', to_jsonb(v_member_ids));

      WHEN 'SET_MEETING_ARRIVAL' THEN
        BEGIN
          v_checkpoint_id := (v_payload->>'checkpoint_id')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'checkpoint_id must be a uuid', 'contract_version', 2);
        END;
        IF v_checkpoint_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'checkpoint_id required', 'contract_version', 2);
        END IF;
        IF coalesce(v_payload->>'arrival_state', '') NOT IN ('pending', 'en_route', 'arrived', 'late', 'no_show') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'arrival_state must be pending | en_route | arrived | late | no_show', 'contract_version', 2);
        END IF;
        SELECT c.status INTO v_cp FROM public.trip_meeting_checkpoints c
         WHERE c.id = v_checkpoint_id AND c.trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_MEETING_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_cp.status <> 'open' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_MEETING_INVALID_TRANSITION', 'detail', 'the checkpoint is ' || v_cp.status, 'contract_version', 2);
        END IF;
        UPDATE public.trip_meeting_checkpoint_participants
           SET arrival_state = v_payload->>'arrival_state',
               arrived_at    = (CASE v_payload->>'arrival_state' WHEN 'arrived' THEN now() ELSE NULL END),
               updated_at    = now()
         WHERE checkpoint_id = v_checkpoint_id AND user_id = v_actor;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_MEETING_NOT_PARTICIPANT', 'contract_version', 2);
        END IF;
        v_family     := 'meeting';
        v_event_type := 'trip.meeting_arrival_set';
        v_result     := jsonb_build_object('id', v_checkpoint_id, 'user_id', v_actor, 'arrival_state', v_payload->>'arrival_state');

      WHEN 'CLOSE_MEETING_CHECKPOINT' THEN
        BEGIN
          v_checkpoint_id := (v_payload->>'checkpoint_id')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'checkpoint_id must be a uuid', 'contract_version', 2);
        END;
        IF v_checkpoint_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'checkpoint_id required', 'contract_version', 2);
        END IF;
        IF coalesce(v_payload->>'outcome', 'met') NOT IN ('met', 'cancelled') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'outcome must be met | cancelled', 'contract_version', 2);
        END IF;
        SELECT c.status, c.created_by INTO v_cp FROM public.trip_meeting_checkpoints c
         WHERE c.id = v_checkpoint_id AND c.trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_MEETING_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_cp.status <> 'open' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_MEETING_INVALID_TRANSITION', 'detail', 'the checkpoint is already ' || v_cp.status, 'contract_version', 2);
        END IF;
        -- the creator, the owner, or an accepted co-host (the host capability, 2500)
        IF v_cp.created_by <> v_actor AND NOT (v_is_owner OR EXISTS (SELECT 1 FROM public.trip_members m
                                                                    WHERE m.trip_id = v_trip_id AND m.user_id = v_actor
                                                                      AND m.role = 'co_host' AND coalesce(m.status, 'accepted') = 'accepted')) THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_HOST', 'contract_version', 2);
        END IF;
        UPDATE public.trip_meeting_checkpoints
           SET status = coalesce(v_payload->>'outcome', 'met'), closed_at = now(), updated_at = now()
         WHERE id = v_checkpoint_id;
        SELECT count(*) FILTER (WHERE p.arrival_state = 'arrived') AS arrived, count(*) AS expected
          INTO v_cp FROM public.trip_meeting_checkpoint_participants p WHERE p.checkpoint_id = v_checkpoint_id;
        v_family     := 'meeting';
        v_event_type := 'trip.meeting_checkpoint_closed';
        v_result     := jsonb_build_object('id', v_checkpoint_id, 'outcome', coalesce(v_payload->>'outcome', 'met'), 'arrived', v_cp.arrived, 'expected', v_cp.expected);

      WHEN 'REMOVE_PLAN' THEN$branches$);

  EXECUTE d;

  branches_after := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF branches_after <> branches_before + 3 THEN
    RAISE EXCEPTION '2794: expected exactly 3 new command branches, found % -> %', branches_before, branches_after;
  END IF;
  IF length(d) <= before_len THEN RAISE EXCEPTION '2794: the definition did not grow'; END IF;
END
$tx$;

DO $post$
DECLARE d text; n int; r record;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF position('CREATE_MEETING_CHECKPOINT' in d) = 0 THEN RAISE EXCEPTION '2794: CREATE_MEETING_CHECKPOINT missing after apply'; END IF;
  IF position('SET_MEETING_ARRIVAL' in d) = 0 THEN RAISE EXCEPTION '2794: SET_MEETING_ARRIVAL missing'; END IF;
  IF position('CLOSE_MEETING_CHECKPOINT' in d) = 0 THEN RAISE EXCEPTION '2794: CLOSE_MEETING_CHECKPOINT missing'; END IF;
  IF position('trip.meeting_checkpoint_created' in d) = 0 THEN RAISE EXCEPTION '2794: trip.meeting_checkpoint_created missing'; END IF;
  IF position('trip.meeting_arrival_set' in d) = 0 THEN RAISE EXCEPTION '2794: trip.meeting_arrival_set missing'; END IF;
  IF position('trip.meeting_checkpoint_closed' in d) = 0 THEN RAISE EXCEPTION '2794: trip.meeting_checkpoint_closed missing'; END IF;
  IF position('TRIP_MEETING_PARTICIPANT_NOT_CREW' in d) = 0 THEN RAISE EXCEPTION '2794: participant-not-crew refusal missing'; END IF;
  IF position('TRIP_MEETING_NOT_PARTICIPANT' in d) = 0 THEN RAISE EXCEPTION '2794: not-participant refusal missing'; END IF;
  IF position('TRIP_MEETING_INVALID_TRANSITION' in d) = 0 THEN RAISE EXCEPTION '2794: invalid-transition refusal missing'; END IF;
  n := (length(d) - length(replace(d, E'v_family     := ''meeting'';', ''))) / length(E'v_family     := ''meeting'';');
  IF n <> 3 THEN RAISE EXCEPTION '2794: expected 3 meeting-family assignments, found %', n; END IF;
  IF position('TRIP_VERSION_CONFLICT' in d) = 0 THEN RAISE EXCEPTION '2794: version conflict lost'; END IF;
  IF position('trip_command_receipts' in d) = 0 THEN RAISE EXCEPTION '2794: idempotency receipt lost'; END IF;
  IF position('CREATE_SUBGROUP' in d) = 0 THEN RAISE EXCEPTION '2794: 2780 subgroup family lost'; END IF;
  SELECT relrowsecurity INTO r FROM pg_class WHERE oid = 'public.trip_meeting_checkpoints'::regclass;
  IF NOT r.relrowsecurity THEN RAISE EXCEPTION '2794: RLS not enabled on trip_meeting_checkpoints'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('trip_meeting_checkpoints', 'trip_meeting_checkpoint_participants') AND cmd <> 'SELECT';
  IF n <> 0 THEN RAISE EXCEPTION '2794: a non-SELECT policy exists; these tables have no client writer'; END IF;
  IF has_table_privilege('authenticated', 'public.trip_meeting_checkpoints', 'INSERT') THEN RAISE EXCEPTION '2794: authenticated can INSERT trip_meeting_checkpoints'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.safe_return_sessions'::regclass AND attname = 'subgroup_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '2794: safe_return_sessions.subgroup_id was not added';
  END IF;
END
$post$;

COMMIT;
