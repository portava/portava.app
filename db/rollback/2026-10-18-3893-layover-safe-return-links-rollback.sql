-- Rollback 3893_layover_safe_return_links.sql. No remote database applied by this lane.
-- Refuses: flag ON; flag audit history; data; missing/extra/drifted objects; external dependents.
-- Table rows are never deleted. Empty installed state restores the prior catalog; second run is a no-op.
-- Removes the link table, its three guard functions, and the two triggers on safe_return_sessions.
-- ACCESS EXCLUSIVE locks are held only in the final catalog phase; lock_timeout 5 seconds.
-- Proven on the full local migrated schema, both sorted-gap and after-3999 order (see lane handback).
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
    RAISE EXCEPTION 'PRECONDITION FAILED (3893 rollback): public.feature_flags and public.schema_migration_ledger must exist.';
  END IF;

  -- The flag row, locked so it cannot be turned on while this transaction runs.
  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_safe_return_product_enabled' FOR UPDATE;
  SELECT count(*), string_agg(flag, ', ' ORDER BY flag) FILTER (WHERE enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags WHERE flag = 'layover_safe_return_product_enabled';
  IF v_on IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3893): % is TRUE. Turn it off deliberately first, then re-run this file. Nothing was changed.', v_on;
  END IF;

  SELECT count(*) INTO v_tables FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('layover_safe_return_links');
  SELECT count(*) INTO v_fns FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_safe_return_link_guard','layover_safe_return_timer_guard','layover_safe_return_started');

  IF v_tables = 0 AND v_fns = 0 AND v_flags = 0 THEN
    RAISE NOTICE '3893 rollback: none of 3893''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_tables <> 1 OR v_fns <> 3 OR v_flags <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3893): 3893''s objects are not each present exactly once (% of 1 tables, % of 3 functions, % of 1 flag row). 3893 creates them all in one transaction, so this state was made by hand. Nothing was changed.', v_tables, v_fns, v_flags;
  END IF;

  -- The flag's audit history: deleting the flag row would cascade to it (0118's foreign key is ON DELETE CASCADE).
  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag = 'layover_safe_return_product_enabled';
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3893): public.feature_flag_audit_log holds % row(s) recording who turned layover_safe_return_product_enabled on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;

  SELECT (SELECT count(*) FROM public.layover_safe_return_links) INTO v_rows;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3893): layover_safe_return_links holds % row(s). They bind certified return timers and exist nowhere else; erasing them is the owner''s decision, not a rollback''s (see the header). Nothing was changed.', v_rows;
  END IF;

  -- 3893's definition, exactly, as this server deparses it.
  WITH expected(k, v) AS (VALUES
-- expected:begin
    ('acl:fn:layover_safe_return_link_guard()', 'service_role:EXECUTE:false'),
    ('acl:fn:layover_safe_return_started()', 'service_role:EXECUTE:false'),
    ('acl:fn:layover_safe_return_timer_guard()', 'service_role:EXECUTE:false'),
    ('acl:rel:layover_safe_return_links', 'service_role:DELETE:false,service_role:INSERT:false,service_role:MAINTAIN:false,service_role:REFERENCES:false,service_role:SELECT:false,service_role:TRIGGER:false,service_role:TRUNCATE:false,service_role:UPDATE:false'),
    ('col:layover_safe_return_links.certification', '5|jsonb|true||||'),
    ('col:layover_safe_return_links.certified_deadline', '4|timestamp with time zone|true||||'),
    ('col:layover_safe_return_links.created_at', '6|timestamp with time zone|true|now()|||'),
    ('col:layover_safe_return_links.layover_session_id', '1|uuid|true||||'),
    ('col:layover_safe_return_links.return_started_at', '7|timestamp with time zone|false||||'),
    ('col:layover_safe_return_links.safe_return_session_id', '2|uuid|true||||'),
    ('col:layover_safe_return_links.user_id', '3|uuid|true||||'),
    ('con:layover_safe_return_links.layover_safe_return_links_certification_check', 'c|CHECK ((jsonb_typeof(certification) = ''object''::text))|true|false|false'),
    ('con:layover_safe_return_links.layover_safe_return_links_layover_session_id_fkey', 'f|FOREIGN KEY (layover_session_id) REFERENCES public.layover_sessions(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_safe_return_links.layover_safe_return_links_pkey', 'p|PRIMARY KEY (layover_session_id)|true|false|false'),
    ('con:layover_safe_return_links.layover_safe_return_links_safe_return_session_id_fkey', 'f|FOREIGN KEY (safe_return_session_id) REFERENCES public.safe_return_sessions(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_safe_return_links.layover_safe_return_links_safe_return_session_id_key', 'u|UNIQUE (safe_return_session_id)|true|false|false'),
    ('con:layover_safe_return_links.layover_safe_return_links_user_id_fkey', 'f|FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE|true|false|false'),
    ('fn:layover_safe_return_link_guard()', 'plpgsql|f|true|v|false|false|trigger|search_path=pg_catalog, public||ebb336772e0b4104a421c981a30b5e365aa6be407267f53d846e1ae5aed14884|d41d8cd98f00b204e9800998ecf8427e|100|0|u|false|-'),
    ('fn:layover_safe_return_started()', 'plpgsql|f|true|v|false|false|trigger|search_path=pg_catalog, public||6ed1e767c6face87c57c69966b6cc360e0062533d1ca5c6e73d8c359e666b19c|d41d8cd98f00b204e9800998ecf8427e|100|0|u|false|-'),
    ('fn:layover_safe_return_timer_guard()', 'plpgsql|f|true|v|false|false|trigger|search_path=pg_catalog, public||cc20f501482faa1fa262f766976de7e1b7109683f5103b111a2314e61b078dec|d41d8cd98f00b204e9800998ecf8427e|100|0|u|false|-'),
    ('fx:layover_safe_return_link_guard()', '---s'),
    ('fx:layover_safe_return_started()', '---s'),
    ('fx:layover_safe_return_timer_guard()', '---s'),
    ('idx:layover_safe_return_links.layover_safe_return_links_pkey', 'CREATE UNIQUE INDEX layover_safe_return_links_pkey ON public.layover_safe_return_links USING btree (layover_session_id)|true|true'),
    ('idx:layover_safe_return_links.layover_safe_return_links_safe_return_session_id_key', 'CREATE UNIQUE INDEX layover_safe_return_links_safe_return_session_id_key ON public.layover_safe_return_links USING btree (safe_return_session_id)|true|true'),
    ('idx:layover_safe_return_links.layover_safe_return_links_started_idx', 'CREATE INDEX layover_safe_return_links_started_idx ON public.layover_safe_return_links USING btree (return_started_at) WHERE (return_started_at IS NOT NULL)|true|true'),
    ('idx:layover_safe_return_links.layover_safe_return_links_user_idx', 'CREATE INDEX layover_safe_return_links_user_idx ON public.layover_safe_return_links USING btree (user_id)|true|true'),
    ('pol:layover_safe_return_links.layover_safe_return_links_service_only', '*|true|service_role|true|true'),
    ('priv:layover_safe_return_links.PUBLIC', ''),
    ('priv:layover_safe_return_links.anon', '--------'),
    ('priv:layover_safe_return_links.authenticated', '--------'),
    ('priv:layover_safe_return_links.service_role', 'siudtrgc'),
    ('rel:layover_safe_return_links', 'r|true|false|p|d41d8cd98f00b204e9800998ecf8427e'),
    ('trg:layover_safe_return_links.layover_safe_return_link_guard', 'CREATE TRIGGER layover_safe_return_link_guard BEFORE INSERT OR UPDATE ON public.layover_safe_return_links FOR EACH ROW EXECUTE FUNCTION public.layover_safe_return_link_guard()|O'),
    ('trg:safe_return_sessions.layover_safe_return_started', 'CREATE TRIGGER layover_safe_return_started AFTER UPDATE ON public.safe_return_sessions FOR EACH ROW EXECUTE FUNCTION public.layover_safe_return_started()|O'),
    ('trg:safe_return_sessions.layover_safe_return_timer_guard', 'CREATE TRIGGER layover_safe_return_timer_guard BEFORE DELETE OR UPDATE ON public.safe_return_sessions FOR EACH ROW EXECUTE FUNCTION public.layover_safe_return_timer_guard()|O')
-- expected:end
  ), actual(k, v) AS (
-- canon:begin
    WITH rel AS (
      SELECT c.oid, c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('layover_safe_return_links')
    ), fn AS (
      SELECT p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_safe_return_link_guard','layover_safe_return_timer_guard','layover_safe_return_started')
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
    SELECT 'pol:' || r.relname || '.' || p.polname, p.polcmd::text || '|' || p.polpermissive || '|' || (SELECT string_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END,',' ORDER BY role_oid) FROM unnest(p.polroles) role_oid) || '|' || coalesce(pg_get_expr(p.polqual,p.polrelid),'') || '|' || coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')
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
             || '|' || md5(coalesce(obj_description(p.oid, 'pg_proc'), '')) || '|' || p.procost || '|' || p.prorows || '|' || p.proparallel::text || '|' || p.proleakproof || '|' || p.prosupport::regproc::text
      FROM fn f JOIN pg_proc p ON p.oid = f.oid JOIN pg_language l ON l.oid = p.prolang
    UNION ALL
    SELECT 'fx:' || f.sig,
           (CASE WHEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN 'P' ELSE '-' END)
        || (CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'a' ELSE '-' END)
        || (CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'u' ELSE '-' END)
        || (CASE WHEN has_function_privilege('service_role', p.oid, 'EXECUTE') THEN 's' ELSE '-' END)
      FROM fn f JOIN pg_proc p ON p.oid = f.oid
    UNION ALL
    SELECT 'acl:rel:' || r.relname, coalesce((SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type || ':' || a.is_grantable,',' ORDER BY a.grantee,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner),'') FROM rel r JOIN pg_class c ON c.oid=r.oid
    UNION ALL
    SELECT 'acl:fn:' || f.sig, coalesce((SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type || ':' || a.is_grantable,',' ORDER BY a.grantee,a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner),'') FROM fn f JOIN pg_proc p ON p.oid=f.oid
-- canon:end
  )
  SELECT string_agg(coalesce(e.k, a.k), ', ' ORDER BY coalesce(e.k, a.k)) INTO v_bad
    FROM expected e FULL JOIN actual a ON a.k = e.k
   WHERE e.v IS DISTINCT FROM a.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3893): the installed objects are not 3893''s definition; these differ (missing, extra or changed): %. Nothing was changed.', left(v_bad, 1500);
  END IF;

  -- Nothing 3893 did not make may depend on its tables or its functions.
  WITH rel AS (
    SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('layover_safe_return_links')
  ), fn AS (
    SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_safe_return_link_guard','layover_safe_return_timer_guard','layover_safe_return_started')
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
    RAISE EXCEPTION 'ROLLBACK REFUSED (3893): objects 3893 did not make depend on its tables or its functions: %. Nothing was changed.', left(v_dep, 1500);
  END IF;
END $pre$;

-- Row-level work first (no strong lock): the flag row and the ledger row. NOTIFY is delivered only at the COMMIT.
DELETE FROM public.feature_flags WHERE flag = 'layover_safe_return_product_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3893_layover_safe_return_links.sql';
NOTIFY pgrst, 'reload schema';

-- The strong-lock phase, catalog-only. Skipped entirely when nothing of 3893's exists ($pre$ refused every partial state).
DO $rb$
BEGIN
  IF to_regclass('public.layover_safe_return_links') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE public.layover_safe_return_links IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.layover_safe_return_links) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3893): a row was written to a 3893 table while this file ran; nothing is dropped (see the header). Nothing was changed.';
  END IF;
  DROP TRIGGER layover_safe_return_timer_guard ON public.safe_return_sessions;
  DROP TRIGGER layover_safe_return_started ON public.safe_return_sessions;
  DROP TABLE public.layover_safe_return_links;
  DROP FUNCTION public.layover_safe_return_link_guard();
  DROP FUNCTION public.layover_safe_return_timer_guard();
  DROP FUNCTION public.layover_safe_return_started();
END $rb$;

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_left FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('layover_safe_return_links');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3893): % still exist(s).', v_left;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_left FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_safe_return_link_guard','layover_safe_return_timer_guard','layover_safe_return_started');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3893): % still exist(s).', v_left;
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_safe_return_product_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3893): the 3893 flag row is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3893_layover_safe_return_links.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3893): the ledger still records 3893 as applied.';
  END IF;
END $post$;
