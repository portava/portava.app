-- Supabase CLI scaffold; extend the existing receipt, never another executor.
BEGIN;
-- Existing moderation audit is also the terminal receipt audit. This one
-- action concerns an anonymous deletion receipt after the profile has gone.
ALTER TABLE public.moderation_actions ALTER COLUMN target_user_id DROP NOT NULL;
ALTER TABLE public.moderation_actions ADD CONSTRAINT moderation_actions_terminal_target
  CHECK (target_user_id IS NOT NULL OR action_type='account_permanent_deletion_reconciled');
-- The profile FK intentionally becomes NULL when Auth deletes the identity.
-- Keep the exact dispatch subject only until this same receipt is completed.
ALTER TABLE public.user_deletion_requests ADD COLUMN execution_subject_id uuid;
ALTER TABLE public.user_deletion_requests ADD CONSTRAINT user_deletion_terminal_subject
  CHECK (execution_subject_id IS NULL OR (status='executing' AND failure_code IS NOT DISTINCT FROM 'auth_delete_dispatched'));

-- One canonical claim writer, with explicit caller protocol. Preserve the old
-- signature only as a refusal so an old API cannot start an unfenced erase.
DO $upgrade$
DECLARE definition text; probe text; anchor text;
BEGIN
  IF NOT public.postcard_canonical_lifecycle_ready() THEN RAISE EXCEPTION '4043 requires intact media retention authority'; END IF;
  definition := pg_get_functiondef('public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text)'::regprocedure);
  IF position('p_reason text)' IN definition)=0 OR position('deletion_not_claimable' IN definition)=0
    OR position('account_permanent_deletion_authorized' IN definition)=0 THEN
    RAISE EXCEPTION '4043 requires the existing 4040 account claim owner'; END IF;
  anchor := format('(%L,%L)','public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text)',md5(definition));
  definition := replace(definition,'p_reason text)','p_reason text, p_protocol integer)');
  definition := replace(definition,E'BEGIN\n',E'BEGIN\n  IF p_protocol IS DISTINCT FROM 1 THEN RETURN jsonb_build_object(''ok'',false,''error'',''deletion_protocol_required''); END IF;\n');
  EXECUTE definition;
  EXECUTE $deny$
    CREATE OR REPLACE FUNCTION public.claim_account_permanent_deletion(p_actor uuid,p_user uuid,p_generation uuid,p_token uuid,p_reason text)
    RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
      SELECT jsonb_build_object('ok',false,'error','deletion_protocol_required');
    $fn$;
  $deny$;
  probe := pg_get_functiondef('public.postcard_canonical_lifecycle_ready()'::regprocedure);
  IF position(anchor IN probe)=0 THEN RAISE EXCEPTION '4043 retention fingerprint anchor changed'; END IF;
  EXECUTE replace(probe,anchor,
    format('(%L,%L),(%L,%L)',
      'public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text)',md5(pg_get_functiondef('public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text)'::regprocedure)),
      'public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text,integer)',md5(pg_get_functiondef('public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text,integer)'::regprocedure))));
  IF NOT public.postcard_canonical_lifecycle_ready() THEN RAISE EXCEPTION '4043 retention authority did not remain ready'; END IF;
END;$upgrade$;
REVOKE ALL ON FUNCTION public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text,integer) TO service_role;

CREATE FUNCTION public.prepare_account_auth_deletion(p_actor uuid,p_request uuid,p_token uuid,p_generation uuid,
  p_deleted jsonb,p_tombstoned jsonb,p_policy text,p_worker text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE request public.user_deletion_requests%ROWTYPE;
BEGIN
  SELECT * INTO request FROM public.user_deletion_requests WHERE deletion_request_id=p_request FOR UPDATE;
  IF NOT FOUND OR request.status<>'executing' OR request.execution_token IS DISTINCT FROM p_token OR p_token IS NULL
    OR request.recovery_generation IS DISTINCT FROM p_generation OR request.executed_by IS DISTINCT FROM p_actor
    OR request.user_id IS NULL OR request.execution_subject_id IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active')
    OR EXISTS(SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended')
      AND (expires_at IS NULL OR expires_at>clock_timestamp()))
    OR jsonb_typeof(p_deleted) IS DISTINCT FROM 'object' OR jsonb_typeof(p_tombstoned) IS DISTINCT FROM 'object'
    OR NULLIF(p_policy,'') IS NULL OR NULLIF(p_worker,'') IS NULL THEN RETURN false; END IF;
  UPDATE public.user_deletion_requests SET execution_subject_id=request.user_id,failure_code='auth_delete_dispatched',
    deleted_counts=p_deleted,tombstoned_counts=p_tombstoned,policy_version=p_policy,worker_version=p_worker
    WHERE deletion_request_id=p_request;
  RETURN true;
END;$fn$;

-- A returned or thrown provider error is not proof that a dispatched erase did
-- nothing. Old callers must also be unable to release this fence for retry.
CREATE OR REPLACE FUNCTION public.finish_account_deletion_attempt(p_request uuid,p_token uuid,p_success boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE request public.user_deletion_requests%ROWTYPE;
BEGIN
  SELECT * INTO request FROM public.user_deletion_requests WHERE deletion_request_id=p_request FOR UPDATE;
  IF NOT FOUND OR request.execution_token IS DISTINCT FROM p_token OR p_token IS NULL THEN RETURN false; END IF;
  IF p_success THEN RETURN request.status='completed' AND request.user_id IS NULL AND request.execution_subject_id IS NULL; END IF;
  IF request.status<>'executing' OR request.execution_subject_id IS NOT NULL THEN RETURN false; END IF;
  UPDATE public.user_deletion_requests SET status='failed',execution_token=NULL,execution_lease_expires_at=NULL,
    failure_code='execution_incomplete',retry_count=retry_count+1 WHERE deletion_request_id=p_request;
  RETURN true;
END;$fn$;

CREATE FUNCTION public.settle_account_auth_deletion(p_actor uuid,p_request uuid,p_generation uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE request public.user_deletion_requests%ROWTYPE;
BEGIN
  IF NULLIF(btrim(p_reason),'') IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active')
    OR EXISTS(SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended')
      AND (expires_at IS NULL OR expires_at>clock_timestamp())) THEN
    RETURN jsonb_build_object('ok',false,'error','admin_reconciliation_required'); END IF;
  SELECT * INTO request FROM public.user_deletion_requests WHERE deletion_request_id=p_request FOR UPDATE;
  IF NOT FOUND OR request.recovery_generation IS DISTINCT FROM p_generation THEN
    RETURN jsonb_build_object('ok',false,'error','deletion_changed'); END IF;
  IF request.status='completed' AND request.user_id IS NULL AND request.execution_subject_id IS NULL
    AND request.failure_code='auth_delete_confirmed' THEN
    RETURN jsonb_build_object('ok',true,'completed',true,'alreadyCompleted',true); END IF;
  IF request.status<>'executing' OR request.execution_token IS NULL OR request.execution_subject_id IS NULL
    OR request.failure_code IS DISTINCT FROM 'auth_delete_dispatched'
    OR (request.user_id IS NOT NULL AND request.user_id IS DISTINCT FROM request.execution_subject_id) THEN
    RETURN jsonb_build_object('ok',false,'error','terminal_dispatch_unverified'); END IF;
  -- Reuse the narrow service-only auth existence owner. Presence, including a
  -- recreated identity, cannot authorize another erase or terminal completion.
  IF public.lock_recoverable_account_identity(request.execution_subject_id)
    OR EXISTS(SELECT 1 FROM public.profiles WHERE id=request.execution_subject_id) THEN
    RETURN jsonb_build_object('ok',false,'error','auth_deletion_unsettled'); END IF;
  IF EXISTS(SELECT 1 FROM public.media_assets WHERE owner_user_id=request.execution_subject_id OR uploader_user_id=request.execution_subject_id)
    OR EXISTS(SELECT 1 FROM public.media_caption_translation_artifacts WHERE owner_user_id=request.execution_subject_id)
    OR EXISTS(SELECT 1 FROM public.media_dubbing_artifacts WHERE owner_user_id=request.execution_subject_id) THEN
    RETURN jsonb_build_object('ok',false,'error','account_media_unsettled'); END IF;
  UPDATE public.user_deletion_requests SET status='completed',user_id=NULL,execution_subject_id=NULL,
    failure_code='auth_delete_confirmed',executed_at=clock_timestamp(),completed_at=clock_timestamp()
    WHERE deletion_request_id=p_request;
  INSERT INTO public.moderation_actions(target_user_id,performed_by,action_type,reason,metadata)
    VALUES(NULL,p_actor,'account_permanent_deletion_reconciled',btrim(p_reason),
      jsonb_build_object('deletion_request_id',p_request,'generation',p_generation));
  RETURN jsonb_build_object('ok',true,'completed',true,'alreadyCompleted',false);
END;$fn$;
-- The API must refuse before claiming or erasing content on a partial rollout.
CREATE FUNCTION public.account_deletion_terminal_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
  SELECT to_regprocedure('public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text,integer)') IS NOT NULL
    AND to_regprocedure('public.prepare_account_auth_deletion(uuid,uuid,uuid,uuid,jsonb,jsonb,text,text)') IS NOT NULL
    AND to_regprocedure('public.settle_account_auth_deletion(uuid,uuid,uuid,text)') IS NOT NULL
    AND to_regprocedure('public.lock_recoverable_account_identity(uuid)') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.user_deletion_requests'::regclass
      AND attname='execution_subject_id' AND atttypid='uuid'::regtype AND NOT attisdropped)
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.user_deletion_requests'::regclass
      AND conname='user_deletion_terminal_subject' AND convalidated)
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.moderation_actions'::regclass
      AND conname='moderation_actions_terminal_target' AND convalidated);
$fn$;
REVOKE ALL ON FUNCTION public.account_deletion_terminal_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_terminal_ready() TO service_role;
REVOKE ALL ON FUNCTION public.prepare_account_auth_deletion(uuid,uuid,uuid,uuid,jsonb,jsonb,text,text),
  public.settle_account_auth_deletion(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_account_auth_deletion(uuid,uuid,uuid,uuid,jsonb,jsonb,text,text),
  public.settle_account_auth_deletion(uuid,uuid,uuid,text) TO service_role;
COMMIT;
