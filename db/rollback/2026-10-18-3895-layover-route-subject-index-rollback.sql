-- Rollback 3895: preserve active routing, historical flag audit, data, and later catalog work.
-- The expected catalog is measured on the full isolated migration chain, using role names.
-- Refuses partial installations, grants, column ACLs, function/trigger/policy drift and dependents.
-- No CASCADE. Empty-state rollback is repeatable; deletion is never a data-recovery strategy.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$
DECLARE objects integer; flags integer; changed text;
BEGIN
  IF to_regclass('public.layover_route_dispatches') IS NOT NULL OR to_regclass('public.layover_route_work') IS NOT NULL OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('layover_route_fanout_ready','layover_route_watch_state','layover_route_fanout_claim','layover_route_fanout_retry','layover_route_fanout_settle')) THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3895): retire dependent3908 first';END IF;
  PERFORM 1 FROM public.feature_flags WHERE flag='layover_route_subjects_enabled' FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_route_subjects_enabled' AND enabled IS NOT FALSE)
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3895): flag is enabled'; END IF;
  IF EXISTS(SELECT 1 FROM public.feature_flag_audit_log WHERE flag='layover_route_subjects_enabled')
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3895): flag audit history exists'; END IF;
  SELECT (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname='layover_route_subjects')
    +(SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('layover_recommendation_route_watch','layover_active_sessions_by_routes','layover_stop_route_watch')) INTO objects;
  SELECT count(*) INTO flags FROM public.feature_flags WHERE flag='layover_route_subjects_enabled';
  IF objects=0 AND flags=0 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('layover_recommendation_route_watch','layover_stop_route_watch')) THEN RETURN; END IF;
  IF objects<>4 OR flags<>1 THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3895): incomplete route subject installation'; END IF;
  LOCK TABLE public.layover_route_subjects IN ACCESS EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM public.layover_route_subjects)
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3895): route dependency evidence exists'; END IF;
  WITH expected(k,v) AS (VALUES
-- expected:begin
    ('acl:fn:layover_active_sessions_by_routes(text[], timestamp with time zone, integer)', 'service_role:EXECUTE:false'),
    ('acl:fn:layover_recommendation_route_watch()', ''),
    ('acl:fn:layover_stop_route_watch()', ''),
    ('acl:rel:layover_route_subjects', 'service_role:SELECT:false'),
    ('col:layover_route_subjects.created_at', '8|timestamp with time zone|true|clock_timestamp()|||'),
    ('col:layover_route_subjects.id', '1|uuid|true|gen_random_uuid()|||'),
    ('col:layover_route_subjects.recommendation_id', '5|uuid|false||||'),
    ('col:layover_route_subjects.route_ref', '7|text|true||||'),
    ('col:layover_route_subjects.session_id', '2|uuid|true||||'),
    ('col:layover_route_subjects.snapshot_id', '4|text|true||||'),
    ('col:layover_route_subjects.stop_id', '6|uuid|false||||'),
    ('col:layover_route_subjects.user_id', '3|uuid|true||||'),
    ('con:layover_route_subjects.layover_route_subject_source', 'c|CHECK (((((recommendation_id IS NOT NULL))::integer + ((stop_id IS NOT NULL))::integer) = 1))|true|false|false'),
    ('con:layover_route_subjects.layover_route_subjects_pkey', 'p|PRIMARY KEY (id)|true|false|false'),
    ('con:layover_route_subjects.layover_route_subjects_recommendation_id_fkey', 'f|FOREIGN KEY (recommendation_id) REFERENCES public.layover_recommendations(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_route_subjects.layover_route_subjects_route_ref_check', 'c|CHECK ((route_ref ~ ''^layover-route:v1:[a-f0-9]{64}$''::text))|true|false|false'),
    ('con:layover_route_subjects.layover_route_subjects_session_id_fkey', 'f|FOREIGN KEY (session_id) REFERENCES public.layover_sessions(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_route_subjects.layover_route_subjects_snapshot_id_check', 'c|CHECK ((length(snapshot_id) > 0))|true|false|false'),
    ('con:layover_route_subjects.layover_route_subjects_stop_id_fkey', 'f|FOREIGN KEY (stop_id) REFERENCES public.layover_plan_stops(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_route_subjects.layover_route_subjects_user_id_fkey', 'f|FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE|true|false|false'),
    ('fn:layover_active_sessions_by_routes(text[], timestamp with time zone, integer)', 'plpgsql|f|false|v|false|false|jsonb|search_path=pg_catalog, public|p_refs text[], p_now timestamp with time zone, p_limit integer|3d1d15907e194c22cb810edd45e192ac3c137acdf18e72a963d389ead0aecd9a|d41d8cd98f00b204e9800998ecf8427e|100|0|u|false|-'),
    ('fn:layover_recommendation_route_watch()', 'plpgsql|f|true|v|false|false|trigger|search_path=pg_catalog, public||8e22b25456313ac56d3a19b28fc3f9db95fc1218adc3f09777b4c8371e494c53|d41d8cd98f00b204e9800998ecf8427e|100|0|u|false|-'),
    ('fn:layover_stop_route_watch()', 'plpgsql|f|true|v|false|false|trigger|search_path=pg_catalog, public||92ad1df41efbca47011f39c94a41ce778dcc10ffe95064dbb25c2117ee474bf3|d41d8cd98f00b204e9800998ecf8427e|100|0|u|false|-'),
    ('fx:layover_active_sessions_by_routes(text[], timestamp with time zone, integer)', '---s'),
    ('fx:layover_recommendation_route_watch()', '----'),
    ('fx:layover_stop_route_watch()', '----'),
    ('idx:layover_route_subjects.layover_route_subjects_owner_idx', 'CREATE INDEX layover_route_subjects_owner_idx ON public.layover_route_subjects USING btree (user_id)|true|true'),
    ('idx:layover_route_subjects.layover_route_subjects_pkey', 'CREATE UNIQUE INDEX layover_route_subjects_pkey ON public.layover_route_subjects USING btree (id)|true|true'),
    ('idx:layover_route_subjects.layover_route_subjects_recommendation_idx', 'CREATE UNIQUE INDEX layover_route_subjects_recommendation_idx ON public.layover_route_subjects USING btree (recommendation_id, route_ref) WHERE (recommendation_id IS NOT NULL)|true|true'),
    ('idx:layover_route_subjects.layover_route_subjects_route_idx', 'CREATE INDEX layover_route_subjects_route_idx ON public.layover_route_subjects USING btree (route_ref, session_id)|true|true'),
    ('idx:layover_route_subjects.layover_route_subjects_session_idx', 'CREATE INDEX layover_route_subjects_session_idx ON public.layover_route_subjects USING btree (session_id)|true|true'),
    ('idx:layover_route_subjects.layover_route_subjects_stop_idx', 'CREATE UNIQUE INDEX layover_route_subjects_stop_idx ON public.layover_route_subjects USING btree (stop_id, route_ref) WHERE (stop_id IS NOT NULL)|true|true'),
    ('priv:layover_route_subjects.PUBLIC', ''),
    ('priv:layover_route_subjects.anon', '--------'),
    ('priv:layover_route_subjects.authenticated', '--------'),
    ('priv:layover_route_subjects.service_role', 's------c'),
    ('rel:layover_route_subjects', 'r|true|false|p|187fb7ee8e22ad203504c329d0fe1cfe'),
    ('trg:layover_plan_stops.layover_stop_route_watch', 'CREATE TRIGGER layover_stop_route_watch AFTER INSERT OR UPDATE ON public.layover_plan_stops FOR EACH ROW EXECUTE FUNCTION public.layover_stop_route_watch()|O'),
    ('trg:layover_recommendations.layover_recommendation_route_watch', 'CREATE TRIGGER layover_recommendation_route_watch AFTER INSERT OR UPDATE ON public.layover_recommendations FOR EACH ROW EXECUTE FUNCTION public.layover_recommendation_route_watch()|O')
-- expected:end
  ), actual(k,v) AS (
-- canon:begin
    WITH rel AS (
      SELECT c.oid, c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('layover_route_subjects')
    ), fn AS (
      SELECT p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_recommendation_route_watch','layover_active_sessions_by_routes','layover_stop_route_watch')
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
    SELECT 'pol:' || r.relname || '.' || p.polname, p.polcmd::text || '|' || p.polpermissive || '|' || (SELECT string_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END,',' ORDER BY CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END) FROM unnest(p.polroles) role_oid) || '|' || coalesce(pg_get_expr(p.polqual,p.polrelid),'') || '|' || coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')
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
    SELECT 'acl:rel:' || r.relname, coalesce((SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type || ':' || a.is_grantable,',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner),'') FROM rel r JOIN pg_class c ON c.oid=r.oid
    UNION ALL
    SELECT 'acl:fn:' || f.sig, coalesce((SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type || ':' || a.is_grantable,',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner),'') FROM fn f JOIN pg_proc p ON p.oid=f.oid
-- canon:end
  ) SELECT string_agg(coalesce(e.k,a.k),', ' ORDER BY coalesce(e.k,a.k)) INTO changed
  FROM expected e FULL JOIN actual a ON a.k=e.k WHERE e.v IS DISTINCT FROM a.v;
  IF changed IS NOT NULL THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3895): catalog definition changed: %',left(changed,1500); END IF;
END $pre$;
DROP TRIGGER IF EXISTS layover_recommendation_route_watch ON public.layover_recommendations;
DROP TRIGGER IF EXISTS layover_stop_route_watch ON public.layover_plan_stops;
DROP FUNCTION IF EXISTS public.layover_active_sessions_by_routes(text[],timestamptz,integer);
DROP FUNCTION IF EXISTS public.layover_stop_route_watch();
DROP TABLE IF EXISTS public.layover_route_subjects;
DROP FUNCTION IF EXISTS public.layover_recommendation_route_watch();
DELETE FROM public.feature_flags WHERE flag='layover_route_subjects_enabled' AND enabled IS FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename='3895_layover_route_subject_index.sql';
DO $post$ BEGIN
  IF to_regclass('public.layover_route_subjects') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('layover_recommendation_route_watch','layover_active_sessions_by_routes','layover_stop_route_watch'))
    OR EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_route_subjects_enabled')
    THEN RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3895): route subject objects remain'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
