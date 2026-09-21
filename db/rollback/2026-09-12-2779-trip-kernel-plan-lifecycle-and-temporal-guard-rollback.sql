-- Rollback for 2779_trip_kernel_plan_lifecycle_and_temporal_guard.sql
--
-- Removes START_PLAN / SKIP_PLAN and START_STAGE / COMPLETE_STAGE, the §7.2
-- temporal guard on MOVE_PLAN / UPDATE_PLAN with its override path, the
-- "moved" rewrite of a confirmed plan's slot, the four locals, the widened
-- plan SELECT, and `skipped` from the terminal set; then drops the §3.3
-- status CHECK.
--
-- READ THIS BEFORE RUNNING IT. After this file:
--   * a plan slot may be moved onto a commitment's approach window again with
--     no refusal and no record — §7.2 is unenforced at the write, as before
--     2779. Rows already carrying `temporal_conflict` in their event results
--     keep it; nothing new is recorded.
--   * plans left in 'in_progress', 'moved' or 'skipped' KEEP those statuses.
--     The CHECK that named them is dropped, so nothing rejects them, and
--     nothing else in the kernel produces them: they are stranded values the
--     pre-2779 code reads as "not draft/proposed/confirmed". Map them first
--     if that matters (the postcondition counts and warns).
--   * a stage left 'active' stays 'active'; only 2779 could complete it.
--
-- ORDER: after the rollbacks of 2780–2786 where they exist. None of those
-- edits the text this file removes (each adds branches before REMOVE_PLAN,
-- after 2779's, and 2783 anchors inside ADD_GOAL), so this file also runs
-- with them present — rehearsed that way — but a family whose branch sits
-- between START_STAGE and the next arm would be excised with it, and the
-- overrun postcondition would then refuse.
--
-- DATA: the CHECK constraint only. No rows are changed.
--
-- Rehearsed on scripts/local-db (a copy of the replica with 2779–2786 applied).

BEGIN;

DO $rb$
DECLARE d text; n int; before_len int; branches_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2779: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  IF position('START_PLAN' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2779: not applied here';
  END IF;

  -- 6. The two branches: each from its WHEN to the next arm's WHEN.
  d := regexp_replace(d,
       $a$      WHEN 'START_PLAN', 'SKIP_PLAN' THEN.*?\n      WHEN 'START_STAGE', 'COMPLETE_STAGE' THEN.*?\n      WHEN '$a$,
       $a$      WHEN '$a$,
       '');

  -- 5. The override annotation on the plan result.
  d := regexp_replace(d,
       $a$        v_result := to_jsonb\(v_row\);\n        IF v_overridden THEN\n.*?\n        END IF;$a$,
       $a$        v_result := to_jsonb(v_row);$a$,
       '');

  -- 4. The §7.2 guard and the moved rewrite, back to the bare status check.
  d := regexp_replace(d,
       $a$        -- 2779 / §3\.3: a CONFIRMED plan whose slot moves is MOVED until confirmed again\.\n.*?\n        IF v_patch \? 'status' THEN\n          v_new_status := v_patch->>'status';$a$,
       $a$        IF v_patch ? 'status' THEN
          v_new_status := v_patch->>'status';
          -- §3.3 draws no arrow out of COMPLETED or CANCELLED.$a$,
       '');

  -- 3. `skipped` leaves the terminal set.
  d := replace(d, 'AND v_status IN (''done'', ''cancelled'', ''skipped'') THEN', 'AND v_status IN (''done'', ''cancelled'') THEN');

  -- 2. The plan SELECT, back to two columns.
  d := replace(d, 'SELECT status, version, starts_at, ends_at INTO v_status, v_plan_version, v_plan_starts, v_plan_ends FROM public.trip_plan_items',
                  'SELECT status, version INTO v_status, v_plan_version FROM public.trip_plan_items');

  -- 1. The dispatch lines and the locals.
  d := replace(d, E'    WHEN ''START_PLAN'' THEN ''crew'' WHEN ''SKIP_PLAN'' THEN ''crew''\n', '');
  d := replace(d, E'    WHEN ''START_STAGE'' THEN ''crew'' WHEN ''COMPLETE_STAGE'' THEN ''crew''\n', '');
  d := replace(d, E'  v_conflict_id uuid;\n', '');
  d := replace(d, E'  v_overridden boolean;\n', '');
  d := replace(d, E'  v_plan_starts timestamptz;\n', '');
  d := replace(d, E'  v_plan_ends  timestamptz;\n', '');

  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 2 THEN
    RAISE EXCEPTION 'rollback 2779: the excision removed % arms, expected exactly 2', branches_before - n;
  END IF;
  IF length(d) >= before_len THEN
    RAISE EXCEPTION 'rollback 2779: the inverse transform did not shrink the definition';
  END IF;

  EXECUTE d;
END
$rb$;

DO $post$
DECLARE d text; n int; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';

  FOREACH t IN ARRAY ARRAY['START_PLAN', 'SKIP_PLAN', 'START_STAGE', 'COMPLETE_STAGE',
                           'trip.plan_started', 'trip.plan_skipped', 'trip.stage_started', 'trip.stage_completed',
                           'override_conflicts', 'v_conflict_id', 'v_overridden', 'v_plan_starts', 'v_plan_ends',
                           'TRIP_STAGE_INVALID_TRANSITION', '''skipped'') THEN', 'temporal_conflict'] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'rollback 2779: % survived', t; END IF;
  END LOOP;
  IF position('-- §3.3 draws no arrow out of COMPLETED or CANCELLED.' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2779: the pre-2779 status check did not come back';
  END IF;

  FOREACH t IN ARRAY ARRAY['ADD_PLAN', 'MOVE_PLAN', 'UPDATE_PLAN', 'REMOVE_PLAN', 'CREATE_TRIP',
                           'ADD_STAGE', 'ADD_LEG', 'ADD_GOAL', 'SET_PRESENCE', 'JOIN_PLAN', 'CREATE_PROPOSAL',
                           'TRIP_VERSION_CONFLICT', 'TRIP_PLAN_VERSION_CONFLICT', 'authz.is_accepted_trip_member',
                           'trip_command_receipts', 'trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 2779: % lost — the excision overran', t; END IF;
  END LOOP;
  -- Families that came after 2779 and sit past the arms this file removed.
  FOREACH t IN ARRAY ARRAY['CREATE_SUBGROUP', 'ADD_TRANSPORT_SEGMENT', 'DECLARE_DISRUPTION', 'OPEN_FREE_WINDOW', 'RECORD_OPPORTUNITY_CHANGE'] LOOP
    IF position(t in d) = 0 THEN RAISE WARNING 'rollback 2779: % is absent — either its family was rolled back first (expected) or the excision overran (not)', t; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, 'v_family     := ''stage'';', ''))) / length('v_family     := ''stage'';');
  IF n <> 3 THEN RAISE EXCEPTION 'rollback 2779: expected 2764''s 3 stage-family assignments, found %', n; END IF;
END
$post$;

ALTER TABLE public.trip_plan_items DROP CONSTRAINT IF EXISTS trip_plan_items_status_known;

DO $data$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.trip_plan_items WHERE status IN ('in_progress', 'moved', 'skipped');
  IF n > 0 THEN
    RAISE WARNING 'rollback 2779: % trip_plan_items row(s) keep a status only 2779 could produce (in_progress / moved / skipped). Nothing rejects them now and nothing reads them as a state; map them if that matters.', n;
  END IF;
END
$data$;

COMMIT;
