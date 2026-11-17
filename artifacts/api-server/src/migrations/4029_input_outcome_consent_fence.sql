-- Consent admission and the outcome write share one transaction. The SHARE
-- locks conflict with a flag change or consent withdrawal/regrant. A writer
-- admitted first finishes before withdrawal's existing counter erase; a writer
-- arriving after withdrawal cannot recreate the erased counters.
-- The grant timestamp binds delayed work to the grant that authorized it.
-- No new data collection, table, grant, or feature activation is introduced.
BEGIN;

CREATE OR REPLACE FUNCTION public.input_record_outcome(
  p_user_id uuid, p_context text, p_entity_type text, p_entity_id text,
  p_consented_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF p_user_id IS NULL OR p_consented_at IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM public.feature_flags
    WHERE flag = 'input_outcome_learning_enabled' AND enabled FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.input_outcome_consent
    WHERE user_id = p_user_id AND enabled AND withdrawn_at IS NULL
      AND consent_version = 'input_outcome_learning_v1'
      AND consented_at = p_consented_at FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.input_outcome_counters (user_id, context, entity_type, entity_id)
  VALUES (p_user_id, p_context, p_entity_type, p_entity_id)
  ON CONFLICT (user_id, context, entity_type, entity_id, bucket_day)
  DO UPDATE SET completed_count = public.input_outcome_counters.completed_count + 1;
  RETURN true;
END
$fn$;

CREATE OR REPLACE FUNCTION public.input_record_task_outcome(
  p_user_id uuid, p_consented_at timestamptz, p_context text, p_task text, p_ok boolean
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF p_user_id IS NULL OR p_consented_at IS NULL OR p_ok IS NULL
     OR p_task IS NULL OR p_task NOT IN
       ('trip_created','trip_destinations_saved','event_created','message_sent') THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.feature_flags
    WHERE flag = 'input_outcome_learning_enabled' AND enabled FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.input_outcome_consent
    WHERE user_id = p_user_id AND enabled AND withdrawn_at IS NULL
      AND consent_version = 'input_outcome_learning_v1'
      AND consented_at = p_consented_at FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- The actor and grant are used only for admission, never stored in the
  -- aggregate. Existing OD-INPUT-2 irreversible aggregation is preserved.
  INSERT INTO public.input_outcome_task_daily (day, context, task, ok, completed_count)
  VALUES ((now() AT TIME ZONE 'utc')::date, p_context, p_task, p_ok, 1)
  ON CONFLICT (day, context, task, ok)
  DO UPDATE SET completed_count = public.input_outcome_task_daily.completed_count + 1;
  RETURN true;
END
$fn$;

-- Legacy callers without grant provenance fail closed during rollout. Core
-- assistance is independent of these optional learning counters.
CREATE OR REPLACE FUNCTION public.input_record_outcome(
  p_user_id uuid, p_context text, p_entity_type text, p_entity_id text
) RETURNS boolean LANGUAGE sql SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog' AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.input_record_task_outcome(
  p_context text, p_task text, p_ok boolean
) RETURNS boolean LANGUAGE sql SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog' AS $$ SELECT false $$;

REVOKE ALL ON FUNCTION public.input_record_outcome(uuid,text,text,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.input_record_outcome(uuid,text,text,text,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.input_record_task_outcome(uuid,timestamptz,text,text,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.input_record_task_outcome(uuid,timestamptz,text,text,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.input_record_outcome(uuid,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.input_record_task_outcome(text,text,boolean)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.input_record_outcome(uuid,text,text,text,timestamptz) IS
  'Service-only outcome write, serialized with consent withdrawal and flag changes, bound to the exact current grant. No grant or stale grant returns false.';
COMMENT ON FUNCTION public.input_record_task_outcome(uuid,timestamptz,text,text,boolean) IS
  'Service-only consent-fenced admission to irreversible task aggregates. Actor and grant timestamp are checked but never persisted in the aggregate.';
COMMENT ON FUNCTION public.input_record_outcome(uuid,text,text,text) IS 'Legacy admission without a grant timestamp is disabled; returns false.';
COMMENT ON FUNCTION public.input_record_task_outcome(text,text,boolean) IS 'Legacy admission without actor consent is disabled; returns false.';

DO $post$
BEGIN
  IF has_function_privilege('anon','public.input_record_outcome(uuid,text,text,text,timestamptz)','EXECUTE')
     OR has_function_privilege('authenticated','public.input_record_outcome(uuid,text,text,text,timestamptz)','EXECUTE')
     OR has_function_privilege('anon','public.input_record_task_outcome(uuid,timestamptz,text,text,boolean)','EXECUTE')
     OR has_function_privilege('authenticated','public.input_record_task_outcome(uuid,timestamptz,text,text,boolean)','EXECUTE') THEN
    RAISE EXCEPTION '4029 outcome admission must remain service-only';
  END IF;
END
$post$;
COMMIT;
