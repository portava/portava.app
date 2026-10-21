-- Rollback 3898: never discard a plan version, outcome, flag audit, or changed object.
-- Isolated, repeatable and no CASCADE. Any downstream dependency or audit trigger refuses.
-- PostgreSQL 18 also catalogs NOT NULL constraints; attnotnull below preserves that check on all supported versions. The table ACL hash names a grantee holding the owner's whole default set (acldefault) ALL, so PostgreSQL 16 (no MAINTAIN) and 17 pin one value and a partial revoke still refuses. Text sort keys (index names, ACL grantees) are COLLATE "C": a pin must not depend on the database collation (glibc en_US ignores "_", macOS and C do not).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$
DECLARE shape text; objects integer; target text; expected text;
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag='layover_experience_execution_enabled' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_experience_execution_enabled' AND enabled IS NOT FALSE)
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3898): flag is enabled.'; END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flag_audit_log WHERE flag='layover_experience_execution_enabled')
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3898): flag audit history exists.'; END IF;
  SELECT (to_regclass('public.layover_experience_plans') IS NOT NULL)::integer
    +(to_regprocedure('public.layover_experience_plan_immutable()') IS NOT NULL)::integer
    +(to_regprocedure('public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text)') IS NOT NULL)::integer INTO objects;
  IF objects=0 THEN RETURN; END IF;
  IF objects<>3 THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3898): incomplete experience schema.'; END IF;
  LOCK TABLE public.layover_experience_plans IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.layover_experience_plans)
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3898): experience evidence exists.'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.layover_experience_plan_immutable()')
      AND (md5(prosrc)<>'1ddacf0d4c6198a0d374c98809a82d2c' OR prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']))
    OR EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text)')
      AND (md5(prosrc)<>'8eb5d38da218f1a2850fac94655fbcc5' OR prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']))
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3898): experience function was changed.'; END IF;
  FOR target,expected IN VALUES ('public.layover_experience_plan_immutable()','a8a73a54bdcc8ffe1ec964fbe74a9658'),('public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text)','062f8dd535cb042fa3bc19af879025fb') LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(target) AND (
      md5(jsonb_build_object('definition',pg_get_functiondef(p.oid),'leakproof',proleakproof,'parallel',proparallel,'cost',procost,'rows',prorows,'support',prosupport::text)::text)<>expected
      OR (SELECT md5(jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,CASE WHEN a.grantor=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)::text) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) IS DISTINCT FROM '6707d82f843f2381f486dd6215ed01fc'))
      THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3898): experience function attributes or privileges were changed.'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.layover_experience_plans'::regclass AND attacl IS NOT NULL)
    OR EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.layover_experience_plans'::regclass AND (
      relforcerowsecurity OR relkind<>'r' OR relpersistence<>'p' OR reloptions IS NOT NULL
      OR (SELECT md5(jsonb_agg(jsonb_build_array(g.grantee,g.grantor,CASE WHEN g.privs=(SELECT array_agg(d.privilege_type ORDER BY d.privilege_type) FROM aclexplode(acldefault('r',c.relowner)) d) THEN ARRAY['ALL'] ELSE g.privs END,g.is_grantable) ORDER BY g.grantee COLLATE "C",g.grantor COLLATE "C",g.is_grantable)::text) FROM (SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=c.relowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END grantee,CASE WHEN a.grantor=c.relowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END grantor,a.is_grantable,array_agg(a.privilege_type ORDER BY a.privilege_type) privs FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a GROUP BY 1,2,3) g) IS DISTINCT FROM '448e1a16e7e012dd102b859139de3843'))
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3898): experience table attributes or privileges were changed.'; END IF;
  SELECT md5(jsonb_build_object(
    'columns',(SELECT jsonb_agg(attname||'|'||format_type(atttypid,atttypmod)||'|'||attnotnull||'|'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') ORDER BY attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.layover_experience_plans'::regclass AND attnum>0 AND NOT attisdropped),
    'constraints',(SELECT jsonb_agg(conname||'|'||pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE contype<>'n' AND conrelid='public.layover_experience_plans'::regclass),
    'indexes',(SELECT jsonb_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid::regclass::text COLLATE "C") FROM pg_index WHERE indrelid='public.layover_experience_plans'::regclass),
    'triggers',(SELECT jsonb_agg(pg_get_triggerdef(oid)||'|'||tgenabled::text ORDER BY tgname) FROM pg_trigger WHERE tgrelid='public.layover_experience_plans'::regclass AND NOT tgisinternal),
    'policies',(SELECT jsonb_agg(polname ORDER BY polname) FROM pg_policy WHERE polrelid='public.layover_experience_plans'::regclass),
    'rls',(SELECT relrowsecurity FROM pg_class WHERE oid='public.layover_experience_plans'::regclass)
  )::text) INTO shape;
  IF shape<>'34bd50ecee973ad4f28dbfb72d1a24e1'
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3898): experience table was changed.'; END IF;
END $pre$;
DROP FUNCTION IF EXISTS public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text);
DROP TABLE IF EXISTS public.layover_experience_plans;
DROP FUNCTION IF EXISTS public.layover_experience_plan_immutable();
DELETE FROM public.feature_flags WHERE flag='layover_experience_execution_enabled' AND enabled IS FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename='3898_layover_experience_plan_versions.sql';
DO $post$ BEGIN
  IF to_regclass('public.layover_experience_plans') IS NOT NULL
    OR to_regprocedure('public.layover_experience_plan_immutable()') IS NOT NULL
    OR to_regprocedure('public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_experience_execution_enabled')
    THEN RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3898): experience objects remain.'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
