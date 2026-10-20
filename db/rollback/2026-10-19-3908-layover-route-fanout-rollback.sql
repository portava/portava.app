-- Rollback3908: empty inactive capability only. Retain work, dispatch history,
-- flag audit history and all later changes. No CASCADE; portable role names and
-- column attnotnull (not PostgreSQL18-only NOT NULL constraint rows).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$
DECLARE objects integer;flags integer;changed text;
BEGIN
 PERFORM 1 FROM public.feature_flags WHERE flag='layover_route_fanout_enabled' FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_route_fanout_enabled' AND enabled IS DISTINCT FROM false) THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3908): flag is enabled';END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flag_audit_log WHERE flag='layover_route_fanout_enabled') THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3908): flag audit history exists';END IF;
 SELECT (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN('layover_route_dispatches','layover_route_work'))+(SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('layover_route_fanout_ready','layover_route_watch_state','layover_route_fanout_claim','layover_route_fanout_retry','layover_route_fanout_settle')) INTO objects;
 SELECT count(*) INTO flags FROM public.feature_flags WHERE flag='layover_route_fanout_enabled';
 IF objects=0 AND flags=0 THEN RETURN;END IF;
 IF objects<>7 OR flags<>1 THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3908): incomplete installation';END IF;
 LOCK TABLE public.layover_route_dispatches,public.layover_route_work IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM public.layover_route_dispatches) OR EXISTS(SELECT 1 FROM public.layover_route_work) THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3908): route work evidence exists';END IF;
 WITH expected(k,v) AS (VALUES
-- expected:begin
    ('acl:fn:layover_route_fanout_claim(integer)', 'service_role:EXECUTE:false'),
    ('acl:fn:layover_route_fanout_ready()', ''),
    ('acl:fn:layover_route_fanout_retry(text, uuid, uuid, text)', 'service_role:EXECUTE:false'),
    ('acl:fn:layover_route_fanout_settle(text, uuid, uuid, text, text, jsonb)', 'service_role:EXECUTE:false'),
    ('acl:fn:layover_route_watch_state(text, uuid, uuid)', ''),
    ('acl:rel:layover_route_dispatches', 'service_role:SELECT:false'),
    ('acl:rel:layover_route_work', 'service_role:SELECT:false'),
    ('col:layover_route_dispatches.after_session_id', '2|uuid|false||||'),
    ('col:layover_route_dispatches.event_id', '1|text|true||||'),
    ('col:layover_route_dispatches.scan_complete', '3|boolean|true|false|||'),
    ('col:layover_route_dispatches.updated_at', '4|timestamp with time zone|true|clock_timestamp()|||'),
    ('col:layover_route_work.attempts', '6|integer|true|0|||'),
    ('col:layover_route_work.created_at', '12|timestamp with time zone|true|clock_timestamp()|||'),
    ('col:layover_route_work.event_id', '2|text|true||||'),
    ('col:layover_route_work.id', '1|uuid|true|gen_random_uuid()|||'),
    ('col:layover_route_work.lease_token', '8|uuid|false||||'),
    ('col:layover_route_work.lease_until', '9|timestamp with time zone|false||||'),
    ('col:layover_route_work.next_attempt_at', '7|timestamp with time zone|true|clock_timestamp()|||'),
    ('col:layover_route_work.reason', '10|text|false||||'),
    ('col:layover_route_work.session_id', '3|uuid|true||||'),
    ('col:layover_route_work.settled_at', '13|timestamp with time zone|false||||'),
    ('col:layover_route_work.snapshot_id', '11|text|false||||'),
    ('col:layover_route_work.state', '5|text|true|''pending''::text|||'),
    ('col:layover_route_work.user_id', '4|uuid|true||||'),
    ('con:layover_route_dispatches.layover_route_dispatches_after_session_id_fkey', 'f|FOREIGN KEY (after_session_id) REFERENCES public.layover_sessions(id) ON DELETE SET NULL|true|false|false'),
    ('con:layover_route_dispatches.layover_route_dispatches_event_id_fkey', 'f|FOREIGN KEY (event_id) REFERENCES public.layover_external_events(event_id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_route_dispatches.layover_route_dispatches_pkey', 'p|PRIMARY KEY (event_id)|true|false|false'),
    ('con:layover_route_work.layover_route_work_attempts_check', 'c|CHECK ((attempts >= 0))|true|false|false'),
    ('con:layover_route_work.layover_route_work_check', 'c|CHECK (((state = ''leased''::text) = ((lease_token IS NOT NULL) AND (lease_until IS NOT NULL))))|true|false|false'),
    ('con:layover_route_work.layover_route_work_check1', 'c|CHECK (((state = ANY (ARRAY[''done''::text, ''obsolete''::text])) = (settled_at IS NOT NULL)))|true|false|false'),
    ('con:layover_route_work.layover_route_work_event_id_fkey', 'f|FOREIGN KEY (event_id) REFERENCES public.layover_external_events(event_id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_route_work.layover_route_work_event_id_session_id_key', 'u|UNIQUE (event_id, session_id)|true|false|false'),
    ('con:layover_route_work.layover_route_work_pkey', 'p|PRIMARY KEY (id)|true|false|false'),
    ('con:layover_route_work.layover_route_work_reason_check', 'c|CHECK (((reason IS NULL) OR (reason ~ ''^[a-z][a-z0-9_]{1,100}$''::text)))|true|false|false'),
    ('con:layover_route_work.layover_route_work_session_id_fkey', 'f|FOREIGN KEY (session_id) REFERENCES public.layover_sessions(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_route_work.layover_route_work_state_check', 'c|CHECK ((state = ANY (ARRAY[''pending''::text, ''leased''::text, ''retry''::text, ''done''::text, ''obsolete''::text])))|true|false|false'),
    ('con:layover_route_work.layover_route_work_user_id_fkey', 'f|FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE|true|false|false'),
    ('fn:layover_route_fanout_claim(integer)', 'plpgsql|f|true|v|false|false|jsonb|search_path=pg_catalog, public|p_limit integer DEFAULT 200|3a666408e0c639308c7d4ef22b71a8b8caedf7f1fd7c2fbf1c12d9f40594a7ba|d41d8cd98f00b204e9800998ecf8427e|100|0|u|false|-'),
    ('fn:layover_route_fanout_ready()', 'sql|f|true|s|false|false|boolean|search_path=pg_catalog, public||316c4fc3219b67443230b29a3cd83304412e462c74e1da098aa4209deda4718f|d41d8cd98f00b204e9800998ecf8427e|100|0|u|false|-'),
    ('fn:layover_route_fanout_retry(text, uuid, uuid, text)', 'plpgsql|f|true|v|false|false|boolean|search_path=pg_catalog, public|p_event text, p_session uuid, p_token uuid, p_reason text|bc8ba7f12c76a636abd51fe09d47d18fdd216e1caafabf792a642d3468c9539d|d41d8cd98f00b204e9800998ecf8427e|100|0|u|false|-'),
    ('fn:layover_route_fanout_settle(text, uuid, uuid, text, text, jsonb)', 'plpgsql|f|true|v|false|false|jsonb|search_path=pg_catalog, public|p_event text, p_session uuid, p_token uuid, p_session_revision text, p_route_revision text, p_payload jsonb|8ad75acb30d6972493c11264ec13e981c0ef468d69c8d04f84e6c1ba1fd4113b|d41d8cd98f00b204e9800998ecf8427e|100|0|u|false|-'),
    ('fn:layover_route_watch_state(text, uuid, uuid)', 'sql|f|true|s|false|false|jsonb|search_path=pg_catalog, public|p_event text, p_session uuid, p_user uuid|9bb3f6138394546041cb1f08f2d1571f6d04f3c092fc6720feda7e10bcbdd74c|d41d8cd98f00b204e9800998ecf8427e|100|0|u|false|-'),
    ('fx:layover_route_fanout_claim(integer)', '---s'),
    ('fx:layover_route_fanout_ready()', '----'),
    ('fx:layover_route_fanout_retry(text, uuid, uuid, text)', '---s'),
    ('fx:layover_route_fanout_settle(text, uuid, uuid, text, text, jsonb)', '---s'),
    ('fx:layover_route_watch_state(text, uuid, uuid)', '----'),
    ('idx:layover_route_dispatches.layover_route_dispatches_pkey', 'CREATE UNIQUE INDEX layover_route_dispatches_pkey ON public.layover_route_dispatches USING btree (event_id)|true|true'),
    ('idx:layover_route_work.layover_route_work_due_idx', 'CREATE INDEX layover_route_work_due_idx ON public.layover_route_work USING btree (next_attempt_at, created_at) WHERE (state = ANY (ARRAY[''pending''::text, ''retry''::text, ''leased''::text]))|true|true'),
    ('idx:layover_route_work.layover_route_work_event_id_session_id_key', 'CREATE UNIQUE INDEX layover_route_work_event_id_session_id_key ON public.layover_route_work USING btree (event_id, session_id)|true|true'),
    ('idx:layover_route_work.layover_route_work_pkey', 'CREATE UNIQUE INDEX layover_route_work_pkey ON public.layover_route_work USING btree (id)|true|true'),
    ('idx:layover_route_work.layover_route_work_session_idx', 'CREATE INDEX layover_route_work_session_idx ON public.layover_route_work USING btree (session_id)|true|true'),
    ('idx:layover_route_work.layover_route_work_user_idx', 'CREATE INDEX layover_route_work_user_idx ON public.layover_route_work USING btree (user_id)|true|true'),
    ('priv:layover_route_dispatches.PUBLIC', ''),
    ('priv:layover_route_dispatches.anon', '--------'),
    ('priv:layover_route_dispatches.authenticated', '--------'),
    ('priv:layover_route_dispatches.service_role', 's------c'),
    ('priv:layover_route_work.PUBLIC', ''),
    ('priv:layover_route_work.anon', '--------'),
    ('priv:layover_route_work.authenticated', '--------'),
    ('priv:layover_route_work.service_role', 's------c'),
    ('rel:layover_route_dispatches', 'r|true|false|p|d41d8cd98f00b204e9800998ecf8427e'),
    ('rel:layover_route_work', 'r|true|false|p|d41d8cd98f00b204e9800998ecf8427e')
-- expected:end
 ),actual(k,v) AS (
-- canon:begin
    WITH rel AS (
      SELECT c.oid, c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('layover_route_dispatches','layover_route_work')
    ), fn AS (
      SELECT p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_route_fanout_ready','layover_route_watch_state','layover_route_fanout_claim','layover_route_fanout_retry','layover_route_fanout_settle')
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
 IF changed IS NOT NULL THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3908): catalog definition changed: %',left(changed,1500);END IF;
END $pre$;
DROP FUNCTION IF EXISTS public.layover_route_fanout_settle(text,uuid,uuid,text,text,jsonb);
DROP FUNCTION IF EXISTS public.layover_route_fanout_retry(text,uuid,uuid,text);
DROP FUNCTION IF EXISTS public.layover_route_fanout_claim(integer);
DROP FUNCTION IF EXISTS public.layover_route_watch_state(text,uuid,uuid);
DROP FUNCTION IF EXISTS public.layover_route_fanout_ready();
DROP TABLE IF EXISTS public.layover_route_work;
DROP TABLE IF EXISTS public.layover_route_dispatches;
DELETE FROM public.feature_flags WHERE flag='layover_route_fanout_enabled' AND enabled IS FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename='3908_layover_route_fanout.sql';
DO $post$ BEGIN
 IF to_regclass('public.layover_route_work') IS NOT NULL OR to_regclass('public.layover_route_dispatches') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('layover_route_fanout_ready','layover_route_watch_state','layover_route_fanout_claim','layover_route_fanout_retry','layover_route_fanout_settle'))
 OR EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_route_fanout_enabled') THEN RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3908): objects remain';END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
