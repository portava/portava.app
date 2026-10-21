-- L259: atomic route watches for published recommendations and copied plan stops.
-- Opaque HMAC directional corridor identities; no coordinates or provider payload.
-- snapshot_id is provenance TEXT: deadline changes and compaction do not erase a
-- route still used by a recommendation or a stop. Stop watches survive rec replacement.
-- Depends only on0127/2700/3623/3828/3871 and feature_flags. FALSE seed.
-- Rollback: db/rollback/2026-10-18-3895-layover-route-subject-index-rollback.sql.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $pre$ BEGIN
 IF to_regclass('public.layover_certified_computations') IS NULL OR to_regclass('public.layover_plan_stops') IS NULL
 OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='layover_sessions' AND column_name='active_snapshot_id')
 OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='layover_recommendations' AND column_name='plan_json')
 THEN RAISE EXCEPTION 'PRECONDITION FAILED (3895): canonical recommendation and plan schemas required'; END IF;
 IF to_regclass('public.layover_route_subjects') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('layover_recommendation_route_watch','layover_stop_route_watch','layover_active_sessions_by_routes'))
 THEN RAISE EXCEPTION 'PRECONDITION FAILED (3895): route watch objects already exist'; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_route_subjects_enabled' AND enabled IS NOT FALSE)
 THEN RAISE EXCEPTION 'PRECONDITION FAILED (3895): existing flag is not FALSE'; END IF;
END $pre$;
CREATE TABLE public.layover_route_subjects (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id UUID NOT NULL REFERENCES public.layover_sessions(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 snapshot_id TEXT NOT NULL CHECK(length(snapshot_id)>0),
 recommendation_id UUID REFERENCES public.layover_recommendations(id) ON DELETE CASCADE,
 stop_id UUID REFERENCES public.layover_plan_stops(id) ON DELETE CASCADE,
 route_ref TEXT NOT NULL CHECK(route_ref ~ '^layover-route:v1:[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT layover_route_subject_source CHECK((recommendation_id IS NOT NULL)::integer+(stop_id IS NOT NULL)::integer=1)
);
CREATE UNIQUE INDEX layover_route_subjects_recommendation_idx ON public.layover_route_subjects(recommendation_id,route_ref) WHERE recommendation_id IS NOT NULL;
CREATE UNIQUE INDEX layover_route_subjects_stop_idx ON public.layover_route_subjects(stop_id,route_ref) WHERE stop_id IS NOT NULL;
CREATE INDEX layover_route_subjects_route_idx ON public.layover_route_subjects(route_ref,session_id);
CREATE INDEX layover_route_subjects_session_idx ON public.layover_route_subjects(session_id);
CREATE INDEX layover_route_subjects_owner_idx ON public.layover_route_subjects(user_id);
ALTER TABLE public.layover_route_subjects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_route_subjects FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.layover_route_subjects TO service_role;
COMMENT ON TABLE public.layover_route_subjects IS 'L259: last published route watches; per-recommendation writes and copied per-stop watches are atomic. Snapshot is provenance, never a claim of fresh measurement. No coordinates. Source/session/owner deletion cascades.';

CREATE FUNCTION public.layover_recommendation_route_watch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s public.layover_sessions%ROWTYPE; refs JSONB; routing JSONB;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_route_subjects_enabled' AND enabled IS TRUE) THEN RETURN NULL; END IF;
 -- Status-only supersession/moderation preserves the last published dependency.
 IF TG_OP='UPDATE' AND NEW.session_id=OLD.session_id AND NEW.snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id AND NEW.plan_json->'routing' IS NOT DISTINCT FROM OLD.plan_json->'routing' THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag IN ('layover_decision_persistence_enabled','layover_canonical_snapshot_enabled','layover_recommendation_snapshot_enabled','layover_recommendation_status_enabled','layover_stable_recommendation_ids_enabled') AND enabled IS TRUE)<>5
 THEN RAISE EXCEPTION USING ERRCODE='LY451',MESSAGE='route watch prerequisites disabled'; END IF;
 SELECT * INTO s FROM public.layover_sessions WHERE id=NEW.session_id FOR UPDATE;
 IF NOT FOUND OR s.status NOT IN ('active','returning') OR s.departure_time<=clock_timestamp() OR NEW.snapshot_id IS NULL OR s.active_snapshot_id IS DISTINCT FROM NEW.snapshot_id
 OR NOT EXISTS(SELECT 1 FROM public.layover_certified_computations c WHERE c.snapshot_id=NEW.snapshot_id AND c.session_id=NEW.session_id)
 THEN RAISE EXCEPTION USING ERRCODE='LY452',MESSAGE='route watch canonical session changed'; END IF;
 IF NEW.plan_json IS NULL OR jsonb_typeof(NEW.plan_json)<>'object' THEN RAISE EXCEPTION USING ERRCODE='LY453',MESSAGE='route watch recommendation contract missing'; END IF;
 routing:=NEW.plan_json->'routing';refs:=coalesce(routing->'routeSubjectRefs','[]'::jsonb);
 IF jsonb_typeof(refs)<>'array' OR jsonb_array_length(refs)>64 OR EXISTS(SELECT 1 FROM jsonb_array_elements(refs) r WHERE jsonb_typeof(r)<>'string' OR r#>>'{}' !~ '^layover-route:v1:[a-f0-9]{64}$')
 OR (routing->>'state'='FEASIBLE' AND jsonb_array_length(refs)<>2)
 THEN RAISE EXCEPTION USING ERRCODE='LY453',MESSAGE='invalid measured route watch'; END IF;
 DELETE FROM public.layover_route_subjects WHERE recommendation_id=NEW.id;
 INSERT INTO public.layover_route_subjects(session_id,user_id,snapshot_id,recommendation_id,route_ref)
 SELECT NEW.session_id,s.user_id,NEW.snapshot_id,NEW.id,r FROM (SELECT DISTINCT jsonb_array_elements_text(refs) r) q;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_recommendation_route_watch() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER layover_recommendation_route_watch AFTER INSERT OR UPDATE ON public.layover_recommendations FOR EACH ROW EXECUTE FUNCTION public.layover_recommendation_route_watch();

CREATE FUNCTION public.layover_stop_route_watch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s public.layover_sessions%ROWTYPE; rec public.layover_recommendations%ROWTYPE; copied INTEGER;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_route_subjects_enabled' AND enabled IS TRUE) THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' AND NEW.session_id=OLD.session_id AND (NEW.recommendation_id IS NOT DISTINCT FROM OLD.recommendation_id OR NEW.recommendation_id IS NULL) THEN RETURN NULL; END IF;
 SELECT * INTO s FROM public.layover_sessions WHERE id=NEW.session_id FOR UPDATE;
 IF NOT FOUND OR s.status NOT IN ('active','returning') OR s.departure_time<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='LY452',MESSAGE='route watch session inactive'; END IF;
 DELETE FROM public.layover_route_subjects WHERE stop_id=NEW.id;
 IF NEW.recommendation_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO rec FROM public.layover_recommendations WHERE id=NEW.recommendation_id AND session_id=NEW.session_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='LY452',MESSAGE='route watch recommendation not owned by stop session'; END IF;
 INSERT INTO public.layover_route_subjects(session_id,user_id,snapshot_id,stop_id,route_ref)
 SELECT NEW.session_id,s.user_id,b.snapshot_id,NEW.id,b.route_ref FROM public.layover_route_subjects b WHERE b.recommendation_id=NEW.recommendation_id;
 GET DIAGNOSTICS copied=ROW_COUNT;
 IF NOT rec.inside_airport AND copied=0 THEN RAISE EXCEPTION USING ERRCODE='LY453',MESSAGE='route watch missing for landside plan stop'; END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_stop_route_watch() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER layover_stop_route_watch AFTER INSERT OR UPDATE ON public.layover_plan_stops FOR EACH ROW EXECUTE FUNCTION public.layover_stop_route_watch();

CREATE FUNCTION public.layover_active_sessions_by_routes(p_refs TEXT[],p_now TIMESTAMPTZ,p_limit INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE result JSONB;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_route_subjects_enabled' AND enabled IS TRUE) THEN RAISE EXCEPTION USING ERRCODE='LY451',MESSAGE='route subject capability is disabled'; END IF;
 IF p_now IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR p_refs IS NULL OR cardinality(p_refs) NOT BETWEEN 1 AND 64 OR EXISTS(SELECT 1 FROM unnest(p_refs) r WHERE r IS NULL OR r !~ '^layover-route:v1:[a-f0-9]{64}$') THEN RAISE EXCEPTION USING ERRCODE='LY453',MESSAGE='invalid bounded route subject query'; END IF;
 SELECT coalesce(jsonb_agg(q.result ORDER BY q.id),'[]'::jsonb) INTO result FROM (
  SELECT s.id,jsonb_build_object('session',to_jsonb(s),'routeRefs',jsonb_agg(DISTINCT b.route_ref)) result
  FROM public.layover_route_subjects b JOIN public.layover_sessions s ON s.id=b.session_id
  WHERE b.route_ref=ANY(p_refs) AND b.user_id=s.user_id AND s.status IN ('active','returning') AND s.departure_time>p_now
  GROUP BY s.id ORDER BY s.id LIMIT p_limit+1
 ) q;RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_active_sessions_by_routes(TEXT[],TIMESTAMPTZ,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.layover_active_sessions_by_routes(TEXT[],TIMESTAMPTZ,INTEGER) TO service_role;
INSERT INTO public.feature_flags(flag,enabled,description) VALUES('layover_route_subjects_enabled',FALSE,'3895: atomic opaque route watches; requires canonical/status/stable generation and configured HMAC key') ON CONFLICT(flag) DO NOTHING;
DO $post$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.layover_route_subjects'::regclass AND relrowsecurity)
 OR NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_route_subjects_enabled' AND enabled IS FALSE)
 OR has_table_privilege('authenticated','public.layover_route_subjects','SELECT,INSERT,UPDATE,DELETE')
 OR has_table_privilege('service_role','public.layover_route_subjects','INSERT,UPDATE,DELETE')
 OR has_function_privilege('anon','public.layover_active_sessions_by_routes(text[],timestamptz,integer)','EXECUTE')
 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3895): route watch boundary unsafe'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
