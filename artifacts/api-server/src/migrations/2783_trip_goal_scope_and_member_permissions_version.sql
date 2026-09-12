-- 2783_trip_goal_scope_and_member_permissions_version.sql
--
-- Trips spec §8.1 TripGoal.scope (personal | shared, weighted) and §3.1
-- TripParticipant.permissions_version. census-trips TR19, TR80, TR138, TR139.
--
-- WHAT WAS TRUE BEFORE THIS FILE
-- ==============================
-- trip_goals (2762) carried four of the contract's five fields; `scope` was
-- "genuinely missing" (TR138), so every goal was the crew's and "goals may be
-- personal or shared and weighted without forcing every participant to share
-- priorities" (TR139) had no representation. trip_members carried a
-- membership state already (status, 2337 — TR19/TR80's "no membership_state"
-- predates it) and no permissions_version: a client holding a role it was
-- granted an hour ago could not tell that the grant had since changed.
--
-- WHAT THIS FILE DOES
-- ===================
--   trip_goals.scope        'shared' | 'personal' (default shared)
--   trip_goals.owner_user_id  set exactly when personal (CHECK), to the actor
--   trip_goals.weight       0..1, optional — a weight is a preference, not a rule
--   RLS: a personal goal is readable by its owner only; shared goals by crew.
--   Kernel: ADD_GOAL / UPDATE_GOAL accept scope and weight; UPDATE_GOAL and
--   REMOVE_GOAL on someone else's personal goal are TRIP_AUTH_NOT_CREATOR.
--   trip_members.permissions_version  bumped by SET_PARTICIPANT_ROLE and
--   carried on its event, so a projection can say which grant it saw.

BEGIN;

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.trip_goals'::regclass AND attname = 'scope' AND NOT attisdropped) THEN
    RAISE EXCEPTION '2783: trip_goals.scope already exists; this migration is not idempotent by design';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.trip_members'::regclass AND attname = 'permissions_version' AND NOT attisdropped) THEN
    RAISE EXCEPTION '2783: trip_members.permissions_version already exists';
  END IF;
END
$pre$;

ALTER TABLE public.trip_goals
  ADD COLUMN scope         text NOT NULL DEFAULT 'shared',
  ADD COLUMN owner_user_id uuid NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD COLUMN weight        numeric(4,3) NULL,
  ADD CONSTRAINT trip_goals_scope_known CHECK (scope IN ('shared', 'personal')),
  ADD CONSTRAINT trip_goals_personal_has_owner CHECK ((scope = 'personal') = (owner_user_id IS NOT NULL)),
  ADD CONSTRAINT trip_goals_weight_unit CHECK (weight IS NULL OR (weight >= 0 AND weight <= 1));
COMMENT ON COLUMN public.trip_goals.scope IS 'Trips spec §8.1: shared (the crew''s) or personal (one participant''s, owner_user_id set); a personal goal is readable by its owner only (RLS) and editable by its owner only (kernel: TRIP_AUTH_NOT_CREATOR).';
COMMENT ON COLUMN public.trip_goals.weight IS 'Trips spec §8.1: an optional 0..1 weight — a preference the planner may consult, never a rule it must obey.';

DROP POLICY IF EXISTS trip_goals_select_crew ON public.trip_goals;
CREATE POLICY trip_goals_select_scoped ON public.trip_goals
  FOR SELECT TO authenticated
  USING (authz.is_trip_crew(trip_id) AND (scope = 'shared' OR owner_user_id = auth.uid()));

ALTER TABLE public.trip_members
  ADD COLUMN permissions_version integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.trip_members.permissions_version IS 'Trips spec §3.1 TripParticipant.permissions_version: bumped by SET_PARTICIPANT_ROLE (kernel) so a client or projection can name the grant it acted under. status is the membership_state.';

-- ── the kernel transform ─────────────────────────────────────────────────────
DO $tx$
DECLARE d text; n int; before_len int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2783: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  IF position('owner_user_id' in d) > 0 AND position('trip_goals (trip_id, type, priority, status, evidence_json, scope' in d) > 0 THEN
    RAISE EXCEPTION '2783: goal scope already present; this migration is not idempotent by design';
  END IF;

  -- ADD_GOAL writes scope / owner / weight
  n := (length(d) - length(replace(d, '          INSERT INTO public.trip_goals (trip_id, type, priority, status, evidence_json)', ''))) / length('          INSERT INTO public.trip_goals (trip_id, type, priority, status, evidence_json)');
  IF n <> 1 THEN RAISE EXCEPTION '2783: anchor ADD_GOAL insert occurs % times, expected 1', n; END IF;
  d := replace(d, '          INSERT INTO public.trip_goals (trip_id, type, priority, status, evidence_json)',
                  '          INSERT INTO public.trip_goals (trip_id, type, priority, status, evidence_json, scope, owner_user_id, weight)');
  n := (length(d) - length(replace(d, E'                  coalesce((v_payload->''evidence_json''), ''{}''::jsonb))', ''))) / length(E'                  coalesce((v_payload->''evidence_json''), ''{}''::jsonb))');
  IF n <> 1 THEN RAISE EXCEPTION '2783: anchor ADD_GOAL values occurs % times, expected 1', n; END IF;
  d := replace(d, E'                  coalesce((v_payload->''evidence_json''), ''{}''::jsonb))',
$v$                  coalesce((v_payload->'evidence_json'), '{}'::jsonb),
                  coalesce(v_payload->>'scope', 'shared'),
                  CASE WHEN coalesce(v_payload->>'scope', 'shared') = 'personal' THEN v_actor ELSE NULL END,
                  (v_payload->>'weight')::numeric)$v$);

  -- UPDATE_GOAL / REMOVE_GOAL: a personal goal is its owner's
  n := (length(d) - length(replace(d, '        PERFORM 1 FROM public.trip_goals WHERE id = v_goal_id AND trip_id = v_trip_id FOR UPDATE;', ''))) / length('        PERFORM 1 FROM public.trip_goals WHERE id = v_goal_id AND trip_id = v_trip_id FOR UPDATE;');
  IF n <> 1 THEN RAISE EXCEPTION '2783: anchor UPDATE_GOAL lock occurs % times, expected 1', n; END IF;
  d := replace(d, '        PERFORM 1 FROM public.trip_goals WHERE id = v_goal_id AND trip_id = v_trip_id FOR UPDATE;',
$l$        PERFORM 1 FROM public.trip_goals WHERE id = v_goal_id AND trip_id = v_trip_id FOR UPDATE;
        IF FOUND AND EXISTS (SELECT 1 FROM public.trip_goals g WHERE g.id = v_goal_id AND g.scope = 'personal' AND g.owner_user_id <> v_actor) THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_CREATOR', 'detail', 'a personal goal is its owner''s', 'contract_version', 2);
        END IF;$l$);
  n := (length(d) - length(replace(d, E'            evidence_json = CASE WHEN v_patch ? ''evidence_json'' THEN coalesce((v_patch->''evidence_json''), ''{}''::jsonb) ELSE evidence_json END,', ''))) / length(E'            evidence_json = CASE WHEN v_patch ? ''evidence_json'' THEN coalesce((v_patch->''evidence_json''), ''{}''::jsonb) ELSE evidence_json END,');
  IF n <> 1 THEN RAISE EXCEPTION '2783: anchor UPDATE_GOAL evidence occurs % times, expected 1', n; END IF;
  d := replace(d, E'            evidence_json = CASE WHEN v_patch ? ''evidence_json'' THEN coalesce((v_patch->''evidence_json''), ''{}''::jsonb) ELSE evidence_json END,',
$u$            evidence_json = CASE WHEN v_patch ? 'evidence_json' THEN coalesce((v_patch->'evidence_json'), '{}'::jsonb) ELSE evidence_json END,
            scope         = CASE WHEN v_patch ? 'scope' THEN coalesce(v_patch->>'scope', 'shared') ELSE scope END,
            owner_user_id = CASE WHEN v_patch ? 'scope' THEN (CASE WHEN coalesce(v_patch->>'scope', 'shared') = 'personal' THEN v_actor ELSE NULL END) ELSE owner_user_id END,
            weight        = CASE WHEN v_patch ? 'weight' THEN (v_patch->>'weight')::numeric ELSE weight END,$u$);
  n := (length(d) - length(replace(d, '        DELETE FROM public.trip_goals WHERE id = v_goal_id AND trip_id = v_trip_id;', ''))) / length('        DELETE FROM public.trip_goals WHERE id = v_goal_id AND trip_id = v_trip_id;');
  IF n <> 1 THEN RAISE EXCEPTION '2783: anchor REMOVE_GOAL delete occurs % times, expected 1', n; END IF;
  d := replace(d, '        DELETE FROM public.trip_goals WHERE id = v_goal_id AND trip_id = v_trip_id;',
$r$        IF EXISTS (SELECT 1 FROM public.trip_goals g WHERE g.id = v_goal_id AND g.trip_id = v_trip_id AND g.scope = 'personal' AND g.owner_user_id <> v_actor) THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_CREATOR', 'detail', 'a personal goal is its owner''s', 'contract_version', 2);
        END IF;
        DELETE FROM public.trip_goals WHERE id = v_goal_id AND trip_id = v_trip_id;$r$);

  -- SET_PARTICIPANT_ROLE bumps permissions_version
  n := (length(d) - length(replace(d, '        UPDATE public.trip_members SET role = v_new_role::member_role', ''))) / length('        UPDATE public.trip_members SET role = v_new_role::member_role');
  IF n <> 1 THEN RAISE EXCEPTION '2783: anchor SET_PARTICIPANT_ROLE update occurs % times, expected 1', n; END IF;
  d := replace(d, '        UPDATE public.trip_members SET role = v_new_role::member_role',
                  '        UPDATE public.trip_members SET role = v_new_role::member_role, permissions_version = permissions_version + 1, updated_at = now()');
  n := (length(d) - length(replace(d, E'        v_event_type := ''trip.participant_role_set'';\n        v_result := jsonb_build_object(''trip_id'', v_trip_id, ''user_id'', v_subject, ''role'', v_member.role::text, ''status'', v_member.status);', ''))) / length(E'        v_event_type := ''trip.participant_role_set'';\n        v_result := jsonb_build_object(''trip_id'', v_trip_id, ''user_id'', v_subject, ''role'', v_member.role::text, ''status'', v_member.status);');
  IF n <> 1 THEN RAISE EXCEPTION '2783: anchor SET_PARTICIPANT_ROLE result occurs % times, expected 1', n; END IF;
  d := replace(d, E'        v_event_type := ''trip.participant_role_set'';\n        v_result := jsonb_build_object(''trip_id'', v_trip_id, ''user_id'', v_subject, ''role'', v_member.role::text, ''status'', v_member.status);',
                  E'        v_event_type := ''trip.participant_role_set'';\n        v_result := jsonb_build_object(''trip_id'', v_trip_id, ''user_id'', v_subject, ''role'', v_member.role::text, ''status'', v_member.status, ''permissions_version'', v_member.permissions_version);');

  EXECUTE d;
  IF length(d) <= before_len THEN RAISE EXCEPTION '2783: the definition did not grow'; END IF;
END
$tx$;

DO $post$
DECLARE d text; n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF position('trip_goals (trip_id, type, priority, status, evidence_json, scope, owner_user_id, weight)' in d) = 0 THEN RAISE EXCEPTION '2783: ADD_GOAL does not write scope'; END IF;
  n := (length(d) - length(replace(d, 'TRIP_AUTH_NOT_CREATOR', ''))) / length('TRIP_AUTH_NOT_CREATOR');
  IF n <> 2 THEN RAISE EXCEPTION '2783: expected 2 owner checks (update, remove), found %', n; END IF;
  IF position('permissions_version = permissions_version + 1' in d) = 0 THEN RAISE EXCEPTION '2783: SET_PARTICIPANT_ROLE does not bump permissions_version'; END IF;
  IF position('CREATE_SUBGROUP' in d) = 0 OR position('ADD_TRANSPORT_SEGMENT' in d) = 0 OR position('START_PLAN' in d) = 0 THEN RAISE EXCEPTION '2783: an earlier family was lost'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'trip_goals';
  IF n <> 1 THEN RAISE EXCEPTION '2783: expected exactly 1 trip_goals policy, found %', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'trip_goals' AND policyname = 'trip_goals_select_scoped') THEN RAISE EXCEPTION '2783: scoped policy missing'; END IF;
END
$post$;

COMMIT;
