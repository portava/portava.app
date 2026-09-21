-- 2965_memory_projector_canon_saves_delete_guard.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2965.
-- Requires 2963. Additive surgery on one statement. Idempotent by refusal.
--
-- ── THE DEFECT ───────────────────────────────────────────────────────────────
-- 2963_memory_projector_place_lane_union.sql:171 writes
--
--     DELETE FROM _canon_saves;
--
-- with no WHERE clause, against the TEMP table it creates six lines above.
-- Postgres permits that. This database does not: `session_preload_libraries`
-- is `supautils`, whose safeupdate guard raises
--
--     DELETE requires a WHERE clause
--
-- for PostgREST-role sessions. The statement is therefore unreachable from the
-- API, and `project_user_memory` fails on every invocation that gets that far.
--
-- ── WHY IT REACHED main AND PRODUCTION UNCAUGHT ──────────────────────────────
-- Three independent reasons, all of them structural rather than careless:
--
--   1. The applier reaches the database through the Supabase MANAGEMENT API,
--      where supautils is not preloaded. 2963 applied cleanly — CREATE OR
--      REPLACE FUNCTION only parses the body, it does not execute it.
--   2. The live suites call the function through POSTGREST, as
--      project_user_memory_with_retraction -> project_user_memory, and that is
--      the session the guard is armed in.
--   3. `db:apply-migrations` runs on main ONLY, so #511's own PR run exercised
--      a database that did not yet carry 2963. The first execution of the new
--      body was on main, after the merge.
--
-- Measured on main fd0b3a6, run 2439: 9 of 11 memory-projection-lifecycle
-- tests and the memory-lifecycle suite, every one failing with that exact
-- message. It is NOT only a test problem — lib/memoryProjectionScheduler.ts:81
-- catches the rejection and only `logger.warn`s it, so wherever the pass runs
-- unattended it fails SILENTLY and projects nothing.
--
-- ── WHY SURGERY RATHER THAN RE-APPLYING 2963 ─────────────────────────────────
-- 2963 carries a schema_migration_ledger row, and scripts/src/apply-migrations
-- skips any file already recorded. Editing 2963 in place would also break its
-- recorded sha256. So this file amends the INSTALLED definition the way 2799
-- amends trip_snapshot_fold: read it with pg_get_functiondef, replace the one
-- statement, EXECUTE the result. That also means it corrects whatever is
-- actually installed rather than whatever this file assumes is installed.
--
-- ── WHY `WHERE true`, AND WHAT IS AND IS NOT PROVEN ──────────────────────────
-- The guard's contract is stated by its own message: a WHERE clause must be
-- PRESENT. `WHERE true` supplies one while leaving the statement's effect
-- identical to what 2963 intended — every row of a table that is private to
-- this session. It is the minimal change that satisfies the guard by the
-- definition of the guard.
--
-- TRUNCATE would very likely also work and was considered. It is NOT rejected
-- on locking grounds: an earlier draft of this header claimed TRUNCATE's ACCESS
-- EXCLUSIVE lock made it unsafe under the concurrent-projection case, and that
-- reasoning was WRONG — `_canon_saves` is a TEMP table, private to its session,
-- so two concurrent projections hold two different tables and never contend. It
-- is rejected only because it is a different statement type whose treatment by
-- this guard could not be tested here, while `WHERE true` is answered directly
-- by the error message.
--
-- WHAT COULD NOT BE PROVEN FROM THE AUTHORING SESSION, STATED PLAINLY. The
-- guard could not be armed to demonstrate the fix: the Management API session
-- cannot `LOAD 'safeupdate'` ("access to library is not allowed") and setting
-- `safeupdate.enabled` in that session has no effect, so a probe issuing an
-- unqualified DELETE there SUCCEEDS and proves nothing. What IS established:
-- `session_preload_libraries = supautils`; `safeupdate.enabled` is a recognised
-- GUC here (supautils.privileged_role_allowed_configs names it); the message in
-- the failures is that guard's verbatim text; this is the ONLY unqualified
-- DELETE in the function; and nine tests fail with exactly that message through
-- the PostgREST path. The diagnosis rests on that chain. The SUFFICIENCY of the
-- fix is confirmed by the live suites on the first main run after this merges —
-- not by any check that can run before it.

BEGIN;

DO $pre$
DECLARE d text; n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prokind = 'f' AND p.proname = 'project_user_memory';
  IF d IS NULL THEN
    RAISE EXCEPTION '2965: public.project_user_memory is absent; apply 2963 first.';
  END IF;

  IF position('DELETE FROM _canon_saves WHERE' in d) > 0 THEN
    RAISE EXCEPTION '2965: the installed definition already qualifies the _canon_saves delete; this migration is not idempotent by design.';
  END IF;

  n := (length(d) - length(replace(d, 'DELETE FROM _canon_saves;', ''))) / length('DELETE FROM _canon_saves;');
  IF n <> 1 THEN
    RAISE EXCEPTION '2965: expected exactly 1 unqualified `DELETE FROM _canon_saves;`, found %. Refusing rather than guessing which one to amend.', n;
  END IF;
END
$pre$;

DO $mig$
DECLARE d text; before_len int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prokind = 'f' AND p.proname = 'project_user_memory';
  before_len := length(d);

  d := replace(d, 'DELETE FROM _canon_saves;', 'DELETE FROM _canon_saves WHERE true;');

  IF length(d) <= before_len THEN
    RAISE EXCEPTION '2965: the definition did not grow; the replacement did not apply.';
  END IF;

  EXECUTE d;
END
$mig$;

-- ── POSTCONDITIONS ───────────────────────────────────────────────────────────
DO $post$
DECLARE d text; n int; v_args text;
BEGIN
  SELECT pg_get_functiondef(p.oid), pg_get_function_identity_arguments(p.oid)
    INTO d, v_args
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prokind = 'f' AND p.proname = 'project_user_memory';

  IF d IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: project_user_memory vanished.';
  END IF;

  -- The signature 2963 installed, unchanged. A replacement that altered the
  -- argument list would leave the old overload behind and the RPC would still
  -- resolve to it.
  IF v_args IS DISTINCT FROM 'p_user_id uuid, p_enforce_flag boolean' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: signature is now (%), expected (p_user_id uuid, p_enforce_flag boolean).', v_args;
  END IF;

  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prokind = 'f' AND p.proname = 'project_user_memory';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % overloads of project_user_memory; the replacement created one instead of replacing.', n;
  END IF;

  IF position('DELETE FROM _canon_saves;' in d) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: an unqualified `DELETE FROM _canon_saves;` is still installed.';
  END IF;

  n := (length(d) - length(replace(d, 'DELETE FROM _canon_saves WHERE true;', ''))) / length('DELETE FROM _canon_saves WHERE true;');
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 qualified delete, found %.', n;
  END IF;

  -- The PLACE lane 2963 exists to add must survive this edit untouched.
  IF position('_canon_saves' in d) = 0 OR position('discovery_place_saves' in d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the PLACE lane is no longer in the body.';
  END IF;
END
$post$;

COMMIT;
