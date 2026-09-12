-- 2780_trip_subgroups.sql
--
-- Trips spec §3.1 TripCrew / §9.2 temporary subgroups. census-trips TR24,
-- TR148 (the SUBGROUP scope had no subject), TR151, TR152, TR384.
--
-- WHAT WAS TRUE BEFORE THIS FILE
-- ==============================
-- "Subgroup has zero occurrences outside docs/" (TR24). 2770 gave plans a
-- plan_scope of all_crew | optional | subgroup | solo, so 'subgroup' was a
-- word a plan could carry with nothing to point at; services/tripCrew/
-- operated on the whole crew; a live-share session was per-user with an
-- allowed_member_ids list and no notion of a crew within the crew; and the
-- closeout's dissolve_temporary_crews step said, truthfully, that there was
-- nothing to dissolve.
--
-- WHAT THIS FILE BUILDS
-- =====================
--   trip_subgroups          — a named, temporary crew inside a trip; active
--                             until dissolved. The parent trip stays canonical:
--                             a subgroup owns nothing the trip does not, it
--                             SCOPES things (§9.2).
--   trip_subgroup_members   — who is in it, with joined_at / left_at kept
--                             (a membership is history, not a flag).
--   trip_plan_items.subgroup_id           — a plan with plan_scope = 'subgroup'
--                             must name its subgroup (CHECK), and the kernel
--                             refuses one that is not an active subgroup of
--                             the same trip.
--   trip_crew_location_sessions.subgroup_id — §9.2's "temporary presence
--                             sharing": a live-share scoped to a subgroup is
--                             visible to its members only (services/tripCrew
--                             honours the column); dissolving the subgroup
--                             stops such sessions.
--   Kernel (transform, 2764's method): CREATE_SUBGROUP, JOIN_SUBGROUP,
--   LEAVE_SUBGROUP, DISSOLVE_SUBGROUP — family 'subgroup', events
--   trip.subgroup_created / _joined / _left / _dissolved. Every named member
--   must be accepted crew (TRIP_SUBGROUP_MEMBER_NOT_CREW). Dissolving is the
--   creator's or a host's (TRIP_AUTH_NOT_HOST otherwise) and is what the
--   closeout's dissolve_temporary_crews step issues (§20.2).
--
-- RLS: crew SELECT only; the kernel writes as service_role. Nothing here is
-- reachable while trip_kernel_enabled is false.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_subgroups') IS NOT NULL THEN
    RAISE EXCEPTION '2780: trip_subgroups already exists; this migration is not idempotent by design';
  END IF;
  IF to_regclass('public.trip_plan_items') IS NULL OR to_regclass('public.trip_crew_location_sessions') IS NULL THEN
    RAISE EXCEPTION '2780: trip_plan_items / trip_crew_location_sessions missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.trip_plan_items'::regclass AND attname = 'plan_scope' AND NOT attisdropped) THEN
    RAISE EXCEPTION '2780: trip_plan_items.plan_scope missing -- apply 2770 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'authz' AND p.proname = 'is_trip_crew') THEN
    RAISE EXCEPTION '2780: authz.is_trip_crew is required for the RLS policy (2334)';
  END IF;
END
$pre$;

CREATE TABLE public.trip_subgroups (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id          uuid        NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  name             text        NOT NULL,
  created_by       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state            text        NOT NULL DEFAULT 'active',
  dissolved_at     timestamptz NULL,
  dissolved_reason text        NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_subgroups_name_len   CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT trip_subgroups_state_known CHECK (state IN ('active', 'dissolved')),
  CONSTRAINT trip_subgroups_dissolved_agrees CHECK ((state = 'dissolved') = (dissolved_at IS NOT NULL))
);
COMMENT ON TABLE public.trip_subgroups IS
  'Trips spec §9.2 temporary subgroup (§3.1 TripCrew): a crew within the crew, active until dissolved; the parent trip remains canonical. Written only by public.trip_kernel_execute (CREATE_SUBGROUP / DISSOLVE_SUBGROUP); RLS: crew SELECT only.';
CREATE INDEX idx_trip_subgroups_trip_active ON public.trip_subgroups (trip_id) WHERE state = 'active';

CREATE TABLE public.trip_subgroup_members (
  subgroup_id uuid        NOT NULL REFERENCES public.trip_subgroups(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  left_at     timestamptz NULL,
  PRIMARY KEY (subgroup_id, user_id)
);
COMMENT ON TABLE public.trip_subgroup_members IS
  'Trips spec §9.2: membership of a temporary subgroup, kept as history (left_at) rather than deleted. Written only by public.trip_kernel_execute (CREATE_SUBGROUP / JOIN_SUBGROUP / LEAVE_SUBGROUP / DISSOLVE_SUBGROUP).';
CREATE INDEX idx_trip_subgroup_members_user ON public.trip_subgroup_members (user_id) WHERE left_at IS NULL;

ALTER TABLE public.trip_plan_items
  ADD COLUMN subgroup_id uuid NULL REFERENCES public.trip_subgroups(id) ON DELETE SET NULL,
  ADD CONSTRAINT trip_plan_items_subgroup_scope_named
    CHECK (plan_scope <> 'subgroup' OR subgroup_id IS NOT NULL);
COMMENT ON COLUMN public.trip_plan_items.subgroup_id IS
  'Trips spec §9.2: the subgroup a plan_scope = ''subgroup'' plan belongs to. Required by CHECK when the scope says subgroup; the kernel additionally requires an ACTIVE subgroup of the same trip and actor membership.';
CREATE INDEX idx_trip_plan_items_subgroup ON public.trip_plan_items (subgroup_id) WHERE subgroup_id IS NOT NULL;

ALTER TABLE public.trip_crew_location_sessions
  ADD COLUMN subgroup_id uuid NULL REFERENCES public.trip_subgroups(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.trip_crew_location_sessions.subgroup_id IS
  'Trips spec §9.2 temporary presence sharing: a live-share scoped to a subgroup is served to that subgroup''s current members only (services/tripCrew/TripCrewLocationService.ts). Dissolving the subgroup stops the session.';

ALTER TABLE public.trip_subgroups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_subgroup_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_subgroups_crew_select ON public.trip_subgroups
  FOR SELECT TO authenticated USING (authz.is_trip_crew(trip_id));
CREATE POLICY trip_subgroup_members_crew_select ON public.trip_subgroup_members
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.trip_subgroups g
                  WHERE g.id = trip_subgroup_members.subgroup_id AND authz.is_trip_crew(g.trip_id)));
REVOKE ALL ON public.trip_subgroups, public.trip_subgroup_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_subgroups, public.trip_subgroup_members TO authenticated;

-- ── the kernel transform ─────────────────────────────────────────────────────
DO $tx$
DECLARE d text; n int; before_len int; branches_before int; branches_after int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2780: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF position('CREATE_SUBGROUP' in d) > 0 THEN
    RAISE EXCEPTION '2780: the subgroup family is already present; this migration is not idempotent by design';
  END IF;

  -- declarations
  n := (length(d) - length(replace(d, '  v_plan_ends  timestamptz;', ''))) / length('  v_plan_ends  timestamptz;');
  IF n <> 1 THEN RAISE EXCEPTION '2780: anchor v_plan_ends occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_plan_ends  timestamptz;',
                  '  v_plan_ends  timestamptz;' || E'\n' ||
                  '  v_subgroup_id uuid;' || E'\n' ||
                  '  v_member_ids uuid[];' || E'\n' ||
                  '  v_uid        uuid;');

  -- capability dispatch
  n := (length(d) - length(replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''', ''))) / length(E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');
  IF n <> 1 THEN RAISE EXCEPTION '2780: anchor SET_TRIP_COVER occurs % times, expected 1', n; END IF;
  d := replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''',
                  E'    WHEN ''CREATE_SUBGROUP'' THEN ''crew'' WHEN ''JOIN_SUBGROUP'' THEN ''crew'' WHEN ''LEAVE_SUBGROUP'' THEN ''crew'' WHEN ''DISSOLVE_SUBGROUP'' THEN ''crew''' || E'\n' ||
                  E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');

  -- ADD_PLAN: a subgroup-scoped plan names an active subgroup the actor belongs to
  n := (length(d) - length(replace(d, E'        INSERT INTO public.trip_plan_items (\n          trip_id, creator_id, title, category, status, source_type, source_id,', ''))) / length(E'        INSERT INTO public.trip_plan_items (\n          trip_id, creator_id, title, category, status, source_type, source_id,');
  IF n <> 1 THEN RAISE EXCEPTION '2780: anchor ADD_PLAN insert occurs % times, expected 1', n; END IF;
  d := replace(d, E'        INSERT INTO public.trip_plan_items (\n          trip_id, creator_id, title, category, status, source_type, source_id,',
$a$        -- 2780 / §9.2: plan_scope = 'subgroup' needs an active subgroup of this trip that the actor is in.
        v_subgroup_id := NULL;
        IF coalesce(v_payload->>'plan_scope', 'all_crew') = 'subgroup' OR (v_payload->>'subgroup_id') IS NOT NULL THEN
          BEGIN
            v_subgroup_id := (v_payload->>'subgroup_id')::uuid;
          EXCEPTION WHEN invalid_text_representation THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'subgroup_id must be a uuid', 'contract_version', 2);
          END;
          IF v_subgroup_id IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'a subgroup-scoped plan needs subgroup_id', 'contract_version', 2);
          END IF;
          PERFORM 1 FROM public.trip_subgroups g WHERE g.id = v_subgroup_id AND g.trip_id = v_trip_id AND g.state = 'active';
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_SUBGROUP_NOT_FOUND', 'contract_version', 2);
          END IF;
          PERFORM 1 FROM public.trip_subgroup_members m WHERE m.subgroup_id = v_subgroup_id AND m.user_id = v_actor AND m.left_at IS NULL;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_SUBGROUP_NOT_MEMBER', 'contract_version', 2);
          END IF;
        END IF;
        INSERT INTO public.trip_plan_items (
          trip_id, creator_id, title, category, status, source_type, source_id,$a$);
  n := (length(d) - length(replace(d, '          stage_id, place_id, privacy_scope, plan_scope)', ''))) / length('          stage_id, place_id, privacy_scope, plan_scope)');
  IF n <> 1 THEN RAISE EXCEPTION '2780: anchor ADD_PLAN column list occurs % times, expected 1', n; END IF;
  d := replace(d, '          stage_id, place_id, privacy_scope, plan_scope)', '          stage_id, place_id, privacy_scope, plan_scope, subgroup_id)');
  n := (length(d) - length(replace(d, E'          coalesce(v_payload->>''plan_scope'', ''all_crew''))', ''))) / length(E'          coalesce(v_payload->>''plan_scope'', ''all_crew''))');
  IF n <> 1 THEN RAISE EXCEPTION '2780: anchor ADD_PLAN values occurs % times, expected 1', n; END IF;
  d := replace(d, E'          coalesce(v_payload->>''plan_scope'', ''all_crew''))', E'          coalesce(v_payload->>''plan_scope'', ''all_crew''), v_subgroup_id)');

  -- UPDATE_PLAN / MOVE_PLAN: a patched subgroup_id is validated the same way
  n := (length(d) - length(replace(d, '        -- 2779 / §3.3: a CONFIRMED plan whose slot moves is MOVED until confirmed again.', ''))) / length('        -- 2779 / §3.3: a CONFIRMED plan whose slot moves is MOVED until confirmed again.');
  IF n <> 1 THEN RAISE EXCEPTION '2780: anchor 2779 guard occurs % times, expected 1', n; END IF;
  d := replace(d, '        -- 2779 / §3.3: a CONFIRMED plan whose slot moves is MOVED until confirmed again.',
$b$        -- 2780 / §9.2: a patched subgroup_id must be an active subgroup of this trip the actor is in.
        IF v_patch ? 'subgroup_id' AND (v_patch->>'subgroup_id') IS NOT NULL THEN
          BEGIN
            v_subgroup_id := (v_patch->>'subgroup_id')::uuid;
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
        -- 2779 / §3.3: a CONFIRMED plan whose slot moves is MOVED until confirmed again.$b$);
  n := (length(d) - length(replace(d, E'          plan_scope          = CASE WHEN v_patch ? ''plan_scope''          THEN v_patch->>''plan_scope''              ELSE plan_scope    END,', ''))) / length(E'          plan_scope          = CASE WHEN v_patch ? ''plan_scope''          THEN v_patch->>''plan_scope''              ELSE plan_scope    END,');
  IF n <> 1 THEN RAISE EXCEPTION '2780: anchor plan_scope SET occurs % times, expected 1', n; END IF;
  d := replace(d, E'          plan_scope          = CASE WHEN v_patch ? ''plan_scope''          THEN v_patch->>''plan_scope''              ELSE plan_scope    END,',
                  E'          plan_scope          = CASE WHEN v_patch ? ''plan_scope''          THEN v_patch->>''plan_scope''              ELSE plan_scope    END,\n' ||
                  E'          subgroup_id         = CASE WHEN v_patch ? ''subgroup_id''         THEN (v_patch->>''subgroup_id'')::uuid       ELSE subgroup_id   END,');

  -- the family
  n := (length(d) - length(replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', ''))) / length(E'      WHEN ''REMOVE_PLAN'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2780: anchor REMOVE_PLAN branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', $branches$      WHEN 'CREATE_SUBGROUP' THEN
        IF coalesce(v_payload->>'name', '') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'name required', 'contract_version', 2);
        END IF;
        BEGIN
          v_member_ids := ARRAY(SELECT DISTINCT (x)::uuid FROM jsonb_array_elements_text(coalesce(v_payload->'member_ids', '[]'::jsonb)) AS x);
        EXCEPTION WHEN invalid_text_representation OR wrong_object_type THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'member_ids must be an array of uuids', 'contract_version', 2);
        END;
        v_member_ids := array_append(array_remove(v_member_ids, v_actor), v_actor);
        FOREACH v_uid IN ARRAY v_member_ids LOOP
          IF NOT authz.is_accepted_trip_member(v_trip_id, v_uid) THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_SUBGROUP_MEMBER_NOT_CREW', 'user_id', v_uid, 'contract_version', 2);
          END IF;
        END LOOP;
        BEGIN
          INSERT INTO public.trip_subgroups (trip_id, name, created_by)
          VALUES (v_trip_id, v_payload->>'name', v_actor)
          RETURNING id INTO v_subgroup_id;
        EXCEPTION WHEN check_violation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
        END;
        INSERT INTO public.trip_subgroup_members (subgroup_id, user_id)
        SELECT v_subgroup_id, u FROM unnest(v_member_ids) AS u;
        v_family     := 'subgroup';
        v_event_type := 'trip.subgroup_created';
        v_result     := jsonb_build_object('id', v_subgroup_id, 'name', v_payload->>'name', 'member_ids', to_jsonb(v_member_ids));

      WHEN 'JOIN_SUBGROUP', 'LEAVE_SUBGROUP' THEN
        BEGIN
          v_subgroup_id := (v_payload->>'subgroup_id')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'subgroup_id must be a uuid', 'contract_version', 2);
        END;
        IF v_subgroup_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'subgroup_id required', 'contract_version', 2);
        END IF;
        PERFORM 1 FROM public.trip_subgroups g WHERE g.id = v_subgroup_id AND g.trip_id = v_trip_id AND g.state = 'active' FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_SUBGROUP_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_type = 'JOIN_SUBGROUP' THEN
          INSERT INTO public.trip_subgroup_members (subgroup_id, user_id) VALUES (v_subgroup_id, v_actor)
          ON CONFLICT (subgroup_id, user_id) DO UPDATE SET joined_at = now(), left_at = NULL;
          v_event_type := 'trip.subgroup_joined';
        ELSE
          UPDATE public.trip_subgroup_members SET left_at = now()
           WHERE subgroup_id = v_subgroup_id AND user_id = v_actor AND left_at IS NULL;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_SUBGROUP_NOT_MEMBER', 'contract_version', 2);
          END IF;
          -- a presence share the actor scoped to this subgroup ends with the membership
          UPDATE public.trip_crew_location_sessions SET status = 'stopped', stopped_at = now()
           WHERE subgroup_id = v_subgroup_id AND user_id = v_actor AND status = 'active';
          v_event_type := 'trip.subgroup_left';
        END IF;
        v_family := 'subgroup';
        v_result := jsonb_build_object('id', v_subgroup_id, 'user_id', v_actor);

      WHEN 'DISSOLVE_SUBGROUP' THEN
        BEGIN
          v_subgroup_id := (v_payload->>'subgroup_id')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'subgroup_id must be a uuid', 'contract_version', 2);
        END;
        IF v_subgroup_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'subgroup_id required', 'contract_version', 2);
        END IF;
        SELECT created_by INTO v_uid FROM public.trip_subgroups g
         WHERE g.id = v_subgroup_id AND g.trip_id = v_trip_id AND g.state = 'active' FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_SUBGROUP_NOT_FOUND', 'contract_version', 2);
        END IF;
        -- the creator, the owner, or an accepted co-host (the host capability, 2500)
        IF v_uid <> v_actor AND NOT (v_is_owner OR EXISTS (SELECT 1 FROM public.trip_members m
                                                            WHERE m.trip_id = v_trip_id AND m.user_id = v_actor
                                                              AND m.role = 'co_host' AND coalesce(m.status, 'accepted') = 'accepted')) THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_HOST', 'contract_version', 2);
        END IF;
        UPDATE public.trip_subgroups
           SET state = 'dissolved', dissolved_at = now(), dissolved_reason = v_payload->>'reason', updated_at = now()
         WHERE id = v_subgroup_id;
        UPDATE public.trip_subgroup_members SET left_at = now() WHERE subgroup_id = v_subgroup_id AND left_at IS NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        UPDATE public.trip_crew_location_sessions SET status = 'stopped', stopped_at = now()
         WHERE subgroup_id = v_subgroup_id AND status = 'active';
        v_family     := 'subgroup';
        v_event_type := 'trip.subgroup_dissolved';
        v_result     := jsonb_build_object('id', v_subgroup_id, 'members_left', v_n, 'reason', v_payload->>'reason');

      WHEN 'REMOVE_PLAN' THEN$branches$);

  EXECUTE d;

  branches_after := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF branches_after <> branches_before + 3 THEN
    RAISE EXCEPTION '2780: expected exactly 3 new command branches, found % -> %', branches_before, branches_after;
  END IF;
  IF length(d) <= before_len THEN RAISE EXCEPTION '2780: the definition did not grow'; END IF;
END
$tx$;

DO $post$
DECLARE d text; n int; r record;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF position('CREATE_SUBGROUP' in d) = 0 THEN RAISE EXCEPTION '2780: CREATE_SUBGROUP missing after apply'; END IF;
  IF position('DISSOLVE_SUBGROUP' in d) = 0 THEN RAISE EXCEPTION '2780: DISSOLVE_SUBGROUP missing'; END IF;
  IF position('trip.subgroup_created' in d) = 0 THEN RAISE EXCEPTION '2780: trip.subgroup_created missing'; END IF;
  IF position('trip.subgroup_dissolved' in d) = 0 THEN RAISE EXCEPTION '2780: trip.subgroup_dissolved missing'; END IF;
  IF position('TRIP_SUBGROUP_MEMBER_NOT_CREW' in d) = 0 THEN RAISE EXCEPTION '2780: member-not-crew refusal missing'; END IF;
  IF position('TRIP_SUBGROUP_NOT_FOUND' in d) = 0 THEN RAISE EXCEPTION '2780: not-found refusal missing'; END IF;
  n := (length(d) - length(replace(d, E'v_family     := ''subgroup'';', ''))) / length(E'v_family     := ''subgroup'';');
  n := n + (length(d) - length(replace(d, E'v_family := ''subgroup'';', ''))) / length(E'v_family := ''subgroup'';');
  IF n <> 3 THEN RAISE EXCEPTION '2780: expected 3 subgroup-family assignments, found %', n; END IF;
  IF position('plan_scope, subgroup_id)' in d) = 0 THEN RAISE EXCEPTION '2780: ADD_PLAN does not write subgroup_id'; END IF;
  IF position('TRIP_VERSION_CONFLICT' in d) = 0 THEN RAISE EXCEPTION '2780: version conflict lost'; END IF;
  IF position('trip_command_receipts' in d) = 0 THEN RAISE EXCEPTION '2780: idempotency receipt lost'; END IF;
  IF position('override_conflicts' in d) = 0 THEN RAISE EXCEPTION '2780: 2779 override path lost'; END IF;
  SELECT relrowsecurity INTO r FROM pg_class WHERE oid = 'public.trip_subgroups'::regclass;
  IF NOT r.relrowsecurity THEN RAISE EXCEPTION '2780: RLS not enabled on trip_subgroups'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('trip_subgroups', 'trip_subgroup_members') AND cmd <> 'SELECT';
  IF n <> 0 THEN RAISE EXCEPTION '2780: a non-SELECT policy exists; these tables have no client writer'; END IF;
  IF has_table_privilege('authenticated', 'public.trip_subgroups', 'INSERT') THEN RAISE EXCEPTION '2780: authenticated can INSERT trip_subgroups'; END IF;
END
$post$;

COMMIT;
