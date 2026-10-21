-- Rollback 3896. Refuse while any certified computation exists: its immutability is part of the stored evidence.
-- No rows are deleted, no CASCADE, no flags. Repeat is a no-op; a modified function refuses instead of being erased.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;
LOCK TABLE public.layover_certified_computations IN ACCESS EXCLUSIVE MODE;
DO $pre$
DECLARE n integer; target text; expected text;
BEGIN
  SELECT (to_regprocedure('public.layover_certified_computations_are_immutable()') IS NOT NULL)::integer +(EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.layover_certified_computations'::regclass AND tgname='layover_certified_computations_immutable'))::integer INTO n;
  IF n=0 THEN RETURN; END IF;
  IF n<>2 THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3896): incomplete immutability schema.'; END IF;
  IF EXISTS (SELECT 1 FROM public.layover_certified_computations) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3896): certified computation data exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.layover_certified_computations_are_immutable()') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex') <> '2573f0aea52714bc3691372ebad09bbe1a8e5bd29a4863ce5cb718a24bc9f874') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3896): immutability function was changed.';
  END IF;
  FOR target,expected IN VALUES ('public.layover_certified_computations_are_immutable()','00eb4948eb2af19f68729c14a6294aa9') LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(target) AND (
      md5(jsonb_build_object('definition',pg_get_functiondef(p.oid),'leakproof',proleakproof,'parallel',proparallel,'cost',procost,'rows',prorows,'support',prosupport::text)::text)<>expected
      OR (SELECT md5(jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,CASE WHEN a.grantor=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)::text) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) IS DISTINCT FROM '6707d82f843f2381f486dd6215ed01fc'))
      THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3896): function was changed (attributes or privileges).'; END IF;
  END LOOP;
  IF (SELECT md5(pg_get_triggerdef(oid)||'|'||tgenabled::text) FROM pg_trigger WHERE tgrelid='public.layover_certified_computations'::regclass AND tgname='layover_certified_computations_immutable') IS DISTINCT FROM '39683b1a3b17caa41c6c8c9e04475064' THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3896): trigger definition was changed.'; END IF;
END $pre$;
DROP TRIGGER IF EXISTS layover_certified_computations_immutable ON public.layover_certified_computations;
DROP FUNCTION IF EXISTS public.layover_certified_computations_are_immutable();
DELETE FROM public.schema_migration_ledger WHERE filename='3896_layover_certified_computations_immutable.sql';
COMMIT;
DO $post$
BEGIN
  IF to_regprocedure('public.layover_certified_computations_are_immutable()') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3896): immutability function remains.';
  END IF;
END $post$;
