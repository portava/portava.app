-- Optional self-report, never an attendance, proximity or Trust assertion.
-- Activation requires an explicit retention choice in flag metadata.
BEGIN;
INSERT INTO public.feature_flags(flag,enabled,metadata) VALUES('telegraph_outcome_feedback_enabled',false,'{"retention_days":null,"evidence":"self_reported"}'::jsonb) ON CONFLICT(flag) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.telegraph_outcome_feedback(
 plan_id uuid NOT NULL REFERENCES public.meetups(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 response text NOT NULL CHECK(response IN ('met','did_not_meet')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(plan_id,user_id)
);
CREATE INDEX IF NOT EXISTS telegraph_outcome_feedback_expiry_idx ON public.telegraph_outcome_feedback(expires_at);
ALTER TABLE public.telegraph_outcome_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegraph_outcome_feedback FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.telegraph_outcome_feedback TO service_role;

CREATE OR REPLACE FUNCTION public.telegraph_outcome_context(p_thread uuid,p_plan uuid,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE plan public.meetups%ROWTYPE; member public.message_thread_members%ROWTYPE; days integer; value text;
BEGIN
 SELECT CASE WHEN enabled AND metadata->>'retention_days' ~ '^[0-9]{1,3}$' THEN (metadata->>'retention_days')::integer ELSE NULL END INTO days FROM public.feature_flags WHERE flag='telegraph_outcome_feedback_enabled';
 IF days IS NULL OR days NOT BETWEEN 1 AND 365 THEN RETURN '{"enabled":false}'::jsonb; END IF;
 SELECT * INTO member FROM public.message_thread_members WHERE thread_id=p_thread AND user_id=p_actor AND left_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'outcome_unavailable'; END IF;
 SELECT * INTO plan FROM public.meetups WHERE id=p_plan AND chat_thread_id=p_thread FOR SHARE;
 IF NOT FOUND OR plan.status IS DISTINCT FROM 'confirmed' OR plan.creator_id IS NULL OR plan.starts_at IS NULL OR coalesce(plan.ends_at,plan.starts_at)>now()
   OR coalesce(plan.ends_at,plan.starts_at)<now()-make_interval(days=>days) THEN RAISE EXCEPTION 'outcome_unavailable'; END IF;
 IF plan.creator_id<>p_actor AND (NOT EXISTS(SELECT 1 FROM public.meetup_invites WHERE meetup_id=p_plan AND user_id=p_actor AND status IN ('going','maybe'))
  OR (member.visible_from_at IS NOT NULL AND plan.starts_at<member.visible_from_at)) THEN RAISE EXCEPTION 'outcome_unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM public.blocks WHERE (blocker_id=p_actor AND blocked_id=plan.creator_id) OR (blocked_id=p_actor AND blocker_id=plan.creator_id)) THEN RAISE EXCEPTION 'outcome_unavailable'; END IF;
 SELECT response INTO value FROM public.telegraph_outcome_feedback WHERE plan_id=p_plan AND user_id=p_actor AND expires_at>now();
 RETURN jsonb_build_object('enabled',true,'retentionDays',days,'response',value,'evidence','self_reported');
END $$;

CREATE OR REPLACE FUNCTION public.telegraph_record_outcome(p_thread uuid,p_plan uuid,p_actor uuid,p_response text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE context jsonb; days integer;
BEGIN
 IF p_response IS NULL OR p_response NOT IN ('met','did_not_meet') THEN RAISE EXCEPTION 'invalid_outcome_response'; END IF;
 context:=public.telegraph_outcome_context(p_thread,p_plan,p_actor);
 IF context->>'enabled' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'outcome_disabled'; END IF;
 days:=(context->>'retentionDays')::integer;
 INSERT INTO public.telegraph_outcome_feedback(plan_id,user_id,response,expires_at)
 VALUES(p_plan,p_actor,p_response,now()+make_interval(days=>days))
 ON CONFLICT(plan_id,user_id) DO UPDATE SET response=EXCLUDED.response,updated_at=now(),
 created_at=CASE WHEN telegraph_outcome_feedback.expires_at<=now() THEN now() ELSE telegraph_outcome_feedback.created_at END,
 expires_at=CASE WHEN telegraph_outcome_feedback.expires_at<=now() THEN EXCLUDED.expires_at ELSE telegraph_outcome_feedback.expires_at END;
 RETURN jsonb_build_object('response',p_response,'evidence','self_reported');
END $$;

CREATE OR REPLACE FUNCTION public.telegraph_outcome_summary()
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 WITH reports AS (SELECT plan_id,user_id,response FROM public.telegraph_outcome_feedback WHERE expires_at>now())
 SELECT jsonb_build_object('evidence','self_reported','scope','unexpired responses across instances',
 'sampleSize',CASE WHEN count(DISTINCT user_id)>=10 THEN count(*) ELSE NULL END,
 'reportedMet',CASE WHEN count(DISTINCT user_id)>=10 THEN count(*) FILTER(WHERE response='met') ELSE NULL END,
 'reportedDidNotMeet',CASE WHEN count(DISTINCT user_id)>=10 THEN count(*) FILTER(WHERE response='did_not_meet') ELSE NULL END,
 'plansWithReports',CASE WHEN count(DISTINCT user_id)>=10 THEN count(DISTINCT plan_id) ELSE NULL END,
 'suppressed',count(DISTINCT user_id)<10,'verifiedAttendance',false) FROM reports
$$;
CREATE OR REPLACE FUNCTION public.telegraph_purge_outcome_feedback()
RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE n integer;
BEGIN
 WITH expired AS(SELECT plan_id,user_id FROM public.telegraph_outcome_feedback WHERE expires_at<=now() ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)
 DELETE FROM public.telegraph_outcome_feedback f USING expired e WHERE f.plan_id=e.plan_id AND f.user_id=e.user_id;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.telegraph_outcome_context(uuid,uuid,uuid),public.telegraph_record_outcome(uuid,uuid,uuid,text),public.telegraph_outcome_summary(),public.telegraph_purge_outcome_feedback() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_outcome_context(uuid,uuid,uuid),public.telegraph_record_outcome(uuid,uuid,uuid,text),public.telegraph_outcome_summary(),public.telegraph_purge_outcome_feedback() TO service_role;
COMMIT;
