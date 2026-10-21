-- Rollback 3871. Isolated and idempotent; refuses classified cards, history, an enabled flag or flag audit history.
-- No production application is claimed. Locks prevent new evidence or a flag toggle between the checks and DROP.
-- No CASCADE: dependencies owned by another migration refuse the rollback. Preserve/export evidence separately.
-- PostgreSQL 18 also catalogs NOT NULL constraints; attnotnull below preserves that check on all supported versions. The table ACL hash names a grantee holding the owner's whole default set (acldefault) ALL, so PostgreSQL 16 (no MAINTAIN) and 17 pin one value and a partial revoke still refuses.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;
LOCK TABLE public.layover_recommendations IN ACCESS EXCLUSIVE MODE;
DO $pre$
DECLARE n integer; shape text; target text; expected text;
BEGIN
  -- PL/pgSQL body references do not create dependency edges for later route settlement.
  IF to_regclass('public.layover_route_dispatches') IS NOT NULL OR to_regclass('public.layover_route_work') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('layover_route_fanout_ready','layover_route_watch_state','layover_route_fanout_claim','layover_route_fanout_retry','layover_route_fanout_settle')) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3871): later migration 3908 still depends on this schema; roll it back first.';
  END IF;
  PERFORM 1 FROM public.feature_flags WHERE flag='layover_recommendation_status_enabled' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_recommendation_status_enabled' AND enabled IS NOT FALSE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3871): recommendation status flag is enabled.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flag_audit_log WHERE flag='layover_recommendation_status_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3871): flag audit history must not be cascaded away.';
  END IF;
  SELECT count(*) INTO n FROM pg_attribute WHERE attrelid='public.layover_recommendations'::regclass AND NOT attisdropped
    AND attname IN ('plan_json','utility_score','risk_band','confidence','expires_at','recommendation_status','status_reason','superseded_by_snapshot_id','superseded_at');
  IF n=0 AND to_regclass('public.layover_recommendation_supersessions') IS NULL AND to_regprocedure('public.layover_rec_supersessions_are_immutable()') IS NULL THEN RETURN; END IF;
  IF n<>9 OR to_regclass('public.layover_recommendation_supersessions') IS NULL OR to_regprocedure('public.layover_rec_supersessions_are_immutable()') IS NULL THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3871): incomplete recommendation schema.'; END IF;
  WITH attrs AS (SELECT a.*,pg_get_expr(d.adbin,d.adrelid) AS expr FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.layover_recommendations'::regclass AND attname IN ('plan_json','utility_score','risk_band','confidence','expires_at','recommendation_status','status_reason','superseded_by_snapshot_id','superseded_at') AND NOT attisdropped)
 SELECT md5(jsonb_build_object(
 'columns',(SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull,expr,attidentity,attgenerated,attacl::text,col_description(attrelid,attnum)) ORDER BY attname) FROM attrs),
 'constraints',(SELECT jsonb_agg(conname||'|'||pg_get_constraintdef(oid)||'|'||convalidated ORDER BY conname) FROM pg_constraint WHERE conrelid='public.layover_recommendations'::regclass AND conkey && ARRAY(SELECT attnum FROM attrs)),
 'indexes',(SELECT jsonb_agg(pg_get_indexdef(indexrelid)||'|'||indisvalid||'|'||indisready ORDER BY indexrelid::regclass::text) FROM pg_index i WHERE indrelid='public.layover_recommendations'::regclass AND EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=i.indexrelid AND d.refclassid='pg_class'::regclass AND d.refobjid=i.indrelid AND d.refobjsubid IN(SELECT attnum FROM attrs)))
 )::text) INTO shape;
  IF shape IS DISTINCT FROM '4348579bc0fa5be0d2fd506ff0b3c258' THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3871): owned column definitions, privileges or dependencies were changed.'; END IF;

  IF n=9 THEN
    IF EXISTS (SELECT 1 FROM public.layover_recommendations WHERE plan_json IS NOT NULL OR utility_score IS NOT NULL OR risk_band IS NOT NULL OR confidence IS NOT NULL OR expires_at IS NOT NULL OR recommendation_status IS NOT NULL OR status_reason IS NOT NULL OR superseded_by_snapshot_id IS NOT NULL OR superseded_at IS NOT NULL) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3871): classified recommendation data exists.';
    END IF;
  END IF;
  IF to_regclass('public.layover_recommendation_supersessions') IS NOT NULL THEN
    LOCK TABLE public.layover_recommendation_supersessions IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public.layover_recommendation_supersessions) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3871): supersession history exists.';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.layover_rec_supersessions_are_immutable()') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex') <> '2ac8e38771a4b0fdb82c4246dea231ccee8cc45a2dc6ed4a387dc5dd1c48fb7f') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3871): immutability function was changed.';
  END IF;
  FOR target,expected IN VALUES ('public.layover_rec_supersessions_are_immutable()','a708185fd0fe188007c5988cce5b50a0') LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(target) AND (
      md5(jsonb_build_object('definition',pg_get_functiondef(p.oid),'leakproof',proleakproof,'parallel',proparallel,'cost',procost,'rows',prorows,'support',prosupport::text)::text)<>expected
      OR (SELECT md5(jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,CASE WHEN a.grantor=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)::text) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) IS DISTINCT FROM '6707d82f843f2381f486dd6215ed01fc'))
      THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3871): function was changed (attributes or privileges).'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.layover_recommendation_supersessions'::regclass AND attacl IS NOT NULL)
    OR EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.layover_recommendation_supersessions'::regclass AND (
      relforcerowsecurity OR relkind<>'r' OR relpersistence<>'p' OR reloptions IS NOT NULL
      OR (SELECT md5(jsonb_agg(jsonb_build_array(g.grantee,g.grantor,CASE WHEN g.privs=(SELECT array_agg(d.privilege_type ORDER BY d.privilege_type) FROM aclexplode(acldefault('r',c.relowner)) d) THEN ARRAY['ALL'] ELSE g.privs END,g.is_grantable) ORDER BY g.grantee,g.grantor,g.is_grantable)::text) FROM (SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=c.relowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END grantee,CASE WHEN a.grantor=c.relowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END grantor,a.is_grantable,array_agg(a.privilege_type ORDER BY a.privilege_type) privs FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a GROUP BY 1,2,3) g) IS DISTINCT FROM '448e1a16e7e012dd102b859139de3843'))
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3871): supersession table attributes or privileges were changed.'; END IF;
  SELECT md5(jsonb_build_object(
 'columns',(SELECT jsonb_agg(attname||'|'||format_type(atttypid,atttypmod)||'|'||attnotnull||'|'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') ORDER BY attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.layover_recommendation_supersessions'::regclass AND attnum>0 AND NOT attisdropped),
 'constraints',(SELECT jsonb_agg(conname||'|'||pg_get_constraintdef(oid)||'|'||convalidated ORDER BY conname) FROM pg_constraint WHERE contype<>'n' AND conrelid='public.layover_recommendation_supersessions'::regclass),
 'indexes',(SELECT jsonb_agg(pg_get_indexdef(indexrelid)||'|'||indisvalid||'|'||indisready ORDER BY indexrelid::regclass::text) FROM pg_index WHERE indrelid='public.layover_recommendation_supersessions'::regclass),
 'triggers',(SELECT jsonb_agg(pg_get_triggerdef(oid)||'|'||tgenabled::text ORDER BY tgname) FROM pg_trigger WHERE tgrelid='public.layover_recommendation_supersessions'::regclass AND NOT tgisinternal),
 'policies',(SELECT jsonb_agg(polname ORDER BY polname) FROM pg_policy WHERE polrelid='public.layover_recommendation_supersessions'::regclass),
 'rls',(SELECT relrowsecurity FROM pg_class WHERE oid='public.layover_recommendation_supersessions'::regclass)
 )::text) INTO shape;
  IF shape IS DISTINCT FROM '6ba139d33cc64563df434febb01eb1b5' THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3871): supersession table definitions were changed.'; END IF;
END $pre$;
DROP TABLE IF EXISTS public.layover_recommendation_supersessions;
DROP FUNCTION IF EXISTS public.layover_rec_supersessions_are_immutable();
ALTER TABLE public.layover_recommendations
  DROP COLUMN IF EXISTS plan_json, DROP COLUMN IF EXISTS utility_score, DROP COLUMN IF EXISTS risk_band,
  DROP COLUMN IF EXISTS confidence, DROP COLUMN IF EXISTS expires_at, DROP COLUMN IF EXISTS recommendation_status,
  DROP COLUMN IF EXISTS status_reason, DROP COLUMN IF EXISTS superseded_by_snapshot_id, DROP COLUMN IF EXISTS superseded_at;
DELETE FROM public.feature_flags WHERE flag='layover_recommendation_status_enabled' AND enabled=FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename='3871_layover_recommendation_status_and_supersession.sql';
NOTIFY pgrst, 'reload schema';
COMMIT;
DO $post$
BEGIN
  IF to_regclass('public.layover_recommendation_supersessions') IS NOT NULL OR EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_recommendation_status_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3871): objects remain.';
  END IF;
END $post$;
