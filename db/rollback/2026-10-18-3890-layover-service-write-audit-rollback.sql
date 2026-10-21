-- 3890 rollback refuses active auditing, retained records, and flag history.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog,pg_temp;
LOCK TABLE public.feature_flags IN ACCESS EXCLUSIVE MODE;
DO $pre$ BEGIN
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_service_write_audit_enabled' AND enabled) THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): live flag'; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flag_audit_log WHERE flag='layover_service_write_audit_enabled') THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): feature flag audit history'; END IF;
 IF to_regclass('public.layover_service_write_audit') IS NOT NULL THEN
  LOCK TABLE public.layover_service_write_audit IN ACCESS EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM public.layover_service_write_audit) THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): retained audit records'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.layover_capture_service_write()') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')<>'f776ad21a4a402e350e73c5b965984d38abbff2c99e810a94481fb4da119a3cf') THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): layover_capture_service_write function was changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.layover_install_service_write_audit()') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')<>'44fa4c22e081b95f9a20e541b3db80d6b062b4ca38cbe651e4c8b48e6c3a24ee') THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): layover_install_service_write_audit function was changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.layover_service_audit_activation()') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')<>'df7e44e882a6042b2bcb970a88a9c45694de58fe31bd4b837483ffd7167a5fc4') THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): layover_service_audit_activation function was changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.layover_expire_service_write_audit(integer)') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')<>'398176277d0a4c7629b8b0772428703a2a7e34823ff7c262412ba9b12b0b5d26') THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): layover_expire_service_write_audit function was changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.layover_service_audit_erase_actor()') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')<>'7d4a7fe2e380f546af8c3f3e28a9f0d679940ec6cae94f7f999b6dd274d7fa3f') THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): layover_service_audit_erase_actor function was changed'; END IF;
END $pre$;
DO $catalog$
DECLARE bad text; tables integer; functions integer; flags integer;
BEGIN
 SELECT count(*) INTO tables FROM pg_class WHERE relnamespace='public'::regnamespace AND relname='layover_service_write_audit';
 SELECT count(*) INTO functions FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('layover_capture_service_write','layover_install_service_write_audit','layover_service_audit_activation','layover_expire_service_write_audit','layover_service_audit_erase_actor');
 SELECT count(*) INTO flags FROM public.feature_flags WHERE flag='layover_service_write_audit_enabled';
 IF tables=0 AND functions=0 AND flags=0 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('layover_service_write_audit','layover_service_audit_activation','layover_service_audit_erase_actor')) THEN RETURN; END IF;
 IF tables<>1 OR functions<>5 OR flags<>1 THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): partial or changed installation'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('layover_capture_service_write','layover_install_service_write_audit','layover_service_audit_activation','layover_expire_service_write_audit','layover_service_audit_erase_actor') AND (procost<>100 OR prorows<>0 OR proparallel<>'u' OR proleakproof OR prosupport<>0)) THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): function planner or support attributes changed'; END IF;
 -- Dynamic triggers are activation-created. Every existing one must be exact;
 -- if activation occurred, a missing table trigger is ambiguous and refuses.
 IF EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND t.tgname='layover_service_write_audit' AND (t.tgenabled<>'O' OR c.relkind<>'r' OR left(c.relname,8)<>'layover_' OR c.relname='layover_service_write_audit' OR pg_get_triggerdef(t.oid)<>format('CREATE TRIGGER layover_service_write_audit AFTER INSERT OR DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.layover_capture_service_write()',c.relname))) THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): dynamic audit trigger definition changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgname='layover_service_write_audit') AND EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND left(c.relname,8)='layover_' AND c.relname<>'layover_service_write_audit' AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='layover_service_write_audit')) THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): dynamic audit trigger missing after activation'; END IF;
 WITH expected(k,v) AS (VALUES
-- expected:begin
    ('acl:fn:layover_capture_service_write()', ''),
    ('acl:fn:layover_expire_service_write_audit(integer)', 'service_role:EXECUTE:false'),
    ('acl:fn:layover_install_service_write_audit()', ''),
    ('acl:fn:layover_service_audit_activation()', ''),
    ('acl:fn:layover_service_audit_erase_actor()', ''),
    ('acl:rel:layover_service_write_audit', 'service_role:SELECT:false'),
    ('col:layover_service_write_audit.actor_kind', '3|text|true||||'),
    ('col:layover_service_write_audit.actor_user_id', '4|uuid|false||||'),
    ('col:layover_service_write_audit.created_at', '11|timestamp with time zone|true|now()|||'),
    ('col:layover_service_write_audit.id', '1|uuid|true|gen_random_uuid()|||'),
    ('col:layover_service_write_audit.layover_session_id', '7|uuid|false||||'),
    ('col:layover_service_write_audit.operation', '9|text|true||||'),
    ('col:layover_service_write_audit.outcome', '10|text|true|''applied''::text|||'),
    ('col:layover_service_write_audit.request_id', '2|uuid|false||||'),
    ('col:layover_service_write_audit.retain_until', '12|timestamp with time zone|true|(now() + ''30 days''::interval)|||'),
    ('col:layover_service_write_audit.route', '6|text|true||||'),
    ('col:layover_service_write_audit.system_actor', '5|text|false||||'),
    ('col:layover_service_write_audit.table_name', '8|text|true||||'),
    ('con:layover_service_write_audit.layover_service_audit_retention_bound', 'c|CHECK (((retain_until >= created_at) AND (retain_until <= (created_at + ''30 days''::interval))))|true|false|false'),
    ('con:layover_service_write_audit.layover_service_write_audit_actor_kind_check', 'c|CHECK ((actor_kind = ANY (ARRAY[''user''::text, ''system''::text, ''database_operator''::text])))|true|false|false'),
    ('con:layover_service_write_audit.layover_service_write_audit_actor_user_id_fkey', 'f|FOREIGN KEY (actor_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL|true|false|false'),
    ('con:layover_service_write_audit.layover_service_write_audit_layover_session_id_fkey', 'f|FOREIGN KEY (layover_session_id) REFERENCES public.layover_sessions(id) ON DELETE SET NULL|true|false|false'),
    ('con:layover_service_write_audit.layover_service_write_audit_operation_check', 'c|CHECK ((operation = ANY (ARRAY[''INSERT''::text, ''UPDATE''::text, ''DELETE''::text])))|true|false|false'),
    ('con:layover_service_write_audit.layover_service_write_audit_outcome_check', 'c|CHECK ((outcome = ''applied''::text))|true|false|false'),
    ('con:layover_service_write_audit.layover_service_write_audit_pkey', 'p|PRIMARY KEY (id)|true|false|false'),
    ('con:layover_service_write_audit.layover_service_write_audit_route_check', 'c|CHECK (((length(route) >= 1) AND (length(route) <= 240)))|true|false|false'),
    ('fn:layover_capture_service_write()', 'plpgsql|f|true|v|false|false|trigger|search_path=pg_catalog, public||f776ad21a4a402e350e73c5b965984d38abbff2c99e810a94481fb4da119a3cf|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:layover_expire_service_write_audit(integer)', 'plpgsql|f|true|v|false|false|integer|search_path=pg_catalog, public|p_limit integer DEFAULT 500|398176277d0a4c7629b8b0772428703a2a7e34823ff7c262412ba9b12b0b5d26|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:layover_install_service_write_audit()', 'plpgsql|f|true|v|false|false|void|search_path=pg_catalog, public||44fa4c22e081b95f9a20e541b3db80d6b062b4ca38cbe651e4c8b48e6c3a24ee|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:layover_service_audit_activation()', 'plpgsql|f|true|v|false|false|trigger|search_path=pg_catalog, public||df7e44e882a6042b2bcb970a88a9c45694de58fe31bd4b837483ffd7167a5fc4|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:layover_service_audit_erase_actor()', 'plpgsql|f|true|v|false|false|trigger|search_path=pg_catalog, public||7d4a7fe2e380f546af8c3f3e28a9f0d679940ec6cae94f7f999b6dd274d7fa3f|d41d8cd98f00b204e9800998ecf8427e'),
    ('fx:layover_capture_service_write()', '----'),
    ('fx:layover_expire_service_write_audit(integer)', '---s'),
    ('fx:layover_install_service_write_audit()', '----'),
    ('fx:layover_service_audit_activation()', '----'),
    ('fx:layover_service_audit_erase_actor()', '----'),
    ('idx:layover_service_write_audit.layover_service_write_audit_pkey', 'CREATE UNIQUE INDEX layover_service_write_audit_pkey ON public.layover_service_write_audit USING btree (id)|true|true'),
    ('idx:layover_service_write_audit.layover_service_write_audit_retention_idx', 'CREATE INDEX layover_service_write_audit_retention_idx ON public.layover_service_write_audit USING btree (retain_until)|true|true'),
    ('idx:layover_service_write_audit.layover_service_write_audit_session_idx', 'CREATE INDEX layover_service_write_audit_session_idx ON public.layover_service_write_audit USING btree (layover_session_id, created_at DESC)|true|true'),
    ('pol:layover_service_write_audit.layover_service_write_audit_service_read', 'r|true|service_role|true|'),
    ('priv:layover_service_write_audit.PUBLIC', ''),
    ('priv:layover_service_write_audit.anon', '--------'),
    ('priv:layover_service_write_audit.authenticated', '--------'),
    ('priv:layover_service_write_audit.service_role', 's------c'),
    ('rel:layover_service_write_audit', 'r|true|false|p|d41d8cd98f00b204e9800998ecf8427e'),
    ('trg:feature_flags.layover_service_audit_activation', 'CREATE TRIGGER layover_service_audit_activation AFTER INSERT OR UPDATE ON public.feature_flags FOR EACH ROW EXECUTE FUNCTION public.layover_service_audit_activation()|O'),
    ('trg:profiles.layover_service_audit_erase_actor', 'CREATE TRIGGER layover_service_audit_erase_actor AFTER UPDATE OF account_status ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.layover_service_audit_erase_actor()|O')
-- expected:end
 ), actual(k,v) AS (
-- canon:begin
    WITH rel AS (
      SELECT c.oid, c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('layover_service_write_audit')
    ), fn AS (
      SELECT p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_capture_service_write','layover_install_service_write_audit','layover_service_audit_activation','layover_expire_service_write_audit','layover_service_audit_erase_actor')
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
     WHERE NOT t.tgisinternal AND t.tgname <> 'layover_service_write_audit' AND (t.tgrelid IN (SELECT oid FROM rel) OR t.tgfoid IN (SELECT oid FROM fn))
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
    UNION ALL
    SELECT 'acl:rel:' || r.relname, coalesce((SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type || ':' || a.is_grantable,',' ORDER BY a.grantee,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner),'') FROM rel r JOIN pg_class c ON c.oid=r.oid
    UNION ALL
    SELECT 'acl:fn:' || f.sig, coalesce((SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type || ':' || a.is_grantable,',' ORDER BY a.grantee,a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner),'') FROM fn f JOIN pg_proc p ON p.oid=f.oid
-- canon:end
 ) SELECT string_agg(coalesce(e.k,a.k),', ' ORDER BY coalesce(e.k,a.k)) INTO bad FROM expected e FULL JOIN actual a ON a.k=e.k WHERE e.v IS DISTINCT FROM a.v;
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3890): installed definition or privileges changed: %',left(bad,1500); END IF;
END $catalog$;
DO $drop$ DECLARE t record; BEGIN
 FOR t IN SELECT n.nspname,c.relname,g.tgname FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE g.tgname='layover_service_write_audit' AND n.nspname='public'
 LOOP EXECUTE format('DROP TRIGGER %I ON %I.%I',t.tgname,t.nspname,t.relname);END LOOP;
END $drop$;
DROP TRIGGER IF EXISTS layover_service_audit_activation ON public.feature_flags;
DROP TRIGGER IF EXISTS layover_service_audit_erase_actor ON public.profiles;
DROP FUNCTION IF EXISTS public.layover_service_audit_erase_actor();
DROP FUNCTION IF EXISTS public.layover_service_audit_activation();
DROP FUNCTION IF EXISTS public.layover_install_service_write_audit();
DROP FUNCTION IF EXISTS public.layover_capture_service_write();
DROP FUNCTION IF EXISTS public.layover_expire_service_write_audit(integer);
DROP TABLE IF EXISTS public.layover_service_write_audit;
DELETE FROM public.feature_flags WHERE flag='layover_service_write_audit_enabled';
DELETE FROM public.schema_migration_ledger WHERE filename='3890_layover_service_write_audit.sql';
DO $post$ BEGIN
 IF to_regclass('public.layover_service_write_audit') IS NOT NULL
 OR to_regprocedure('public.layover_capture_service_write()') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('layover_service_write_audit','layover_service_audit_activation','layover_service_audit_erase_actor')) THEN
  RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3890): audit objects remain';
 END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
