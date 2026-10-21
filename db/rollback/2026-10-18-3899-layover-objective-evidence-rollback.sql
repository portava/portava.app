-- Rollback 3899: preserve source/intent evidence, flag history and changed objects.
-- Repeatable after a successful rollback. No CASCADE; downstream dependencies refuse.
-- PostgreSQL 18 also catalogs NOT NULL constraints; attnotnull below preserves that check on all supported versions. The table ACL hash names a grantee holding the owner's whole default set (acldefault) ALL, so PostgreSQL 16 (no MAINTAIN) and 17 pin one value and a partial revoke still refuses. Text sort keys (index names, ACL grantees) are COLLATE "C": a pin must not depend on the database collation (glibc en_US ignores "_", macOS and C do not).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$
DECLARE shape text; objects integer; target text; expected text;
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag='layover_objective_evidence_enabled' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_objective_evidence_enabled' AND enabled IS NOT FALSE)
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3899): flag is enabled.'; END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flag_audit_log WHERE flag='layover_objective_evidence_enabled')
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3899): flag audit history exists.'; END IF;
  SELECT (to_regclass('public.layover_objective_facts') IS NOT NULL)::integer
    +(to_regclass('public.layover_objective_intents') IS NOT NULL)::integer
    +(to_regprocedure('public.layover_objective_evidence_guard()') IS NOT NULL)::integer INTO objects;
  IF objects=0 THEN RETURN; END IF;
  IF objects<>3 THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3899): incomplete objective schema.'; END IF;
  LOCK TABLE public.layover_objective_facts,public.layover_objective_intents IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.layover_objective_facts) OR EXISTS (SELECT 1 FROM public.layover_objective_intents)
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3899): objective evidence exists.'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.layover_objective_evidence_guard()')
      AND (md5(prosrc)<>'0fb4543d82297642e0dff4e2caa98649' OR prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']))
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3899): objective function was changed.'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.layover_objective_evidence_guard()') AND (
    md5(jsonb_build_object('definition',pg_get_functiondef(p.oid),'leakproof',proleakproof,'parallel',proparallel,'cost',procost,'rows',prorows,'support',prosupport::text)::text)<>'e839003af2f1c3d003575bb0acff1d3a'
    OR (SELECT md5(jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,CASE WHEN a.grantor=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)::text) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) IS DISTINCT FROM '6707d82f843f2381f486dd6215ed01fc'))
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3899): objective function attributes or privileges were changed.'; END IF;
  FOR target,expected IN VALUES ('layover_objective_facts','b77f5f28131ac7c6574499d81748c726'),('layover_objective_intents','7ef5132267fcce141de315a1b044c4da') LOOP
    IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=('public.'||target)::regclass AND attacl IS NOT NULL)
      OR EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=('public.'||target)::regclass AND (
        relforcerowsecurity OR relkind<>'r' OR relpersistence<>'p' OR reloptions IS NOT NULL
        OR (SELECT md5(jsonb_agg(jsonb_build_array(g.grantee,g.grantor,CASE WHEN g.privs=(SELECT array_agg(d.privilege_type ORDER BY d.privilege_type) FROM aclexplode(acldefault('r',c.relowner)) d) THEN ARRAY['ALL'] ELSE g.privs END,g.is_grantable) ORDER BY g.grantee COLLATE "C",g.grantor COLLATE "C",g.is_grantable)::text) FROM (SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=c.relowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END grantee,CASE WHEN a.grantor=c.relowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END grantor,a.is_grantable,array_agg(a.privilege_type ORDER BY a.privilege_type) privs FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a GROUP BY 1,2,3) g) IS DISTINCT FROM '448e1a16e7e012dd102b859139de3843'))
      THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3899): objective table % attributes or privileges were changed.',target; END IF;
    SELECT md5(jsonb_build_object(
      'columns',(SELECT jsonb_agg(attname||'|'||format_type(atttypid,atttypmod)||'|'||attnotnull||'|'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') ORDER BY attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=('public.'||target)::regclass AND attnum>0 AND NOT attisdropped),
      'constraints',(SELECT jsonb_agg(conname||'|'||pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE contype<>'n' AND conrelid=('public.'||target)::regclass),
      'indexes',(SELECT jsonb_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid::regclass::text COLLATE "C") FROM pg_index WHERE indrelid=('public.'||target)::regclass),
      'triggers',(SELECT jsonb_agg(pg_get_triggerdef(oid)||'|'||tgenabled::text ORDER BY tgname) FROM pg_trigger WHERE tgrelid=('public.'||target)::regclass AND NOT tgisinternal),
      'policies',(SELECT jsonb_agg(polname ORDER BY polname) FROM pg_policy WHERE polrelid=('public.'||target)::regclass),
      'rls',(SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||target)::regclass)
    )::text) INTO shape;
    IF shape<>expected THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3899): objective table % was changed.',target; END IF;
  END LOOP;
END $pre$;
DROP TABLE IF EXISTS public.layover_objective_intents;
DROP TABLE IF EXISTS public.layover_objective_facts;
DROP FUNCTION IF EXISTS public.layover_objective_evidence_guard();
DELETE FROM public.feature_flags WHERE flag='layover_objective_evidence_enabled' AND enabled IS FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename='3899_layover_objective_evidence.sql';
DO $post$ BEGIN
  IF to_regclass('public.layover_objective_facts') IS NOT NULL OR to_regclass('public.layover_objective_intents') IS NOT NULL
    OR to_regprocedure('public.layover_objective_evidence_guard()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_objective_evidence_enabled')
    THEN RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3899): objective objects remain.'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
