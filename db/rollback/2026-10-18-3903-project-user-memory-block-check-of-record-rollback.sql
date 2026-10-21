-- Rollback for 3903_project_user_memory_block_check_of_record.sql (census-telegraph T220 §15; wave 5,
-- docs/ops/wave5-owner-decisions-20261018.md "Migrations").
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3903 DID: amended public.project_user_memory(uuid, boolean) in place (2965's method: the installed
-- definition read with pg_get_functiondef, two predicates replaced, the result EXECUTEd as CREATE OR REPLACE).
-- The social lane's two inline block reads, one in the memory_events insert and one in the memory_projections
-- insert,
--   NOT EXISTS (SELECT 1 FROM public.blocks b WHERE (b.blocker_id=p_user_id AND b.blocked_id=uf.following_id) OR (b.blocker_id=uf.following_id AND b.blocked_id=p_user_id))
-- became
--   NOT authz.is_blocked(p_user_id, uf.following_id)
-- Nothing else: the signature, the four lanes, the flag gate, 2965's qualified delete, the search_path, SECURITY
-- INVOKER, the service_role-only ACL and the comment were carried. No table, column, row, grant, policy or flag.
-- The only row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: the inverse surgery. It reads the installed definition, puts 2963's inline predicate (as 2965
-- left it, byte for byte) back in place of each of the two calls, EXECUTEs the result as CREATE OR REPLACE (owner,
-- ACL and comment kept), and deletes 3903's ledger row so the runner re-applies 3903 later. The definition is
-- then 2963 + 2965's again. Behaviour does not change either way: both forms exclude the same follows in both
-- directions, because the projector runs as service_role, past blocks' RLS.
--
-- On a database whose pre-3903 predicate was spelled differently (3903's pattern tolerates whitespace), this
-- restores the same predicate in 2963's spelling, not a byte copy of the old spelling. On production the
-- installed definition matched the repo's 2963 + 2965 when last fingerprinted (prod-apply-packet-20261017,
-- inputs/prod-fingerprint-2-20261017.json: 1f468c6f1a63 on both).
--
-- Refuses unless the installed definition is 3903's (exactly 2 calls and no inline blocks read), and unless the
-- result differs from it in those two predicates only, character for character. If the definition is already
-- 2963 + 2965's (2 inline reads, no call), it changes nothing and clears only the ledger row. It also refuses
-- when service_role cannot SELECT public.blocks: the restored inline read runs as the caller.
--
-- LOCK: none on any table. CREATE OR REPLACE FUNCTION locks only the function's catalog row.

BEGIN;

DO $pre$
DECLARE
  n int;
BEGIN
  IF to_regprocedure('public.project_user_memory(uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3903 rollback): public.project_user_memory(uuid, boolean) is absent.';
  END IF;
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'project_user_memory';
  IF n <> 1 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3903 rollback): % overloads of public.project_user_memory exist; exactly 1 is required.', n;
  END IF;
  IF to_regclass('public.blocks') IS NULL
     OR NOT has_table_privilege('service_role', 'public.blocks', 'SELECT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3903 rollback): service_role, the projector''s only caller, cannot SELECT public.blocks; the restored inline read would fail.';
  END IF;
END $pre$;

DO $rb$
DECLARE
  NEW_CALL constant text := 'NOT authz.is_blocked(p_user_id, uf.following_id)';
  OLD_PRED constant text := 'NOT EXISTS (SELECT 1 FROM public.blocks b WHERE (b.blocker_id=p_user_id AND b.blocked_id=uf.following_id) OR (b.blocker_id=uf.following_id AND b.blocked_id=p_user_id))';
  -- 3903's own pattern for the inline read, so "already rolled back" means what 3903 would amend.
  OLD_RE   constant text := 'NOT EXISTS \(\s*SELECT 1 FROM public\.blocks b WHERE \(b\.blocker_id\s*=\s*p_user_id AND b\.blocked_id\s*=\s*uf\.following_id\) OR \(b\.blocker_id\s*=\s*uf\.following_id AND b\.blocked_id\s*=\s*p_user_id\)\s*\)';
  d_cur text;
  d_old text;
  n_new int;
  n_old int;
  n_any int;
BEGIN
  d_cur := pg_get_functiondef('public.project_user_memory(uuid,boolean)'::regprocedure);
  n_new := (length(d_cur) - length(replace(d_cur, NEW_CALL, ''))) / length(NEW_CALL);
  SELECT count(*) INTO n_old FROM regexp_matches(d_cur, OLD_RE, 'g');
  n_any := (length(d_cur) - length(replace(d_cur, 'authz.is_blocked', ''))) / length('authz.is_blocked');

  IF n_new = 0 AND n_old = 2 AND n_any = 0 THEN
    RAISE NOTICE '3903 rollback: project_user_memory already reads blocks inline in both social-lane statements (2963 + 2965); nothing to undo.';
    RETURN;
  END IF;
  IF n_new <> 2 OR n_old <> 0 OR n_any <> n_new THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3903): expected 3903''s definition (exactly 2 authz.is_blocked calls, both of 3903''s form, and 0 inline blocks reads) in the installed project_user_memory, found % call(s) of 3903''s form, % inline read(s) and % mention(s) of authz.is_blocked. Nothing was changed.', n_new, n_old, n_any;
  END IF;

  d_old := replace(d_cur, NEW_CALL, OLD_PRED);

  -- Minimality, character for character: everything but the two predicates is carried.
  IF replace(d_cur, NEW_CALL, '<3903>') IS DISTINCT FROM replace(d_old, OLD_PRED, '<3903>') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3903): the restored definition would differ from the installed one outside the two block predicates. Nothing was changed.';
  END IF;
  IF position('authz.is_blocked' IN d_old) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3903): the restored definition would still call authz.is_blocked. Nothing was changed.';
  END IF;

  EXECUTE d_old;
END $rb$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3903_project_user_memory_block_check_of_record.sql';

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  d text;
  v_code text;
  n int;
  OLD_RE constant text := 'NOT EXISTS \(\s*SELECT 1 FROM public\.blocks b WHERE \(b\.blocker_id\s*=\s*p_user_id AND b\.blocked_id\s*=\s*uf\.following_id\) OR \(b\.blocker_id\s*=\s*uf\.following_id AND b\.blocked_id\s*=\s*p_user_id\)\s*\)';
BEGIN
  IF to_regprocedure('public.project_user_memory(uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3903): public.project_user_memory(uuid, boolean) is gone.';
  END IF;
  d := pg_get_functiondef('public.project_user_memory(uuid,boolean)'::regprocedure);
  v_code := regexp_replace(d, '--[^' || chr(10) || ']*', '', 'g');
  IF position('authz.is_blocked' IN v_code) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3903): project_user_memory still calls authz.is_blocked.';
  END IF;
  SELECT count(*) INTO n FROM regexp_matches(v_code, OLD_RE, 'g');
  IF n <> 2 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3903): the social lane does not read blocks inline twice (events and projections).';
  END IF;
  IF pg_get_function_identity_arguments('public.project_user_memory(uuid,boolean)'::regprocedure) IS DISTINCT FROM 'p_user_id uuid, p_enforce_flag boolean' THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3903): the signature changed.';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.project_user_memory(uuid,boolean)'::regprocedure) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3903): project_user_memory became SECURITY DEFINER.';
  END IF;
  IF has_function_privilege('anon', 'public.project_user_memory(uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.project_user_memory(uuid,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.project_user_memory(uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3903): project_user_memory''s EXECUTE is no longer service_role only.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3903_project_user_memory_block_check_of_record.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3903): the ledger still records 3903 as applied.';
  END IF;
END $post$;
