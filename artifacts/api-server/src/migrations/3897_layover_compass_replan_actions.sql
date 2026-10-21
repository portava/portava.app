-- L112: explicit traveller-authorized recheck of current saved facts. A model may propose, never execute.
-- Additive; depends only on profiles/sessions (0127) and active_snapshot_id (3828). Nothing later owns these names.
-- No saved schedule, constraint, flight status or provider fact is changed by this action.
-- Rollback: db/rollback/2026-10-18-3897-layover-compass-replan-actions-rollback.sql; refuses data/flag history.
BEGIN;
DO $pre$ BEGIN
  IF to_regclass('public.layover_sessions') IS NULL OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='layover_sessions' AND column_name='active_snapshot_id'
  ) THEN RAISE EXCEPTION 'PRECONDITION FAILED (3897): sessions with active snapshot required (3828)'; END IF;
  IF to_regclass('public.layover_compass_actions') IS NOT NULL OR to_regprocedure('public.claim_layover_compass_replan(uuid,uuid,uuid)') IS NOT NULL
    OR to_regprocedure('public.layover_compass_action_guard()') IS NOT NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED (3897): action objects already exist'; END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_compass_replan_enabled' AND enabled IS NOT FALSE)
    THEN RAISE EXCEPTION 'PRECONDITION FAILED (3897): existing flag is not FALSE'; END IF;
END $pre$;

CREATE TABLE public.layover_compass_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.layover_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind='recheck_current_facts'),
  expected_snapshot_id TEXT NOT NULL,
  expected_session_updated_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','running','applied','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,
  CONSTRAINT layover_compass_action_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  CONSTRAINT layover_compass_action_result CHECK (result IS NULL OR jsonb_typeof(result)='object'),
  CONSTRAINT layover_compass_action_state CHECK (
    (status='proposed' AND started_at IS NULL AND completed_at IS NULL AND result IS NULL) OR
    (status='running' AND started_at IS NOT NULL AND completed_at IS NULL AND result IS NULL) OR
    (status IN ('applied','failed') AND started_at IS NOT NULL AND completed_at IS NOT NULL AND result IS NOT NULL)
  )
);
CREATE INDEX layover_compass_actions_session_idx ON public.layover_compass_actions(session_id);
CREATE INDEX layover_compass_actions_user_idx ON public.layover_compass_actions(user_id);
ALTER TABLE public.layover_compass_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_compass_actions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.layover_compass_actions TO service_role;
COMMENT ON TABLE public.layover_compass_actions IS 'Owner-bound L112 explicit replan approvals and durable results; server-only, erased with session/user. A proposal grants no execution authority.';

CREATE FUNCTION public.layover_compass_action_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'proposed' OR NOT EXISTS (SELECT 1 FROM public.layover_sessions s WHERE s.id=NEW.session_id AND s.user_id=NEW.user_id)
      THEN RAISE EXCEPTION USING ERRCODE='LY430', MESSAGE='compass action must begin as an owned proposal'; END IF;
  ELSE
    IF ROW(NEW.id,NEW.session_id,NEW.user_id,NEW.kind,NEW.expected_snapshot_id,NEW.expected_session_updated_at,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.session_id,OLD.user_id,OLD.kind,OLD.expected_snapshot_id,OLD.expected_session_updated_at,OLD.created_at,OLD.expires_at)
      OR NOT ((OLD.status='proposed' AND NEW.status='running') OR (OLD.status='running' AND NEW.status IN ('applied','failed')))
      OR (OLD.status='running' AND NEW.started_at IS DISTINCT FROM OLD.started_at)
      THEN RAISE EXCEPTION USING ERRCODE='LY431', MESSAGE='compass action evidence and completed outcomes are immutable'; END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER layover_compass_action_guard BEFORE INSERT OR UPDATE ON public.layover_compass_actions
FOR EACH ROW EXECUTE FUNCTION public.layover_compass_action_guard();
REVOKE ALL ON FUNCTION public.layover_compass_action_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.layover_compass_action_guard() TO service_role;

CREATE FUNCTION public.claim_layover_compass_replan(p_action_id UUID,p_session_id UUID,p_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE s public.layover_sessions%ROWTYPE; a public.layover_compass_actions%ROWTYPE;
BEGIN
  -- Session before action is the common lock order, including session deletion cascades.
  SELECT * INTO s FROM public.layover_sessions WHERE id=p_session_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed',false,'reason','not_found'); END IF;
  SELECT * INTO a FROM public.layover_compass_actions WHERE id=p_action_id AND session_id=p_session_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed',false,'reason','not_found'); END IF;
  IF a.status IN ('applied','failed') THEN RETURN jsonb_build_object('claimed',false,'reason','completed','result',a.result); END IF;
  IF a.status='running' THEN RETURN jsonb_build_object('claimed',false,'reason','action_in_progress'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_compass_replan_enabled' AND enabled IS TRUE)
    THEN RETURN jsonb_build_object('claimed',false,'reason','feature_disabled'); END IF;
  IF a.expires_at <= clock_timestamp() THEN RETURN jsonb_build_object('claimed',false,'reason','action_expired'); END IF;
  IF s.status NOT IN ('active','returning') OR s.departure_time <= clock_timestamp()
    THEN RETURN jsonb_build_object('claimed',false,'reason','session_ended'); END IF;
  IF s.active_snapshot_id IS DISTINCT FROM a.expected_snapshot_id OR s.updated_at IS DISTINCT FROM a.expected_session_updated_at
    THEN RETURN jsonb_build_object('claimed',false,'reason','action_stale'); END IF;
  UPDATE public.layover_compass_actions SET status='running',started_at=clock_timestamp() WHERE id=a.id;
  RETURN jsonb_build_object('claimed',true);
END $fn$;
REVOKE ALL ON FUNCTION public.claim_layover_compass_replan(UUID,UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_layover_compass_replan(UUID,UUID,UUID) TO service_role;
INSERT INTO public.feature_flags(flag,enabled) VALUES ('layover_compass_replan_enabled',FALSE) ON CONFLICT(flag) DO NOTHING;

DO $post$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.layover_compass_actions'::regclass AND relrowsecurity)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_compass_replan_enabled' AND enabled IS FALSE)
    OR has_table_privilege('authenticated','public.layover_compass_actions','INSERT,UPDATE,DELETE')
    OR has_function_privilege('authenticated','public.claim_layover_compass_replan(uuid,uuid,uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3897): service-only action contract not installed'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
