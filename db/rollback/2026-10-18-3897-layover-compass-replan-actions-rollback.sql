-- Rollback 3897: never discard an approval, outcome, flag audit, or changed object.
-- Isolated, repeatable and no CASCADE. Any downstream dependency or audit trigger refuses.
-- PostgreSQL 18 also catalogs NOT NULL constraints; attnotnull below preserves that check on all supported versions. The table ACL hash names a grantee holding the owner's whole default set (acldefault) ALL, so PostgreSQL 16 (no MAINTAIN) and 17 pin one value and a partial revoke still refuses.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$
DECLARE shape text; objects integer; target text; expected text;
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag='layover_compass_replan_enabled' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_compass_replan_enabled' AND enabled IS NOT FALSE)
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3897): flag is enabled.'; END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flag_audit_log WHERE flag='layover_compass_replan_enabled')
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3897): flag audit history exists.'; END IF;
  SELECT (to_regclass('public.layover_compass_actions') IS NOT NULL)::integer
    +(to_regprocedure('public.layover_compass_action_guard()') IS NOT NULL)::integer
    +(to_regprocedure('public.claim_layover_compass_replan(uuid,uuid,uuid)') IS NOT NULL)::integer INTO objects;
  IF objects=0 THEN RETURN; END IF;
  IF objects<>3 THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3897): incomplete action schema.'; END IF;
  LOCK TABLE public.layover_compass_actions IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.layover_compass_actions)
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3897): action evidence exists.'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.layover_compass_action_guard()')
      AND (md5(prosrc)<>'3c8e10bc61ae8c8c33b9a69eaad6e4cc' OR prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']))
    OR EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.claim_layover_compass_replan(uuid,uuid,uuid)')
      AND (md5(prosrc)<>'37c904ee932533fd68331f9f6796ec5b' OR prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']))
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3897): action function was changed.'; END IF;
  FOR target,expected IN VALUES ('public.layover_compass_action_guard()','d4df1ec2a763b04424fa671b2a0d634a'),('public.claim_layover_compass_replan(uuid,uuid,uuid)','212f9635252adceee72cdd4ef276c16f') LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(target) AND (
      md5(jsonb_build_object('definition',pg_get_functiondef(p.oid),'leakproof',proleakproof,'parallel',proparallel,'cost',procost,'rows',prorows,'support',prosupport::text)::text)<>expected
      OR (SELECT md5(jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,CASE WHEN a.grantor=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)::text) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) IS DISTINCT FROM '6707d82f843f2381f486dd6215ed01fc'))
      THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3897): action function attributes or privileges were changed.'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.layover_compass_actions'::regclass AND attacl IS NOT NULL)
    OR EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.layover_compass_actions'::regclass AND (
      relforcerowsecurity OR relkind<>'r' OR relpersistence<>'p' OR reloptions IS NOT NULL
      OR (SELECT md5(jsonb_agg(jsonb_build_array(g.grantee,g.grantor,CASE WHEN g.privs=(SELECT array_agg(d.privilege_type ORDER BY d.privilege_type) FROM aclexplode(acldefault('r',c.relowner)) d) THEN ARRAY['ALL'] ELSE g.privs END,g.is_grantable) ORDER BY g.grantee,g.grantor,g.is_grantable)::text) FROM (SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=c.relowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END grantee,CASE WHEN a.grantor=c.relowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END grantor,a.is_grantable,array_agg(a.privilege_type ORDER BY a.privilege_type) privs FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a GROUP BY 1,2,3) g) IS DISTINCT FROM '448e1a16e7e012dd102b859139de3843'))
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3897): action table attributes or privileges were changed.'; END IF;
  SELECT md5(jsonb_build_object(
    'columns',(SELECT jsonb_agg(attname||'|'||format_type(atttypid,atttypmod)||'|'||attnotnull||'|'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') ORDER BY attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.layover_compass_actions'::regclass AND attnum>0 AND NOT attisdropped),
    'constraints',(SELECT jsonb_agg(conname||'|'||pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE contype<>'n' AND conrelid='public.layover_compass_actions'::regclass),
    'indexes',(SELECT jsonb_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid::regclass::text) FROM pg_index WHERE indrelid='public.layover_compass_actions'::regclass),
    'triggers',(SELECT jsonb_agg(pg_get_triggerdef(oid)||'|'||tgenabled::text ORDER BY tgname) FROM pg_trigger WHERE tgrelid='public.layover_compass_actions'::regclass AND NOT tgisinternal),
    'policies',(SELECT jsonb_agg(polname ORDER BY polname) FROM pg_policy WHERE polrelid='public.layover_compass_actions'::regclass),
    'rls',(SELECT relrowsecurity FROM pg_class WHERE oid='public.layover_compass_actions'::regclass)
  )::text) INTO shape;
  IF shape<>'b6eee2d6280676163a2fdc52682c5713'
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3897): action table was changed.'; END IF;
END $pre$;
DROP FUNCTION IF EXISTS public.claim_layover_compass_replan(uuid,uuid,uuid);
DROP TABLE IF EXISTS public.layover_compass_actions;
DROP FUNCTION IF EXISTS public.layover_compass_action_guard();
DELETE FROM public.feature_flags WHERE flag='layover_compass_replan_enabled' AND enabled IS FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename='3897_layover_compass_replan_actions.sql';
DO $post$ BEGIN
  IF to_regclass('public.layover_compass_actions') IS NOT NULL
    OR to_regprocedure('public.layover_compass_action_guard()') IS NOT NULL
    OR to_regprocedure('public.claim_layover_compass_replan(uuid,uuid,uuid)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_compass_replan_enabled')
    THEN RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3897): action objects remain.'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
