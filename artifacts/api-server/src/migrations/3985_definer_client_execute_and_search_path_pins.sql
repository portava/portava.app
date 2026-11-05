-- 3985_definer_client_execute_and_search_path_pins.sql
-- Client roles stop holding EXECUTE on the SECURITY DEFINER functions that no client needs, and ten
-- functions get a fixed search_path. Closes the portava-ci security advisor's findings
-- anon/authenticated_security_definer_function_executable (where it can be closed without breaking a
-- policy) and function_search_path_mutable (all ten). POST-CUTOVER CANONICAL FORWARD MIGRATION
-- (3000-3999 band, a gap number; written 2026-11-04 on main 28f6e2555).
--
-- WRITTEN, NOT APPLIED. Privileges and function settings only: no table, column, policy, trigger, row,
-- flag or function body changes. It narrows what the anon key and a signed-in client key can call, so
-- it needs the owner's production approval and is sequenced by the integration owner.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHAT THE ADVISOR REPORTED (portava-ci hwokxgbmezheskbzskfr, get_advisors type=security, 2026-11-04)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 15 anon + 22 authenticated "SECURITY DEFINER function executable" findings over 20 functions, and 10
-- "function_search_path_mutable" findings. Each SECURITY DEFINER function was judged per role by one
-- rule. A role KEEPS EXECUTE when (i) an RLS policy that applies to that role calls it (a policy
-- predicate is evaluated as the querying role, so a revoke makes the policy raise "permission denied
-- for function" for every token — measured, see the header of checkSecurityDefinerOracles.ts), or
-- (ii) the mobile app calls it directly (.rpc, Realtime or storage), or (iii) a SECURITY INVOKER
-- function the role may call invokes it, or (iv) a storage policy calls it. Otherwise it is revoked.
-- service_role keeps EXECUTE on everything.
--
-- Client evidence (main 28f6e2555): travel-buddy-standalone makes no .rpc() call at all; its one
-- Realtime subscription is generated_visuals and its storage use is a post-media remove. The API
-- reaches the database only as service_role.
--
-- ── REVOKED FROM PUBLIC, anon AND authenticated (service_role keeps EXECUTE) ──────────────────────
--   add_owner_as_member()               RETURNS trigger. PostgreSQL refuses to call a trigger function
--   enforce_is_official_privileged()    any other way ("trigger functions can only be called as
--   enforce_profile_role_privileged()   triggers"), and a firing trigger does not check EXECUTE (it is
--   enforce_trip_max_members()          checked once, at CREATE TRIGGER, against the migration role —
--   handle_new_user()                   2175 and 2973 rely on the same fact). Client EXECUTE does
--                                       nothing for anyone; the triggers keep firing for every role.
--   event_is_in_state(uuid, event_state[])
--                                       Referenced by no policy, view, trigger, function body or
--                                       client. Ledgered HOLD in SECURITY_DEFINER_ORACLES.json as "its
--                                       exposure is live and unearned TODAY": POST /rpc/event_is_in_state
--                                       told an anonymous caller whether any event id exists and is in a
--                                       named state. That ledger's own remedy line allows a REVOKE "when
--                                       no policy calls it"; the function itself stays for the HOLD.
--
-- ── REVOKED FROM PUBLIC AND anon ONLY (authenticated and service_role keep EXECUTE) ───────────────
--   can_post_to_trip(uuid)              Its one policy is posts_insert, FOR INSERT TO authenticated.
--   user_is_event_participant(uuid)     Its one policy is events_participant_read, TO authenticated.
--   is_accepted_trip_member(uuid)       Named in no policy; its callers can_post_to_trip, can_see_post
--                                       and can_see_postcard are SECURITY DEFINER, so they check
--                                       EXECUTE as their owner. authenticated is KEPT only because
--                                       2973's postcondition 4 matches policy text by bare word, and
--                                       the policies that call authz.is_accepted_trip_member(uuid, uuid)
--                                       — a different function — match it. Revoking authenticated
--                                       would fail that re-run (certify stage 4). Owner check: see below.
--
-- ── NOT TOUCHED, AND WHY (the remaining advisor findings stay open on purpose) ────────────────────
--   auth_uid_has_event_role, auth_uid_has_event_rsvp, auth_uid_is_event_cohost, auth_uid_is_event_host,
--   can_see_post, can_see_postcard, can_see_trip, viewer_is_blocked
--       each is called by policies TO public on tables anon can SELECT (events, event_attendees,
--       event_media, event_posts, event_cohosts, event_invites, event_activity_log, posts,
--       passport_postcards, trips and its read set, profiles, highlights, highlight_replies). A revoke
--       from either client role turns those reads into errors. 2534's postcondition also pins anon and
--       authenticated EXECUTE on can_see_trip, and 2973's postcondition 4 pins authenticated on all.
--       viewer_is_blocked is the block-status oracle: POST /rpc/viewer_is_blocked tells a caller whether
--       a given user has blocked them. Its policies already let a blocked viewer infer the same for a
--       public profile (the row disappears); the RPC also answers for a private one. Closing it means
--       moving it out of the PostgREST-exposed schema (the 2182 method, ALTER FUNCTION ... SET SCHEMA
--       authz, which keeps the OID so policies keep binding) — which also needs can_see_trip's pinned
--       search_path to reach it, contradicts docs/architecture/10_Database_Architecture.md section 7
--       ("the deliberate exception ... stays in public"), and breaks scripts/src/beta-db-core.ts, which
--       requires public.viewer_is_blocked. That is an owner decision, not part of this file.
--   intel_self_contributor_tokens()     authenticated only (3002 revoked anon); its policies
--                                       intel_observations_select_own and intel_confirmations_select_own
--                                       are TO authenticated.
--   post_media_path_is_moderated(text, uuid)
--                                       authenticated only; storage policies post_media_owner_insert and
--                                       post_media_owner_update are TO authenticated (3909's posture).
--   st_estimatedextent(...) x3          PostGIS extension members owned by supabase_admin: postgres
--                                       cannot revoke on them (the 2490/2973 lesson). Belongs with the
--                                       extension_in_public finding.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- THE SEARCH PATH PINS: SET search_path = '' (the 2175 form)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- pg_catalog is searched first whether or not it is named, so an empty path changes nothing a body
-- resolves from pg_catalog and only removes the caller's ability to put a same-named object in front
-- of an unqualified reference. Every body below was read at its last definition and names only
-- pg_catalog built-ins, or public.* objects by their qualified names:
--   canonical_events_append_only()                      2120  RAISE only
--   input_normalize_city_key(text)                      3440  translate, normalize, regexp_replace, lower,
--                                                             btrim, length, chr, replace
--   stories_freeze_deleted_at()                         2998  now()
--   trip_presence_freshness(timestamptz x3)             2776  a CASE over its arguments
--   trip_reservation_events_append_only()               2784  RAISE only
--   trip_reservation_events_no_direct_delete()          2784  reads public.trip_reservations
--   trip_snapshot_fold(jsonb, jsonb)                    2773, transformed by 2787 and 2799: jsonb
--                                                             built-ins only
--   trip_snapshot_fold_all(jsonb, jsonb[])              2773  calls public.trip_snapshot_fold
--   trip_snapshot_replay(uuid, jsonb, bigint, bigint)   2773  reads public.trip_events, calls
--                                                             public.trip_snapshot_fold_all
--   trip_snapshot_seed(uuid)                            2773  jsonb_build_object
-- The postcondition calls each non-trigger one under the pin and compares the answer to the value its
-- own migration asserted. COST, stated: a function with a SET clause is never inlined, so the two SQL
-- functions trip_presence_freshness (called per row by the trip_presence_current view) and
-- trip_snapshot_seed become ordinary calls. Same results; constant folding still applies.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- DEFAULT PRIVILEGES ARE NOT CHANGED — the house rule, kept
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Supabase's ALTER DEFAULT PRIVILEGES still grants EXECUTE on every new public function to anon and
-- authenticated. 2973 explains why the house leaves that alone: a policy helper created without it
-- would make its policy deny every row, silently. So each function is revoked by name here, as 2973,
-- 3906 and their predecessors do. What stops a later file from undoing this one is the offline
-- ratchet src/scripts/lib/definerClientExecuteWithdrawn.ts, run by check:security-definer-oracles: it
-- fails a later GRANT of these functions to a withdrawn role, a DROP or plain CREATE that would bring
-- the default grants back, a re-definition that drops a pin, and any policy calling a withdrawn
-- function for a role that no longer holds EXECUTE.
--
-- ACCEPTED STARTING STATE (anything else refuses the apply — it is a state nobody wrote down):
--   all nineteen functions exist with these signatures, none is an extension member, and the migration
--   role can act as each owner; the nine whose grants change are SECURITY DEFINER and the five trigger
--   functions return trigger; no policy, view, default, constraint or SECURITY INVOKER function body
--   that a losing role can reach calls a function this file withdraws from that role (checked by OID
--   through pg_depend, and by text over function bodies, in every schema); and each of the ten
--   pinned functions has no search_path setting yet, or already exactly ''.
-- IDEMPOTENT: a second apply finds the same state and changes nothing.
--
-- ORDER: needs the functions of 2033, 2078, 2079, 2120, 2337, 2773, 2776, 2784, 2787, 2799, 2998 and
-- 3440. portava-ci's advisor lists all nineteen. Production carries them through its 2026-08-19 baseline
-- or its applied-migrations record (3440 included, which the postcondition's city-key probe needs).
-- Nothing numbered above 3985 on main or in open PRs #814 and #748 names any of the nineteen, so the gap
-- number is order-independent.
--
-- ROLLBACK: db/rollback/2026-11-04-3985-definer-client-execute-and-search-path-pins-rollback.sql
-- (grants client EXECUTE back exactly as the baseline had it and RESETs the ten search_paths).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  v_sig  text;
  v_fn   oid;
  v_name text;
  v_re   text;
  v_full boolean;
  v_bad  text;
  v_cfg  text[];
  -- withdrawn from PUBLIC, anon and authenticated; the first five return trigger
  v_all  constant text[] := ARRAY[
    'public.add_owner_as_member()',
    'public.enforce_is_official_privileged()',
    'public.enforce_profile_role_privileged()',
    'public.enforce_trip_max_members()',
    'public.handle_new_user()',
    'public.event_is_in_state(uuid, public.event_state[])'];
  -- withdrawn from PUBLIC and anon only
  v_anon constant text[] := ARRAY[
    'public.can_post_to_trip(uuid)',
    'public.user_is_event_participant(uuid)',
    'public.is_accepted_trip_member(uuid)'];
  v_pin  constant text[] := ARRAY[
    'public.canonical_events_append_only()',
    'public.input_normalize_city_key(text)',
    'public.stories_freeze_deleted_at()',
    'public.trip_presence_freshness(timestamptz, timestamptz, timestamptz)',
    'public.trip_reservation_events_append_only()',
    'public.trip_reservation_events_no_direct_delete()',
    'public.trip_snapshot_fold(jsonb, jsonb)',
    'public.trip_snapshot_fold_all(jsonb, jsonb[])',
    'public.trip_snapshot_replay(uuid, jsonb, bigint, bigint)',
    'public.trip_snapshot_seed(uuid)'];
BEGIN
  FOREACH v_sig IN ARRAY v_all || v_anon || v_pin LOOP
    v_fn := to_regprocedure(v_sig);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3985): % does not exist.', v_sig;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = v_fn AND d.deptype = 'e') THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3985): % belongs to an extension; its grants and settings are the extension''s.', v_sig;
    END IF;
    IF NOT pg_has_role(current_user, (SELECT p.proowner FROM pg_proc p WHERE p.oid = v_fn), 'USAGE') THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3985): % is owned by a role % cannot act as, so its revoke would be a silent no-op.', v_sig, current_user;
    END IF;
  END LOOP;

  FOREACH v_sig IN ARRAY v_all || v_anon LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3985): % is not SECURITY DEFINER; the state this file was decided against is gone.', v_sig;
    END IF;
  END LOOP;
  FOREACH v_sig IN ARRAY v_all[1:5] LOOP
    IF (SELECT p.prorettype FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) <> 'trigger'::regtype THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3985): % no longer returns trigger, so a client could call it.', v_sig;
    END IF;
  END LOOP;

  -- Nothing a losing role reaches may call a function this file withdraws from that role.
  FOREACH v_sig IN ARRAY v_all[6:6] || v_anon LOOP
    v_fn := to_regprocedure(v_sig);
    v_full := v_sig = ANY (v_all);
    v_name := substring(v_sig FROM '^public\.([a-z_]+)\(');
    -- (a) by OID: policies, views, defaults, constraints, BEGIN ATOMIC bodies. A policy is allowed only
    --     when the role keeps EXECUTE (anon-only set: the policy applies neither to PUBLIC nor to a role
    --     anon has the privileges of); a SECURITY DEFINER caller checks EXECUTE as its owner.
    SELECT string_agg(pg_describe_object(d.classid, d.objid, d.objsubid), '; ') INTO v_bad
      FROM pg_depend d
     WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = v_fn AND d.deptype = 'n'
       AND NOT (
             (d.classid = 'pg_policy'::regclass AND NOT v_full
              AND NOT EXISTS (SELECT 1 FROM pg_policy pol, unnest(pol.polroles) AS r(role_oid)
                               WHERE pol.oid = d.objid
                                 AND CASE WHEN r.role_oid = 0 THEN true ELSE pg_has_role('anon', r.role_oid, 'USAGE') END))
          OR (d.classid = 'pg_proc'::regclass
              AND coalesce((SELECT p.prosecdef FROM pg_proc p WHERE p.oid = d.objid), false)));
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3985): % is reached by a role this file withdraws it from: %.', v_sig, v_bad;
    END IF;
    -- (b) by text: plpgsql and string-bodied sql functions record no dependency on what they call. An
    --     INVOKER function a losing role can execute, or any INVOKER trigger function, must not name it.
    v_re := '(^|[^.[:alnum:]_"])"?' || v_name || '"?[[:space:]]*\(|public\."?' || v_name || '"?[[:space:]]*\(';
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
      FROM pg_proc p
     WHERE NOT p.prosecdef AND p.oid <> v_fn AND p.prosrc ~ v_re
       AND (p.prorettype = 'trigger'::regtype
            OR has_function_privilege('anon', p.oid, 'EXECUTE')
            OR (v_full AND has_function_privilege('authenticated', p.oid, 'EXECUTE')));
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3985): % is called by SECURITY INVOKER function(s) a losing role can run: %.', v_sig, v_bad;
    END IF;
  END LOOP;

  FOREACH v_sig IN ARRAY v_pin LOOP
    SELECT p.proconfig INTO v_cfg FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig);
    IF EXISTS (SELECT 1 FROM unnest(v_cfg) AS c(setting) WHERE c.setting LIKE 'search_path=%' AND c.setting <> 'search_path=""') THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3985): % already pins a different search_path (%).', v_sig, v_cfg;
    END IF;
  END LOOP;
END $pre$;

-- ── client EXECUTE withdrawn from PUBLIC, anon and authenticated ─────────────────────────────────────
REVOKE ALL ON FUNCTION public.add_owner_as_member() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_owner_as_member() TO service_role;
REVOKE ALL ON FUNCTION public.enforce_is_official_privileged() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_is_official_privileged() TO service_role;
REVOKE ALL ON FUNCTION public.enforce_profile_role_privileged() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_profile_role_privileged() TO service_role;
REVOKE ALL ON FUNCTION public.enforce_trip_max_members() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_trip_max_members() TO service_role;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
REVOKE ALL ON FUNCTION public.event_is_in_state(uuid, public.event_state[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_is_in_state(uuid, public.event_state[]) TO service_role;

-- ── client EXECUTE withdrawn from PUBLIC and anon; granted explicitly to authenticated so that a
--    database where authenticated held it only through PUBLIC keeps it ────────────────────────────────
REVOKE ALL ON FUNCTION public.can_post_to_trip(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_post_to_trip(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.user_is_event_participant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_is_event_participant(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_accepted_trip_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_accepted_trip_member(uuid) TO authenticated, service_role;

-- ── search_path pinned ──────────────────────────────────────────────────────────────────────────────
ALTER FUNCTION public.canonical_events_append_only() SET search_path = '';
ALTER FUNCTION public.input_normalize_city_key(text) SET search_path = '';
ALTER FUNCTION public.stories_freeze_deleted_at() SET search_path = '';
ALTER FUNCTION public.trip_presence_freshness(timestamptz, timestamptz, timestamptz) SET search_path = '';
ALTER FUNCTION public.trip_reservation_events_append_only() SET search_path = '';
ALTER FUNCTION public.trip_reservation_events_no_direct_delete() SET search_path = '';
ALTER FUNCTION public.trip_snapshot_fold(jsonb, jsonb) SET search_path = '';
ALTER FUNCTION public.trip_snapshot_fold_all(jsonb, jsonb[]) SET search_path = '';
ALTER FUNCTION public.trip_snapshot_replay(uuid, jsonb, bigint, bigint) SET search_path = '';
ALTER FUNCTION public.trip_snapshot_seed(uuid) SET search_path = '';

-- ── POSTCONDITIONS: absolute and re-runnable, so certify stage 4 re-asserts them after the commit ──
DO $post$
DECLARE
  v_sig    text;
  v_fn     oid;
  v_t0     constant timestamptz := '2026-01-01 00:00:00+00';
  v_nil    constant uuid := '00000000-0000-0000-0000-000000000000';
  v_event  constant jsonb := '{"type": "trip.stage_added", "aggregate_version": 1, "payload_json": {"payload": {"stage_type": "city", "state": "active", "sequence": "1"}, "result": {"id": "s1"}}}';
  v_seed   jsonb;
  v_folded jsonb;
  v_all    constant text[] := ARRAY[
    'public.add_owner_as_member()',
    'public.enforce_is_official_privileged()',
    'public.enforce_profile_role_privileged()',
    'public.enforce_trip_max_members()',
    'public.handle_new_user()',
    'public.event_is_in_state(uuid, public.event_state[])'];
  v_anon   constant text[] := ARRAY[
    'public.can_post_to_trip(uuid)',
    'public.user_is_event_participant(uuid)',
    'public.is_accepted_trip_member(uuid)'];
  v_pin    constant text[] := ARRAY[
    'public.canonical_events_append_only()',
    'public.input_normalize_city_key(text)',
    'public.stories_freeze_deleted_at()',
    'public.trip_presence_freshness(timestamptz, timestamptz, timestamptz)',
    'public.trip_reservation_events_append_only()',
    'public.trip_reservation_events_no_direct_delete()',
    'public.trip_snapshot_fold(jsonb, jsonb)',
    'public.trip_snapshot_fold_all(jsonb, jsonb[])',
    'public.trip_snapshot_replay(uuid, jsonb, bigint, bigint)',
    'public.trip_snapshot_seed(uuid)'];
BEGIN
  FOREACH v_sig IN ARRAY v_all || v_anon LOOP
    v_fn := to_regprocedure(v_sig);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3985): % does not exist.', v_sig;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = v_fn AND a.grantee = 0) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3985): PUBLIC holds EXECUTE on %.', v_sig;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3985): anon can execute %.', v_sig;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3985): service_role cannot execute %; the API reaches the database only as service_role.', v_sig;
    END IF;
  END LOOP;
  FOREACH v_sig IN ARRAY v_all LOOP
    IF has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3985): authenticated can execute %.', v_sig;
    END IF;
  END LOOP;
  FOREACH v_sig IN ARRAY v_anon LOOP
    IF NOT has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3985): authenticated cannot execute %, so every policy TO authenticated that calls it raises for every signed-in user.', v_sig;
    END IF;
  END LOOP;

  FOREACH v_sig IN ARRAY v_pin LOOP
    v_fn := to_regprocedure(v_sig);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3985): % does not exist.', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) AS c(setting)
                    WHERE p.oid = v_fn AND c.setting = 'search_path=""') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3985): % does not pin search_path to ''''.', v_sig;
    END IF;
  END LOOP;

  -- Every non-trigger pinned function still resolves its body and answers what its own migration said.
  IF public.input_normalize_city_key('Đà Nẵng') IS DISTINCT FROM 'da nang'
     OR public.input_normalize_city_key('Ho Chi Minh City') IS DISTINCT FROM 'ho chi minh'
     OR public.input_normalize_city_key('Cebu City') IS DISTINCT FROM 'cebu' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3985): input_normalize_city_key no longer folds as 3440 asserted under the pinned search_path.';
  END IF;
  IF public.trip_presence_freshness(v_t0, v_t0 + interval '4 hours', v_t0) IS DISTINCT FROM 'live'
     OR public.trip_presence_freshness(v_t0, v_t0 + interval '4 hours', v_t0 + interval '2 hours') IS DISTINCT FROM 'recent'
     OR public.trip_presence_freshness(v_t0, v_t0 + interval '4 hours', v_t0 + interval '5 hours') IS DISTINCT FROM 'last_known'
     OR public.trip_presence_freshness(v_t0, v_t0 + interval '4 hours', v_t0 + interval '9 hours') IS DISTINCT FROM 'offline' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3985): trip_presence_freshness no longer grades as 2776 defined under the pinned search_path.';
  END IF;
  v_seed := public.trip_snapshot_seed(v_nil);
  IF v_seed->>'aggregate_version' IS DISTINCT FROM '0' OR v_seed->>'trip_id' IS DISTINCT FROM v_nil::text THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3985): trip_snapshot_seed no longer builds the 2773 seed under the pinned search_path.';
  END IF;
  v_folded := public.trip_snapshot_fold(v_seed, v_event);
  IF v_folded->'stages'->'s1'->>'state' IS DISTINCT FROM 'active'
     OR v_folded->>'stage_id' IS DISTINCT FROM 's1'
     OR v_folded->>'aggregate_version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3985): trip_snapshot_fold no longer folds a stage_added event under the pinned search_path.';
  END IF;
  IF public.trip_snapshot_fold_all(v_seed, ARRAY[v_event]) IS DISTINCT FROM v_folded
     OR public.trip_snapshot_fold_all(v_seed, NULL) IS DISTINCT FROM v_seed THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3985): trip_snapshot_fold_all no longer folds through trip_snapshot_fold under the pinned search_path.';
  END IF;
  IF public.trip_snapshot_replay(v_nil, v_seed, 0, NULL) IS DISTINCT FROM v_seed THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3985): trip_snapshot_replay of a trip with no events is not its starting snapshot under the pinned search_path.';
  END IF;
END $post$;

NOTIFY pgrst, 'reload schema';

COMMIT;
