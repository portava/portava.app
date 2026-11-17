-- Wall real-world outcomes must belong to the currently active consent grant.
-- Generated with Supabase CLI; canonical forward migration. No history rewrite,
-- collection expansion, retention change, or consent grant is performed here.
BEGIN;
ALTER TABLE public.wall_telemetry_events ADD COLUMN IF NOT EXISTS consent_granted_at timestamptz;

CREATE OR REPLACE FUNCTION public.guard_wall_outcome_consent()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE c public.intel_contribution_consent%ROWTYPE;
BEGIN
  IF NEW.event_name <> 'wall_real_world_outcome' THEN RETURN NEW; END IF;
  -- FOR SHARE conflicts with the existing consent upsert's UPDATE lock and is
  -- held until commit: withdrawal cannot acknowledge while admission is pending.
  SELECT * INTO c FROM public.intel_contribution_consent WHERE user_id = NEW.viewer_id FOR SHARE;
  IF NOT FOUND OR NOT c.enabled OR c.withdrawn_at IS NOT NULL
     OR NEW.consent_granted_at IS NULL OR c.consented_at IS DISTINCT FROM NEW.consent_granted_at THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.guard_wall_outcome_consent() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_wall_outcome_consent() TO service_role;
DROP TRIGGER IF EXISTS wall_outcome_consent_guard ON public.wall_telemetry_events;
CREATE TRIGGER wall_outcome_consent_guard BEFORE INSERT OR UPDATE OF viewer_id, event_name, consent_granted_at, payload
ON public.wall_telemetry_events FOR EACH ROW EXECUTE FUNCTION public.guard_wall_outcome_consent();

-- Service-only caller stamps p_actor from the authenticated bearer. A separate
-- RPC returns the actual insert count, including trigger refusal, so old-client
-- outcomes without grant provenance never get a misleading acceptance receipt.
CREATE OR REPLACE FUNCTION public.insert_wall_telemetry_outcomes(p_actor uuid, p_rows jsonb, p_consent_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE n integer;
BEGIN
  IF p_actor IS NULL OR p_consent_at IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RETURN 0; END IF;
  IF jsonb_array_length(p_rows) > 100 THEN RAISE EXCEPTION 'wall_outcome_batch_too_large'; END IF;
  INSERT INTO public.wall_telemetry_events(viewer_id,event_name,schema_version,payload,consent_granted_at)
  SELECT p_actor,'wall_real_world_outcome',COALESCE(r->>'schema_version','1.0'),r->'payload',p_consent_at
  FROM jsonb_array_elements(p_rows) r;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;
REVOKE ALL ON FUNCTION public.insert_wall_telemetry_outcomes(uuid,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_wall_telemetry_outcomes(uuid,jsonb,timestamptz) TO service_role;
COMMENT ON COLUMN public.wall_telemetry_events.consent_granted_at IS
  'Current server-issued Intelligence Contributions grant that admitted this real-world outcome. Not required for ordinary product telemetry; legacy outcomes are unchanged. Existing expiry and account-deletion cascade still apply.';
COMMIT;
