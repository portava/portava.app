-- Private, opt-in image/video drafts. This migration does not enable generation.
BEGIN;
CREATE TABLE IF NOT EXISTS public.media_generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  client_request_id uuid NOT NULL,
  request_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image','video')),
  model text NOT NULL,
  provider_input jsonb NOT NULL,
  consent_version text NOT NULL,
  estimated_cost_usd numeric(12,6) NOT NULL CHECK (estimated_cost_usd > 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','ready','failed','blocked','deleted')),
  provider_receipt jsonb,
  completion jsonb,
  webhook_event_id text,
  submission_started_at timestamptz,
  provider_cleaned boolean NOT NULL DEFAULT false,
  delete_requested boolean NOT NULL DEFAULT false,
  storage_path text,
  mime_type text,
  failure_code text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS media_generation_owner_created ON public.media_generation_jobs(owner_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS media_generation_created ON public.media_generation_jobs(created_at);
CREATE INDEX IF NOT EXISTS media_generation_due ON public.media_generation_jobs(next_attempt_at)
 WHERE state IN ('queued','running') OR NOT provider_cleaned OR delete_requested;
ALTER TABLE public.media_generation_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_generation_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_generation_jobs TO service_role;

-- Reserve before any external request. A single transaction serializes the
-- global+owner rolling-day budget; deleted/failed requests still consume the
-- estimate so uncertain charges/refunds cannot accidentally reopen spending.
CREATE OR REPLACE FUNCTION public.media_generation_reserve(
 p_owner uuid, p_client_request uuid, p_hash text, p_kind text, p_model text,
 p_input jsonb, p_policy text, p_cost numeric, p_owner_budget numeric, p_global_budget numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE existing public.media_generation_jobs; saved public.media_generation_jobs;
BEGIN
 IF p_owner IS NULL OR p_client_request IS NULL OR p_hash IS NULL OR length(p_hash) <> 64
   OR p_cost IS NULL OR p_cost <= 0 OR p_owner_budget IS NULL OR p_owner_budget <= 0
   OR p_global_budget IS NULL OR p_global_budget <= 0 THEN
   RAISE EXCEPTION 'invalid_generation_request';
 END IF;
 PERFORM pg_advisory_xact_lock(4025, 1);
 SELECT * INTO existing FROM public.media_generation_jobs WHERE owner_user_id=p_owner AND client_request_id=p_client_request;
 IF FOUND THEN
   IF existing.request_hash <> p_hash THEN RAISE EXCEPTION 'generation_request_conflict'; END IF;
   RETURN to_jsonb(existing);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='higgsfield_generation_enabled' AND enabled) THEN
   RAISE EXCEPTION 'generation_disabled';
 END IF;
 IF (SELECT count(*) FROM public.media_generation_jobs WHERE owner_user_id=p_owner AND state IN ('queued','running')) >= 2
   OR (SELECT count(*) FROM public.media_generation_jobs WHERE created_at > now()-interval '24 hours') >= 1000
   OR (SELECT coalesce(sum(estimated_cost_usd),0) FROM public.media_generation_jobs WHERE owner_user_id=p_owner AND created_at > now()-interval '24 hours') + p_cost > p_owner_budget
   OR (SELECT coalesce(sum(estimated_cost_usd),0) FROM public.media_generation_jobs WHERE created_at > now()-interval '24 hours') + p_cost > p_global_budget
 THEN RAISE EXCEPTION 'generation_budget_exceeded'; END IF;
 INSERT INTO public.media_generation_jobs(owner_user_id,client_request_id,request_hash,kind,model,provider_input,consent_version,estimated_cost_usd)
 VALUES(p_owner,p_client_request,p_hash,p_kind,p_model,p_input,p_policy,p_cost) RETURNING * INTO saved;
 RETURN to_jsonb(saved);
END $$;
REVOKE ALL ON FUNCTION public.media_generation_reserve(uuid,uuid,text,text,text,jsonb,text,numeric,numeric,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_generation_reserve(uuid,uuid,text,text,text,jsonb,text,numeric,numeric,numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.media_generation_claim(p_job uuid)
RETURNS SETOF public.media_generation_jobs LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 UPDATE public.media_generation_jobs j SET lease_until=now()+interval '120 seconds', lease_token=gen_random_uuid(), updated_at=now()
 WHERE j.id=(SELECT q.id FROM public.media_generation_jobs q WHERE q.id=p_job
   AND (q.lease_until IS NULL OR q.lease_until < now()) FOR UPDATE SKIP LOCKED)
 RETURNING j.*;
$$;
REVOKE ALL ON FUNCTION public.media_generation_claim(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_generation_claim(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.media_generation_complete(p_job uuid,p_event text,p_request uuid,p_completion jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE j public.media_generation_jobs;
BEGIN
 SELECT * INTO j FROM public.media_generation_jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND OR j.provider_receipt->>'requestId' IS DISTINCT FROM p_request::text THEN RETURN false; END IF;
 IF j.completion IS NOT NULL THEN RETURN j.completion=p_completion; END IF;
 UPDATE public.media_generation_jobs SET completion=p_completion,webhook_event_id=p_event,updated_at=now() WHERE id=p_job;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.media_generation_complete(uuid,text,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_generation_complete(uuid,text,uuid,jsonb) TO service_role;

-- Private state-only notifications. No prompt, output URL, or credentials in events.
CREATE OR REPLACE FUNCTION public.media_generation_broadcast() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.state IS DISTINCT FROM OLD.state OR NEW.delete_requested IS DISTINCT FROM OLD.delete_requested THEN
   PERFORM realtime.send(jsonb_build_object('id',NEW.id),'generation_changed','media-generation:'||NEW.owner_user_id::text,true);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.media_generation_broadcast() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS media_generation_changed ON public.media_generation_jobs;
CREATE TRIGGER media_generation_changed AFTER INSERT OR UPDATE ON public.media_generation_jobs FOR EACH ROW EXECUTE FUNCTION public.media_generation_broadcast();
DROP POLICY IF EXISTS media_generation_receive ON realtime.messages;
CREATE POLICY media_generation_receive ON realtime.messages FOR SELECT TO authenticated
 USING (extension='broadcast' AND (select realtime.topic())='media-generation:'||(select auth.uid())::text);
-- Restrictive policy prevents any existing permissive catch-all from exposing this namespace.
DROP POLICY IF EXISTS media_generation_receive_isolation ON realtime.messages;
CREATE POLICY media_generation_receive_isolation ON realtime.messages AS RESTRICTIVE FOR SELECT TO anon, authenticated
 USING (coalesce(topic,'') NOT LIKE 'media-generation:%' OR topic='media-generation:'||(select auth.uid())::text);
DROP POLICY IF EXISTS media_generation_no_client_send ON realtime.messages;
CREATE POLICY media_generation_no_client_send ON realtime.messages AS RESTRICTIVE FOR INSERT TO anon, authenticated
 WITH CHECK (coalesce(topic,'') NOT LIKE 'media-generation:%');

INSERT INTO public.feature_flags(flag,enabled) VALUES('higgsfield_generation_enabled',false) ON CONFLICT(flag) DO NOTHING;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 VALUES('generated-media-private','generated-media-private',false,83886080,ARRAY['image/webp','video/mp4']) ON CONFLICT(id) DO NOTHING;
COMMIT;
