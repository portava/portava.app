-- Rollback for 3872_layover_crew_plans.sql (LAYOVER 165, lane B2-CREW; census-layover L134/L135, spec §14.1).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3872 DID (one transaction, additive):
--   * created two service-role-only tables (RLS on, a service_role policy each, every client privilege revoked), with
--     their indexes, constraints and comments:
--       public.layover_crew_plans           crew_id -> layover_crews, proposed_by -> profiles,
--                                           proposed_session_id -> layover_sessions (all ON DELETE CASCADE)
--       public.layover_crew_plan_branches   plan_id -> layover_crew_plans ON DELETE CASCADE
--   * created four functions: the two guard trigger functions (layover_crew_plan_guard, layover_crew_plan_branch_guard)
--     with their BEFORE INSERT OR UPDATE triggers; layover_crew_plan_member_gone with its AFTER UPDATE OF left_at OR
--     DELETE trigger ON public.layover_crew_members (a 2984 table: the ONE object 3872 put on a table it did not create);
--     and layover_propose_crew_plan(uuid, uuid, uuid, text, jsonb) (SECURITY INVOKER, EXECUTE for service_role only);
--   * seeded the flag layover_crew_split_plans_enabled FALSE (ON CONFLICT DO NOTHING).
-- It read and wrote no existing row. The only other row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: drops the member-gone trigger from public.layover_crew_members, drops the two tables (their indexes, constraints, policies, triggers, grants and the RI triggers their
-- foreign keys put on public.layover_crews, public.profiles and public.layover_sessions go with them) and the three
-- four functions, deletes the flag row and 3872's ledger row (so the runner re-applies 3872 later), and asks PostgREST to
-- reload its schema cache (delivered at the COMMIT). The catalog is then the one before 3872. No row of layover_crews,
-- layover_crew_members, layover_sessions or profiles is touched. With the flag row gone the API reads split plans as
-- absent, which is off: the crew card certifies the empty unsplit plan, exactly as before 3872.
--
-- DATA: IT REFUSES WHILE EITHER TABLE HOLDS A ROW. A row there is a crew's proposed itinerary (who is back when);
-- erasing it is the owner's decision, never a rollback's. To roll back anyway, after that decision: with the flag
-- FALSE, delete the rows deliberately and re-run this file. The emptiness check runs twice: before any strong lock, and
-- again after the two tables are locked, so a row written in between is not dropped either.
-- IT ALSO REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR THE FLAG (0118's foreign key from that log to
-- feature_flags is ON DELETE CASCADE, so deleting the flag row would silently erase who changed it and when).
--
-- Refuses, changing nothing, unless the installed state is exactly 3872's:
--   * the flag is TRUE (turn it off deliberately first), or the flag row is missing while 3872's objects stand;
--   * the flag audit log holds a row for the flag (above);
--   * 3872's objects are not each present exactly once;
--   * any table, column, constraint, index, trigger, policy, table privilege, comment, function body, function
--     attribute or EXECUTE privilege differs from 3872's own (the expected rows below, generated from 3872 applied on
--     the packet's replica, PostgreSQL 18.3; compared as THIS server deparses them, with search_path pinned);
--   * any object 3872 did not make depends on one of its tables or functions;
--   * a table holds a row (above).
-- If none of 3872's objects exists, it changes nothing and clears only the (already absent) ledger row: a second run is
-- a no-op, and it takes no lock on the referenced tables.
--
-- LOCK: ACCESS EXCLUSIVE on the two tables it drops, on public.layover_crew_members (DROP TRIGGER), and — inherent to removing a foreign key's RI triggers — on
-- public.layover_crews, public.profiles and public.layover_sessions, held until the COMMIT. Every check runs first under
-- ACCESS SHARE only; the strong-lock phase is catalog-only; lock_timeout = 5s makes a lock request that would queue
-- behind a long transaction fail instead. On a timeout the transaction aborts, nothing has changed, and the file can be
-- re-run. Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_audit   bigint;
  v_flags   int;
  v_on      text;
  v_tables  int;
  v_fns     int;
  v_rows    bigint;
  v_bad     text;
  v_dep     text;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3872 rollback): public.feature_flags and public.schema_migration_ledger must exist.';
  END IF;

  -- The flag row, locked so it cannot be turned on while this transaction runs.
  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_crew_split_plans_enabled' FOR UPDATE;
  SELECT count(*), string_agg(flag, ', ' ORDER BY flag) FILTER (WHERE enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags WHERE flag = 'layover_crew_split_plans_enabled';
  IF v_on IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3872): % is TRUE. Turn it off deliberately first, then re-run this file. Nothing was changed.', v_on;
  END IF;

  SELECT count(*) INTO v_tables FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('layover_crew_plans', 'layover_crew_plan_branches');
  SELECT count(*) INTO v_fns FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_crew_plan_guard', 'layover_crew_plan_branch_guard', 'layover_crew_plan_member_gone', 'layover_propose_crew_plan');

  IF v_tables = 0 AND v_fns = 0 AND v_flags = 0 THEN
    RAISE NOTICE '3872 rollback: none of 3872''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_tables <> 2 OR v_fns <> 4 OR v_flags <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3872): 3872''s objects are not each present exactly once (% of 2 tables, % of 4 functions, % of 1 flag row). 3872 creates them all in one transaction, so this state was made by hand. Nothing was changed.', v_tables, v_fns, v_flags;
  END IF;

  -- The flag's audit history: deleting the flag row would cascade to it (0118's foreign key is ON DELETE CASCADE).
  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag = 'layover_crew_split_plans_enabled';
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3872): public.feature_flag_audit_log holds % row(s) recording who turned layover_crew_split_plans_enabled on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;

  SELECT (SELECT count(*) FROM public.layover_crew_plans) + (SELECT count(*) FROM public.layover_crew_plan_branches) INTO v_rows;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3872): layover_crew_plans + layover_crew_plan_branches hold % row(s). They are crews'' proposed itineraries and exist nowhere else; erasing them is the owner''s decision, not a rollback''s (see the header). Nothing was changed.', v_rows;
  END IF;

  -- 3872's definition, exactly, as this server deparses it.
  WITH expected(k, v) AS (VALUES
-- expected:begin
    ('col:layover_crew_plan_branches.branch_key', '2|text|true||||'),
    ('col:layover_crew_plan_branches.member_user_ids', '4|uuid[]|true||||'),
    ('col:layover_crew_plan_branches.plan_id', '1|uuid|true||||'),
    ('col:layover_crew_plan_branches.position', '3|smallint|true||||'),
    ('col:layover_crew_plan_branches.return_by', '5|timestamp with time zone|true||||'),
    ('col:layover_crew_plan_branches.stops_json', '6|jsonb|true|''[]''::jsonb|||'),
    ('col:layover_crew_plans.created_at', '7|timestamp with time zone|true|now()|||'),
    ('col:layover_crew_plans.crew_id', '2|uuid|true||||'),
    ('col:layover_crew_plans.crew_version', '6|text|true||||'),
    ('col:layover_crew_plans.ended_at', '8|timestamp with time zone|false||||'),
    ('col:layover_crew_plans.id', '1|uuid|true|gen_random_uuid()|||'),
    ('col:layover_crew_plans.proposed_by', '3|uuid|true||||'),
    ('col:layover_crew_plans.proposed_session_id', '4|uuid|true||||'),
    ('col:layover_crew_plans.status', '5|text|true|''proposed''::text|||'),
    ('con:layover_crew_plan_branches.layover_crew_plan_branches_key_check', 'c|CHECK ((branch_key ~ ''^[a-z][a-z0-9_]{0,23}$''::text))|true|false|false'),
    ('con:layover_crew_plan_branches.layover_crew_plan_branches_members_check', 'c|CHECK ((((cardinality(member_user_ids) >= 1) AND (cardinality(member_user_ids) <= 12)) AND (array_position(member_user_ids, NULL::uuid) IS NULL)))|true|false|false'),
    ('con:layover_crew_plan_branches.layover_crew_plan_branches_pkey', 'p|PRIMARY KEY (plan_id, branch_key)|true|false|false'),
    ('con:layover_crew_plan_branches.layover_crew_plan_branches_plan_id_fkey', 'f|FOREIGN KEY (plan_id) REFERENCES public.layover_crew_plans(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_crew_plan_branches.layover_crew_plan_branches_position_check', 'c|CHECK ((("position" >= 0) AND ("position" <= 3)))|true|false|false'),
    ('con:layover_crew_plan_branches.layover_crew_plan_branches_position_unique', 'u|UNIQUE (plan_id, "position")|true|false|false'),
    ('con:layover_crew_plan_branches.layover_crew_plan_branches_stops_check', 'c|CHECK (((jsonb_typeof(stops_json) = ''array''::text) AND (jsonb_array_length(stops_json) <= 12)))|true|false|false'),
    ('con:layover_crew_plans.layover_crew_plans_crew_id_fkey', 'f|FOREIGN KEY (crew_id) REFERENCES public.layover_crews(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_crew_plans.layover_crew_plans_crew_version_check', 'c|CHECK (((char_length(crew_version) >= 1) AND (char_length(crew_version) <= 40)))|true|false|false'),
    ('con:layover_crew_plans.layover_crew_plans_ended_iff_not_proposed', 'c|CHECK (((status = ''proposed''::text) = (ended_at IS NULL)))|true|false|false'),
    ('con:layover_crew_plans.layover_crew_plans_pkey', 'p|PRIMARY KEY (id)|true|false|false'),
    ('con:layover_crew_plans.layover_crew_plans_proposed_by_fkey', 'f|FOREIGN KEY (proposed_by) REFERENCES public.profiles(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_crew_plans.layover_crew_plans_proposed_session_id_fkey', 'f|FOREIGN KEY (proposed_session_id) REFERENCES public.layover_sessions(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_crew_plans.layover_crew_plans_status_check', 'c|CHECK ((status = ANY (ARRAY[''proposed''::text, ''superseded''::text, ''withdrawn''::text])))|true|false|false'),
    ('fn:layover_crew_plan_branch_guard()', 'plpgsql|f|false|v|false|false|trigger|search_path=pg_catalog, public||4ae9aaf990d384850771b16829907512c6e10695be609648017cfaac8450618c|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:layover_crew_plan_guard()', 'plpgsql|f|false|v|false|false|trigger|search_path=pg_catalog, public||926d1067b8f84c68795d1e9659916c98ed7baff9c42de7f0e36842e7a768205e|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:layover_crew_plan_member_gone()', 'plpgsql|f|false|v|false|false|trigger|search_path=pg_catalog, public||81596844c07afcfef13c35006871263f2e3c4c5e4dd834c697821605cc7f88e9|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:layover_propose_crew_plan(uuid, uuid, uuid, text, jsonb)', 'plpgsql|f|false|v|false|false|uuid|search_path=pg_catalog, public|p_crew_id uuid, p_user_id uuid, p_session_id uuid, p_crew_version text, p_branches jsonb|4359f0e2b7c6ad25e16c090f812c93c8730118cf0615cd4df65fc266ab266218|d41d8cd98f00b204e9800998ecf8427e'),
    ('fx:layover_crew_plan_branch_guard()', '---s'),
    ('fx:layover_crew_plan_guard()', '---s'),
    ('fx:layover_crew_plan_member_gone()', '---s'),
    ('fx:layover_propose_crew_plan(uuid, uuid, uuid, text, jsonb)', '---s'),
    ('idx:layover_crew_plan_branches.layover_crew_plan_branches_pkey', 'CREATE UNIQUE INDEX layover_crew_plan_branches_pkey ON public.layover_crew_plan_branches USING btree (plan_id, branch_key)|true|true'),
    ('idx:layover_crew_plan_branches.layover_crew_plan_branches_position_unique', 'CREATE UNIQUE INDEX layover_crew_plan_branches_position_unique ON public.layover_crew_plan_branches USING btree (plan_id, "position")|true|true'),
    ('idx:layover_crew_plans.layover_crew_plans_one_live_idx', 'CREATE UNIQUE INDEX layover_crew_plans_one_live_idx ON public.layover_crew_plans USING btree (crew_id) WHERE (status = ''proposed''::text)|true|true'),
    ('idx:layover_crew_plans.layover_crew_plans_pkey', 'CREATE UNIQUE INDEX layover_crew_plans_pkey ON public.layover_crew_plans USING btree (id)|true|true'),
    ('idx:layover_crew_plans.layover_crew_plans_proposer_idx', 'CREATE INDEX layover_crew_plans_proposer_idx ON public.layover_crew_plans USING btree (proposed_by)|true|true'),
    ('idx:layover_crew_plans.layover_crew_plans_session_idx', 'CREATE INDEX layover_crew_plans_session_idx ON public.layover_crew_plans USING btree (proposed_session_id)|true|true'),
    ('pol:layover_crew_plan_branches.layover_crew_plan_branches_service', '*|true'),
    ('pol:layover_crew_plans.layover_crew_plans_service', '*|true'),
    ('priv:layover_crew_plan_branches.PUBLIC', ''),
    ('priv:layover_crew_plan_branches.anon', '--------'),
    ('priv:layover_crew_plan_branches.authenticated', '--------'),
    ('priv:layover_crew_plan_branches.service_role', 'siudtrgc'),
    ('priv:layover_crew_plans.PUBLIC', ''),
    ('priv:layover_crew_plans.anon', '--------'),
    ('priv:layover_crew_plans.authenticated', '--------'),
    ('priv:layover_crew_plans.service_role', 'siudtrgc'),
    ('rel:layover_crew_plan_branches', 'r|true|false|p|b27508f54ef5cd2b60fc9672eed42c07'),
    ('rel:layover_crew_plans', 'r|true|false|p|1ca877a9aaa33d5c85feb21e930874a9'),
    ('trg:layover_crew_members.layover_crew_plan_member_gone', 'CREATE TRIGGER layover_crew_plan_member_gone AFTER DELETE OR UPDATE OF left_at ON public.layover_crew_members FOR EACH ROW EXECUTE FUNCTION public.layover_crew_plan_member_gone()|O'),
    ('trg:layover_crew_plan_branches.layover_crew_plan_branch_guard', 'CREATE TRIGGER layover_crew_plan_branch_guard BEFORE INSERT OR UPDATE ON public.layover_crew_plan_branches FOR EACH ROW EXECUTE FUNCTION public.layover_crew_plan_branch_guard()|O'),
    ('trg:layover_crew_plans.layover_crew_plan_guard', 'CREATE TRIGGER layover_crew_plan_guard BEFORE INSERT OR UPDATE ON public.layover_crew_plans FOR EACH ROW EXECUTE FUNCTION public.layover_crew_plan_guard()|O')
-- expected:end
  ), actual(k, v) AS (
-- canon:begin
    WITH rel AS (
      SELECT c.oid, c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('layover_crew_plans', 'layover_crew_plan_branches')
    ), fn AS (
      SELECT p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_crew_plan_guard', 'layover_crew_plan_branch_guard', 'layover_crew_plan_member_gone', 'layover_propose_crew_plan')
    )
    SELECT 'rel:' || r.relname, c.relkind::text || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' || c.relpersistence::text
             || '|' || md5(coalesce(obj_description(c.oid, 'pg_class'), ''))
      FROM rel r JOIN pg_class c ON c.oid = r.oid
    UNION ALL
    SELECT 'col:' || r.relname || '.' || a.attname, a.attnum::text || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull
             || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || '|' || a.attidentity::text || a.attgenerated::text
             || '|' || coalesce(md5(col_description(r.oid, a.attnum)), '') || '|' || coalesce(a.attacl::text, '')
      FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum
    UNION ALL
    SELECT 'con:' || r.relname || '.' || k.conname, k.contype::text || '|' || pg_get_constraintdef(k.oid) || '|' || k.convalidated
             || '|' || k.condeferrable || '|' || k.condeferred
      FROM rel r JOIN pg_constraint k ON k.conrelid = r.oid WHERE k.contype <> 'n'
    UNION ALL
    SELECT 'idx:' || r.relname || '.' || ic.relname, pg_get_indexdef(i.indexrelid) || '|' || i.indisvalid || '|' || i.indisready
      FROM rel r JOIN pg_index i ON i.indrelid = r.oid JOIN pg_class ic ON ic.oid = i.indexrelid
    UNION ALL
    SELECT 'trg:' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal AND (t.tgrelid IN (SELECT oid FROM rel) OR t.tgfoid IN (SELECT oid FROM fn))
    UNION ALL
    SELECT 'pol:' || r.relname || '.' || p.polname, p.polcmd::text || '|' || p.polpermissive
      FROM rel r JOIN pg_policy p ON p.polrelid = r.oid
    UNION ALL
    SELECT 'priv:' || r.relname || '.' || g.role,
           (CASE WHEN has_table_privilege(g.role, r.oid, 'SELECT') THEN 's' ELSE '-' END)
        || (CASE WHEN has_table_privilege(g.role, r.oid, 'INSERT') THEN 'i' ELSE '-' END)
        || (CASE WHEN has_table_privilege(g.role, r.oid, 'UPDATE') THEN 'u' ELSE '-' END)
        || (CASE WHEN has_table_privilege(g.role, r.oid, 'DELETE') THEN 'd' ELSE '-' END)
        || (CASE WHEN has_table_privilege(g.role, r.oid, 'TRUNCATE') THEN 't' ELSE '-' END)
        || (CASE WHEN has_table_privilege(g.role, r.oid, 'REFERENCES') THEN 'r' ELSE '-' END)
        || (CASE WHEN has_table_privilege(g.role, r.oid, 'TRIGGER') THEN 'g' ELSE '-' END)
        || (CASE WHEN has_any_column_privilege(g.role, r.oid, 'SELECT, INSERT, UPDATE, REFERENCES') THEN 'c' ELSE '-' END)
      FROM rel r CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) g(role)
    UNION ALL
    SELECT 'priv:' || r.relname || '.PUBLIC',
           coalesce((SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type)
                       FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee = 0), '')
      FROM rel r JOIN pg_class c ON c.oid = r.oid
    UNION ALL
    SELECT 'fn:' || f.sig, l.lanname::text || '|' || p.prokind::text || '|' || p.prosecdef || '|' || p.provolatile::text || '|' || p.proisstrict
             || '|' || p.proretset || '|' || p.prorettype::regtype::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '')
             || '|' || pg_get_function_arguments(p.oid) || '|' || encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
             || '|' || md5(coalesce(obj_description(p.oid, 'pg_proc'), ''))
      FROM fn f JOIN pg_proc p ON p.oid = f.oid JOIN pg_language l ON l.oid = p.prolang
    UNION ALL
    SELECT 'fx:' || f.sig,
           (CASE WHEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN 'P' ELSE '-' END)
        || (CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'a' ELSE '-' END)
        || (CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'u' ELSE '-' END)
        || (CASE WHEN has_function_privilege('service_role', p.oid, 'EXECUTE') THEN 's' ELSE '-' END)
      FROM fn f JOIN pg_proc p ON p.oid = f.oid
-- canon:end
  )
  SELECT string_agg(coalesce(e.k, a.k), ', ' ORDER BY coalesce(e.k, a.k)) INTO v_bad
    FROM expected e FULL JOIN actual a ON a.k = e.k
   WHERE e.v IS DISTINCT FROM a.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3872): the installed objects are not 3872''s definition; these differ (missing, extra or changed): %. Nothing was changed.', left(v_bad, 1500);
  END IF;

  -- Nothing 3872 did not make may depend on its tables or its functions.
  WITH rel AS (
    SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('layover_crew_plans', 'layover_crew_plan_branches')
  ), fn AS (
    SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_crew_plan_guard', 'layover_crew_plan_branch_guard', 'layover_crew_plan_member_gone', 'layover_propose_crew_plan')
  ), con AS (
    SELECT k.oid FROM pg_constraint k WHERE k.conrelid IN (SELECT oid FROM rel)
  )
  SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), '; ') INTO v_dep
    FROM pg_depend d
   WHERE d.deptype IN ('n', 'a')
     AND ((d.refclassid = 'pg_class'::regclass AND d.refobjid IN (SELECT oid FROM rel))
       OR (d.refclassid = 'pg_proc'::regclass AND d.refobjid IN (SELECT oid FROM fn))
       OR (d.refclassid = 'pg_type'::regclass AND d.refobjid IN (SELECT c.reltype FROM pg_class c WHERE c.oid IN (SELECT oid FROM rel))))
     AND NOT ((d.classid = 'pg_class'::regclass
               AND (d.objid IN (SELECT oid FROM rel) OR d.objid IN (SELECT i.indexrelid FROM pg_index i WHERE i.indrelid IN (SELECT oid FROM rel))))
           OR (d.classid = 'pg_constraint'::regclass AND d.objid IN (SELECT oid FROM con))
           OR (d.classid = 'pg_attrdef'::regclass AND d.objid IN (SELECT ad.oid FROM pg_attrdef ad WHERE ad.adrelid IN (SELECT oid FROM rel)))
           OR (d.classid = 'pg_policy'::regclass AND d.objid IN (SELECT po.oid FROM pg_policy po WHERE po.polrelid IN (SELECT oid FROM rel)))
           OR (d.classid = 'pg_trigger'::regclass AND d.objid IN (
                 SELECT t.oid FROM pg_trigger t WHERE t.tgrelid IN (SELECT oid FROM rel) OR t.tgconstraint IN (SELECT oid FROM con) OR t.tgfoid IN (SELECT oid FROM fn))));
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3872): objects 3872 did not make depend on its tables or its functions: %. Nothing was changed.', left(v_dep, 1500);
  END IF;
END $pre$;

-- Row-level work first (no strong lock): the flag row and the ledger row. NOTIFY is delivered only at the COMMIT.
DELETE FROM public.feature_flags WHERE flag = 'layover_crew_split_plans_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3872_layover_crew_plans.sql';
NOTIFY pgrst, 'reload schema';

-- The strong-lock phase, catalog-only. Skipped entirely when nothing of 3872's exists ($pre$ refused every partial state).
DO $rb$
BEGIN
  IF to_regclass('public.layover_crew_plans') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE public.layover_crew_plans, public.layover_crew_plan_branches IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.layover_crew_plans) OR EXISTS (SELECT 1 FROM public.layover_crew_plan_branches) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3872): a row was written to a 3872 table while this file ran; nothing is dropped (see the header). Nothing was changed.';
  END IF;
  DROP TRIGGER layover_crew_plan_member_gone ON public.layover_crew_members;
  DROP TABLE public.layover_crew_plan_branches, public.layover_crew_plans;
  DROP FUNCTION public.layover_propose_crew_plan(uuid, uuid, uuid, text, jsonb);
  DROP FUNCTION public.layover_crew_plan_branch_guard();
  DROP FUNCTION public.layover_crew_plan_guard();
  DROP FUNCTION public.layover_crew_plan_member_gone();
END $rb$;

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_left FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('layover_crew_plans', 'layover_crew_plan_branches');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3872): % still exist(s).', v_left;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_left FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_crew_plan_guard', 'layover_crew_plan_branch_guard', 'layover_crew_plan_member_gone', 'layover_propose_crew_plan');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3872): % still exist(s).', v_left;
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_crew_split_plans_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3872): the 3872 flag row is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3872_layover_crew_plans.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3872): the ledger still records 3872 as applied.';
  END IF;
END $post$;
