-- L15: immutable executable experience selections, starts and refused attempts.
-- Depends on 0127 sessions/stops/profiles and 3827/3828 state/active snapshot, nothing later.
-- Rollback: db/rollback/2026-10-18-3898-layover-experience-plan-versions-rollback.sql.
BEGIN;
DO $pre$ BEGIN
  IF to_regclass('public.layover_plan_stops') IS NULL OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='layover_sessions' AND column_name='active_snapshot_id'
  ) OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='layover_sessions' AND column_name='state')
    THEN RAISE EXCEPTION 'PRECONDITION FAILED (3898): sessions/stops and lifecycle/snapshot columns required'; END IF;
  IF to_regclass('public.layover_experience_plans') IS NOT NULL OR to_regprocedure('public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text)') IS NOT NULL
    OR to_regprocedure('public.layover_experience_plan_immutable()') IS NOT NULL
    THEN RAISE EXCEPTION 'PRECONDITION FAILED (3898): experience objects already exist'; END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_experience_execution_enabled' AND enabled IS NOT FALSE)
    THEN RAISE EXCEPTION 'PRECONDITION FAILED (3898): existing flag is not FALSE'; END IF;
END $pre$;
CREATE TABLE public.layover_experience_plans (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.layover_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version>0),
  operation TEXT NOT NULL CHECK(operation IN ('select','start')),
  phase TEXT NOT NULL CHECK(phase IN ('selected','executing','refused')),
  previous_plan_id UUID,
  snapshot_id TEXT,
  stops JSONB NOT NULL CHECK(jsonb_typeof(stops)='array'),
  contract JSONB,
  refusal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(session_id,version),
  CONSTRAINT layover_experience_plan_contract CHECK (COALESCE((
    (phase='refused' AND refusal_reason IS NOT NULL AND contract IS NULL) OR
    (phase IN ('selected','executing') AND refusal_reason IS NULL AND snapshot_id IS NOT NULL
      AND jsonb_typeof(contract)='object' AND contract->>'state'='READY'
      AND contract->>'snapshotId'=snapshot_id AND contract->>'riskBand' IN ('LOW','MODERATE','HIGH')
      AND jsonb_array_length(stops) BETWEEN 1 AND 6)
  ),FALSE)),
  CONSTRAINT layover_experience_plan_operation CHECK(phase='refused' OR operation='select' AND phase='selected' OR operation='start' AND phase='executing')
);
CREATE INDEX layover_experience_plans_user_idx ON public.layover_experience_plans(user_id);
ALTER TABLE public.layover_experience_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_experience_plans FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.layover_experience_plans TO service_role;
COMMENT ON TABLE public.layover_experience_plans IS 'Immutable compiler-selected contracts, explicit starts and refused attempts. Latest successful version is current; no visa/entry truth is stored here. Owner/session erasure cascades.';
CREATE FUNCTION public.layover_experience_plan_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
BEGIN RAISE EXCEPTION USING ERRCODE='LY440',MESSAGE='experience plan versions are immutable'; END $fn$;
CREATE TRIGGER layover_experience_plan_immutable BEFORE UPDATE ON public.layover_experience_plans
FOR EACH ROW EXECUTE FUNCTION public.layover_experience_plan_immutable();
REVOKE ALL ON FUNCTION public.layover_experience_plan_immutable() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.layover_experience_plan_immutable() TO service_role;

CREATE FUNCTION public.layover_experience_plan_write(
 p_id UUID,p_session_id UUID,p_user_id UUID,p_operation TEXT,p_previous_plan_id UUID,
 p_snapshot_id TEXT,p_session_updated_at TIMESTAMPTZ,p_prior_state TEXT,p_stops JSONB,p_contract JSONB,p_refusal TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE s public.layover_sessions%ROWTYPE; prior public.layover_experience_plans%ROWTYPE; result public.layover_experience_plans%ROWTYPE;
 actual_stops JSONB; refusal TEXT:=p_refusal; next_version INTEGER;
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('select','start') OR p_id IS NULL OR jsonb_typeof(p_stops) IS DISTINCT FROM 'array'
    THEN RETURN jsonb_build_object('ok',false,'reason','invalid_request'); END IF;
  SELECT * INTO s FROM public.layover_sessions WHERE id=p_session_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
  SELECT * INTO result FROM public.layover_experience_plans WHERE id=p_id;
  IF FOUND THEN
    IF result.session_id<>p_session_id OR result.user_id<>p_user_id OR result.operation<>p_operation OR result.previous_plan_id IS DISTINCT FROM p_previous_plan_id
      THEN RETURN jsonb_build_object('ok',false,'reason','idempotency_conflict'); END IF;
    RETURN jsonb_build_object('ok',result.phase<>'refused','reason',result.refusal_reason,'plan',to_jsonb(result),'duplicate',true);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_experience_execution_enabled' AND enabled IS TRUE)
    THEN RETURN jsonb_build_object('ok',false,'reason','feature_disabled'); END IF;
  -- Parent lock closes insert/delete races via the FK; row locks close edits/reordering.
  PERFORM id FROM public.layover_plan_stops WHERE session_id=p_session_id ORDER BY id FOR UPDATE;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'recommendationId',recommendation_id,'order',stop_order,'duration',duration_min,'travel',travel_min,'insideAirport',inside_airport,'title',title,'description',description,'placeId',place_id,'locationLabel',location_label,'lat',lat,'lng',lng) ORDER BY stop_order,id),'[]'::jsonb)
    INTO actual_stops FROM public.layover_plan_stops WHERE session_id=p_session_id;
  SELECT * INTO prior FROM public.layover_experience_plans WHERE session_id=p_session_id AND phase IN ('selected','executing') ORDER BY version DESC LIMIT 1;
  IF s.status<>'active' OR s.departure_time<=clock_timestamp() THEN refusal:='session_not_active';
  ELSIF actual_stops IS DISTINCT FROM p_stops THEN refusal:='plan_stops_changed';
  ELSIF s.active_snapshot_id IS DISTINCT FROM p_snapshot_id THEN refusal:='snapshot_changed';
  ELSIF s.updated_at IS DISTINCT FROM p_session_updated_at OR s.state IS DISTINCT FROM p_prior_state THEN refusal:='session_changed';
  ELSIF p_operation='start' AND (prior.id IS DISTINCT FROM p_previous_plan_id OR prior.phase IS DISTINCT FROM 'selected') THEN refusal:='selected_plan_changed';
  ELSIF prior.phase='executing' THEN refusal:='already_executing';
  ELSIF refusal IS NULL AND p_operation='select' AND (s.state IS NULL OR s.state NOT IN ('AIRPORT_ONLY','LANDSIDE_AVAILABLE','PLAN_SELECTED')) THEN refusal:='lifecycle_refused';
  ELSIF refusal IS NULL AND p_operation='start' AND s.state IS DISTINCT FROM 'PLAN_SELECTED' THEN refusal:='lifecycle_refused';
  END IF;
  IF refusal IS NULL AND NOT COALESCE((jsonb_typeof(p_contract)='object' AND p_contract->>'state'='READY'
    AND p_contract->>'snapshotId'=p_snapshot_id AND p_contract->>'riskBand' IN ('LOW','MODERATE','HIGH')
    AND (p_contract->>'expiresAt')::timestamptz>clock_timestamp()
    AND (p_contract->>'departBy')::timestamptz>=clock_timestamp()
    AND (p_contract->>'expectedAirportReturn')::timestamptz<=(p_contract->>'hardReturnBy')::timestamptz),FALSE)
    THEN refusal:='contract_unavailable'; END IF;
  SELECT coalesce(max(version),0)+1 INTO next_version FROM public.layover_experience_plans WHERE session_id=p_session_id;
  INSERT INTO public.layover_experience_plans(id,session_id,user_id,version,operation,phase,previous_plan_id,snapshot_id,stops,contract,refusal_reason)
    VALUES(p_id,p_session_id,p_user_id,next_version,p_operation,CASE WHEN refusal IS NOT NULL THEN 'refused' WHEN p_operation='select' THEN 'selected' ELSE 'executing' END,
      p_previous_plan_id,p_snapshot_id,p_stops,CASE WHEN refusal IS NULL THEN p_contract ELSE NULL END,refusal) RETURNING * INTO result;
  IF refusal IS NULL THEN UPDATE public.layover_sessions SET state=CASE WHEN p_operation='select' THEN 'PLAN_SELECTED' ELSE 'EXECUTING' END,updated_at=clock_timestamp() WHERE id=p_session_id; END IF;
  RETURN jsonb_build_object('ok',refusal IS NULL,'reason',refusal,'plan',to_jsonb(result),'duplicate',false);
END $fn$;
REVOKE ALL ON FUNCTION public.layover_experience_plan_write(UUID,UUID,UUID,TEXT,UUID,TEXT,TIMESTAMPTZ,TEXT,JSONB,JSONB,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.layover_experience_plan_write(UUID,UUID,UUID,TEXT,UUID,TEXT,TIMESTAMPTZ,TEXT,JSONB,JSONB,TEXT) TO service_role;
INSERT INTO public.feature_flags(flag,enabled) VALUES('layover_experience_execution_enabled',FALSE) ON CONFLICT(flag) DO NOTHING;
DO $post$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.layover_experience_plans'::regclass AND relrowsecurity)
    OR has_table_privilege('authenticated','public.layover_experience_plans','INSERT,UPDATE,DELETE')
    OR has_function_privilege('authenticated','public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text)','EXECUTE')
    OR NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_experience_execution_enabled' AND enabled IS FALSE)
    THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3898): service-only experience contract not installed'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
