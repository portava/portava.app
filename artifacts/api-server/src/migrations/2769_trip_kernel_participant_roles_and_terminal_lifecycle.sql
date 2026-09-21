-- 2769_trip_kernel_participant_roles_and_terminal_lifecycle.sql
--
-- Two corrections to the ancestry, both found by executing it rather than by
-- reading it. db/harness/probe_kernel_ancestry.sql now pins both.
--
-- 1. THE KERNEL CANNOT CREATE A CO_HOST, BUT DEPENDS ON ONE EXISTING
-- ==================================================================
-- 2500 added the `host` capability — "owner OR an accepted co_host row" — and
-- gated ADD_PARTICIPANT and SET_PARTICIPANT_ROLE on it. But SET_PARTICIPANT_ROLE
-- refuses any role outside ('member','invited'), so no command in the kernel can
-- make a co_host. In a kernel-only world `host` and `owner` are therefore the
-- same capability, and every co_host that exists came from a writer outside the
-- kernel — which is the thing §1 forbids: "No Map, Compass, Telegraph,
-- Discovery, Buddy, or UI component may independently invent canonical trip
-- state."
--
-- `viewer` has the same problem and matters for the same reason:
-- authz.accepted_trip_ids counts role IN ('owner','co_host','member','viewer'),
-- so a viewer IS crew, and no command can make one.
--
-- WHO MAY GRANT WHAT. Adding co_host to the allowed set without saying who may
-- grant it would let a co_host promote another co_host, and privilege that
-- propagates sideways is privilege nobody owns. §6.1: "Roles are coarse
-- ... Capabilities are derived from role + trip policy". The rule here:
--   * the OWNER may set any role, co_host included;
--   * a co_host may set 'member', 'viewer' and 'invited' — the roles that carry
--     no authority over other participants — and is refused co_host.
-- That is the narrowest rule that makes the capability reachable at all, and
-- widening it later cannot retroactively legitimise a grant this one refused.
-- The new refusal is TRIP_AUTH_NOT_OWNER, which the kernel already returns for
-- owner-only commands: from the actor's side this IS an owner-only operation.
--
-- 2. CANCEL_TRIP SUCCEEDS ON A COMPLETED TRIP
-- ===========================================
-- The lifecycle guard refuses only three edges: a no-op transition, anything
-- out of ARCHIVED, and COMPLETE from CANCELLED. It does not refuse CANCEL from
-- COMPLETED, so a finished trip can be marked cancelled.
--
-- That is not a policy choice, it is a contradiction. §3.1's primary lifecycle
-- runs "... → COMPLETED → MEMORY", and §20.1 builds durable memory out of a
-- completed trip's outcomes: places visited, activities completed, stamps,
-- milestones. A trip cannot both have happened and have been called off. By the
-- time COMPLETE_TRIP has run, RECORD_OUTCOME rows (2768) may already assert that
-- it did.
--
-- COMPLETED → ARCHIVED stays allowed. Archiving a finished trip is filing it,
-- not denying it. The refusal reuses TRIP_LIFECYCLE_INVALID_TRANSITION, which
-- already carries `from` and `to`, so no new reason code is needed and no
-- client learns a new case.
--
-- BASE: the post-2768 kernel. Both edits are inside branches 2450 wrote, so
-- this file asserts the whole ancestry AND every family already layered on it —
-- if it were applied to a bare 2450 the anchors would still match and the
-- 276x families would be silently absent from the result.
--
-- Rehearsed on db/harness/run.sh, where probe_kernel_ancestry.sql exercises
-- both edits against real rows.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2769 (Trips).

BEGIN;

DO $base$
DECLARE d text; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '2769: trip_kernel_execute not found'; END IF;
  FOREACH t IN ARRAY ARRAY['SET_TRIP_COVER','ADD_STAGE','ADD_LEG','ADD_GOAL','SET_PRESENCE'] LOOP
    IF position(t in d) = 0 THEN
      RAISE EXCEPTION '2769: the installed kernel is missing %; apply 2450 -> 2500 -> 2590 -> 2764 -> 2765 -> 2766 -> 2768 first', t;
    END IF;
  END LOOP;
END
$base$;

DO $mig$
DECLARE
  d text;
  n int;
  before_len int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  before_len := length(d);

  IF position('TRIP_ROLE_GRANT_REQUIRES_OWNER' in d) > 0 THEN
    RAISE EXCEPTION '2769: already applied; this migration is not idempotent by design';
  END IF;

  -- ── 1a. SET_PARTICIPANT_ROLE learns co_host and viewer ─────────────────────
  -- The role check appears TWICE in the kernel: once in INVITE/ADD_PARTICIPANT
  -- and once in SET_PARTICIPANT_ROLE. Only the second is replaced, so an INVITE
  -- still cannot mint a co_host directly. The two are distinguished by the line
  -- that precedes them, which is why the anchor carries it.
  n := (length(d) - length(replace(d, $a$        v_new_role := v_payload->>'role';$a$, ''))) / length($a$        v_new_role := v_payload->>'role';$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2769: anchor SET_PARTICIPANT_ROLE assignment occurs % times, expected 1', n; END IF;
  d := replace(d, $a$        v_new_role := v_payload->>'role';$a$,
                  $a$        v_new_role := v_payload->>'role';
        v_role_grant_is_owner_only := (v_new_role = 'co_host');$a$);

  n := (length(d) - length(replace(d,
    $a$        IF v_new_role NOT IN ('member', 'invited') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'role must be member or invited', 'contract_version', 2);
        END IF;
        SELECT * INTO v_member FROM public.trip_members WHERE trip_id = v_trip_id AND user_id = v_subject FOR UPDATE;
        IF NOT FOUND THEN$a$, ''))) /
    length($a$        IF v_new_role NOT IN ('member', 'invited') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'role must be member or invited', 'contract_version', 2);
        END IF;
        SELECT * INTO v_member FROM public.trip_members WHERE trip_id = v_trip_id AND user_id = v_subject FOR UPDATE;
        IF NOT FOUND THEN$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2769: anchor SET_PARTICIPANT_ROLE vocabulary occurs % times, expected 1 (INVITE/ADD must not match)', n; END IF;
  d := replace(d,
    $a$        IF v_new_role NOT IN ('member', 'invited') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'role must be member or invited', 'contract_version', 2);
        END IF;
        SELECT * INTO v_member FROM public.trip_members WHERE trip_id = v_trip_id AND user_id = v_subject FOR UPDATE;
        IF NOT FOUND THEN$a$,
    $a$        -- 2769. co_host and viewer join the vocabulary because
        -- authz.accepted_trip_ids counts both as crew and 2500's `host`
        -- capability is unreachable without the first.
        IF v_new_role NOT IN ('member', 'invited', 'co_host', 'viewer') THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED', 'detail', 'role must be member, invited, co_host or viewer', 'contract_version', 2);
        END IF;
        -- 2769. Granting co_host grants the `host` capability itself. A co_host
        -- promoting another co_host is privilege propagating sideways, so only
        -- the owner may do it. TRIP_ROLE_GRANT_REQUIRES_OWNER.
        IF v_role_grant_is_owner_only AND v_actor IS DISTINCT FROM v_trip.owner_id THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_OWNER',
            'detail', 'TRIP_ROLE_GRANT_REQUIRES_OWNER: only the trip owner may grant or revoke co_host',
            'contract_version', 2);
        END IF;
        SELECT * INTO v_member FROM public.trip_members WHERE trip_id = v_trip_id AND user_id = v_subject FOR UPDATE;
        IF NOT FOUND THEN$a$);

  -- Revoking co_host is the same grant in reverse and must be owner-only too:
  -- a co_host who may demote another co_host can remove the only person who
  -- could have stopped them.
  n := (length(d) - length(replace(d, $a$        v_role := v_member.role::text;
        UPDATE public.trip_members SET role = v_new_role::member_role$a$, ''))) /
       length($a$        v_role := v_member.role::text;
        UPDATE public.trip_members SET role = v_new_role::member_role$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2769: anchor SET_PARTICIPANT_ROLE update occurs % times, expected 1', n; END IF;
  d := replace(d, $a$        v_role := v_member.role::text;
        UPDATE public.trip_members SET role = v_new_role::member_role$a$,
                  $a$        v_role := v_member.role::text;
        IF v_role = 'co_host' AND v_actor IS DISTINCT FROM v_trip.owner_id THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_AUTH_NOT_OWNER',
            'detail', 'TRIP_ROLE_GRANT_REQUIRES_OWNER: only the trip owner may grant or revoke co_host',
            'contract_version', 2);
        END IF;
        UPDATE public.trip_members SET role = v_new_role::member_role$a$);

  -- ── 1b. the flag variable ──────────────────────────────────────────────────
  n := (length(d) - length(replace(d, '  v_new_role   text;', ''))) / length('  v_new_role   text;');
  IF n <> 1 THEN RAISE EXCEPTION '2769: anchor v_new_role declaration occurs % times, expected 1', n; END IF;
  d := replace(d, '  v_new_role   text;',
                  '  v_new_role   text;' || E'\n' ||
                  '  v_role_grant_is_owner_only boolean;');

  -- ── 2. COMPLETED is terminal for CANCEL ────────────────────────────────────
  n := (length(d) - length(replace(d, $a$           OR (v_type = 'COMPLETE_TRIP' AND v_status = 'cancelled') THEN$a$, ''))) /
       length($a$           OR (v_type = 'COMPLETE_TRIP' AND v_status = 'cancelled') THEN$a$);
  IF n <> 1 THEN RAISE EXCEPTION '2769: anchor lifecycle guard occurs % times, expected 1', n; END IF;
  d := replace(d, $a$           OR (v_type = 'COMPLETE_TRIP' AND v_status = 'cancelled') THEN$a$,
                  $a$           OR (v_type = 'COMPLETE_TRIP' AND v_status = 'cancelled')
           -- 2769. A trip cannot both have happened and have been called off.
           -- §3.1 runs "... -> COMPLETED -> MEMORY" and §20.1 builds durable
           -- memory from a completed trip's outcomes; by the time this edge is
           -- reachable, RECORD_OUTCOME rows may already assert that it did.
           -- COMPLETED -> ARCHIVED stays allowed: filing a finished trip is not
           -- denying it.
           OR (v_type = 'CANCEL_TRIP' AND v_status = 'completed') THEN$a$);

  IF length(d) <= before_len THEN
    RAISE EXCEPTION '2769: the transform did not grow the definition';
  END IF;
  -- This migration adds NO branches. Saying so as an assertion is the same
  -- invariant every family migration carries, in the case where the number is 0.
  EXECUTE d;
END
$mig$;

DO $post$
DECLARE d text; n int; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';

  IF position('TRIP_ROLE_GRANT_REQUIRES_OWNER' in d) = 0 THEN
    RAISE EXCEPTION '2769: the co_host grant rule is missing after apply';
  END IF;
  -- Count the RETURNED detail, not the token: the token also appears in the
  -- comment that explains the rule, and a count of 3 would be a comment, not a
  -- third code path.
  n := (length(d) - length(replace(d, $chk$'detail', 'TRIP_ROLE_GRANT_REQUIRES_OWNER:$chk$, '')))
       / length($chk$'detail', 'TRIP_ROLE_GRANT_REQUIRES_OWNER:$chk$);
  IF n <> 2 THEN RAISE EXCEPTION '2769: expected the grant rule on both the grant and the revoke path, found %', n; END IF;
  IF position($chk$IF v_new_role NOT IN ('member', 'invited', 'co_host', 'viewer') THEN$chk$ in d) = 0 THEN
    RAISE EXCEPTION '2769: SET_PARTICIPANT_ROLE did not learn co_host and viewer';
  END IF;
  IF position($chk$(v_type = 'CANCEL_TRIP' AND v_status = 'completed')$chk$ in d) = 0 THEN
    RAISE EXCEPTION '2769: COMPLETED is still not terminal for CANCEL';
  END IF;

  -- INVITE_PARTICIPANT / ADD_PARTICIPANT must NOT have learned co_host: an
  -- invite that mints a host would route around the owner-only rule entirely.
  IF position($chk$'detail', 'role must be member or invited'$chk$ in d) = 0 THEN
    RAISE EXCEPTION '2769: the INVITE/ADD role vocabulary was replaced too; an invite can now mint a co_host';
  END IF;

  -- Nothing else moved.
  FOREACH t IN ARRAY ARRAY['ADD_STAGE','ADD_LEG','ADD_COMMITMENT','ADD_GOAL','ADD_RISK',
                           'SET_PRESENCE','CREATE_PROPOSAL','RECORD_OUTCOME','SET_TRIP_COVER',
                           'JOIN_VIA_LINK','CREATE_TRIP','REMOVE_PLAN','TRIP_VERSION_CONFLICT',
                           'authz.is_accepted_trip_member','trip_command_receipts','trip_outbox',
                           'TRIP_LIFECYCLE_INVALID_TRANSITION'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION '2769: % was lost', t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stage','leg','commitment','goal','decision_task','risk','proposal'] LOOP
    n := (length(d) - length(replace(d, 'v_family     := ''' || t || ''';', ''))) / length('v_family     := ''' || t || ''';');
    IF n <> 3 THEN RAISE EXCEPTION '2769: the %-family assignments became %', t, n; END IF;
  END LOOP;
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> 45 THEN RAISE EXCEPTION '2769: expected 45 command branches after this no-branch migration, found %', n; END IF;
END
$post$;

COMMIT;
