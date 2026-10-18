-- 3903_project_user_memory_block_check_of_record.sql
-- The memory projector's social lane asks the definition of record whether two
-- people are blocked (census-telegraph T220 §15 "No subsystem may independently
-- 'rediscover' a blocked relationship"; independent verification pass 4's
-- boundary note: "project_user_memory ... inline NOT EXISTS (SELECT 1 FROM
-- public.blocks ...) instead of calling is_blocked"). POST-CUTOVER CANONICAL
-- FORWARD MIGRATION (3000-3999 band, gap number 3903;
-- docs/ops/wave5-owner-decisions-20261018.md "Migrations").
--
-- WRITTEN, NOT APPLIED. One function body amended in place. No table, column,
-- row, grant, policy or flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT CHANGES, AND WHAT DOES NOT
-- ══════════════════════════════════════════════════════════════════════════════
-- The current definition is 2963's body as amended by 2965 (2965 rewrote one
-- statement of the installed definition; no later file redefines it). Its social
-- lane reads public.blocks inline, twice — once for the memory_events insert,
-- once for the memory_projections insert — each as
--
--   NOT EXISTS (SELECT 1 FROM public.blocks b WHERE (b.blocker_id=p_user_id AND
--     b.blocked_id=uf.following_id) OR (b.blocker_id=uf.following_id AND
--     b.blocked_id=p_user_id))
--
-- and this file replaces exactly those two predicates with
--
--   NOT authz.is_blocked(p_user_id, uf.following_id)
--
-- authz.is_blocked(a, b) (baseline public.is_blocked, moved to authz by 2182)
-- is EXISTS over blocks WHERE (blocker_id = a AND blocked_id = b) OR (blocker_id
-- = b AND blocked_id = a): the same predicate, both directions, NULL-for-NULL
-- (an unmatched comparison finds no row either way). The function is SECURITY
-- INVOKER and EXECUTE-able by service_role only (2184-2193), so it already read
-- blocks past RLS; the definer function reads the same rows. Nothing a caller
-- can observe changes: the same follows are excluded, the same rows written.
-- The planner can no longer turn the predicate into an anti-join (a SECURITY
-- DEFINER function is not inlined): one indexed probe of blocks per followed
-- account, for one user per call.
--
-- HOW (2965's method, which this function's history established). The
-- installed definition is read with pg_get_functiondef, the two predicates are
-- replaced, and the result is EXECUTEd — so whatever is installed is amended,
-- and nothing else can change: the $mig$ block refuses unless masking the old
-- predicate out of the old text and the new call out of the new text leaves the
-- SAME text, character for character. The signature, the four lanes, the flag
-- gate, 2965's qualified delete, the search_path, INVOKER, the ACL and the
-- comment survive (CREATE OR REPLACE keeps the owner, ACL and comment).
-- Re-running is a no-op: with both calls present and no inline read left, the
-- $mig$ block says so and changes nothing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER INDEPENDENCE (a gap number: applied at 3903 on a fresh replay, after 3999
-- on portava-ci and production)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on public.project_user_memory(uuid, boolean) (2963, amended by 2965)
-- and authz.is_blocked(uuid, uuid) (2182). No file above 3903 names
-- project_user_memory, is_blocked or public.blocks: 3314 is the last file to name
-- the projector (it calls it), and it sits below. So nothing above alters,
-- drops or redefines what this file amends.
--
-- ROLLBACK (the inverse surgery; nothing depends on the change):
--   BEGIN;
--   DO $rb$ DECLARE d text; BEGIN
--     d := pg_get_functiondef('public.project_user_memory(uuid,boolean)'::regprocedure);
--     d := replace(d, 'NOT authz.is_blocked(p_user_id, uf.following_id)',
--       'NOT EXISTS (SELECT 1 FROM public.blocks b WHERE (b.blocker_id=p_user_id AND b.blocked_id=uf.following_id) OR (b.blocker_id=uf.following_id AND b.blocked_id=p_user_id))');
--     EXECUTE d; END $rb$;
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3903_project_user_memory_block_check_of_record.sql';
--   COMMIT;

BEGIN;

DO $pre$
DECLARE
  n int;
BEGIN
  IF to_regprocedure('public.project_user_memory(uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3903): public.project_user_memory(uuid, boolean) is absent; apply 2963 and 2965 first.';
  END IF;
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'project_user_memory';
  IF n <> 1 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3903): % overloads of public.project_user_memory exist; exactly 1 is required.', n;
  END IF;
  IF to_regprocedure('authz.is_blocked(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3903): authz.is_blocked(uuid, uuid) is absent; apply 2182 first.';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'authz.is_blocked(uuid,uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3903): authz.is_blocked is not SECURITY DEFINER; it would read blocks through the caller''s RLS.';
  END IF;
  IF NOT has_schema_privilege('service_role', 'authz', 'USAGE')
     OR NOT has_function_privilege('service_role', 'authz.is_blocked(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3903): service_role, the projector''s only caller, cannot reach authz.is_blocked.';
  END IF;
END $pre$;

DO $mig$
DECLARE
  OLD_RE   constant text := 'NOT EXISTS \(\s*SELECT 1 FROM public\.blocks b WHERE \(b\.blocker_id\s*=\s*p_user_id AND b\.blocked_id\s*=\s*uf\.following_id\) OR \(b\.blocker_id\s*=\s*uf\.following_id AND b\.blocked_id\s*=\s*p_user_id\)\s*\)';
  NEW_CALL constant text := 'NOT authz.is_blocked(p_user_id, uf.following_id)';
  d_old text;
  d_new text;
  n_old int;
  n_new int;
BEGIN
  d_old := pg_get_functiondef('public.project_user_memory(uuid,boolean)'::regprocedure);
  SELECT count(*) INTO n_old FROM regexp_matches(d_old, OLD_RE, 'g');
  n_new := (length(d_old) - length(replace(d_old, NEW_CALL, ''))) / length(NEW_CALL);

  IF n_old = 0 AND n_new = 2 AND d_old !~ '\mpublic\.blocks\M' THEN
    RAISE NOTICE '3903: project_user_memory already asks authz.is_blocked in both social-lane statements; nothing to do.';
    RETURN;
  END IF;
  IF n_old <> 2 OR n_new <> 0 THEN
    RAISE EXCEPTION '3903 PRECONDITION FAILED: expected exactly 2 inline blocks predicates and 0 authz.is_blocked calls in the installed project_user_memory, found % and %. Refusing rather than guessing which to amend.', n_old, n_new;
  END IF;

  d_new := regexp_replace(d_old, OLD_RE, NEW_CALL, 'g');

  -- Minimality, character for character: everything but the two predicates is carried.
  IF regexp_replace(d_old, OLD_RE, '<3903>', 'g') IS DISTINCT FROM replace(d_new, NEW_CALL, '<3903>') THEN
    RAISE EXCEPTION '3903: the amended definition differs from the installed one outside the two block predicates. Refusing to write.';
  END IF;
  IF d_new ~ '\mpublic\.blocks\M' THEN
    RAISE EXCEPTION '3903: the amended definition still reads public.blocks inline.';
  END IF;

  EXECUTE d_new;
END $mig$;

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  d text;
  v_code text;
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'project_user_memory';
  IF n <> 1 OR to_regprocedure('public.project_user_memory(uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3903): expected exactly one public.project_user_memory(uuid, boolean); found % overload(s).', n;
  END IF;
  d := pg_get_functiondef('public.project_user_memory(uuid,boolean)'::regprocedure);
  v_code := regexp_replace(d, '--[^' || chr(10) || ']*', '', 'g');

  n := (length(v_code) - length(replace(v_code, 'NOT authz.is_blocked(p_user_id, uf.following_id)', ''))) / length('NOT authz.is_blocked(p_user_id, uf.following_id)');
  IF n <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3903): the social lane asks authz.is_blocked % time(s); expected 2 (events and projections).', n;
  END IF;
  IF v_code ~ '\mblocks\M' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3903): project_user_memory still reads the blocks table itself.';
  END IF;

  -- 2963's and 2965's invariants, unchanged.
  IF pg_get_function_identity_arguments('public.project_user_memory(uuid,boolean)'::regprocedure) IS DISTINCT FROM 'p_user_id uuid, p_enforce_flag boolean' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3903): the signature changed.';
  END IF;
  IF v_code NOT LIKE '%''episodic''%' OR v_code NOT LIKE '%''semantic''%' OR v_code NOT LIKE '%''social''%' OR v_code NOT LIKE '%''place''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3903): a memory lane is gone.';
  END IF;
  IF v_code NOT LIKE '%p_enforce_flag%' OR position('_canon_saves WHERE true' IN v_code) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3903): the flag gate or 2965''s qualified temp-table delete is gone.';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.project_user_memory(uuid,boolean)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3903): project_user_memory became SECURITY DEFINER.';
  END IF;
  IF has_function_privilege('anon', 'public.project_user_memory(uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.project_user_memory(uuid,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.project_user_memory(uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3903): project_user_memory''s EXECUTE is no longer service_role only.';
  END IF;
  IF NOT has_schema_privilege('service_role', 'authz', 'USAGE')
     OR NOT has_function_privilege('service_role', 'authz.is_blocked(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3903): service_role cannot reach authz.is_blocked.';
  END IF;
END $post$;
