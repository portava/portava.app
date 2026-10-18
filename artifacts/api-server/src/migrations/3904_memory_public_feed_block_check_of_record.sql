-- 3904_memory_public_feed_block_check_of_record.sql
-- The §18 public Memory feed asks the definition of record whether the viewer
-- and an author are blocked (census-telegraph T220 §15 "No subsystem may
-- independently 'rediscover' a blocked relationship"; independent verification
-- pass 4's boundary note: "memory_public_feed (2338, applied) inline NOT EXISTS
-- (SELECT 1 FROM public.blocks ...) instead of calling is_blocked").
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band, gap number 3904;
-- docs/ops/wave5-owner-decisions-20261018.md "Migrations").
--
-- WRITTEN, NOT APPLIED. One function body amended in place. No table, column,
-- row, grant, policy or flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT CHANGES, AND WHAT DOES NOT
-- ══════════════════════════════════════════════════════════════════════════════
-- The current definition is 2338's (DROP + CREATE; 3813 names it only in a
-- comment). Its block predicate is
--
--   AND NOT EXISTS (
--     SELECT 1 FROM public.blocks b
--      WHERE (b.blocker_id = p_viewer     AND b.blocked_id = m.owner_id)
--         OR (b.blocker_id = m.owner_id   AND b.blocked_id = p_viewer)
--   )
--
-- and this file replaces exactly that predicate with
--
--   AND NOT authz.is_blocked(p_viewer, m.owner_id)
--
-- authz.is_blocked(a, b) (baseline public.is_blocked, moved to authz by 2182)
-- is EXISTS over blocks WHERE (blocker_id = a AND blocked_id = b) OR (blocker_id
-- = b AND blocked_id = a): the same predicate, both directions; p_viewer is
-- non-NULL by the function's first conjunct, and a NULL owner matches no row
-- either way. memory_public_feed is SECURITY INVOKER and EXECUTE-able by
-- service_role only (2338), so it already read blocks past RLS; the definer
-- function reads the same rows. Every other predicate, the column list, the
-- ORDER BY, the LIMIT clamp, STABLE, INVOKER, the pinned search_path, the
-- service_role-only ACL and the comment are carried. The flag that routes GET
-- /memories here (memory_public_feed_projection_enabled) is untouched.
-- The planner can no longer turn the predicate into an anti-join (a SECURITY
-- DEFINER function is not inlined): one indexed probe of blocks per public
-- Memory the scan reaches before the LIMIT.
--
-- HOW (2965's method). The installed definition is read with
-- pg_get_functiondef, the predicate is replaced, and the result is EXECUTEd as
-- CREATE OR REPLACE (owner, ACL and comment kept). The $mig$ block refuses
-- unless masking the old predicate out of the old text and the new call out of
-- the new text leaves the SAME text, character for character. Re-running is a
-- no-op: with the call present and no inline read left it changes nothing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER INDEPENDENCE (a gap number: applied at 3904 on a fresh replay, after 3999
-- on portava-ci and production)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on public.memory_public_feed(uuid, integer, timestamptz) (2338) and
-- authz.is_blocked(uuid, uuid) (2182). No file above 3904 names
-- memory_public_feed, is_blocked or public.blocks, and none alters a column of
-- public.memories the body reads (CREATE OR REPLACE re-validates a SQL body, so
-- a dropped column would refuse this file wherever it ran after the drop).
--
-- ROLLBACK (the inverse surgery; nothing depends on the change):
--   BEGIN;
--   DO $rb$ DECLARE d text; BEGIN
--     d := pg_get_functiondef('public.memory_public_feed(uuid,integer,timestamptz)'::regprocedure);
--     d := replace(d, 'NOT authz.is_blocked(p_viewer, m.owner_id)', E'NOT EXISTS (\n      SELECT 1 FROM public.blocks b\n       WHERE (b.blocker_id = p_viewer     AND b.blocked_id = m.owner_id)\n          OR (b.blocker_id = m.owner_id   AND b.blocked_id = p_viewer)\n    )');
--     EXECUTE d; END $rb$;
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3904_memory_public_feed_block_check_of_record.sql';
--   COMMIT;

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.memory_public_feed(uuid,integer,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3904): public.memory_public_feed(uuid, integer, timestamptz) is absent; apply 2338 first.';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public' AND p.proname = 'memory_public_feed') <> 1 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3904): public.memory_public_feed must have exactly one overload.';
  END IF;
  IF to_regprocedure('authz.is_blocked(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3904): authz.is_blocked(uuid, uuid) is absent; apply 2182 first.';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'authz.is_blocked(uuid,uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3904): authz.is_blocked is not SECURITY DEFINER; it would read blocks through the caller''s RLS.';
  END IF;
  IF NOT has_schema_privilege('service_role', 'authz', 'USAGE')
     OR NOT has_function_privilege('service_role', 'authz.is_blocked(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3904): service_role, the feed''s only caller, cannot reach authz.is_blocked.';
  END IF;
END $pre$;

DO $mig$
DECLARE
  OLD_RE   constant text := 'NOT EXISTS \(\s*SELECT 1 FROM public\.blocks b\s+WHERE \(b\.blocker_id = p_viewer\s+AND b\.blocked_id = m\.owner_id\)\s+OR \(b\.blocker_id = m\.owner_id\s+AND b\.blocked_id = p_viewer\)\s*\)';
  NEW_CALL constant text := 'NOT authz.is_blocked(p_viewer, m.owner_id)';
  d_old text;
  d_new text;
  n_old int;
  n_new int;
BEGIN
  d_old := pg_get_functiondef('public.memory_public_feed(uuid,integer,timestamptz)'::regprocedure);
  SELECT count(*) INTO n_old FROM regexp_matches(d_old, OLD_RE, 'g');
  n_new := (length(d_old) - length(replace(d_old, NEW_CALL, ''))) / length(NEW_CALL);

  IF n_old = 0 AND n_new = 1 AND d_old !~ '\mpublic\.blocks\M' THEN
    RAISE NOTICE '3904: memory_public_feed already asks authz.is_blocked; nothing to do.';
    RETURN;
  END IF;
  IF n_old <> 1 OR n_new <> 0 THEN
    RAISE EXCEPTION '3904 PRECONDITION FAILED: expected exactly 1 inline blocks predicate and 0 authz.is_blocked calls in the installed memory_public_feed, found % and %. Refusing rather than guessing.', n_old, n_new;
  END IF;

  d_new := regexp_replace(d_old, OLD_RE, NEW_CALL, 'g');

  -- Minimality, character for character: everything but the one predicate is carried.
  IF regexp_replace(d_old, OLD_RE, '<3904>', 'g') IS DISTINCT FROM replace(d_new, NEW_CALL, '<3904>') THEN
    RAISE EXCEPTION '3904: the amended definition differs from the installed one outside the block predicate. Refusing to write.';
  END IF;
  IF d_new ~ '\mpublic\.blocks\M' THEN
    RAISE EXCEPTION '3904: the amended definition still reads public.blocks inline.';
  END IF;

  EXECUTE d_new;
END $mig$;

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  f oid := to_regprocedure('public.memory_public_feed(uuid,integer,timestamptz)');
  v_src text;
  n int;
BEGIN
  IF f IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3904): public.memory_public_feed(uuid, integer, timestamptz) is gone.';
  END IF;
  SELECT regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') INTO v_src FROM pg_proc WHERE oid = f;

  n := (length(v_src) - length(replace(v_src, 'NOT authz.is_blocked(p_viewer, m.owner_id)', ''))) / length('NOT authz.is_blocked(p_viewer, m.owner_id)');
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3904): the feed asks authz.is_blocked % time(s); expected 1.', n;
  END IF;
  IF v_src ~ '\mblocks\M' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3904): memory_public_feed still reads the blocks table itself.';
  END IF;

  -- 2338's other predicates and shape, unchanged.
  IF position('m.state = ''published''' IN v_src) = 0 OR position('m.visibility = ''public''' IN v_src) = 0
     OR position('NOT (p_viewer = ANY (m.hidden_user_ids))' IN v_src) = 0 OR position('p_viewer IS NOT NULL' IN v_src) = 0
     OR position('LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3904): one of 2338''s state, visibility, hidden-viewer, viewer or limit predicates is gone.';
  END IF;
  IF (SELECT prosecdef OR provolatile <> 's' OR NOT coalesce(proconfig @> ARRAY['search_path=public, pg_temp'], false) FROM pg_proc WHERE oid = f) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3904): memory_public_feed is no longer STABLE SECURITY INVOKER with its pinned search_path.';
  END IF;
  IF has_function_privilege('anon', 'public.memory_public_feed(uuid,integer,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_public_feed(uuid,integer,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.memory_public_feed(uuid,integer,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3904): memory_public_feed''s EXECUTE is no longer service_role only (2182''s oracle class).';
  END IF;
  IF NOT has_schema_privilege('service_role', 'authz', 'USAGE')
     OR NOT has_function_privilege('service_role', 'authz.is_blocked(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3904): service_role cannot reach authz.is_blocked.';
  END IF;
END $post$;
