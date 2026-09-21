-- Rollback for 2769_trip_kernel_participant_roles_and_terminal_lifecycle.sql
--
-- Puts back a kernel in which no command can create a co_host, and in which a
-- completed trip can be cancelled. Both are defects; this file exists because a
-- migration that cannot be withdrawn is a migration nobody should apply, not
-- because either state is desirable.
--
-- ORDER: independent of the family rollbacks. 2769 touches only branches 2450
-- wrote, so this file may run at any point while the ancestry is installed.
-- It refuses if the ancestry is gone.
--
-- DATA: none directly. NOTE that any co_host row 2769's SET_PARTICIPANT_ROLE
-- created SURVIVES this rollback and keeps its `host` capability — the
-- capability check in 2500 reads the row, and this file does not touch rows.
-- That is deliberate: silently demoting people to undo a code change would be
-- a data migration disguised as a rollback. If the co_hosts must go too, that
-- is a separate, explicit step.

BEGIN;

DO $rb$
DECLARE d text; n int; before_len int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2769: trip_kernel_execute not found'; END IF;
  before_len := length(d);

  IF position('TRIP_ROLE_GRANT_REQUIRES_OWNER' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2769: not applied here';
  END IF;

  -- 2. the lifecycle edge
  n := (length(d) - length(replace(d, $a$           OR (v_type = 'CANCEL_TRIP' AND v_status = 'completed') THEN$a$, ''))) /
       length($a$           OR (v_type = 'CANCEL_TRIP' AND v_status = 'completed') THEN$a$);
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2769: the lifecycle edge occurs % times, expected 1', n; END IF;
  d := regexp_replace(d,
       $a$           OR \(v_type = 'COMPLETE_TRIP' AND v_status = 'cancelled'\)\n(           --[^\n]*\n)*           OR \(v_type = 'CANCEL_TRIP' AND v_status = 'completed'\) THEN$a$,
       $a$           OR (v_type = 'COMPLETE_TRIP' AND v_status = 'cancelled') THEN$a$,
       '');
  IF position($a$(v_type = 'CANCEL_TRIP' AND v_status = 'completed')$a$ in d) > 0 THEN
    RAISE EXCEPTION 'rollback 2769: the lifecycle edge did not come out';
  END IF;

  -- 1c. the revoke guard
  d := replace(d, $a$        IF v_role = 'co_host' AND v_actor IS DISTINCT FROM v_trip.owner_id THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_OWNER',
            'detail', 'TRIP_ROLE_GRANT_REQUIRES_OWNER: only the trip owner may grant or revoke co_host',
            'contract_version', 2);
        END IF;
$a$, '');

  -- 1b. the vocabulary and the grant guard, back to 2450's two lines
  d := regexp_replace(d,
       $a$        -- 2769\. co_host and viewer join the vocabulary.*?        SELECT \* INTO v_member FROM public\.trip_members WHERE trip_id = v_trip_id AND user_id = v_subject FOR UPDATE;$a$,
       $a$        IF v_new_role NOT IN ('member', 'invited') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'role must be member or invited', 'contract_version', 2);
        END IF;
        SELECT * INTO v_member FROM public.trip_members WHERE trip_id = v_trip_id AND user_id = v_subject FOR UPDATE;$a$,
       '');

  -- 1a. the flag assignment and its declaration
  d := replace(d, E'\n        v_role_grant_is_owner_only := (v_new_role = \'co_host\');', '');
  d := replace(d, E'  v_role_grant_is_owner_only boolean;\n', '');

  IF length(d) >= before_len THEN
    RAISE EXCEPTION 'rollback 2769: the inverse transform did not shrink the definition';
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

  FOREACH t IN ARRAY ARRAY['TRIP_ROLE_GRANT_REQUIRES_OWNER','v_role_grant_is_owner_only',
                           $a$'co_host', 'viewer'$a$] LOOP
    IF position(t in d) > 0 THEN RAISE EXCEPTION 'rollback 2769: % survived', t; END IF;
  END LOOP;

  -- The kernel must be INTACT, not merely 2769-free.
  FOREACH t IN ARRAY ARRAY['ADD_STAGE','ADD_LEG','ADD_GOAL','SET_PRESENCE','CREATE_PROPOSAL',
                           'RECORD_OUTCOME','SET_TRIP_COVER','JOIN_VIA_LINK','CREATE_TRIP',
                           'SET_PARTICIPANT_ROLE','TRIP_LIFECYCLE_INVALID_TRANSITION',
                           'TRIP_VERSION_CONFLICT','trip_command_receipts','trip_outbox'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'rollback 2769: % lost — the excision overran', t; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> 45 THEN RAISE EXCEPTION 'rollback 2769: expected 45 command branches, found %', n; END IF;
  n := (length(d) - length(replace(d, $a$'detail', 'role must be member or invited'$a$, ''))) /
       length($a$'detail', 'role must be member or invited'$a$);
  IF n <> 2 THEN RAISE EXCEPTION 'rollback 2769: expected both role-vocabulary sites back at 2450''s wording, found %', n; END IF;
END
$post$;

COMMIT;
