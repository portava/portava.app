-- 2973_security_definer_execute_boundary.sql
--
-- `anon` and `authenticated` stop holding EXECUTE on SECURITY DEFINER functions
-- that WRITE.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2973.
--
-- Privilege-only. Creates nothing, drops nothing, writes no row, flips no flag,
-- adds/alters/drops no RLS policy, changes no function body, and touches no
-- table privilege. Idempotent (REVOKE is a no-op when the privilege is absent).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS: 2490 SWEPT TABLES AND NOBODY EVER SWEPT FUNCTIONS
-- ══════════════════════════════════════════════════════════════════════════════
-- 2490_destructive_privilege_boundary.sql states the root cause exactly:
--
--   "Supabase's ALTER DEFAULT PRIVILEGES hands `anon`, `authenticated` and
--    `service_role` the full set `arwdDxtm` on every table created in `public`."
--
-- The same ALTER DEFAULT PRIVILEGES also hands them EXECUTE on every FUNCTION
-- created in `public`. 2490 swept tables and fixed the `postgres` default for
-- tables. Its own "THE HALF THIS MIGRATION CANNOT REACH" section lists future
-- tables and CI drift. Functions are not in that list -- not because they were
-- considered and excluded, but because that lane was scoped to tables. The
-- function half has been open ever since.
--
-- A SECURITY DEFINER function runs as its OWNER (`postgres`), which is BYPASSRLS.
-- So EXECUTE on one is not "a privilege RLS polices badly", the way TRUNCATE is.
-- It is a privilege RLS is not consulted for AT ALL: the function's body is the
-- entire access control. If the body does not check the caller, there is no
-- check.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- MEASURED 2026-09-16, BOTH DATABASES
-- ══════════════════════════════════════════════════════════════════════════════
-- Application (non-extension) SECURITY DEFINER functions in `public` reachable
-- by `anon` or `authenticated`:
--
--                                       production   portava-ci
--   policy-referenced STABLE boolean        12           11    <- legitimate
--   event_is_in_state (STABLE, unused)       1            1    <- harmless
--   trigger-returning                        5            5    <- see below
--   VOLATILE WRITERS                         3           23    <- the defect
--                                       ----------   ----------
--                                           21           40
--
-- Production's three, all reachable by `authenticated` (not by `anon`):
--   increment_distribution_stats(p_item_id text, p_viewer_id text, ...)
--       any logged-in user inflates distribution stats for any item, attributed
--       to any viewer id.
--   purge_old_ranking_debug_samples()
--       any logged-in user purges ranking debug samples. Destructive.
--   upsert_hashtag_usage_and_increment(..., p_author_id uuid, ...)
--       any logged-in user forges hashtag usage attributed to any author.
--
-- portava-ci carries those three plus TWENTY more, including upsert_city_stamp,
-- increment_stamp_progress, toggle_feature_flag_with_audit, increment_counter,
-- rb_adjust_buddy_counter and claim_invite_link_slot_for_user.
--
-- ── THE TWENTY ARE A FORECAST, NOT A CI QUIRK ───────────────────────────────
-- portava-ci differs from production because it has the migrations production
-- has not had yet. Those twenty functions are client-executable on CI precisely
-- BECAUSE their migrations ran there. Applying the remaining chain to production
-- hands production the same twenty. This migration is therefore a PREREQUISITE
-- for that apply, not a cleanup after it.
--
-- REHEARSED against portava-ci 2026-09-16, in a transaction that was rolled
-- back: 73 application SECURITY DEFINER functions examined, 48 matched the
-- sweep predicate, 23 of those were client-reachable and were closed, and all
-- six postconditions below passed. The sweep is deliberately unconditional over
-- its predicate rather than filtered to the currently-reachable ones, so it is
-- idempotent and re-running it re-asserts the boundary on all 48.
--
-- ── PROVED, NOT INFERRED ─────────────────────────────────────────────────────
-- Zero-write probes on portava-ci (SET LOCAL ROLE anon; call; roll back). Each
-- was chosen so that the two outcomes are distinguishable by SQLSTATE and
-- NEITHER writes a row:
--
--   toggle_feature_flag_with_audit('<no such flag>', ...) as anon
--       -> P0002 "Flag not found"        = the body was ENTERED. Reachable.
--   upsert_city_stamp(NULL, ...) as anon
--       -> returned via the NULL guard   = the body was ENTERED. Reachable.
--   upsert_city_stamp(NULL, ...) as anon, ON PRODUCTION
--       -> 42501 permission denied       = correctly locked.
--   admin_set_profile_role(...) as anon
--       -> 42501 "caller is not privileged" = its INTERNAL guard held.
--
-- That last one is why this file exists in the shape it does.
-- `admin_set_profile_role` carries this comment:
--
--   "Belt and braces. EXECUTE is granted to service_role only (below), so a
--    non-privileged caller should never reach this line; if a future migration
--    widens that grant by accident, this check still holds."
--
-- The grant WAS widened -- not by a future migration, but by the Supabase
-- default the migration never revoked -- and the internal check is the only
-- reason that function is not a privilege-escalation hole today. It was right.
-- This migration restores the braces it assumed it had; 2974 adds the same belt
-- to `toggle_feature_flag_with_audit`, which has none.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS REVOKED, AND WHY THE PREDICATE IS SHAPED THIS WAY
-- ══════════════════════════════════════════════════════════════════════════════
-- EXECUTE is revoked from PUBLIC, anon and authenticated on every function in
-- `public` that is ALL of:
--
--   prosecdef            SECURITY DEFINER -- runs as owner, so RLS never applies
--   provolatile = 'v'    VOLATILE         -- PostgreSQL's own marker for "may write"
--   prorettype <> trigger
--   not extension-owned  (pg_depend deptype='e')
--   not referenced by any RLS policy in ANY schema
--
-- Each conjunct earns its place:
--
--   VOLATILE, and not "is it a writer" by hand. STABLE and IMMUTABLE are
--   contracts a function gives the planner that it performs no writes; PostgreSQL
--   enforces that a STABLE function cannot execute INSERT/UPDATE/DELETE. So
--   `provolatile='v'` is the database's own answer to "can this write", and it
--   needs no list to maintain. Every one of the 12 legitimate policy predicates
--   is STABLE and is untouched by this file for that reason alone -- the policy
--   cross-check below is a second, independent net, not the primary one.
--
--   NOT TRIGGER-RETURNING. A trigger function is invoked by the trigger
--   machinery, which does not consult EXECUTE; revoking would neither harden
--   nor break anything. Calling one directly fails on the missing trigger
--   context regardless. Excluding them keeps this sweep to privileges that
--   actually decide something.
--
--   NOT POLICY-REFERENCED, scanned across ALL schemas and not just `public`.
--   Storage policies live in `storage`, and production's
--   `post_media_path_is_moderated` is referenced from there. A `public`-only
--   scan would have called it unused. It is STABLE and so was never in scope
--   anyway -- but the scan is written wide because the postcondition below
--   depends on it, and a postcondition with a narrow scan is a postcondition
--   that passes by not looking.
--
--   NOT EXTENSION-OWNED, for 2490's reason: `postgres` cannot revoke on objects
--   owned by `supabase_admin`, and a postcondition that asserts something about
--   an object the migration cannot touch aborts the transaction and lands
--   nothing. 2490 learned that from 2333; this file inherits the lesson rather
--   than repeating it.
--
-- service_role is GRANTED rather than merely left alone, so the end state is
-- stated positively and this file is safe to run on a database where an earlier
-- hand-revoke went too far.
--
-- ── WHY REVOKING CANNOT BREAK A CALLER (checked, not assumed) ────────────────
--   1. `travel-buddy-standalone/src` contains ZERO `.rpc(` calls -- the entire
--      client workspace, every file. The browser never invokes a function.
--   2. Every `.rpc(` in production code is under `artifacts/api-server/src/`.
--   3. `artifacts/api-server/src/lib/supabase.ts` constructs its client with
--      `serviceRoleKey`. Every `SUPABASE_ANON_KEY` reference in the api-server
--      is under `src/test/`.
--   So all RPC traffic arrives as `service_role`, whose EXECUTE is granted below.
--
--   This includes the ADMIN surfaces. An authenticated administrator is a client
--   user too, and their privileged actions do not travel over the anon key: they
--   go to the api-server, which authorizes them and then acts as `service_role`.
--   `admin_set_profile_role` is the worked example -- `caller_may_write_profile_role()`
--   admits `service_role`/`postgres`/`supabase_admin` and rejects `authenticated`
--   by name, so an admin's own JWT was never the thing that made that call legal.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ONE THING DELIBERATELY NOT DONE -- STATED, NOT HIDDEN
-- ══════════════════════════════════════════════════════════════════════════════
-- There is no `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS`, and
-- that asymmetry with 2490 is a choice rather than an oversight.
--
-- 2490 could safely fix the table default because not one caller uses TRUNCATE,
-- REFERENCES, TRIGGER or MAINTAIN. EXECUTE is different: twelve functions
-- LEGITIMATELY need `anon`/`authenticated` to hold it, because an RLS policy
-- evaluates its predicate as the querying role. Revoking the default would mean
-- the next predicate helper anyone writes is created without EXECUTE, and its
-- policy would then deny every row for every client -- a silent, total read
-- outage on whatever table it guards, appearing at CREATE POLICY time with no
-- error.
--
-- Trading a loud, bounded exposure for a silent, unbounded outage is the wrong
-- trade. The drift this file cannot prevent is caught instead by
-- `checkSecurityDefinerExposure.ts`, which fails the build the day a new
-- volatile SECURITY DEFINER function becomes client-reachable. A guard that
-- names the offender beats a default that breaks the innocent.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ══════════════════════════════════════════════════════════════════════════════
-- Restoring the previous state means re-granting EXECUTE on write functions to
-- the unauthenticated public role, which no code path uses. There is no rollback
-- file. If some function is later found to genuinely need a client role to
-- execute it, grant it back on THAT function with the reason recorded, and make
-- its body check the caller -- rather than reverting the sweep.
-- ══════════════════════════════════════════════════════════════════════════════
--
-- ══════════════════════════════════════════════════════════════════════════════
-- HOW THIS FILE IS SPLIT, AND WHY IT MATTERS TO certify:migrations
-- ══════════════════════════════════════════════════════════════════════════════
-- certify:migrations STAGE 4 re-runs each migration's postcondition blocks
-- against the COMMITTED database, in a later job and a different process. It
-- collects a `DO` block only when the block raises and contains no mutation
-- keyword, and it runs each collected block STANDALONE.
--
-- That has a consequence this file has to be built around: a collected block
-- must be re-runnable forever, with nothing left over from the transaction that
-- applied it. So the work is split in two, and the split is not cosmetic:
--
--   $sweep$  Mutates (CREATE TEMP / REVOKE / GRANT / INSERT), so STAGE 4 never
--            collects it. It holds the sweep AND the before/after comparisons --
--            "did this migration take away a privilege it should not have".
--            Those are apply-time questions by nature: they compare against a
--            pre-state that exists only inside this transaction, and re-running
--            them a week later would be meaningless even if it worked.
--
--   $post$   Absolute, re-runnable invariants only. No temp tables, no
--            before/after. This is the block STAGE 4 collects, so it is the one
--            that keeps paying: every certify run re-asserts that no volatile
--            SECURITY DEFINER function in `public` is client-reachable. That
--            turns this migration from a one-time sweep into a standing ratchet,
--            which is the whole reason the invariants are written absolutely
--            rather than as a diff.
--
-- The first draft of this file put the before/after checks in the collected
-- block. It passed on apply and would have failed every certify run afterwards
-- with `relation "_2973_pre" does not exist` -- a migration that certifies
-- itself green once and then breaks the pipeline for everyone else.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- READ checkSecurityDefinerOracles.ts BEFORE CHANGING THIS FILE
-- ══════════════════════════════════════════════════════════════════════════════
-- That check's header addresses a future session directly:
--
--   "A future session reading a 'SECURITY DEFINER callable by anon' advisory
--    should read this paragraph before writing a REVOKE migration."
--
-- This is that migration, and the warning was read. Its finding is real and was
-- measured on CI: for a function an RLS POLICY references, the EXECUTE grant is
-- LOAD-BEARING. The policy expression is evaluated as the querying role, so
-- revoking EXECUTE turns a working read into `permission denied for function`
-- for every end-user token. Its conclusion -- never REVOKE on a policy-
-- referenced function -- is correct and is obeyed here twice over: such
-- functions are excluded from the sweep predicate, and postcondition 4 fails
-- the migration if one lost a privilege anyway.
--
-- Where this file goes further is a distinction that check does not draw. It
-- treats "referenced" as one category, spanning five sources, one of which is
-- the function's name appearing as a string literal in TypeScript. Those two
-- kinds of reference have opposite consequences for a REVOKE:
--
--   referenced BY A POLICY        the client role evaluates it -> EXECUTE is
--                                 load-bearing -> revoking breaks the table.
--   referenced BY THE APPLICATION the api-server calls it as `service_role` ->
--                                 the client-role grant is load-bearing for
--                                 nothing -> revoking is the missing remedy.
--
-- All 23 functions this file closes are the second kind. None is named by any
-- policy in any schema, and the api-server reaches every one of them through a
-- service-role client. So "there is nothing to remedy at this layer" is right
-- about policy predicates and wrong about application RPCs, and conflating them
-- is what left this open. checkSecurityDefinerOracles.ts remains correct in its
-- own terms -- it is an offline check about SHAPE, and it says so ("EXECUTE is a
-- live fact"); the live half is what was missing.

BEGIN;

-- ─── the sweep, and the apply-time before/after safety checks ────────────────
-- One block, deliberately. It mutates, so certify STAGE 4 never collects it,
-- which is correct: everything in here is a question about THIS transaction.
DO $sweep$
DECLARE
  f       record;
  v_bad   int;
  v_names text;
  v_swept int;
BEGIN
  -- Pre-state. The postconditions here compare against this rather than against
  -- an absolute, and that distinction is load-bearing: production's
  -- `post_media_path_is_moderated` is referenced by a storage policy and is
  -- executable by `authenticated` but deliberately NOT by `anon`. A check
  -- asserting "every policy-referenced function is executable by both client
  -- roles" would fail on production while this migration had done nothing
  -- wrong. The question worth asking is not "does this function have the
  -- privileges I expect" but "did this migration TAKE ONE AWAY".
  CREATE TEMP TABLE _2973_pre ON COMMIT DROP AS
  SELECT p.oid,
         p.proname,
         has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
         EXISTS (
           SELECT 1 FROM pg_policies pol
           WHERE coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')
                 ~ ('\m' || p.proname || '\M')
         ) AS policy_ref
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
  WHERE n.nspname = 'public' AND p.prosecdef AND d.objid IS NULL;

  CREATE TEMP TABLE _2973_swept (oid oid PRIMARY KEY) ON COMMIT DROP;

  FOR f IN
    SELECT p.oid,
           n.nspname AS sch,
           p.proname AS nm,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.provolatile = 'v'
      AND p.prorettype <> 'trigger'::regtype
      AND d.objid IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies pol
        WHERE coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')
              ~ ('\m' || p.proname || '\M')
      )
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM PUBLIC, anon, authenticated',
      f.sch, f.nm, f.args);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.%I(%s) TO service_role',
      f.sch, f.nm, f.args);
    INSERT INTO _2973_swept (oid) VALUES (f.oid);
  END LOOP;

  -- A. VACUITY GUARD ON THE SWEEP. The population could be healthy while the
  --    predicate matched nothing -- a typo in the WHERE clause looks exactly
  --    like a clean database. Production has 3 volatile writers; portava-ci has
  --    48 functions matching the predicate, 23 of which were reachable.
  SELECT count(*) INTO v_swept FROM _2973_swept;
  IF v_swept < 3 THEN
    RAISE EXCEPTION
      '2973 VACUOUS: the sweep matched only % function(s); expected 3+. A predicate that matches nothing is indistinguishable from a clean database, so this fails rather than reporting success.',
      v_swept;
  END IF;

  -- B. THE SAFETY NET ON THE CLASSIFICATION ITSELF.
  --    If the sweep revoked EXECUTE on a function an RLS policy evaluates, that
  --    policy now denies every row for every client -- silently, at query time,
  --    with nothing raised and nothing logged. The predicate above is written to
  --    make that impossible; this exists to catch the predicate being WRONG.
  SELECT count(*), string_agg(pre.proname, ', ' ORDER BY pre.proname)
    INTO v_bad, v_names
    FROM _2973_pre pre
   WHERE pre.policy_ref
     AND ((pre.anon_x AND NOT has_function_privilege('anon', pre.oid, 'EXECUTE'))
       OR (pre.auth_x AND NOT has_function_privilege('authenticated', pre.oid, 'EXECUTE')));
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '2973 FAILED: % policy-referenced function(s) LOST client EXECUTE, which silently denies every row on the table(s) they guard: %',
      v_bad, v_names;
  END IF;

  -- C. Nothing OUTSIDE the swept set lost anything. Broader than B and cheap:
  --    this sweep is meant to be surgical, so any privilege change on a function
  --    it did not touch means it was not.
  SELECT count(*), string_agg(pre.proname, ', ' ORDER BY pre.proname)
    INTO v_bad, v_names
    FROM _2973_pre pre
   WHERE pre.oid NOT IN (SELECT oid FROM _2973_swept)
     AND ((pre.anon_x AND NOT has_function_privilege('anon', pre.oid, 'EXECUTE'))
       OR (pre.auth_x AND NOT has_function_privilege('authenticated', pre.oid, 'EXECUTE')));
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '2973 FAILED: % function(s) OUTSIDE the swept set lost a client privilege: %',
      v_bad, v_names;
  END IF;

  RAISE NOTICE '2973: EXECUTE boundary asserted on % function(s).', v_swept;
END $sweep$;

-- ═══════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS — absolute and re-runnable, so certify STAGE 4 collects them
-- and re-asserts this boundary on every run rather than only on apply day.
-- ═══════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v_examined int;
  v_bad      int;
  v_names    text;
BEGIN
  -- 1. VACUITY GUARD on the population. An assertion that examines nothing must
  --    fail, not pass. Production measured 90 application SECURITY DEFINER
  --    functions in `public` and portava-ci 73; a schema with fewer than 40 is
  --    neither of this project's databases.
  SELECT count(*) INTO v_examined
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
   WHERE n.nspname = 'public' AND p.prosecdef AND d.objid IS NULL;
  IF v_examined < 40 THEN
    RAISE EXCEPTION
      '2973 postcondition 1 VACUOUS: only % application SECURITY DEFINER function(s) in schema public; expected 40+ (production 90, portava-ci 73).',
      v_examined;
  END IF;

  -- 2. THE STANDING INVARIANT. No volatile, non-trigger, non-extension SECURITY
  --    DEFINER function in `public` that no policy references is executable by
  --    a client role. This is the line 2973 draws, restated as a fact that must
  --    keep being true -- so the day someone adds a function and lets the
  --    Supabase default grant it to anon, this fails and names it.
  SELECT count(*), string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_bad, v_names
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND p.provolatile = 'v'
     AND p.prorettype <> 'trigger'::regtype
     AND d.objid IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies pol
       WHERE coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')
             ~ ('\m' || p.proname || '\M')
     )
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '2973 postcondition 2 FAILED: % volatile SECURITY DEFINER function(s) in public are executable by a client role: %. Either revoke EXECUTE from PUBLIC, anon and authenticated, or -- if a client genuinely must call it -- make its body check the caller the way 2974 does.',
      v_bad, v_names;
  END IF;

  -- 3. The other half of the same boundary, and it is not redundant: a sweep
  --    that revoked from everyone including `service_role` would satisfy
  --    postcondition 2 perfectly and break every RPC path in the api-server,
  --    which is the sole caller of all of them.
  SELECT count(*), string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_bad, v_names
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND p.provolatile = 'v'
     AND p.prorettype <> 'trigger'::regtype
     AND d.objid IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies pol
       WHERE coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')
             ~ ('\m' || p.proname || '\M')
     )
     AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '2973 postcondition 3 FAILED: % function(s) not executable by service_role: %. The api-server reaches every one of these as service_role; this is a broken RPC path, not a hardening.',
      v_bad, v_names;
  END IF;

  -- 4. And the policy predicates still work. `authenticated` rather than both
  --    roles, because `anon` legitimately varies -- production withholds it from
  --    `post_media_path_is_moderated` on purpose. A policy helper that
  --    `authenticated` cannot execute denies every row to every logged-in user.
  SELECT count(*), string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_bad, v_names
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND EXISTS (
       SELECT 1 FROM pg_policies pol
       WHERE coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')
             ~ ('\m' || p.proname || '\M')
     )
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '2973 postcondition 4 FAILED: % policy-referenced function(s) are not executable by `authenticated`: %. Every RLS policy naming one of these now denies every row to every logged-in user.',
      v_bad, v_names;
  END IF;
END $post$;

COMMIT;
