-- Rollback for 3904_memory_public_feed_block_check_of_record.sql (census-telegraph T220 §15; wave 5,
-- docs/ops/wave5-owner-decisions-20261018.md "Migrations").
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3904 DID: amended public.memory_public_feed(uuid, integer, timestamptz) in place (2965's method: the
-- installed definition read with pg_get_functiondef, one predicate replaced, the result EXECUTEd as CREATE OR
-- REPLACE). 2338's inline block read
--     AND NOT EXISTS (
--       SELECT 1 FROM public.blocks b
--        WHERE (b.blocker_id = p_viewer     AND b.blocked_id = m.owner_id)
--           OR (b.blocker_id = m.owner_id   AND b.blocked_id = p_viewer)
--     )
-- became
--     AND NOT authz.is_blocked(p_viewer, m.owner_id)
-- Nothing else: every other predicate, the column list, the ORDER BY, the LIMIT clamp, STABLE, SECURITY INVOKER,
-- the pinned search_path, the service_role-only ACL and the comment were carried. No table, column, row, grant,
-- policy or flag. The only row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: the inverse surgery. It reads the installed definition, puts 2338's inline predicate (byte for
-- byte as 2338 spells it, line breaks and alignment included) back in place of the call, EXECUTEs the result as
-- CREATE OR REPLACE (owner, ACL and comment kept), and deletes 3904's ledger row so the runner re-applies 3904
-- later. The definition is then 2338's again. Behaviour does not change either way: the feed is service_role
-- only, so its inline read already ran past blocks' RLS, and both forms exclude both directions.
--
-- ⚠ PRODUCTION'S FEED IS DRIFTED FROM 2338. prod-apply-packet-20261017 measured it read-only on 2026-10-17:
-- its fingerprint is 91b5d7c40a75 where the repo's 2338 gives e5f33a8b55cb
-- (the packet's verify/logs/fidelity-C-ledgered-mismatches.json). 3904's pattern tolerates whitespace, so if production's
-- inline read was spelled differently, this rollback restores the same predicate in 2338's spelling, not a byte
-- copy of production's. Capture pg_get_functiondef read-only before pressing 3904 if a byte copy matters.
--
-- Refuses unless the installed definition is 3904's (exactly 1 call and no inline blocks read), and unless the
-- result differs from it in that one predicate only, character for character. If the definition already reads
-- blocks inline (1 inline read, no call), it changes nothing and clears only the ledger row. It also refuses when
-- service_role cannot SELECT public.blocks: the restored inline read runs as the caller.
--
-- LOCK: none on any table. CREATE OR REPLACE FUNCTION locks only the function's catalog row. CREATE OR REPLACE
-- re-validates a SQL body, so the columns of public.memories it reads must still exist.

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.memory_public_feed(uuid,integer,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3904 rollback): public.memory_public_feed(uuid, integer, timestamptz) is absent.';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public' AND p.proname = 'memory_public_feed') <> 1 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3904 rollback): public.memory_public_feed must have exactly one overload.';
  END IF;
  IF to_regclass('public.blocks') IS NULL
     OR NOT has_table_privilege('service_role', 'public.blocks', 'SELECT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3904 rollback): service_role, the feed''s only caller, cannot SELECT public.blocks; the restored inline read would fail.';
  END IF;
END $pre$;

DO $rb$
DECLARE
  NEW_CALL constant text := 'NOT authz.is_blocked(p_viewer, m.owner_id)';
  OLD_PRED constant text := E'NOT EXISTS (\n      SELECT 1 FROM public.blocks b\n       WHERE (b.blocker_id = p_viewer     AND b.blocked_id = m.owner_id)\n          OR (b.blocker_id = m.owner_id   AND b.blocked_id = p_viewer)\n    )';
  -- 3904's own pattern for the inline read, so "already rolled back" means what 3904 would amend.
  OLD_RE   constant text := 'NOT EXISTS \(\s*SELECT 1 FROM public\.blocks b\s+WHERE \(b\.blocker_id = p_viewer\s+AND b\.blocked_id = m\.owner_id\)\s+OR \(b\.blocker_id = m\.owner_id\s+AND b\.blocked_id = p_viewer\)\s*\)';
  d_cur text;
  d_old text;
  n_new int;
  n_old int;
  n_any int;
BEGIN
  d_cur := pg_get_functiondef('public.memory_public_feed(uuid,integer,timestamptz)'::regprocedure);
  n_new := (length(d_cur) - length(replace(d_cur, NEW_CALL, ''))) / length(NEW_CALL);
  SELECT count(*) INTO n_old FROM regexp_matches(d_cur, OLD_RE, 'g');
  n_any := (length(d_cur) - length(replace(d_cur, 'authz.is_blocked', ''))) / length('authz.is_blocked');

  IF n_new = 0 AND n_old = 1 AND n_any = 0 THEN
    RAISE NOTICE '3904 rollback: memory_public_feed already reads blocks inline; nothing to undo.';
    RETURN;
  END IF;
  IF n_new <> 1 OR n_old <> 0 OR n_any <> n_new THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3904): expected 3904''s definition (exactly 1 authz.is_blocked call, of 3904''s form, and 0 inline blocks reads) in the installed memory_public_feed, found % call(s) of 3904''s form, % inline read(s) and % mention(s) of authz.is_blocked. Nothing was changed.', n_new, n_old, n_any;
  END IF;

  d_old := replace(d_cur, NEW_CALL, OLD_PRED);

  -- Minimality, character for character: everything but the one predicate is carried.
  IF replace(d_cur, NEW_CALL, '<3904>') IS DISTINCT FROM replace(d_old, OLD_PRED, '<3904>') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3904): the restored definition would differ from the installed one outside the block predicate. Nothing was changed.';
  END IF;
  IF position('authz.is_blocked' IN d_old) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3904): the restored definition would still call authz.is_blocked. Nothing was changed.';
  END IF;

  EXECUTE d_old;
END $rb$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3904_memory_public_feed_block_check_of_record.sql';

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  f oid := to_regprocedure('public.memory_public_feed(uuid,integer,timestamptz)');
  v_src text;
  n int;
BEGIN
  IF f IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3904): public.memory_public_feed(uuid, integer, timestamptz) is gone.';
  END IF;
  SELECT regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') INTO v_src FROM pg_proc WHERE oid = f;
  IF position('authz.is_blocked' IN v_src) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3904): memory_public_feed still calls authz.is_blocked.';
  END IF;
  SELECT count(*) INTO n FROM regexp_matches(v_src, 'NOT EXISTS \(\s*SELECT 1 FROM public\.blocks b\s+WHERE \(b\.blocker_id = p_viewer\s+AND b\.blocked_id = m\.owner_id\)\s+OR \(b\.blocker_id = m\.owner_id\s+AND b\.blocked_id = p_viewer\)\s*\)', 'g');
  IF n <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3904): the feed reads blocks inline % time(s); expected 1.', n;
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = f) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3904): memory_public_feed became SECURITY DEFINER.';
  END IF;
  IF has_function_privilege('anon', 'public.memory_public_feed(uuid,integer,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_public_feed(uuid,integer,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.memory_public_feed(uuid,integer,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3904): memory_public_feed''s EXECUTE is no longer service_role only.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3904_memory_public_feed_block_check_of_record.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3904): the ledger still records 3904 as applied.';
  END IF;
END $post$;
