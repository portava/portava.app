-- 3979_trip_kernel_admin_restore_participant_reissue.sql
--
-- 3974's Trip Kernel command ADMIN_RESTORE_PARTICIPANT, RE-ISSUED so that it can
-- be applied by the live applier. The transform is 3974's, byte for byte (the
-- branch, the dispatch entry and the declarations are the same literals); only
-- the assertions around it changed. ORDER_OVERRIDES.json declares 3974 SKIPPED,
-- superseded by this file. What the command does, and why, is 3974's header and
-- docs/migrations.md's 3974 entry; nothing about the command is revisited here.
--
-- ── WHY 3974 CANNOT BE APPLIED BY THE LIVE APPLIER ─────────────────────────
-- scripts/src/apply-migrations.ts sends a migration's body (with its ledger row)
-- and its post-COMMIT postconditions as SEPARATE Management API requests, so
-- they run in different sessions. 3974's body stored the family count in a
-- session temp table (pg_temp._k3974_after) and its postcondition read it back:
-- on the live database the table never exists in the postcondition's session.
-- main 2de186f820, live-DB run 37737811561 (job 113182011739):
--   apply-migrations STOPPED at 3974_trip_kernel_admin_restore_participant.sql
--   (postcondition-failed) ... 42P01: relation "pg_temp._k3974_after" does not exist
-- The body and its ledger row COMMITTED first (the applier's "applied + recorded"
-- line precedes the failure), so 3974 is applied and recorded on portava-ci
-- (applied_by='ci', run 37737811561) and cannot be edited: its recorded checksum
-- would no longer match and the applier would refuse the tree as drifted. CI's
-- local-db replay runs a whole file in one psql session, which is why it passed.
-- 3974 also carried a second live-only failure behind the first: its `$base$`
-- precondition ("ADMIN_RESTORE_PARTICIPANT is already present; this migration
-- is not idempotent by design") is not tagged `$pre$`, so certify:migrations
-- stage 4 re-runs it AFTER the commit, where it must be false (2965's lesson).
--
-- ── WHAT THIS FILE DOES ON EACH DATABASE ────────────────────────────────────
-- * Where 3974 never ran (a fresh database: the CI replay, portava-beta,
--   production — 3974 is skipped there): 3974's transform, verbatim.
-- * Where 3974 ran (portava-ci): NOTHING, after proving the installed command is
--   3974's exact text (the branch, immediately before ADMIN_HIDE_TRIP's; the
--   dispatch entry; the declarations — each exactly once). Any other installed
--   ADMIN_RESTORE_PARTICIPANT is refused, never adopted. 2134 is the precedent
--   for a re-issue that is a verified no-op on portava-ci.
-- Either way the postconditions below then assert the same end state, and they
-- are SELF-CONTAINED: they recompute everything from the catalog in their own
-- session and read no state the body left behind (no temp table, no GUC). The
-- precondition is tagged `$pre$`, so certify stage 4 holds it back.
--
-- ── ORDER ───────────────────────────────────────────────────────────────────
-- 3979 sorts after 3975-3978, none of which reads or writes trip_kernel_execute,
-- so on a fresh database the kernel this file produces is the kernel 3974 would
-- have produced in its own position (measured on the PGlite full-chain replay,
-- 2026-10-08: identical pg_get_functiondef md5 either way).
--
-- Rollback: db/rollback/2026-10-08-3979-trip-kernel-admin-restore-participant-reissue-rollback.sql
-- (supersedes 3974's rollback file wherever 3979 is recorded).

BEGIN;

DO $pre$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '3979: trip_kernel_execute not found'; END IF;
  IF position('ADD_RECURRING_COMMITMENT' in d) = 0 THEN
    RAISE EXCEPTION '3979: the installed kernel predates 2798; apply the kernel ancestry through 2798 first';
  END IF;
  IF to_regclass('public.trip_crew_location_sessions') IS NULL THEN
    RAISE EXCEPTION '3979: trip_crew_location_sessions is required (the restore stops a surviving session)';
  END IF;
END
$pre$;

DO $mig$
DECLARE
  d text;
  n int;
  before_len int;
  branches_before int;
  admin_before int;
  family_before int;
  dn text;
  -- 3974's three literals, verbatim. `v_branch` is 3974's branch followed by the
  -- ADMIN_HIDE_TRIP header it was inserted in front of.
  v_branch     constant text := $branches$      WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN
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
$branches$;
  v_hide_head  constant text := E'      WHEN ''ADMIN_HIDE_TRIP'' THEN\n';
  v_dispatch   constant text := $a$    WHEN 'ADMIN_HIDE_TRIP' THEN 'admin'$a$;
  v_dispatch2  constant text := $a$    WHEN 'ADMIN_HIDE_TRIP' THEN 'admin' WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN 'admin'$a$;
  v_decl       constant text := '  v_rec_day    date;';
  v_decl2      constant text := '  v_rec_day    date;' || E'\n' ||
                                '  v_rst_event  uuid;' || E'\n' ||
                                '  v_rst_seq    bigint;' || E'\n' ||
                                '  v_rst_access text;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';

  -- ── 3974 already ran here (portava-ci): accept ONLY its exact text ─────────
  IF position('ADMIN_RESTORE_PARTICIPANT' in d) > 0 THEN
    n := (length(d) - length(replace(d, v_branch, ''))) / length(v_branch);
    IF n <> 1 THEN
      RAISE EXCEPTION '3979: an ADMIN_RESTORE_PARTICIPANT branch is installed, but not 3974''s text immediately before ADMIN_HIDE_TRIP (found % exact copies); refusing to adopt it', n;
    END IF;
    n := (length(d) - length(replace(d, v_dispatch2, ''))) / length(v_dispatch2);
    IF n <> 1 THEN RAISE EXCEPTION '3979: 3974''s admin dispatch entry occurs % times, expected 1', n; END IF;
    n := (length(d) - length(replace(d, v_decl2, ''))) / length(v_decl2);
    IF n <> 1 THEN RAISE EXCEPTION '3979: 3974''s declarations occur % times, expected 1', n; END IF;
    -- Exactly the branch header and the dispatch entry name the command.
    n := (length(d) - length(replace(d, 'ADMIN_RESTORE_PARTICIPANT', ''))) / length('ADMIN_RESTORE_PARTICIPANT');
    IF n <> 2 THEN RAISE EXCEPTION '3979: ADMIN_RESTORE_PARTICIPANT occurs % times in the kernel, expected 2 (branch + dispatch)', n; END IF;
    RAISE NOTICE '3979: ADMIN_RESTORE_PARTICIPANT is installed exactly as 3974 wrote it; nothing to do';
    RETURN;
  END IF;

  -- ── A fresh database: 3974's transform, verbatim ─────────────────────────
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  admin_before := (length(d) - length(replace(d, $a$THEN 'admin'$a$, ''))) / length($a$THEN 'admin'$a$);
  -- family assignments, counted on an alignment-normalised COPY (2798's reason; d itself is EXECUTEd below and keeps its own spacing)
  dn := regexp_replace(d, 'v_family\s+:=', 'v_family :=', 'g');
  family_before := (length(dn) - length(replace(dn, E'v_family := ''participant'';', ''))) / length(E'v_family := ''participant'';');

  -- 1. declarations, after 2798's last
  n := (length(d) - length(replace(d, v_decl, ''))) / length(v_decl);
  IF n <> 1 THEN RAISE EXCEPTION '3979: anchor v_rec_day occurs % times, expected 1', n; END IF;
  d := replace(d, v_decl, v_decl2);

  -- 2. capability dispatch: the admin family
  n := (length(d) - length(replace(d, v_dispatch, ''))) / length(v_dispatch);
  IF n <> 1 THEN RAISE EXCEPTION '3979: anchor ADMIN_HIDE_TRIP dispatch occurs % times, expected 1', n; END IF;
  d := replace(d, v_dispatch, v_dispatch2);

  -- 3. the branch, inserted before ADMIN_HIDE_TRIP's
  n := (length(d) - length(replace(d, v_hide_head, ''))) / length(v_hide_head);
  IF n <> 1 THEN RAISE EXCEPTION '3979: anchor ADMIN_HIDE_TRIP branch occurs % times, expected 1', n; END IF;
  d := replace(d, v_hide_head, v_branch);

  IF length(d) <= before_len THEN RAISE EXCEPTION '3979: the transform did not grow the definition'; END IF;
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before + 1 THEN
    RAISE EXCEPTION '3979: the transform added % command branches, expected exactly 1', n - branches_before;
  END IF;
  n := (length(d) - length(replace(d, $a$THEN 'admin'$a$, ''))) / length($a$THEN 'admin'$a$);
  IF n <> admin_before + 1 THEN
    RAISE EXCEPTION '3979: the admin dispatch went from % to % entries, expected +1', admin_before, n;
  END IF;
  -- family assignments must grow by exactly two (entry + before the event), in
  -- this transaction where `family_before` is known; the postcondition re-measures
  -- the same fact on the branch itself.
  dn := regexp_replace(d, 'v_family\s+:=', 'v_family :=', 'g');
  n := (length(dn) - length(replace(dn, E'v_family := ''participant'';', ''))) / length(E'v_family := ''participant'';');
  IF n <> family_before + 2 THEN
    RAISE EXCEPTION '3979: participant family assignments went from % to %, expected +2', family_before, n;
  END IF;

  EXECUTE d;
END
$mig$;

COMMIT;

-- ── Postconditions (separate transaction AND separate session under the live
--    applier: everything below is recomputed from the catalog; nothing the body
--    did is read back except through the installed function itself) ──────────
DO $post$
DECLARE d text; t text; n int; i int; j int; b text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3979): trip_kernel_execute not found'; END IF;
  FOREACH t IN ARRAY ARRAY[
    $a$WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN 'admin'$a$,
    $a$WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN$a$,
    'TRIP_RESTORE_REMOVAL_NOT_RECORDED', 'TRIP_RESTORE_NOT_LATEST_REMOVAL', 'TRIP_RESTORE_ACCESS_MISMATCH',
    'TRIP_RESTORE_TRIP_STATUS_UNKNOWN', $a$'via', 'admin_restore'$a$, $a$'live_sharing_restored', false$a$,
    -- what this transform did not name must still be there
    $a$WHEN 'ADMIN_HIDE_TRIP' THEN 'admin'$a$, 'trip.hidden_by_admin', 'ADD_RECURRING_COMMITMENT', 'REMOVE_PARTICIPANT', 'JOIN_VIA_LINK',
    'TRIP_VERSION_CONFLICT', 'authz.is_accepted_trip_member', 'trip_command_receipts', 'trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3979): % missing after apply', t; END IF;
  END LOOP;
  IF position('  v_rst_access text;' in d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3979): the restore declarations are missing';
  END IF;

  -- One command, one branch, one dispatch entry.
  n := (length(d) - length(replace(d, E'      WHEN ''ADMIN_RESTORE_PARTICIPANT'' THEN\n', ''))) / length(E'      WHEN ''ADMIN_RESTORE_PARTICIPANT'' THEN\n');
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3979): % ADMIN_RESTORE_PARTICIPANT branches, expected 1', n; END IF;
  n := (length(d) - length(replace(d, $a$WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN 'admin'$a$, ''))) / length($a$WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN 'admin'$a$);
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3979): % admin dispatch entries for ADMIN_RESTORE_PARTICIPANT, expected 1', n; END IF;

  -- The branch itself, cut from the INSTALLED definition: from its header to
  -- ADMIN_HIDE_TRIP's, which it was inserted in front of.
  i := position(E'      WHEN ''ADMIN_RESTORE_PARTICIPANT'' THEN\n' in d);
  j := position(E'      WHEN ''ADMIN_HIDE_TRIP'' THEN\n' in d);
  IF j <= i THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3979): the ADMIN_RESTORE_PARTICIPANT branch is not immediately before ADMIN_HIDE_TRIP''s';
  END IF;
  b := substr(d, i, j - i);
  n := (length(b) - length(replace(b, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3979): % other command branch(es) sit inside the restore branch', n; END IF;
  -- Ledger attribution, measured on the branch (3974 compared a count its body
  -- had left in a temp table; this re-derives the same fact from the catalog):
  -- it sets v_family exactly twice, both times to 'participant' — at entry and
  -- immediately before its event. A dropped one would file the event under the
  -- wrong family.
  b := regexp_replace(b, 'v_family\s+:=', 'v_family :=', 'g');
  n := (length(b) - length(replace(b, 'v_family :=', ''))) / length('v_family :=');
  IF n <> 2 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3979): the restore branch assigns v_family % times, expected 2', n; END IF;
  n := (length(b) - length(replace(b, E'v_family := ''participant'';', ''))) / length(E'v_family := ''participant'';');
  IF n <> 2 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3979): the restore branch files % of its 2 family assignments under participant', n; END IF;
  IF position(E'v_event_type := ''trip.participant_added'';' in b) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3979): the restore branch does not emit trip.participant_added';
  END IF;
END
$post$;
