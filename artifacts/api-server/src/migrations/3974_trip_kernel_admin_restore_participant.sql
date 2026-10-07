-- 3974_trip_kernel_admin_restore_participant.sql
--
-- Trip Kernel command ADMIN_RESTORE_PARTICIPANT — the write an upheld
-- trip-membership appeal needs (lane B's request, wave 2; census-trips §83).
-- The owner's ruling (Trips, "Appeal restoration", 2026-10-04), verbatim:
--
--   "If an appeal succeeds, restore the access and permissions removed by that
--    decision. Don't recreate missed live activity or location sharing; if a
--    trip has ended, restore access to its retained record only."
--
-- Lane B (services/appeals/adminRestoreParticipant.ts on its branch) decides
-- WHAT to restore — planAppealRestoration: the role at removal, read from the
-- removal event, and `membership` for a live trip or `retained_record_only` for
-- an ended one — and refused, naming this command, because no kernel command
-- could carry the write: REMOVE_PARTICIPANT deletes the trip_members row, so a
-- restoration is an INSERT, ADD_PARTICIPANT needs the trip's `host`, and the
-- admin family (2450) held ADMIN_HIDE_TRIP alone.
--
-- THE COMMAND (admin family: actor_role 'admin' AND profiles.role = 'admin',
-- the capability check 2450 already runs for the family)
--   payload { user_id, role, access, appeal_id, removal_event_id, reason }
--   The kernel RE-CHECKS everything the plan claims, against the ledger it owns:
--   * the removal event exists, on THIS trip, is a trip.participant_removed of
--     THIS person, and recorded THIS role as role_at_removal — the role is the
--     one the decision took away and no other (TRIP_RESTORE_REMOVAL_NOT_RECORDED);
--   * it is the person's LATEST removal on the trip (TRIP_RESTORE_NOT_LATEST_REMOVAL);
--   * the role is one a removal can have taken: member, co_host, viewer, invited
--     (never owner);
--   * `access` matches the trip as it is NOW: retained_record_only for a
--     completed / archived / cancelled trip, membership for planning / active,
--     anything else refused (TRIP_RESTORE_ACCESS_MISMATCH / TRIP_RESTORE_TRIP_STATUS_UNKNOWN);
--   * the person is not on the trip already (TRIP_PARTICIPANT_ALREADY_EXISTS);
--   * the admin is not restoring themselves.
--   Then it inserts the trip_members row in that role (an `invited` row keeps the
--   invite's legacy shape, as INVITE_PARTICIPANT writes it), stamps
--   permissions = {"access": ..., "restored_by_appeal": ...}, stops any live
--   location session the person still has on the trip, and emits
--   trip.participant_added with payload.via = 'admin_restore' — an existing,
--   folded event type (2773's crew fold reads role/status from the result), the
--   way JOIN_VIA_LINK reuses trip.participant_joined. No new event type.
--
-- LIVE SHARING IS OFF AFTER A RESTORE, by construction: no location session is
-- created and any still active is stopped here; no private-anchor grant exists,
-- because 3972's membership trigger clears every grant to and by a membership
-- that begins. Location PREFERENCES are not touched: a preference is not a share.
--
-- THE CREW CAP STILL APPLIES. enforce_trip_max_members fires on this INSERT as
-- on every other; a full trip is refused TRIP_PARTICIPANT_CAPACITY_REACHED, as
-- ADD_PARTICIPANT is. Lane B's plan reads the ruling as NOT subject to the cap;
-- that reading needs the owner, and this file does not bypass the trigger.
--
-- A TRANSFORM, NOT A REWRITE — 2764's method, as 2798 uses it: anchors counted
-- before they are replaced, branch count checked exactly, postconditions re-read
-- the installed function. BASE: the post-2798 kernel. NOT REHEARSED on
-- db/harness/run.sh (no Postgres on this machine) nor on any Supabase database;
-- APPLIED TO NO DATABASE. Its application is the owner's.
--
-- Rollback: db/rollback/2026-10-05-3974-trip-kernel-admin-restore-participant-rollback.sql

BEGIN;

DO $base$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '3974: trip_kernel_execute not found'; END IF;
  IF position('ADD_RECURRING_COMMITMENT' in d) = 0 THEN
    RAISE EXCEPTION '3974: the installed kernel predates 2798; apply the kernel ancestry through 2798 first';
  END IF;
  IF position('ADMIN_RESTORE_PARTICIPANT' in d) > 0 THEN
    RAISE EXCEPTION '3974: ADMIN_RESTORE_PARTICIPANT is already present; this migration is not idempotent by design';
  END IF;
  IF to_regclass('public.trip_crew_location_sessions') IS NULL THEN
    RAISE EXCEPTION '3974: trip_crew_location_sessions is required (the restore stops a surviving session)';
  END IF;
END
$base$;

DO $mig$
DECLARE
  d text;
  n int;
  before_len int;
  branches_before int;
  admin_before int;
  family_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  admin_before := (length(d) - length(replace(d, $a$THEN 'admin'$a$, ''))) / length($a$THEN 'admin'$a$);
  -- family assignments, counted FROM THE KERNEL IN FRONT OF US (2798's reason), whatever the alignment of `:=` (the kernel's own branches use 1 to 5 spaces; counting one spacing measured 0 → 1 and refused the replay)
  family_before := (SELECT count(*)::int FROM regexp_matches(d, 'v_family\s+:= ''participant'';', 'g'));
  CREATE TEMP TABLE _k3974_before (what text PRIMARY KEY, n int) ON COMMIT DROP;
  INSERT INTO _k3974_before VALUES ('participant_family', family_before), ('branches', branches_before);

  -- 1. declarations, after 2798's last
  n := (length(d) - length(replace(d, '  v_rec_day    date;', ''))) / length('  v_rec_day    date;');
  IF n <> 1 THEN RAISE EXCEPTION '3974: anchor v_rec_day occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_rec_day    date;',
                  '  v_rec_day    date;' || E'\n' ||
                  '  v_rst_event  uuid;' || E'\n' ||
                  '  v_rst_seq    bigint;' || E'\n' ||
                  '  v_rst_access text;');

  -- 2. capability dispatch: the admin family
  n := (length(d) - length(replace(d, $a$    WHEN 'ADMIN_HIDE_TRIP' THEN 'admin'$a$, ''))) / length($a$    WHEN 'ADMIN_HIDE_TRIP' THEN 'admin'$a$);
  IF n <> 1 THEN RAISE EXCEPTION '3974: anchor ADMIN_HIDE_TRIP dispatch occurs % times, expected 1', n; END IF;
  d := replace(d, $a$    WHEN 'ADMIN_HIDE_TRIP' THEN 'admin'$a$,
                  $a$    WHEN 'ADMIN_HIDE_TRIP' THEN 'admin' WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN 'admin'$a$);

  -- 3. the branch, inserted before ADMIN_HIDE_TRIP's
  n := (length(d) - length(replace(d, E'      WHEN ''ADMIN_HIDE_TRIP'' THEN\n', ''))) / length(E'      WHEN ''ADMIN_HIDE_TRIP'' THEN\n');
  IF n <> 1 THEN RAISE EXCEPTION '3974: anchor ADMIN_HIDE_TRIP branch occurs % times, expected 1', n; END IF;
  d := replace(d, E'      WHEN ''ADMIN_HIDE_TRIP'' THEN\n', $branches$      WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN
        -- 3974 (census-trips §83): an upheld appeal restores what the removal took.
        v_family := 'participant';
        BEGIN
          v_subject   := (v_payload->>'user_id')::uuid;
          v_rst_event := (v_payload->>'removal_event_id')::uuid;
          PERFORM (v_payload->>'appeal_id')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'user_id, removal_event_id and appeal_id must be uuids', 'contract_version', 2);
        END;
        v_new_role   := v_payload->>'role';
        v_rst_access := v_payload->>'access';
        IF v_subject IS NULL OR v_rst_event IS NULL OR coalesce(v_payload->>'appeal_id', '') = ''
           OR coalesce(v_new_role, '') = '' OR coalesce(v_rst_access, '') = '' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'user_id, role, access, appeal_id and removal_event_id are required', 'contract_version', 2);
        END IF;
        IF v_subject = v_actor THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'an admin cannot restore themselves', 'contract_version', 2);
        END IF;
        IF v_new_role NOT IN ('member', 'co_host', 'viewer', 'invited') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'role must be a role a removal can take: member, co_host, viewer or invited', 'contract_version', 2);
        END IF;
        IF v_rst_access NOT IN ('membership', 'retained_record_only') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'access must be membership or retained_record_only', 'contract_version', 2);
        END IF;
        -- The ruling's split, re-decided from the trip as it is now.
        IF v_trip.status::text IN ('completed', 'archived', 'cancelled') THEN
          IF v_rst_access <> 'retained_record_only' THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RESTORE_ACCESS_MISMATCH', 'detail', 'the trip has ended: only its retained record can be restored', 'contract_version', 2);
          END IF;
        ELSIF v_trip.status::text IN ('planning', 'active') THEN
          IF v_rst_access <> 'membership' THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RESTORE_ACCESS_MISMATCH', 'detail', 'the trip is live: the membership is restored', 'contract_version', 2);
          END IF;
        ELSE
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RESTORE_TRIP_STATUS_UNKNOWN', 'detail', 'trip status ' || coalesce(v_trip.status::text, 'NULL') || ' is not one the ruling is applied to', 'contract_version', 2);
        END IF;
        -- The removal, from the ledger this function writes: this trip, this
        -- person, this role.
        SELECT e.sequence INTO v_rst_seq FROM public.trip_events e
         WHERE e.event_id = v_rst_event
           AND e.trip_id = v_trip_id
           AND e.type = 'trip.participant_removed'
           AND e.payload_json->'result'->>'user_id' = v_subject::text
           AND e.payload_json->'payload'->>'role_at_removal' = v_new_role;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RESTORE_REMOVAL_NOT_RECORDED', 'detail', 'no trip.participant_removed event of this person on this trip records that role', 'contract_version', 2);
        END IF;
        IF EXISTS (SELECT 1 FROM public.trip_events e2
                    WHERE e2.trip_id = v_trip_id AND e2.type = 'trip.participant_removed'
                      AND e2.payload_json->'result'->>'user_id' = v_subject::text
                      AND e2.sequence > v_rst_seq) THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_RESTORE_NOT_LATEST_REMOVAL', 'detail', 'a later removal of this person is on record; restore what the latest one took', 'contract_version', 2);
        END IF;
        SELECT * INTO v_member FROM public.trip_members WHERE trip_id = v_trip_id AND user_id = v_subject FOR UPDATE;
        IF FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PARTICIPANT_ALREADY_EXISTS', 'current_role', v_member.role::text, 'contract_version', 2);
        END IF;
        BEGIN
          IF v_new_role = 'invited' THEN
            -- An invite comes back as INVITE_PARTICIPANT writes one: role 'invited', status at its default.
            INSERT INTO public.trip_members (trip_id, user_id, role, permissions)
            VALUES (v_trip_id, v_subject, 'invited',
                    jsonb_build_object('access', v_rst_access, 'restored_by_appeal', v_payload->>'appeal_id'))
            RETURNING * INTO v_member;
          ELSE
            INSERT INTO public.trip_members (trip_id, user_id, role, status, joined_at, permissions)
            VALUES (v_trip_id, v_subject, v_new_role::member_role, 'accepted', now(),
                    jsonb_build_object('access', v_rst_access, 'restored_by_appeal', v_payload->>'appeal_id'))
            RETURNING * INTO v_member;
          END IF;
        EXCEPTION
          WHEN raise_exception THEN
            IF SQLERRM = 'trip_full' THEN
              RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_PARTICIPANT_CAPACITY_REACHED', 'contract_version', 2);
            END IF;
            RAISE;
        END;
        -- "Don't recreate missed live activity or location sharing."
        UPDATE public.trip_crew_location_sessions SET status = 'stopped', stopped_at = now()
         WHERE trip_id = v_trip_id AND user_id = v_subject AND status = 'active';
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_family     := 'participant';
        v_event_type := 'trip.participant_added';
        v_result := jsonb_build_object('trip_id', v_trip_id, 'user_id', v_subject, 'role', v_member.role::text,
                                       'status', v_member.status, 'access', v_rst_access,
                                       'live_sharing_restored', false, 'sessions_stopped', v_n);
        v_payload := v_payload || jsonb_build_object('via', 'admin_restore', 'removal_sequence', v_rst_seq);

      WHEN 'ADMIN_HIDE_TRIP' THEN
$branches$);

  IF length(d) <= before_len THEN RAISE EXCEPTION '3974: the transform did not grow the definition'; END IF;
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before + 1 THEN
    RAISE EXCEPTION '3974: the transform added % command branches, expected exactly 1', n - branches_before;
  END IF;
  n := (length(d) - length(replace(d, $a$THEN 'admin'$a$, ''))) / length($a$THEN 'admin'$a$);
  IF n <> admin_before + 1 THEN
    RAISE EXCEPTION '3974: the admin dispatch went from % to % entries, expected +1', admin_before, n;
  END IF;

  EXECUTE d;
  -- family assignments must grow by exactly two (entry + before the event); checked again after COMMIT
  n := (SELECT count(*)::int FROM regexp_matches(d, 'v_family\s+:= ''participant'';', 'g'));
  IF n <> family_before + 2 THEN
    RAISE EXCEPTION '3974: participant family assignments went from % to %, expected +2', family_before, n;
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS _k3974_after (what text PRIMARY KEY, n int);
  DELETE FROM _k3974_after;
  INSERT INTO _k3974_after VALUES ('participant_family', n);
END
$mig$;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE d text; t text; n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  FOREACH t IN ARRAY ARRAY[
    $a$WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN 'admin'$a$,
    $a$WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN$a$,
    'TRIP_RESTORE_REMOVAL_NOT_RECORDED', 'TRIP_RESTORE_NOT_LATEST_REMOVAL', 'TRIP_RESTORE_ACCESS_MISMATCH',
    'TRIP_RESTORE_TRIP_STATUS_UNKNOWN', $a$'via', 'admin_restore'$a$, $a$'live_sharing_restored', false$a$,
    -- what this transform did not name must still be there
    $a$WHEN 'ADMIN_HIDE_TRIP' THEN 'admin'$a$, 'trip.hidden_by_admin', 'ADD_RECURRING_COMMITMENT', 'REMOVE_PARTICIPANT', 'JOIN_VIA_LINK',
    'TRIP_VERSION_CONFLICT', 'authz.is_accepted_trip_member', 'trip_command_receipts', 'trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3974): % missing after apply', t; END IF;
  END LOOP;
  -- Ledger attribution: the branch sets v_family twice (at entry, and again
  -- immediately before its event), so the participant family assignments in the
  -- installed definition must have grown by exactly two.
  n := (SELECT count(*)::int FROM regexp_matches(d, 'v_family\s+:= ''participant'';', 'g'));
  IF n <> (SELECT b.n FROM pg_temp._k3974_after b WHERE b.what = 'participant_family') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3974): participant family assignments are %, expected % — a dropped one would file events under the wrong family', n, (SELECT b.n FROM pg_temp._k3974_after b WHERE b.what = 'participant_family');
  END IF;
END
$post$;
