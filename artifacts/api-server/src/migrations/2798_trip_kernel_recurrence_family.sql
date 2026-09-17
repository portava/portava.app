-- 2798_trip_kernel_recurrence_family.sql
--
-- Trips v4 §4: the ADD_RECURRING_COMMITMENT / UPDATE_RECURRING_COMMITMENT /
-- REMOVE_RECURRING_COMMITMENT / SKIP_RECURRENCE_OCCURRENCE /
-- UNSKIP_RECURRENCE_OCCURRENCE command family, so that
-- `trip_commitment_recurrences` (2797) stops being a table nothing writes and
-- §23's "Long-stay 45 days" scenario has a write path (census-trips TR427).
--
-- BASE: the post-2765 kernel. This file asserts ADD_COMMITMENT is present
-- before it touches anything, for the reason 2764's header gives at length: a
-- transform applied to the wrong base produces a plausible-looking WRONG
-- function, and the only defence is refusing to start. A recurrence is the
-- recurring form of a commitment and its branches are inserted beside that
-- family's, so that anchor is both the precondition and the insertion point.
--
-- A TRANSFORM, NOT A REWRITE — 2764's method, unchanged. Every anchor is
-- counted before it is replaced, the branch count is checked exactly, and the
-- postconditions re-read the installed function to confirm that what this file
-- did not name is still there.
--
-- REHEARSED ON db/harness/run.sh (db/harness/probe_recurrence_family.sql),
-- where the commands are EXECUTED and the rollback must restore the definition
-- byte-for-byte. Read that file's header for what a green run does and does not
-- establish. NOT REHEARSED ON ANY SUPABASE DATABASE.
--
-- FIVE COMMANDS, AND WHY THE LAST TWO EXIST
-- =========================================
-- ADD / UPDATE / REMOVE are the shape every §5 family has. The other two are
-- the EXCEPTION mechanism 2797's header describes: "Thursday's class is at
-- 10:00 this week" is SKIP_RECURRENCE_OCCURRENCE(Thursday) plus an ordinary
-- ADD_COMMITMENT. UNSKIP exists because a skip that cannot be undone is a trap:
-- the traveller who cancels the cancellation would otherwise have to edit the
-- whole rule, and editing a rule to fix one day is how a rule becomes wrong.
--
-- Both are UPDATEs of `skip_dates` and both are IDEMPOTENT IN THE DATA
-- (array_agg(DISTINCT …) and array_remove), which is deliberate and is NOT the
-- same as §22.4 idempotency: a second SKIP with a DIFFERENT idempotency key is
-- a new command, writes a new event and bumps the version, but leaves the set
-- unchanged. A traveller pressing "skip" twice must not produce two skips.
--
-- THE TWO CHECKS NO CONSTRAINT CAN MAKE, MADE HERE
-- ================================================
-- 1. THE TIMEZONE MUST RESOLVE. 2797's CHECK can only prove the string is
--    non-empty and is not a UTC offset; whether 'Europe/Lisbob' is a zone is a
--    question only the server's tzdata can answer. This branch asks it, by
--    evaluating `now() AT TIME ZONE tz`, and refuses TRIP_RECURRENCE_TIMEZONE_UNKNOWN.
--    Without this, a typo produces a rule that stores fine and expands to
--    nothing forever.
-- 2. THE RANGE IS CAPPED AT 400 DAYS. Not a CHECK, because it is a POLICY and
--    policies move; a CHECK would have to be migrated to change it. 400 days is
--    "a long stay plus a leap year's slack" and is the write-time half of the
--    anti-bloat guarantee: the read-time half is the expander's horizon and
--    occurrence cap (domain/trips/invariants/TripRecurrence.ts). Refused as
--    TRIP_RECURRENCE_RANGE_TOO_LONG, which is a refusal a client can explain.
--
-- WHAT THIS FILE DOES NOT DO, STATED SO IT IS NOT READ AS DONE
-- ============================================================
--   * 2779's §7.2 approach-window guard refuses a PLAN that overlaps a
--     COMMITMENT ROW. Recurrence occurrences are not rows, so that guard does
--     not see them. A plan placed on top of a standing 09:00 class is reported
--     by the freedom projection (which does expand the rule) and is NOT refused
--     at the write. Closing that needs the guard to expand rules inside the
--     kernel, which is a second implementation of the expander in plpgsql —
--     the wrong trade, and named here rather than left to be discovered.
--   * 2785's MARK_COMMITMENT_AT_RISK takes a `trip_commitments.id`. An
--     occurrence has no row and therefore cannot be marked at risk. The
--     traveller's remedy is the one the model already gives: skip the
--     occurrence and add a real commitment for it.
--   * No flag. 2797's header says why.

BEGIN;

DO $base$
DECLARE d text; n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_commitment_recurrences';
  IF n <> 1 THEN RAISE EXCEPTION '2798: requires 2797 (trip_commitment_recurrences)'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2798: trip_kernel_execute not found'; END IF;
  IF position('ADD_COMMITMENT' in d) = 0 THEN
    RAISE EXCEPTION '2798: the installed kernel predates 2765 (no commitment family). A recurrence is the recurring form of a commitment; apply 2450 -> 2500 -> 2590 -> 2764 -> 2765 first.';
  END IF;
  IF position('v_patch      jsonb;' in d) = 0 THEN
    RAISE EXCEPTION '2798: the installed kernel does not declare v_patch; the UPDATE branch below reuses it';
  END IF;
  IF position('  v_commit_id  uuid;' in d) = 0 THEN
    RAISE EXCEPTION '2798: the installed kernel does not declare v_commit_id; the declaration anchor below is 2765''s';
  END IF;
END
$base$;

DO $mig$
DECLARE
  d text;
  n int;
  before_len int;
  branches_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  -- The "what this transform did not name, it must not have moved" counts are
  -- taken FROM THE KERNEL IN FRONT OF US, and never hard-coded from a reading
  -- of 2764/2765. Those two files are not the whole ancestry: 2768, 2793 and
  -- 2794 each added stage- and range-checking branches of their own, so the
  -- installed kernel carries 5 stage-family assignments and 3
  -- TRIP_TEMPORAL_RANGE_INVERTED sites, not the 3 and 2 a reading of 2765
  -- suggests. An absolute number here is wrong on this kernel AND weaker than
  -- a delta on any kernel — a transform that dropped one stage branch and
  -- added another still totals whatever it totalled. What must hold is that
  -- these counts are UNCHANGED by a transform that does not name them.
  CREATE TEMP TABLE _k2798_before (what text PRIMARY KEY, n int) ON COMMIT DROP;
  INSERT INTO _k2798_before VALUES
    ('branches',   branches_before),
    ('stage',      (length(d) - length(replace(d, E'v_family     := ''stage'';',      ''))) / length(E'v_family     := ''stage'';')),
    ('commitment', (length(d) - length(replace(d, E'v_family     := ''commitment'';', ''))) / length(E'v_family     := ''commitment'';')),
    ('leg',        (length(d) - length(replace(d, E'v_family     := ''leg'';',        ''))) / length(E'v_family     := ''leg'';')),
    ('range_inv',  (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED',     ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED')),
    ('ins_commit', (length(d) - length(replace(d, 'INSERT INTO public.trip_commitments' || E'\n', ''))) / length('INSERT INTO public.trip_commitments' || E'\n'));

  IF position('ADD_RECURRING_COMMITMENT' in d) > 0 THEN
    RAISE EXCEPTION '2798: the recurrence family is already present; this migration is not idempotent by design';
  END IF;

  -- 1. the declarations
  n := (length(d) - length(replace(d, '  v_commit_id  uuid;', ''))) / length('  v_commit_id  uuid;');
  IF n <> 1 THEN RAISE EXCEPTION '2798: anchor v_commit_id occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_commit_id  uuid;',
                  '  v_commit_id  uuid;' || E'\n' ||
                  '  v_rec_id     uuid;' || E'\n' ||
                  '  v_rec_tz     text;' || E'\n' ||
                  '  v_rec_from   date;' || E'\n' ||
                  '  v_rec_until  date;' || E'\n' ||
                  '  v_rec_day    date;');

  -- 2. capability dispatch. Crew, like every other §5 family: a routine is trip
  --    state and the 2337 accepted-member rule is what guards trip state.
  n := (length(d) - length(replace(d, $a$    WHEN 'ADD_COMMITMENT' THEN 'crew'$a$, ''))) / length($a$    WHEN 'ADD_COMMITMENT' THEN 'crew'$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2798: anchor ADD_COMMITMENT dispatch occurs % times, expected 1', n; END IF;
  d := replace(d, $a$    WHEN 'ADD_COMMITMENT' THEN 'crew'$a$,
                  $a$    WHEN 'ADD_RECURRING_COMMITMENT' THEN 'crew' WHEN 'UPDATE_RECURRING_COMMITMENT' THEN 'crew' WHEN 'REMOVE_RECURRING_COMMITMENT' THEN 'crew'
    WHEN 'SKIP_RECURRENCE_OCCURRENCE' THEN 'crew' WHEN 'UNSKIP_RECURRENCE_OCCURRENCE' THEN 'crew'
    WHEN 'ADD_COMMITMENT' THEN 'crew'$a$);

  -- 3. the branches, inserted before the commitment family's
  n := (length(d) - length(replace(d, E'      WHEN ''ADD_COMMITMENT'' THEN', ''))) / length(E'      WHEN ''ADD_COMMITMENT'' THEN');
  IF n <> 1 THEN RAISE EXCEPTION '2798: anchor ADD_COMMITMENT branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''ADD_COMMITMENT'' THEN', $branches$      WHEN 'ADD_RECURRING_COMMITMENT' THEN
        IF coalesce(v_payload->>'type','') = ''
           OR coalesce(v_payload->>'timezone','') = ''
           OR coalesce(v_payload->>'freq','') = ''
           OR (v_payload->>'local_time') IS NULL
           OR (v_payload->>'effective_from') IS NULL
           OR (v_payload->>'effective_until') IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'type, timezone, freq, local_time, effective_from and effective_until are required', 'contract_version', 2);
        END IF;
        IF (v_payload->>'stage_id') IS NOT NULL THEN
          PERFORM 1 FROM public.trip_stages
           WHERE id = (v_payload->>'stage_id')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
          END IF;
        END IF;
        -- The zone must RESOLVE. 2797's CHECK cannot ask this; tzdata can.
        v_rec_tz := v_payload->>'timezone';
        BEGIN
          PERFORM now() AT TIME ZONE v_rec_tz;
        EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RECURRENCE_TIMEZONE_UNKNOWN',
            'timezone', v_rec_tz, 'contract_version', 2);
        END;
        BEGIN
          v_rec_from  := (v_payload->>'effective_from')::date;
          v_rec_until := (v_payload->>'effective_until')::date;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        -- The write-time half of the anti-bloat guarantee. A policy, not a CHECK.
        IF (v_rec_until - v_rec_from) > 400 THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RECURRENCE_RANGE_TOO_LONG',
            'days', (v_rec_until - v_rec_from), 'max_days', 400, 'contract_version', 2);
        END IF;
        BEGIN
          INSERT INTO public.trip_commitment_recurrences
            (trip_id, stage_id, type, label, timezone, freq, interval_count, by_weekday,
             local_time, duration, arrival_lead, lateness_tolerance, prep_duration,
             place_id, flexibility, confidence, effective_from, effective_until, skip_dates, source_ref)
          VALUES (v_trip_id, (v_payload->>'stage_id')::uuid, v_payload->>'type', v_payload->>'label',
                  v_rec_tz, v_payload->>'freq',
                  coalesce((v_payload->>'interval_count')::integer, 1),
                  CASE WHEN jsonb_typeof(v_payload->'by_weekday') = 'array'
                       THEN (SELECT array_agg(x::smallint ORDER BY x::smallint)
                               FROM jsonb_array_elements_text(v_payload->'by_weekday') AS t(x))
                       ELSE NULL END,
                  (v_payload->>'local_time')::time,
                  (v_payload->>'duration')::interval,
                  (v_payload->>'arrival_lead')::interval,
                  (v_payload->>'lateness_tolerance')::interval,
                  (v_payload->>'prep_duration')::interval,
                  (v_payload->>'place_id')::uuid,
                  coalesce(v_payload->>'flexibility','flexible'),
                  (v_payload->>'confidence')::numeric,
                  v_rec_from, v_rec_until,
                  CASE WHEN jsonb_typeof(v_payload->'skip_dates') = 'array'
                       THEN (SELECT coalesce(array_agg(DISTINCT x::date ORDER BY x::date), '{}'::date[])
                               FROM jsonb_array_elements_text(v_payload->'skip_dates') AS t(x))
                       ELSE '{}'::date[] END,
                  v_payload->>'source_ref')
          RETURNING id INTO v_rec_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation
                    OR invalid_text_representation OR invalid_datetime_format
                    OR numeric_value_out_of_range OR not_null_violation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'recurrence';
        v_event_type := 'trip.recurring_commitment_added';
        v_result := jsonb_build_object('id', v_rec_id);

      WHEN 'UPDATE_RECURRING_COMMITMENT' THEN
        v_rec_id := (v_payload->>'recurrence_id')::uuid;
        v_patch  := coalesce(v_payload->'patch', '{}'::jsonb);
        IF v_rec_id IS NULL OR jsonb_typeof(v_patch) <> 'object' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        PERFORM 1 FROM public.trip_commitment_recurrences
         WHERE id = v_rec_id AND trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RECURRENCE_NOT_FOUND', 'contract_version', 2);
        END IF;
        IF v_patch ? 'stage_id' AND (v_patch->>'stage_id') IS NOT NULL THEN
          PERFORM 1 FROM public.trip_stages
           WHERE id = (v_patch->>'stage_id')::uuid AND trip_id = v_trip_id;
          IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_STAGE_NOT_FOUND', 'contract_version', 2);
          END IF;
        END IF;
        IF v_patch ? 'timezone' THEN
          v_rec_tz := v_patch->>'timezone';
          BEGIN
            PERFORM now() AT TIME ZONE v_rec_tz;
          EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RECURRENCE_TIMEZONE_UNKNOWN',
              'timezone', v_rec_tz, 'contract_version', 2);
          END;
        END IF;
        -- The 400-day cap again, over the range the patch LEAVES BEHIND, not
        -- over the keys it happens to carry: moving one end is how a capped
        -- range becomes uncapped.
        BEGIN
          SELECT CASE WHEN v_patch ? 'effective_from'  THEN (v_patch->>'effective_from')::date  ELSE r.effective_from  END,
                 CASE WHEN v_patch ? 'effective_until' THEN (v_patch->>'effective_until')::date ELSE r.effective_until END
            INTO v_rec_from, v_rec_until
            FROM public.trip_commitment_recurrences r
           WHERE r.id = v_rec_id AND r.trip_id = v_trip_id;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        IF (v_rec_until - v_rec_from) > 400 THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RECURRENCE_RANGE_TOO_LONG',
            'days', (v_rec_until - v_rec_from), 'max_days', 400, 'contract_version', 2);
        END IF;
        BEGIN
          UPDATE public.trip_commitment_recurrences SET
            stage_id           = CASE WHEN v_patch ? 'stage_id'           THEN (v_patch->>'stage_id')::uuid          ELSE stage_id           END,
            type               = CASE WHEN v_patch ? 'type'               THEN v_patch->>'type'                      ELSE type               END,
            label              = CASE WHEN v_patch ? 'label'              THEN v_patch->>'label'                     ELSE label              END,
            timezone           = CASE WHEN v_patch ? 'timezone'           THEN v_patch->>'timezone'                  ELSE timezone           END,
            freq               = CASE WHEN v_patch ? 'freq'               THEN v_patch->>'freq'                      ELSE freq               END,
            interval_count     = CASE WHEN v_patch ? 'interval_count'     THEN (v_patch->>'interval_count')::integer ELSE interval_count     END,
            by_weekday         = CASE WHEN v_patch ? 'by_weekday'
                                      THEN CASE WHEN jsonb_typeof(v_patch->'by_weekday') = 'array'
                                                THEN (SELECT array_agg(x::smallint ORDER BY x::smallint)
                                                        FROM jsonb_array_elements_text(v_patch->'by_weekday') AS t(x))
                                                ELSE NULL END
                                      ELSE by_weekday END,
            local_time         = CASE WHEN v_patch ? 'local_time'         THEN (v_patch->>'local_time')::time        ELSE local_time         END,
            duration           = CASE WHEN v_patch ? 'duration'           THEN (v_patch->>'duration')::interval      ELSE duration           END,
            arrival_lead       = CASE WHEN v_patch ? 'arrival_lead'       THEN (v_patch->>'arrival_lead')::interval  ELSE arrival_lead       END,
            lateness_tolerance = CASE WHEN v_patch ? 'lateness_tolerance' THEN (v_patch->>'lateness_tolerance')::interval ELSE lateness_tolerance END,
            prep_duration      = CASE WHEN v_patch ? 'prep_duration'      THEN (v_patch->>'prep_duration')::interval ELSE prep_duration      END,
            place_id           = CASE WHEN v_patch ? 'place_id'           THEN (v_patch->>'place_id')::uuid          ELSE place_id           END,
            flexibility        = CASE WHEN v_patch ? 'flexibility'        THEN v_patch->>'flexibility'               ELSE flexibility        END,
            confidence         = CASE WHEN v_patch ? 'confidence'         THEN (v_patch->>'confidence')::numeric     ELSE confidence         END,
            effective_from     = v_rec_from,
            effective_until    = v_rec_until,
            skip_dates         = CASE WHEN v_patch ? 'skip_dates'
                                      THEN CASE WHEN jsonb_typeof(v_patch->'skip_dates') = 'array'
                                                THEN (SELECT coalesce(array_agg(DISTINCT x::date ORDER BY x::date), '{}'::date[])
                                                        FROM jsonb_array_elements_text(v_patch->'skip_dates') AS t(x))
                                                ELSE '{}'::date[] END
                                      ELSE skip_dates END,
            source_ref         = CASE WHEN v_patch ? 'source_ref'         THEN v_patch->>'source_ref'                ELSE source_ref         END,
            updated_at         = now()
          WHERE id = v_rec_id AND trip_id = v_trip_id;
        EXCEPTION WHEN check_violation OR foreign_key_violation
                    OR invalid_text_representation OR invalid_datetime_format
                    OR numeric_value_out_of_range OR not_null_violation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'recurrence';
        v_event_type := 'trip.recurring_commitment_updated';
        v_result := jsonb_build_object('id', v_rec_id);

      WHEN 'REMOVE_RECURRING_COMMITMENT' THEN
        v_rec_id := (v_payload->>'recurrence_id')::uuid;
        IF v_rec_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'contract_version', 2);
        END IF;
        -- A hard DELETE, for 2764's stated reason: the table carries no
        -- removed_at and inventing one here would be inventing a lifecycle the
        -- spec does not describe. Nothing cascades: occurrences were never rows,
        -- and an exception's one-off commitment is a commitment in its own
        -- right and stays.
        DELETE FROM public.trip_commitment_recurrences
         WHERE id = v_rec_id AND trip_id = v_trip_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RECURRENCE_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_family     := 'recurrence';
        v_event_type := 'trip.recurring_commitment_removed';
        v_result := jsonb_build_object('id', v_rec_id);

      WHEN 'SKIP_RECURRENCE_OCCURRENCE' THEN
        v_rec_id := (v_payload->>'recurrence_id')::uuid;
        IF v_rec_id IS NULL OR (v_payload->>'occurrence_date') IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'recurrence_id and occurrence_date are required', 'contract_version', 2);
        END IF;
        BEGIN
          v_rec_day := (v_payload->>'occurrence_date')::date;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        SELECT r.effective_from, r.effective_until INTO v_rec_from, v_rec_until
          FROM public.trip_commitment_recurrences r
         WHERE r.id = v_rec_id AND r.trip_id = v_trip_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RECURRENCE_NOT_FOUND', 'contract_version', 2);
        END IF;
        -- A skip outside the rule's own range is not an exception to anything.
        IF v_rec_day < v_rec_from OR v_rec_day > v_rec_until THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RECURRENCE_DATE_OUT_OF_RANGE',
            'occurrence_date', v_rec_day, 'effective_from', v_rec_from, 'effective_until', v_rec_until,
            'contract_version', 2);
        END IF;
        BEGIN
          UPDATE public.trip_commitment_recurrences r SET
            skip_dates = (SELECT array_agg(DISTINCT u.d ORDER BY u.d)
                            FROM unnest(r.skip_dates || ARRAY[v_rec_day]) AS u(d)),
            updated_at = now()
          WHERE r.id = v_rec_id AND r.trip_id = v_trip_id;
        EXCEPTION WHEN check_violation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        v_family     := 'recurrence';
        v_event_type := 'trip.recurrence_occurrence_skipped';
        v_result := jsonb_build_object('id', v_rec_id, 'occurrence_date', v_rec_day);

      WHEN 'UNSKIP_RECURRENCE_OCCURRENCE' THEN
        v_rec_id := (v_payload->>'recurrence_id')::uuid;
        IF v_rec_id IS NULL OR (v_payload->>'occurrence_date') IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', 'recurrence_id and occurrence_date are required', 'contract_version', 2);
        END IF;
        BEGIN
          v_rec_day := (v_payload->>'occurrence_date')::date;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
            'detail', SQLERRM, 'contract_version', 2);
        END;
        UPDATE public.trip_commitment_recurrences r SET
          skip_dates = array_remove(r.skip_dates, v_rec_day),
          updated_at = now()
        WHERE r.id = v_rec_id AND r.trip_id = v_trip_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RECURRENCE_NOT_FOUND', 'contract_version', 2);
        END IF;
        v_family     := 'recurrence';
        v_event_type := 'trip.recurrence_occurrence_restored';
        v_result := jsonb_build_object('id', v_rec_id, 'occurrence_date', v_rec_day);

      WHEN 'ADD_COMMITMENT' THEN$branches$);

  IF length(d) <= before_len THEN
    RAISE EXCEPTION '2798: the transform did not grow the definition';
  END IF;
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before + 5 THEN
    RAISE EXCEPTION '2798: the transform added % command branches, expected exactly 5', n - branches_before;
  END IF;

  EXECUTE d;
END
$mig$;

DO $post$
DECLARE d text; n int; was int; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';

  FOREACH t IN ARRAY ARRAY['ADD_RECURRING_COMMITMENT','UPDATE_RECURRING_COMMITMENT','REMOVE_RECURRING_COMMITMENT',
                           'SKIP_RECURRENCE_OCCURRENCE','UNSKIP_RECURRENCE_OCCURRENCE',
                           'trip.recurring_commitment_added','trip.recurring_commitment_updated',
                           'trip.recurring_commitment_removed','trip.recurrence_occurrence_skipped',
                           'trip.recurrence_occurrence_restored',
                           'TRIP_RECURRENCE_NOT_FOUND','TRIP_RECURRENCE_TIMEZONE_UNKNOWN',
                           'TRIP_RECURRENCE_RANGE_TOO_LONG','TRIP_RECURRENCE_DATE_OUT_OF_RANGE'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2798: % missing after apply', t; END IF;
  END LOOP;

  -- Ledger attribution, 2764's defect class: a branch that forgets v_family
  -- files its events under 'plan' and nothing downstream notices. Five branches,
  -- five assignments.
  n := (length(d) - length(replace(d, E'v_family     := ''recurrence'';', ''))) / length(E'v_family     := ''recurrence'';');
  IF n <> 5 THEN RAISE EXCEPTION '2798: expected 5 recurrence-family assignments, found %', n; END IF;

  -- The anti-bloat guarantee, restated where it can be checked: the kernel must
  -- NOT write trip_commitments from a recurrence branch. Materialising an
  -- occurrence into a commitment row is exactly what 2797 exists to prevent, and
  -- the place that would happen is here. The recurrence branches insert into
  -- trip_commitment_recurrences and nothing else, so the number of
  -- `INSERT INTO public.trip_commitments` in the whole function must be exactly
  -- what it was before this transform ran.
  n := (length(d) - length(replace(d, 'INSERT INTO public.trip_commitments' || E'\n', ''))) / length('INSERT INTO public.trip_commitments' || E'\n');
  SELECT b.n INTO was FROM _k2798_before b WHERE b.what = 'ins_commit';
  IF n <> was THEN RAISE EXCEPTION '2798: INSERT INTO trip_commitments went from % to % — an occurrence is being materialised', was, n; END IF;
  n := (length(d) - length(replace(d, 'INSERT INTO public.trip_commitment_recurrences', ''))) / length('INSERT INTO public.trip_commitment_recurrences');
  IF n <> 1 THEN RAISE EXCEPTION '2798: expected exactly 1 INSERT INTO trip_commitment_recurrences, found %', n; END IF;

  -- What this transform did not name, it must not have moved.
  FOREACH t IN ARRAY ARRAY['TRIP_VERSION_CONFLICT','authz.is_accepted_trip_member',
                           'trip_command_receipts','trip_outbox',
                           'ADD_COMMITMENT','ADD_LEG','ADD_STAGE','SET_TRIP_COVER','JOIN_VIA_LINK','CREATE_TRIP'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2798: % was lost', t; END IF;
  END LOOP;
  -- Each of these is a DELTA against the kernel as it stood at the top of this
  -- migration, recorded in _k2798_before. See the note there for why an
  -- absolute count would be both wrong on this ancestry and weaker on any.
  n := (length(d) - length(replace(d, E'v_family     := ''commitment'';', ''))) / length(E'v_family     := ''commitment'';');
  SELECT b.n INTO was FROM _k2798_before b WHERE b.what = 'commitment';
  IF n <> was THEN RAISE EXCEPTION '2798: commitment-family assignments went from % to %', was, n; END IF;
  n := (length(d) - length(replace(d, E'v_family     := ''leg'';', ''))) / length(E'v_family     := ''leg'';');
  SELECT b.n INTO was FROM _k2798_before b WHERE b.what = 'leg';
  IF n <> was THEN RAISE EXCEPTION '2798: leg-family assignments went from % to %', was, n; END IF;
  n := (length(d) - length(replace(d, E'v_family     := ''stage'';', ''))) / length(E'v_family     := ''stage'';');
  SELECT b.n INTO was FROM _k2798_before b WHERE b.what = 'stage';
  IF n <> was THEN RAISE EXCEPTION '2798: stage-family assignments went from % to %', was, n; END IF;
  n := (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED', ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED');
  SELECT b.n INTO was FROM _k2798_before b WHERE b.what = 'range_inv';
  IF n <> was THEN RAISE EXCEPTION '2798: trip-level range checks went from % to %', was, n; END IF;
  -- And the branch total: exactly the 5 this migration names, no more.
  SELECT b.n INTO was FROM _k2798_before b WHERE b.what = 'branches';
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> was + 5 THEN RAISE EXCEPTION '2798: the installed kernel has % branches, expected % (was % + 5)', n, was + 5, was; END IF;
END
$post$;

COMMIT;
