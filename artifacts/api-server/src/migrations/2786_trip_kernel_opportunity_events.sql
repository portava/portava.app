-- 2786_trip_kernel_opportunity_events.sql
--
-- Trips spec §13.3 Opportunity events — "Notify only when the action universe
-- changes enough to matter" — as a §4.2 domain event the kernel records.
-- census-trips TR244–TR253, TR263, TR397.
--
-- WHAT THIS FILE BUILDS
-- =====================
--   One engine-capability command, RECORD_OPPORTUNITY_CHANGE, whose event is
--   trip.opportunities_changed. The payload IS the §13.3 contract:
--     trigger, window_id, previous_window, new_window, added[], removed[],
--     significance, expires_at, reason_codes[]
--   The engine (services/trips/TripOpportunityProjection.ts) issues it with
--   actor_role 'system' and an idempotency key made of the window id and the
--   diff, so the same change recorded twice is one event (§22.4). Accepted
--   crew may record one too — the 'engine' capability 2785 introduced.
--
-- WHAT IT DOES NOT DO
-- ===================
--   It does not notify. The attention policy (§11.4, lib/tripPush.ts) reads
--   the significance and decides; a projection recomputing on a GET must not
--   push as a side effect. It does not store opportunities: the portfolio is
--   a ledgered decision (§21.2, trip_decisions.decision_type =
--   'opportunity_portfolio'), and this event is the change between two of
--   them.
--
-- METHOD: 2764's transform, as 2779–2785. Read the installed definition,
-- count each anchor, replace, EXECUTE, then assert on the installed text.

DO $tx$
DECLARE d text; n int; before_len int; branches_before int; branches_after int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2786: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF position('RECORD_OPPORTUNITY_CHANGE' in d) > 0 THEN
    RAISE EXCEPTION '2786: RECORD_OPPORTUNITY_CHANGE is already present; this migration is not idempotent by design';
  END IF;
  IF position('WHEN ''engine'' THEN' in d) = 0 OR position('OPEN_FREE_WINDOW' in d) = 0 THEN
    RAISE EXCEPTION '2786: the installed kernel is missing 2785''s engine capability; this transform predates nothing and needs 2785 applied first';
  END IF;

  -- declaration: the significance, held once and checked once
  n := (length(d) - length(replace(d, '  v_disruption_id uuid;', ''))) / length('  v_disruption_id uuid;');
  IF n <> 1 THEN RAISE EXCEPTION '2786: anchor v_disruption_id occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_disruption_id uuid;',
                  '  v_disruption_id uuid;' || E'\n' ||
                  '  v_opp_significance text;');

  -- capability: engine
  n := (length(d) - length(replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''', ''))) / length(E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');
  IF n <> 1 THEN RAISE EXCEPTION '2786: anchor SET_TRIP_COVER occurs % times, expected 1', n; END IF;
  d := replace(d, E'    WHEN ''SET_TRIP_COVER'' THEN ''system''',
                  E'    WHEN ''RECORD_OPPORTUNITY_CHANGE'' THEN ''engine''' || E'\n' ||
                  E'    WHEN ''SET_TRIP_COVER'' THEN ''system''');

  -- the branch, before REMOVE_PLAN as every family since 2779
  n := (length(d) - length(replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', ''))) / length(E'      WHEN ''REMOVE_PLAN'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2786: anchor REMOVE_PLAN branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''REMOVE_PLAN'' THEN', $branches$      WHEN 'RECORD_OPPORTUNITY_CHANGE' THEN
        IF coalesce(v_payload->>'window_id', '') = '' OR coalesce(v_payload->>'significance', '') = '' OR coalesce(v_payload->>'trigger', '') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'window_id, trigger and significance are required', 'contract_version', 2);
        END IF;
        v_opp_significance := v_payload->>'significance';
        IF v_opp_significance NOT IN ('none', 'low', 'medium', 'high', 'critical') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'significance must be none | low | medium | high | critical', 'contract_version', 2);
        END IF;
        IF jsonb_typeof(coalesce(v_payload->'added', '[]'::jsonb)) <> 'array' OR jsonb_typeof(coalesce(v_payload->'removed', '[]'::jsonb)) <> 'array'
           OR jsonb_typeof(coalesce(v_payload->'reason_codes', '[]'::jsonb)) <> 'array' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'added, removed and reason_codes must be arrays', 'contract_version', 2);
        END IF;
        v_family     := 'opportunity';
        v_event_type := 'trip.opportunities_changed';
        v_result     := jsonb_build_object(
          'trigger', v_payload->>'trigger', 'window_id', v_payload->>'window_id',
          'previous_window', v_payload->'previous_window', 'new_window', v_payload->'new_window',
          'added', coalesce(v_payload->'added', '[]'::jsonb), 'removed', coalesce(v_payload->'removed', '[]'::jsonb),
          'significance', v_opp_significance, 'expires_at', v_payload->>'expires_at',
          'reason_codes', coalesce(v_payload->'reason_codes', '[]'::jsonb), 'source', coalesce(v_payload->>'source', 'engine'));

      WHEN 'REMOVE_PLAN' THEN$branches$);

  EXECUTE d;

  branches_after := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF branches_after <> branches_before + 1 THEN
    RAISE EXCEPTION '2786: expected exactly 1 new command branch, found % -> %', branches_before, branches_after;
  END IF;
  IF length(d) <= before_len THEN RAISE EXCEPTION '2786: the definition did not grow'; END IF;
END
$tx$;

DO $post$
DECLARE d text; n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF position('trip.opportunities_changed' in d) = 0 THEN RAISE EXCEPTION '2786: trip.opportunities_changed missing'; END IF;
  n := (length(d) - length(replace(d, 'v_family     := ''opportunity'';', ''))) / length('v_family     := ''opportunity'';');
  IF n <> 1 THEN RAISE EXCEPTION '2786: expected exactly 1 opportunity family assignments, found %', n; END IF;
  IF position('v_opp_significance text;' in d) = 0 THEN RAISE EXCEPTION '2786: the significance local is missing'; END IF;
  n := (length(d) - length(replace(d, 'THEN ''engine''', ''))) / length('THEN ''engine''');
  IF n <> 4 THEN RAISE EXCEPTION '2786: expected 4 engine-capability commands, found %', n; END IF;
  IF position('significance must be none | low | medium | high | critical' in d) = 0 THEN RAISE EXCEPTION '2786: significance vocabulary check missing'; END IF;
  IF position('DECLARE_DISRUPTION' in d) = 0 OR position('OPEN_FREE_WINDOW' in d) = 0 OR position('START_PLAN' in d) = 0 OR position('CREATE_SUBGROUP' in d) = 0 THEN
    RAISE EXCEPTION '2786: an earlier family was lost';
  END IF;
  IF position('trip_command_receipts' in d) = 0 OR position('TRIP_VERSION_CONFLICT' in d) = 0 OR position('trip_outbox' in d) = 0
     OR position('authz.is_accepted_trip_member' in d) = 0 THEN RAISE EXCEPTION '2786: kernel guarantees lost'; END IF;
END
$post$;
