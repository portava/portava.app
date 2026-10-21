-- L205: atomic, minimal audit of protected Layover service writes.
-- Dependencies below 3890: profiles, layover_sessions, feature_flags + its audit log.
-- Activation, not migration order, installs triggers on the then-present Layover
-- tables. This commutes with higher-numbered table/column migrations while the
-- FALSE seed stays off. Re-enable after schema additions; the CI inventory guard
-- proves every protected table is installed after activation.
-- Rollback: db/rollback/2026-10-18-3890-layover-service-write-audit-rollback.sql;
-- refuses live flag, audit records, or feature_flag_audit_log history.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $pre$ BEGIN
 IF to_regclass('public.layover_sessions') IS NULL OR to_regclass('public.profiles') IS NULL
 OR to_regclass('public.feature_flags') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED (3890): base Layover and flags required'; END IF;
END $pre$;
CREATE TABLE IF NOT EXISTS public.layover_service_write_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid,
 actor_kind text NOT NULL CHECK(actor_kind IN ('user','system','database_operator')),
 actor_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
 system_actor text,
 route text NOT NULL CHECK(length(route) BETWEEN 1 AND 240),
 layover_session_id uuid REFERENCES public.layover_sessions(id) ON DELETE SET NULL,
 table_name text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
 outcome text NOT NULL DEFAULT 'applied' CHECK(outcome='applied'),
 created_at timestamptz NOT NULL DEFAULT now(),
 retain_until timestamptz NOT NULL DEFAULT now()+interval '30 days',
 CONSTRAINT layover_service_audit_retention_bound CHECK(retain_until>=created_at AND retain_until<=created_at+interval '30 days')
);
CREATE INDEX IF NOT EXISTS layover_service_write_audit_session_idx ON public.layover_service_write_audit(layover_session_id,created_at DESC);
CREATE INDEX IF NOT EXISTS layover_service_write_audit_retention_idx ON public.layover_service_write_audit(retain_until);
ALTER TABLE public.layover_service_write_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_service_write_audit FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.layover_service_write_audit TO service_role;
CREATE POLICY layover_service_write_audit_service_read ON public.layover_service_write_audit FOR SELECT TO service_role USING(true);

CREATE OR REPLACE FUNCTION public.layover_capture_service_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE h jsonb; r jsonb; role_name text; actor uuid; sid uuid; request_id uuid; kind text; system_name text; route_name text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_service_write_audit_enabled' AND enabled) THEN RETURN NULL; END IF;
 role_name:=current_setting('role',true);
 IF role_name IN ('anon','authenticated') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='layover_audit_server_authoritative'; END IF;
 h:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb);
 IF role_name='service_role' THEN
  route_name:=nullif(h->>'x-portava-layover-route','');
  request_id:=nullif(h->>'x-portava-layover-request','')::uuid;
  actor:=nullif(h->>'x-portava-layover-actor','')::uuid;
  system_name:=nullif(h->>'x-portava-layover-system','');
  IF route_name IS NULL OR request_id IS NULL OR (actor IS NULL AND system_name IS NULL)
   OR (actor IS NOT NULL AND system_name IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='layover_audit_verified_scope_required'; END IF;
  kind:=CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END;
 ELSE
  kind:='database_operator';system_name:=session_user;route_name:='DATABASE OPERATOR';
 END IF;
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 sid:=CASE WHEN TG_TABLE_NAME='layover_sessions' THEN nullif(r->>'id','')::uuid ELSE coalesce(nullif(r->>'session_id',''),nullif(r->>'layover_session_id',''))::uuid END;
 -- Retention and erasure never preserve a foreign key to a deleted identity.
 IF actor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=actor AND account_status<>'deleted') THEN actor:=NULL; END IF;
 IF sid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.layover_sessions WHERE id=sid) THEN sid:=NULL; END IF;
 INSERT INTO public.layover_service_write_audit(request_id,actor_kind,actor_user_id,system_actor,route,layover_session_id,table_name,operation)
 VALUES(request_id,kind,actor,system_name,left(route_name,240),sid,TG_TABLE_NAME,TG_OP);
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_capture_service_write() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.layover_install_service_write_audit() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE t record;
BEGIN
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND left(c.relname,8)='layover_' AND c.relname<>'layover_service_write_audit'
 LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS layover_service_write_audit ON public.%I',t.relname);
  EXECUTE format('CREATE TRIGGER layover_service_write_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.layover_capture_service_write()',t.relname);
 END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_install_service_write_audit() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.layover_service_audit_activation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
 IF NEW.flag='layover_service_write_audit_enabled' AND NEW.enabled THEN PERFORM public.layover_install_service_write_audit(); END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_service_audit_activation() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER layover_service_audit_activation AFTER INSERT OR UPDATE ON public.feature_flags FOR EACH ROW EXECUTE FUNCTION public.layover_service_audit_activation();
INSERT INTO public.feature_flags(flag,enabled,description) VALUES('layover_service_write_audit_enabled',false,'3890: atomically audit protected Layover writes with verified server request or worker identity; activate after schema press') ON CONFLICT(flag) DO NOTHING;
DO $existing$ BEGIN
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_service_write_audit_enabled' AND enabled) THEN PERFORM public.layover_install_service_write_audit(); END IF;
END $existing$;

-- Delete only expired audit rows, bounded; there is no direct service-role
-- UPDATE/DELETE grant. Identity FKs independently null on account/session erasure.
CREATE OR REPLACE FUNCTION public.layover_expire_service_write_audit(p_limit integer DEFAULT 500) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE n integer;
BEGIN
 IF p_limit<1 OR p_limit>5000 THEN RAISE EXCEPTION 'layover_audit_invalid_limit'; END IF;
 DELETE FROM public.layover_service_write_audit WHERE id IN (SELECT id FROM public.layover_service_write_audit WHERE retain_until<=now() ORDER BY retain_until LIMIT p_limit FOR UPDATE SKIP LOCKED);
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_expire_service_write_audit(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.layover_expire_service_write_audit(integer) TO service_role;
-- Account deletion retains a tombstone profile, so FK SET NULL alone cannot
-- erase its actor identifier. Scrub atomically with the deletion tombstone.
CREATE OR REPLACE FUNCTION public.layover_service_audit_erase_actor() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
 IF NEW.account_status='deleted' THEN
  UPDATE public.layover_service_write_audit SET actor_user_id=NULL,layover_session_id=NULL WHERE actor_user_id=NEW.id;
 END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_service_audit_erase_actor() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER layover_service_audit_erase_actor AFTER UPDATE OF account_status ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.layover_service_audit_erase_actor();
DO $post$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.layover_service_write_audit'::regclass AND relrowsecurity)
 OR has_table_privilege('authenticated','public.layover_service_write_audit','SELECT')
 OR has_table_privilege('service_role','public.layover_service_write_audit','UPDATE') THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3890): audit privileges'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
