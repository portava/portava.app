BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$ DECLARE a record; objects integer; BEGIN
  SELECT * INTO a FROM pg_attribute WHERE attrelid='public.airport_profiles'::regclass AND attname='curated_timing_evidence' AND NOT attisdropped;
  SELECT (a.attnum IS NOT NULL)::integer+(to_regprocedure('public.airport_profiles_timing_evidence_guard()') IS NOT NULL)::integer+(EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.airport_profiles'::regclass AND tgname='airport_profiles_timing_evidence_guard'))::integer INTO objects;
  IF objects=0 THEN RETURN; END IF;
  IF objects<>3 THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3881): incomplete timing projection'; END IF;
  LOCK TABLE public.airport_profiles,public.airport_curated_facts IN ACCESS EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM public.airport_profiles WHERE curated_timing_evidence IS NOT NULL) OR EXISTS(SELECT 1 FROM public.airport_curated_facts WHERE value ? 'timingEvidence') THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3881): sourced timing evidence exists'; END IF;
  IF a.atttypid<>'jsonb'::regtype OR a.attnotnull OR a.atthasdef OR a.attacl IS NOT NULL OR a.attgenerated<>'' OR a.attidentity<>''
    OR col_description(a.attrelid,a.attnum) IS DISTINCT FROM '3881: published anonymous timing sample evidence with source fact identity; never synthetic percentiles. Read-time expiry/context validation is mandatory.'
    OR EXISTS(SELECT 1 FROM pg_depend WHERE refclassid='pg_class'::regclass AND refobjid=a.attrelid AND refobjsubid=a.attnum)
    THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3881): timing column changed or depended upon'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=a.attrelid AND tgname='airport_profiles_timing_evidence_guard' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER airport_profiles_timing_evidence_guard BEFORE INSERT OR UPDATE ON public.airport_profiles FOR EACH ROW EXECUTE FUNCTION public.airport_profiles_timing_evidence_guard()') THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3881): projection trigger changed'; END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE oid=to_regprocedure('public.airport_profiles_timing_evidence_guard()') AND (
    md5(prosrc)<>'7c1af3d7d3cf2fd6f7dbb83d0f7507d0' OR prosecdef OR proleakproof OR proisstrict OR provolatile<>'v' OR proparallel<>'u' OR procost<>100 OR prorows<>0 OR prosupport<>0 OR prorettype<>'trigger'::regtype OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
    OR (SELECT md5(jsonb_agg(jsonb_build_array(CASE WHEN x.grantee=0 THEN 'PUBLIC' WHEN x.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(x.grantee) END,CASE WHEN x.grantor=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(x.grantor) END,x.privilege_type,x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' WHEN x.grantee=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type,x.is_grantable)::text) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x) IS DISTINCT FROM '6707d82f843f2381f486dd6215ed01fc')) THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3881): projection function changed'; END IF;
END $pre$;
DROP TRIGGER IF EXISTS airport_profiles_timing_evidence_guard ON public.airport_profiles;
DROP FUNCTION IF EXISTS public.airport_profiles_timing_evidence_guard();
ALTER TABLE public.airport_profiles DROP COLUMN IF EXISTS curated_timing_evidence;
DELETE FROM public.schema_migration_ledger WHERE filename='3881_airport_sourced_timing.sql';
NOTIFY pgrst,'reload schema';
COMMIT;
