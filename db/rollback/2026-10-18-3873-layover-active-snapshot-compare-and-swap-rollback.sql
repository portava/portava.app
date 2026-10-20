-- Rollback 3873. Refuse stored expectations, an enabled canonical switch, or audit history; no evidence is deleted.
-- No CASCADE; independent later dependencies refuse rollback. Lock writers before checking data. Repeat is a no-op.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;
LOCK TABLE public.layover_certified_computations IN ACCESS EXCLUSIVE MODE;
DO $pre$
DECLARE n integer; shape text; target text; expected text;
BEGIN
  -- PL/pgSQL body references do not create dependency edges for later route settlement.
  IF to_regclass('public.layover_route_dispatches') IS NOT NULL OR to_regclass('public.layover_route_work') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('layover_route_fanout_ready','layover_route_watch_state','layover_route_fanout_claim','layover_route_fanout_retry','layover_route_fanout_settle')) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3873): later migration 3908 still depends on this schema; roll it back first.';
  END IF;
  PERFORM 1 FROM public.feature_flags WHERE flag='layover_canonical_snapshot_enabled' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_canonical_snapshot_enabled' AND enabled IS NOT FALSE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3873): canonical snapshot flag is enabled.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flag_audit_log WHERE flag='layover_canonical_snapshot_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3873): flag audit history must not be cascaded away.';
  END IF;
  SELECT (EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.layover_certified_computations'::regclass AND attname='expected_active_version' AND NOT attisdropped))::integer +(to_regprocedure('public.layover_certcomp_active_cas()') IS NOT NULL)::integer +(EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.layover_certified_computations'::regclass AND tgname='layover_certcomp_active_cas'))::integer INTO n;
  IF n=0 THEN RETURN; END IF;
  IF n<>3 THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3873): incomplete compare-and-swap schema.'; END IF;

  WITH attrs AS (SELECT a.*,pg_get_expr(d.adbin,d.adrelid) AS expr FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.layover_certified_computations'::regclass AND attname IN ('expected_active_version') AND NOT attisdropped)
 SELECT md5(jsonb_build_object(
 'columns',(SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull,expr,attidentity,attgenerated,attacl::text,col_description(attrelid,attnum)) ORDER BY attname) FROM attrs),
 'constraints',(SELECT jsonb_agg(conname||'|'||pg_get_constraintdef(oid)||'|'||convalidated ORDER BY conname) FROM pg_constraint WHERE conrelid='public.layover_certified_computations'::regclass AND conkey && ARRAY(SELECT attnum FROM attrs)),
 'indexes',(SELECT jsonb_agg(pg_get_indexdef(indexrelid)||'|'||indisvalid||'|'||indisready ORDER BY indexrelid::regclass::text) FROM pg_index i WHERE indrelid='public.layover_certified_computations'::regclass AND EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=i.indexrelid AND d.refclassid='pg_class'::regclass AND d.refobjid=i.indrelid AND d.refobjsubid IN(SELECT attnum FROM attrs)))
 )::text) INTO shape;
  IF shape IS DISTINCT FROM '4ea08bcf2d0645b3bac5c048222d11af' THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3873): owned column definitions, privileges or dependencies were changed.'; END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.layover_certified_computations'::regclass AND attname='expected_active_version' AND NOT attisdropped) THEN
    IF EXISTS (SELECT 1 FROM public.layover_certified_computations WHERE expected_active_version IS NOT NULL) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3873): stored compare-and-swap expectation data exists.';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.layover_certcomp_active_cas()') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex') <> '52bd66aa769d59dfe66be81394dd8d4fbfe53e481c7dbf658482f8c7ae456171') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3873): compare-and-swap function was changed.';
  END IF;
  FOR target,expected IN VALUES ('public.layover_certcomp_active_cas()','4cfe97d075f633a2cc0bebe83aab56ed') LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(target) AND (
      md5(jsonb_build_object('definition',pg_get_functiondef(p.oid),'leakproof',proleakproof,'parallel',proparallel,'cost',procost,'rows',prorows,'support',prosupport::text)::text)<>expected
      OR (SELECT md5(jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,CASE WHEN a.grantor=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)::text) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) IS DISTINCT FROM '6707d82f843f2381f486dd6215ed01fc'))
      THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3873): function was changed (attributes or privileges).'; END IF;
  END LOOP;
  IF (SELECT md5(pg_get_triggerdef(oid)||'|'||tgenabled::text) FROM pg_trigger WHERE tgrelid='public.layover_certified_computations'::regclass AND tgname='layover_certcomp_active_cas') IS DISTINCT FROM 'fb0454cd2a747ceb44d2a7659c908bd4' THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3873): trigger definition was changed.'; END IF;
END $pre$;
DROP TRIGGER IF EXISTS layover_certcomp_active_cas ON public.layover_certified_computations;
DROP FUNCTION IF EXISTS public.layover_certcomp_active_cas();
ALTER TABLE public.layover_certified_computations DROP COLUMN IF EXISTS expected_active_version;
DELETE FROM public.feature_flags WHERE flag='layover_canonical_snapshot_enabled' AND enabled=FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename='3873_layover_active_snapshot_compare_and_swap.sql';
NOTIFY pgrst, 'reload schema';
COMMIT;
DO $post$
BEGIN
  IF to_regprocedure('public.layover_certcomp_active_cas()') IS NOT NULL OR EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_canonical_snapshot_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3873): objects remain.';
  END IF;
END $post$;
