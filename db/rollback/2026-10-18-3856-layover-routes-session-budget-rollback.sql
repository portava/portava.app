-- Rollback for 3856_layover_routes_session_budget.sql (LAYOVER 165, lane B1-R1; owner decision R5, 2026-10-18).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3856 DID (one transaction, additive):
--   * seeded the flag layover_routed_corridor_enabled FALSE (ON CONFLICT DO NOTHING);
--   * created two service-role-only tables (RLS on, no policy, every client privilege revoked, service_role SELECT),
--     with their indexes, constraints and table comments:
--       public.routes_api_layover_session_usage     PK session_id -> public.layover_sessions ON DELETE CASCADE,
--                                                   user_id -> auth.users ON DELETE CASCADE
--       public.routes_api_layover_user_daily_usage  PK (usage_day, user_id), user_id -> auth.users ON DELETE CASCADE
--   * created one function, public.routes_api_try_spend_layover(integer, bigint, bigint, uuid, uuid, integer, integer)
--     (SECURITY DEFINER, search_path pinned, EXECUTE for service_role only).
-- It read and wrote no existing row. The only other row its apply wrote is the applier's schema_migration_ledger row.
-- (A CALL of the function writes 3971's routes_api_daily_usage day row; that row is Trips' too and is never touched
-- here.)
--
-- WHAT THIS DOES: drops the function and the two tables (their indexes, constraints, comments, grants and the RI
-- triggers their foreign keys put on public.layover_sessions and auth.users go with them), deletes the flag row and
-- 3856's ledger row (so the runner re-applies 3856 later), and asks PostgREST to reload its schema cache (delivered
-- at the COMMIT). The catalog is then the one before 3856. No row of layover_sessions, auth.users or
-- routes_api_daily_usage is touched. With the flag row gone the API reads layover Routes as absent, which is off,
-- exactly as before 3856.
--
-- DATA: IT REFUSES WHILE EITHER TABLE HOLDS A ROW. A row there is a count of Google Routes calls already billed to a
-- session or a person; whether to erase it (and with it the record of what was spent against the owner's caps) is
-- the owner's decision, never a rollback's. To roll back anyway, after that decision: with the flag FALSE, delete
-- the rows deliberately and re-run this file. The emptiness check runs twice: before any strong lock, and again
-- after the two tables are locked, so a row written in between is not dropped either.
-- IT ALSO REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR THE FLAG. The admin toggle
-- (toggle_feature_flag_with_audit) writes one each time a flag is turned on or off, and 0118's foreign key from that
-- log to feature_flags is ON DELETE CASCADE, so deleting the flag row would silently erase who changed it and when.
-- Export or delete those audit rows deliberately first. (The flag row is locked FOR UPDATE first, so no toggle can
-- add one while this runs.)
--
-- Refuses, changing nothing, unless the installed state is exactly 3856's:
--   * the flag is TRUE (turn it off deliberately first), or the flag row is missing while 3856's objects stand;
--   * the flag audit log holds a row for the flag (above);
--   * 3856's objects are not each present exactly once (3856 creates them all in one transaction, so such a state
--     was made by hand);
--   * any table, column, constraint, index, table privilege, comment, function body, function attribute or EXECUTE
--     privilege differs from 3856's own (the expected rows below, generated from 3856 applied on the packet's
--     replica, PostgreSQL 18.3; compared as THIS server deparses them, with search_path pinned to pg_catalog);
--   * any object 3856 did not make depends on one of its tables or on its function;
--   * a table holds a row (above).
-- If none of 3856's objects exists, it changes nothing and clears only the (already absent) ledger row: a second
-- run is a no-op, and it takes no lock on public.layover_sessions or auth.users.
--
-- LOCK (measured on PGlite 0.5.8 = PostgreSQL 18.3 over the packet's replica; held until the COMMIT): ACCESS
-- EXCLUSIVE on public.layover_sessions and on auth.users, and on the two tables it drops. READS ARE BLOCKED on
-- layover_sessions and auth.users while it runs (every layover read, and every Supabase Auth read and write of a
-- user row). That is inherent to an exact undo: removing a foreign key's RI triggers from the referenced table takes
-- ACCESS EXCLUSIVE in PostgreSQL. To keep it short: every check runs first under ACCESS SHARE only; the strong-lock
-- phase is catalog-only (no scan); lock_timeout = 5s makes a lock request that would queue behind a long
-- transaction fail instead, so readers never wait behind this file for more than 5 s. On a timeout (or a deadlock
-- with an account erasure at the same moment) the transaction aborts, nothing has changed, and the file can be
-- re-run. Also: ROW SHARE on public.feature_flags (the flag row is locked FOR UPDATE) and ROW EXCLUSIVE on
-- schema_migration_ledger. Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

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
  v_n1      bigint;
  v_n2      bigint;
  v_bad     text;
  v_dep     text;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL
     OR to_regclass('public.layover_sessions') IS NULL OR to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3856 rollback): public.feature_flags, public.schema_migration_ledger, public.layover_sessions and auth.users must exist.';
  END IF;

  -- The flag row, locked so it cannot be turned on while this transaction runs.
  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_routed_corridor_enabled' FOR UPDATE;
  SELECT count(*), string_agg(flag, ', ' ORDER BY flag) FILTER (WHERE enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags WHERE flag = 'layover_routed_corridor_enabled';
  IF v_on IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3856): % is TRUE. The owner has turned layover Routes on since 3856 was applied; deleting the row would silently turn it off and dropping the tables would break the spend gate mid-flight (every layover Routes call would answer unavailable). Turn it off deliberately first, then re-run this file. Nothing was changed.', v_on;
  END IF;

  SELECT count(*) INTO v_tables FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('routes_api_layover_session_usage', 'routes_api_layover_user_daily_usage');
  SELECT count(*) INTO v_fns FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'routes_api_try_spend_layover';

  IF v_tables = 0 AND v_fns = 0 AND v_flags = 0 THEN
    RAISE NOTICE '3856 rollback: none of 3856''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_tables <> 2 OR v_fns <> 1 OR v_flags <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3856): 3856''s objects are not each present exactly once (% of 2 tables, % of 1 function, % of 1 flag row). 3856 creates them all in one transaction, so this state was made by hand. Nothing was changed.', v_tables, v_fns, v_flags;
  END IF;

  -- The flag's audit history: deleting the flag row would cascade to it (0118's foreign key is ON DELETE CASCADE).
  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag = 'layover_routed_corridor_enabled';
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3856): public.feature_flag_audit_log holds % row(s) recording who turned layover_routed_corridor_enabled on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;

  SELECT (SELECT count(*) FROM public.routes_api_layover_session_usage),
         (SELECT count(*) FROM public.routes_api_layover_user_daily_usage)
    INTO v_n1, v_n2;
  IF v_n1 + v_n2 > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3856): routes_api_layover_session_usage holds % row(s) and routes_api_layover_user_daily_usage %. They count Google Routes calls already billed against the owner''s layover caps, and they exist nowhere else; erasing them is the owner''s decision, not a rollback''s (see the header). Nothing was changed.', v_n1, v_n2;
  END IF;

  -- 3856's definition, exactly, as this server deparses it.
  WITH expected(k, v) AS (VALUES
-- expected:begin
    ('col:routes_api_layover_session_usage.calls', '3|integer|true|0|||'),
    ('col:routes_api_layover_session_usage.session_id', '1|uuid|true||||'),
    ('col:routes_api_layover_session_usage.updated_at', '4|timestamp with time zone|true|now()|||'),
    ('col:routes_api_layover_session_usage.user_id', '2|uuid|true||||'),
    ('col:routes_api_layover_user_daily_usage.calls', '3|integer|true|0|||'),
    ('col:routes_api_layover_user_daily_usage.updated_at', '4|timestamp with time zone|true|now()|||'),
    ('col:routes_api_layover_user_daily_usage.usage_day', '1|date|true||||'),
    ('col:routes_api_layover_user_daily_usage.user_id', '2|uuid|true||||'),
    ('con:routes_api_layover_session_usage.routes_api_layover_session_usage_calls_nonnegative', 'c|CHECK ((calls >= 0))|true|false|false'),
    ('con:routes_api_layover_session_usage.routes_api_layover_session_usage_pkey', 'p|PRIMARY KEY (session_id)|true|false|false'),
    ('con:routes_api_layover_session_usage.routes_api_layover_session_usage_session_id_fkey', 'f|FOREIGN KEY (session_id) REFERENCES public.layover_sessions(id) ON DELETE CASCADE|true|false|false'),
    ('con:routes_api_layover_session_usage.routes_api_layover_session_usage_user_id_fkey', 'f|FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE|true|false|false'),
    ('con:routes_api_layover_user_daily_usage.routes_api_layover_user_daily_usage_calls_nonnegative', 'c|CHECK ((calls >= 0))|true|false|false'),
    ('con:routes_api_layover_user_daily_usage.routes_api_layover_user_daily_usage_pkey', 'p|PRIMARY KEY (usage_day, user_id)|true|false|false'),
    ('con:routes_api_layover_user_daily_usage.routes_api_layover_user_daily_usage_user_id_fkey', 'f|FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE|true|false|false'),
    ('fn:routes_api_try_spend_layover(integer, bigint, bigint, uuid, uuid, integer, integer)', 'plpgsql|f|true|v|false|false|text|search_path=public, pg_catalog|p_quota integer, p_budget_micros bigint, p_cost_micros bigint, p_user_id uuid, p_session_id uuid, p_session_cap integer, p_user_daily_cap integer|f104ce213b365aad4864b3e1345501091ebc10fe1782afad3699c3b6ef06736b|7b429f48d1acee2ce75b2621073cf3d7'),
    ('fx:routes_api_try_spend_layover(integer, bigint, bigint, uuid, uuid, integer, integer)', '---s'),
    ('idx:routes_api_layover_session_usage.routes_api_layover_session_usage_pkey', 'CREATE UNIQUE INDEX routes_api_layover_session_usage_pkey ON public.routes_api_layover_session_usage USING btree (session_id)|true|true'),
    ('idx:routes_api_layover_session_usage.routes_api_layover_session_usage_user_idx', 'CREATE INDEX routes_api_layover_session_usage_user_idx ON public.routes_api_layover_session_usage USING btree (user_id)|true|true'),
    ('idx:routes_api_layover_user_daily_usage.routes_api_layover_user_daily_usage_pkey', 'CREATE UNIQUE INDEX routes_api_layover_user_daily_usage_pkey ON public.routes_api_layover_user_daily_usage USING btree (usage_day, user_id)|true|true'),
    ('idx:routes_api_layover_user_daily_usage.routes_api_layover_user_daily_usage_user_idx', 'CREATE INDEX routes_api_layover_user_daily_usage_user_idx ON public.routes_api_layover_user_daily_usage USING btree (user_id)|true|true'),
    ('priv:routes_api_layover_session_usage.PUBLIC', ''),
    ('priv:routes_api_layover_session_usage.anon', '--------'),
    ('priv:routes_api_layover_session_usage.authenticated', '--------'),
    ('priv:routes_api_layover_session_usage.service_role', 'siudtrgc'),
    ('priv:routes_api_layover_user_daily_usage.PUBLIC', ''),
    ('priv:routes_api_layover_user_daily_usage.anon', '--------'),
    ('priv:routes_api_layover_user_daily_usage.authenticated', '--------'),
    ('priv:routes_api_layover_user_daily_usage.service_role', 'siudtrgc'),
    ('rel:routes_api_layover_session_usage', 'r|true|false|p|c0b56387a5891e6ab17e2c0b563bdbd3'),
    ('rel:routes_api_layover_user_daily_usage', 'r|true|false|p|f6a91b842653db86743b296ac6227a94')
-- expected:end
  ), actual(k, v) AS (
-- canon:begin
    WITH rel AS (
      SELECT c.oid, c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('routes_api_layover_session_usage', 'routes_api_layover_user_daily_usage')
    ), fn AS (
      SELECT p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'routes_api_try_spend_layover'
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
    RAISE EXCEPTION 'ROLLBACK REFUSED (3856): the installed objects are not 3856''s definition; these differ (missing, extra or changed): %. Nothing was changed.', left(v_bad, 1500);
  END IF;

  -- Nothing 3856 did not make may depend on its tables or its function (DROP without CASCADE would refuse it anyway,
  -- but only after taking the strong locks; this refuses before any).
  WITH rel AS (
    SELECT c.oid FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname IN ('routes_api_layover_session_usage', 'routes_api_layover_user_daily_usage')
  ), fn AS (
    SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'routes_api_try_spend_layover'
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
           OR (d.classid = 'pg_trigger'::regclass AND d.objid IN (
                 SELECT t.oid FROM pg_trigger t WHERE t.tgrelid IN (SELECT oid FROM rel) OR t.tgconstraint IN (SELECT oid FROM con))));
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3856): objects 3856 did not make depend on its tables or its function: %. Nothing was changed.', left(v_dep, 1500);
  END IF;
END $pre$;

-- Row-level work first (no strong lock): the flag row and the ledger row. NOTIFY is delivered only at the COMMIT.
DELETE FROM public.feature_flags WHERE flag = 'layover_routed_corridor_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3856_layover_routes_session_budget.sql';
NOTIFY pgrst, 'reload schema';

-- The strong-lock phase, catalog-only. Skipped entirely when nothing of 3856's exists ($pre$ refused every
-- partial state).
DO $rb$
BEGIN
  IF to_regclass('public.routes_api_layover_session_usage') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE public.routes_api_layover_session_usage, public.routes_api_layover_user_daily_usage IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.routes_api_layover_session_usage) OR EXISTS (SELECT 1 FROM public.routes_api_layover_user_daily_usage) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3856): a row was written to a 3856 table while this file ran; nothing is dropped (see the header). Nothing was changed.';
  END IF;
  DROP FUNCTION public.routes_api_try_spend_layover(integer, bigint, bigint, uuid, uuid, integer, integer);
  DROP TABLE public.routes_api_layover_session_usage, public.routes_api_layover_user_daily_usage;
END $rb$;

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_left FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('routes_api_layover_session_usage', 'routes_api_layover_user_daily_usage');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3856): % still exist(s).', v_left;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'routes_api_try_spend_layover') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3856): routes_api_try_spend_layover still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE contype = 'f' AND confrelid IN ('auth.users'::regclass, 'public.layover_sessions'::regclass)
                AND conname LIKE 'routes\_api\_layover\_%') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3856): a 3856 foreign key into auth.users or public.layover_sessions survived.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_routed_corridor_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3856): the 3856 flag row is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3856_layover_routes_session_budget.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3856): the ledger still records 3856 as applied.';
  END IF;
END $post$;
