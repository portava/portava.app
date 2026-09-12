-- 2779_trip_kernel_plan_lifecycle_and_temporal_guard.sql
--
-- Trips spec §3.3 (the plan state machine), §7.2 (the temporal invariant at
-- the write) and §4.2 (stage_started). census-trips TR46, TR55, TR61/TR62,
-- TR129, TR194.
--
-- WHAT WAS TRUE BEFORE THIS FILE
-- ==============================
-- trip_plan_items.status was free text carrying four of §3.3's nine states —
-- 'tentative' | 'confirmed' | 'done' | 'cancelled' (0010:12-13) — with no
-- CHECK, and the kernel drew exactly one arrow out of them: nothing leaves
-- 'done' or 'cancelled'. IN_PROGRESS, MOVED and SKIPPED did not exist as
-- stored states, so a plan could not be started (§40.4 derived AT_RISK; it
-- said plainly that the stored states needed a migration this environment
-- could not run — it can now, scripts/local-db). trip_stages.state had four
-- values and no command moved a stage through them, so 'trip.stage_started'
-- (§4.2) was emitted nowhere. And §7.2's invariant was judged only AFTER the
-- fact by the feasibility engine: a MOVE_PLAN into a commitment's approach
-- window was accepted and reported later, never refused, and §7.2's "only
-- when explicitly overridden" had nothing to record an override in.
--
-- WHAT THIS FILE DOES (a TRANSFORM of the installed kernel, 2764's method)
-- ========================================================================
--   1. trip_plan_items.status gets the §3.3 vocabulary as a CHECK, NOT VALID
--      (2750's posture for a live table: a violating row today is a
--      precondition failure, not a silent skip).
--   2. START_PLAN  — draft|proposed|tentative|confirmed|moved -> in_progress,
--      event trip.plan_started. SKIP_PLAN — any non-terminal -> skipped, event
--      trip.plan_skipped. Both plan-level versioned (2772), both crew.
--   3. MOVE_PLAN on a CONFIRMED plan leaves it MOVED: a confirmed slot that
--      changes needs confirming again (§3.3). Tentative plans stay tentative.
--   4. 'skipped' joins 'done' and 'cancelled' as terminal.
--   5. §7.2 at the write: MOVE_PLAN / UPDATE_PLAN that changes starts_at or
--      ends_at is refused TRIP_TEMPORAL_CONFLICT when the new interval overlaps
--      a commitment's approach window [required_arrival_at - prep_duration,
--      coalesce(starts_at, required_arrival_at) + lateness_tolerance] on the
--      same trip — UNLESS the command carries override_conflicts: true, in
--      which case it is applied and the EVENT records
--      temporal_conflict: { commitment_id, overridden: true }. That is the
--      override path §7.2 names and TR129 found missing.
--   6. START_STAGE / COMPLETE_STAGE — planned -> active -> completed, events
--      trip.stage_started / trip.stage_completed, family 'stage'.
--
-- Every anchor is counted before it is replaced and the postcondition counts
-- the branches after, so the transform either lands exactly or does not land.
-- Nothing here is reachable while trip_kernel_enabled is false (2420), and
-- START_PLAN/SKIP_PLAN/START_STAGE/COMPLETE_STAGE have no legacy twin, so the
-- /commands endpoint may issue them the way it issues ADD_STAGE.

BEGIN;

-- ── 1. the §3.3 vocabulary ────────────────────────────────────────────────────
DO $pre$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.trip_plan_items
   WHERE status NOT IN ('draft','proposed','tentative','confirmed','in_progress','done','moved','cancelled','skipped');
  IF n <> 0 THEN
    RAISE EXCEPTION '2779: % trip_plan_items row(s) carry a status outside the §3.3 vocabulary; map them before adding the CHECK', n;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trip_plan_items_status_known') THEN
    RAISE EXCEPTION '2779: trip_plan_items_status_known already exists; this migration is not idempotent by design';
  END IF;
END
$pre$;

ALTER TABLE public.trip_plan_items
  ADD CONSTRAINT trip_plan_items_status_known
  CHECK (status IN ('draft','proposed','tentative','confirmed','in_progress','done','moved','cancelled','skipped')) NOT VALID;
ALTER TABLE public.trip_plan_items VALIDATE CONSTRAINT trip_plan_items_status_known;

COMMENT ON COLUMN public.trip_plan_items.status IS
  'Trips spec §3.3 plan state machine: draft → proposed → confirmed → in_progress → done, with moved / cancelled / skipped; tentative is the pre-2779 spelling of draft/proposed and stays valid. AT_RISK is derived (§40.4), never stored. Terminal: done, cancelled, skipped. Written by public.trip_kernel_execute (CONFIRM_PLAN, START_PLAN, COMPLETE_ACTIVITY, CANCEL_PLAN, SKIP_PLAN, MOVE_PLAN → moved) and, while trip_kernel_enabled is false, by routes/trips.ts.';

-- ── 2..6. the kernel transform ────────────────────────────────────────────────
DO $tx$
DECLARE
  d text; n int; before_len int; branches_before int; branches_after int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2779: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF position('START_PLAN' in d) > 0 THEN
    RAISE EXCEPTION '2779: the plan lifecycle family is already present; this migration is not idempotent by design';
  END IF;

  -- declarations
  n := (length(d) - length(replace(d, '  v_link_id    uuid;', ''))) / length('  v_link_id    uuid;');
  IF n <> 1 THEN RAISE EXCEPTION '2779: anchor v_link_id occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_link_id    uuid;',
                  '  v_link_id    uuid;' || E'\n' ||
                  '  v_conflict_id uuid;' || E'\n' ||
                  '  v_overridden boolean;' || E'\n' ||
                  '  v_plan_starts timestamptz;' || E'\n' ||
                  '  v_plan_ends  timestamptz;');

  -- capability dispatch
  n := (length(d) - length(replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''', ''))) / length(E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');
  IF n <> 1 THEN RAISE EXCEPTION '2779: anchor SET_TRIP_COVER occurs % times, expected 1', n; END IF;
  d := replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''',
                  E'    WHEN ''START_PLAN'' THEN ''crew'' WHEN ''SKIP_PLAN'' THEN ''crew''' || E'\n' ||
                  E'    WHEN ''START_STAGE'' THEN ''crew'' WHEN ''COMPLETE_STAGE'' THEN ''crew''' || E'\n' ||
                  E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');

  -- the combined plan branch reads the interval too (for the §7.2 guard)
  n := (length(d) - length(replace(d, 'SELECT status, version INTO v_status, v_plan_version FROM public.trip_plan_items', ''))) / length('SELECT status, version INTO v_status, v_plan_version FROM public.trip_plan_items');
  IF n <> 1 THEN RAISE EXCEPTION '2779: anchor plan SELECT occurs % times, expected 1', n; END IF;
  d := replace(d, 'SELECT status, version INTO v_status, v_plan_version FROM public.trip_plan_items',
                  'SELECT status, version, starts_at, ends_at INTO v_status, v_plan_version, v_plan_starts, v_plan_ends FROM public.trip_plan_items');

  -- 'skipped' is terminal
  n := (length(d) - length(replace(d, 'AND v_status IN (''done'', ''cancelled'') THEN', ''))) / length('AND v_status IN (''done'', ''cancelled'') THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2779: anchor terminal set occurs % times, expected 1', n; END IF;
  d := replace(d, 'AND v_status IN (''done'', ''cancelled'') THEN', 'AND v_status IN (''done'', ''cancelled'', ''skipped'') THEN');

  -- MOVED + the §7.2 guard, inserted just before the terminal-state check
  n := (length(d) - length(replace(d, E'        IF v_patch ? ''status'' THEN\n          v_new_status := v_patch->>''status'';\n          -- §3.3 draws no arrow out of COMPLETED or CANCELLED.', ''))) / length(E'        IF v_patch ? ''status'' THEN\n          v_new_status := v_patch->>''status'';\n          -- §3.3 draws no arrow out of COMPLETED or CANCELLED.');
  IF n <> 1 THEN RAISE EXCEPTION '2779: anchor §3.3 status check occurs % times, expected 1', n; END IF;
  d := replace(d, E'        IF v_patch ? ''status'' THEN\n          v_new_status := v_patch->>''status'';\n          -- §3.3 draws no arrow out of COMPLETED or CANCELLED.',
$guard$        -- 2779 / §3.3: a CONFIRMED plan whose slot moves is MOVED until confirmed again.
        IF v_type = 'MOVE_PLAN' AND v_status = 'confirmed' AND NOT (v_patch ? 'status') THEN
          v_patch := v_patch || jsonb_build_object('status', 'moved');
        END IF;
        -- 2779 / §7.2 at the write (TR55, TR129): the new interval may not overlap a
        -- commitment's approach window unless the caller overrides by name.
        v_conflict_id := NULL; v_overridden := false;
        IF v_type IN ('MOVE_PLAN', 'UPDATE_PLAN') AND (v_patch ? 'starts_at' OR v_patch ? 'ends_at') THEN
          BEGIN
            v_plan_starts := CASE WHEN v_patch ? 'starts_at' THEN (v_patch->>'starts_at')::timestamptz ELSE v_plan_starts END;
            v_plan_ends   := CASE WHEN v_patch ? 'ends_at'   THEN (v_patch->>'ends_at')::timestamptz   ELSE v_plan_ends   END;
          EXCEPTION WHEN invalid_datetime_format OR invalid_text_representation THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', SQLERRM, 'contract_version', 2);
          END;
          IF v_plan_starts IS NOT NULL THEN
            SELECT c.id INTO v_conflict_id
              FROM public.trip_commitments c
             WHERE c.trip_id = v_trip_id
               AND c.required_arrival_at IS NOT NULL
               -- greatest(): an inverted interval on either side must not throw here;
               -- the plan's own interval CHECK refuses it at the UPDATE.
               AND tstzrange(c.required_arrival_at - coalesce(c.prep_duration, interval '0'),
                             greatest(coalesce(c.starts_at, c.required_arrival_at) + coalesce(c.lateness_tolerance, interval '0'),
                                      c.required_arrival_at - coalesce(c.prep_duration, interval '0')), '[]')
                   && tstzrange(v_plan_starts, greatest(coalesce(v_plan_ends, v_plan_starts), v_plan_starts), '[]')
             ORDER BY c.required_arrival_at
             LIMIT 1;
            IF v_conflict_id IS NOT NULL THEN
              IF coalesce((v_payload->>'override_conflicts')::boolean, false) THEN
                v_overridden := true;
              ELSE
                RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_TEMPORAL_CONFLICT',
                  'commitment_id', v_conflict_id, 'detail', 'the new interval overlaps a commitment''s approach window; resend with override_conflicts: true to keep both and have the override recorded',
                  'contract_version', 2);
              END IF;
            END IF;
          END IF;
        END IF;
        IF v_patch ? 'status' THEN
          v_new_status := v_patch->>'status';
          -- §3.3 draws no arrow out of COMPLETED or CANCELLED.$guard$);

  -- the override is a fact the event must carry
  n := (length(d) - length(replace(d, E'          ELSE                          ''trip.plan_updated'' END;\n        v_result := to_jsonb(v_row);', ''))) / length(E'          ELSE                          ''trip.plan_updated'' END;\n        v_result := to_jsonb(v_row);');
  IF n <> 1 THEN RAISE EXCEPTION '2779: anchor plan result occurs % times, expected 1', n; END IF;
  d := replace(d, E'          ELSE                          ''trip.plan_updated'' END;\n        v_result := to_jsonb(v_row);',
$res$          ELSE                          'trip.plan_updated' END;
        v_result := to_jsonb(v_row);
        IF v_overridden THEN
          v_result := v_result || jsonb_build_object('temporal_conflict',
            jsonb_build_object('commitment_id', v_conflict_id, 'overridden', true, 'reason', 'TRIP_TEMPORAL_CONFLICT'));
        END IF;$res$);

  -- the new branches
  n := (length(d) - length(replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', ''))) / length(E'      WHEN ''REMOVE_PLAN'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2779: anchor REMOVE_PLAN branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', $branches$      WHEN 'START_PLAN', 'SKIP_PLAN' THEN
        v_item_id := (v_payload->>'item_id')::uuid;
        IF v_item_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'item_id required', 'contract_version', 2);
        END IF;
        SELECT status, version INTO v_status, v_plan_version
          FROM public.trip_plan_items
         WHERE id = v_item_id AND trip_id = v_trip_id AND removed_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_NOT_FOUND', 'contract_version', 2);
        END IF;
        BEGIN
          v_expected_plan := (v_payload->>'expected_plan_version')::bigint;
        EXCEPTION WHEN OTHERS THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'expected_plan_version must be an integer', 'contract_version', 2);
        END;
        IF v_expected_plan IS NOT NULL AND v_expected_plan <> v_plan_version THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_VERSION_CONFLICT',
            'current_version', v_plan_version, 'expected_version', v_expected_plan, 'contract_version', 2);
        END IF;
        v_new_status := CASE v_type WHEN 'START_PLAN' THEN 'in_progress' ELSE 'skipped' END;
        -- §3.3: START only from a state that precedes IN_PROGRESS; SKIP never out of a terminal state.
        IF (v_type = 'START_PLAN' AND v_status NOT IN ('draft', 'proposed', 'tentative', 'confirmed', 'moved'))
           OR (v_type = 'SKIP_PLAN' AND v_status IN ('done', 'cancelled', 'skipped')) THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PLAN_INVALID_TRANSITION',
                                    'from', v_status, 'to', v_new_status, 'contract_version', 2);
        END IF;
        UPDATE public.trip_plan_items
           SET status = v_new_status, version = version + 1, updated_at = now()
         WHERE id = v_item_id
        RETURNING * INTO v_row;
        v_event_type := CASE v_type WHEN 'START_PLAN' THEN 'trip.plan_started' ELSE 'trip.plan_skipped' END;
        v_result := to_jsonb(v_row);

      WHEN 'START_STAGE', 'COMPLETE_STAGE' THEN
        v_stage_id := (v_payload->>'stage_id')::uuid;
        IF v_stage_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'stage_id required', 'contract_version', 2);
        END IF;
        SELECT state INTO v_status FROM public.trip_stages
         WHERE id = v_stage_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_new_status := CASE v_type WHEN 'START_STAGE' THEN 'active' ELSE 'completed' END;
        IF (v_type = 'START_STAGE' AND v_status <> 'planned') OR (v_type = 'COMPLETE_STAGE' AND v_status <> 'active') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_INVALID_TRANSITION',
                                    'from', v_status, 'to', v_new_status, 'contract_version', 2);
        END IF;
        UPDATE public.trip_stages SET state = v_new_status, updated_at = now() WHERE id = v_stage_id;
        v_family     := 'stage';
        v_event_type := CASE v_type WHEN 'START_STAGE' THEN 'trip.stage_started' ELSE 'trip.stage_completed' END;
        v_result     := jsonb_build_object('id', v_stage_id, 'state', v_new_status);

      WHEN 'REMOVE_PLAN' THEN$branches$);

  EXECUTE d;

  branches_after := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF branches_after <> branches_before + 2 THEN
    RAISE EXCEPTION '2779: expected exactly 2 new command branches, found % -> %', branches_before, branches_after;
  END IF;
  IF length(d) <= before_len THEN RAISE EXCEPTION '2779: the definition did not grow'; END IF;
END
$tx$;

-- ── postconditions: read the INSTALLED definition, not the text above ─────────
DO $post$
DECLARE d text; n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF position('START_PLAN' in d) = 0 THEN RAISE EXCEPTION '2779: START_PLAN missing after apply'; END IF;
  IF position('SKIP_PLAN' in d) = 0 THEN RAISE EXCEPTION '2779: SKIP_PLAN missing'; END IF;
  IF position('START_STAGE' in d) = 0 THEN RAISE EXCEPTION '2779: START_STAGE missing'; END IF;
  IF position('trip.plan_started' in d) = 0 THEN RAISE EXCEPTION '2779: trip.plan_started missing'; END IF;
  IF position('trip.plan_skipped' in d) = 0 THEN RAISE EXCEPTION '2779: trip.plan_skipped missing'; END IF;
  IF position('trip.stage_started' in d) = 0 THEN RAISE EXCEPTION '2779: trip.stage_started missing'; END IF;
  IF position('trip.stage_completed' in d) = 0 THEN RAISE EXCEPTION '2779: trip.stage_completed missing'; END IF;
  IF position('TRIP_TEMPORAL_CONFLICT' in d) = 0 THEN RAISE EXCEPTION '2779: the §7.2 refusal is missing'; END IF;
  IF position('override_conflicts' in d) = 0 THEN RAISE EXCEPTION '2779: the override path is missing'; END IF;
  IF position('TRIP_STAGE_INVALID_TRANSITION' in d) = 0 THEN RAISE EXCEPTION '2779: stage transition refusal missing'; END IF;
  IF position('''skipped'') THEN' in d) = 0 THEN RAISE EXCEPTION '2779: skipped is not terminal'; END IF;
  n := (length(d) - length(replace(d, E'v_family     := ''stage'';', ''))) / length(E'v_family     := ''stage'';');
  IF n <> 4 THEN RAISE EXCEPTION '2779: expected 4 stage-family assignments (3 from 2764 + 1), found %', n; END IF;
  -- pre-existing guarantees must survive verbatim
  IF position('TRIP_VERSION_CONFLICT' in d) = 0 THEN RAISE EXCEPTION '2779: version conflict lost'; END IF;
  IF position('TRIP_PLAN_VERSION_CONFLICT' in d) = 0 THEN RAISE EXCEPTION '2779: plan version conflict lost'; END IF;
  IF position('authz.is_accepted_trip_member' in d) = 0 THEN RAISE EXCEPTION '2779: crew capability check lost'; END IF;
  IF position('trip_command_receipts' in d) = 0 THEN RAISE EXCEPTION '2779: idempotency receipt lost'; END IF;
  IF position('trip_outbox' in d) = 0 THEN RAISE EXCEPTION '2779: outbox write lost'; END IF;
  n := (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED', ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED');
  IF n <> 2 THEN RAISE EXCEPTION '2779: expected the 2 pre-existing trip-level range checks, found %', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trip_plan_items_status_known' AND convalidated) THEN
    RAISE EXCEPTION '2779: the §3.3 status CHECK is missing or not validated';
  END IF;
END
$post$;

COMMIT;
