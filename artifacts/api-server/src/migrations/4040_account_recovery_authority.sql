-- Generated with Supabase CLI; existing request and audit stores remain sole
-- owners. User decision: owner recovery for 90 days, admin recovery until an
-- admin explicitly authorizes permanent deletion. Never infer that old pending
-- requests are intact: the old executor could erase content while still pending.
BEGIN;
ALTER TABLE public.user_deletion_requests
  ALTER COLUMN scheduled_at DROP NOT NULL,
  ADD COLUMN recovery_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN recovery_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN recovery_profile_status text,
  ADD COLUMN recovery_discovery_allowed boolean;
-- Reuse 4002 execution_token/started_at/lease fields. A non-expiring claim
-- requires reconciliation after interruption instead of starting a second writer.
-- Remove automatic deadlines, including legacy pending requests. This is not
-- an assertion that the legacy records can safely be restored.
UPDATE public.user_deletion_requests SET scheduled_at=NULL WHERE status='pending';

-- The service role deliberately cannot enumerate auth.users. This narrow
-- service-only identity check locks one known ID and returns only existence;
-- profile commands retain INVOKER rights over business tables and explicit actor
-- authorization. No grant on the private auth table or identity data exposure.
CREATE FUNCTION public.lock_recoverable_account_identity(p_user uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
  PERFORM 1 FROM auth.users WHERE id=p_user FOR KEY SHARE;
  RETURN FOUND;
END;$fn$;
REVOKE ALL ON FUNCTION public.lock_recoverable_account_identity(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lock_recoverable_account_identity(uuid) TO service_role;

CREATE FUNCTION public.request_recoverable_account_deletion(p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE request public.user_deletion_requests%ROWTYPE; profile_state text; discovery boolean;
  requested timestamptz:=clock_timestamp(); generation uuid:=gen_random_uuid();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||p_user::text,0));
  SELECT * INTO request FROM public.user_deletion_requests WHERE user_id=p_user FOR UPDATE;
  IF FOUND AND request.status='pending' THEN
    IF NOT request.recovery_verified THEN RETURN jsonb_build_object('ok',false,'error','legacy_recovery_unverified'); END IF;
    RETURN jsonb_build_object('ok',true,'generation',request.recovery_generation,'selfRecoverableUntil',request.requested_at+interval '90 days','scheduledAt',NULL);
  END IF;
  IF request.status IN ('executing','failed','executed','completed') OR request.execution_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'error','permanent_deletion_started');
  END IF;
  SELECT account_status INTO profile_state FROM public.profiles WHERE id=p_user FOR UPDATE;
  IF NOT FOUND OR profile_state NOT IN ('active','deactivated') OR NOT public.lock_recoverable_account_identity(p_user) THEN
    RETURN jsonb_build_object('ok',false,'error','profile_unavailable');
  END IF;
  SELECT allow_profile_discovery INTO discovery FROM public.profile_privacy_settings WHERE user_id=p_user FOR UPDATE;
  INSERT INTO public.user_deletion_requests(user_id,status,requested_at,scheduled_at,recovery_generation,recovery_verified,recovery_profile_status,recovery_discovery_allowed)
    VALUES(p_user,'pending',requested,NULL,generation,true,profile_state,COALESCE(discovery,true))
    ON CONFLICT(user_id) DO UPDATE SET status='pending',requested_at=excluded.requested_at,scheduled_at=NULL,
      cancelled_at=NULL,recovery_generation=excluded.recovery_generation,recovery_verified=true,
      recovery_profile_status=excluded.recovery_profile_status,recovery_discovery_allowed=excluded.recovery_discovery_allowed;
  UPDATE public.profiles SET account_status='deactivated' WHERE id=p_user;
  INSERT INTO public.profile_privacy_settings(user_id,allow_profile_discovery,updated_at) VALUES(p_user,false,requested)
    ON CONFLICT(user_id) DO UPDATE SET allow_profile_discovery=false,updated_at=excluded.updated_at;
  RETURN jsonb_build_object('ok',true,'generation',generation,'selfRecoverableUntil',requested+interval '90 days','scheduledAt',NULL);
END;$fn$;

CREATE FUNCTION public.recover_deleted_account(p_actor uuid,p_user uuid,p_generation uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE request public.user_deletion_requests%ROWTYPE; profile_state text; is_admin boolean; recovered timestamptz:=clock_timestamp();
BEGIN
  is_admin:=EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active');
  IF p_actor IS NULL OR (p_actor IS DISTINCT FROM p_user AND NOT is_admin) OR NULLIF(btrim(p_reason),'') IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','recovery_forbidden');
  END IF;
  IF EXISTS(SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended') AND
    (expires_at IS NULL OR expires_at>recovered)) THEN RETURN jsonb_build_object('ok',false,'error','recovery_forbidden'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||p_user::text,0));
  SELECT * INTO request FROM public.user_deletion_requests WHERE user_id=p_user FOR UPDATE;
  IF NOT FOUND OR request.recovery_generation IS DISTINCT FROM p_generation THEN RETURN jsonb_build_object('ok',false,'error','deletion_changed'); END IF;
  IF NOT request.recovery_verified THEN RETURN jsonb_build_object('ok',false,'error','legacy_recovery_unverified'); END IF;
  IF request.execution_started_at IS NOT NULL OR request.status NOT IN ('pending','cancelled') THEN
    RETURN jsonb_build_object('ok',false,'error','permanent_deletion_started');
  END IF;
  SELECT account_status INTO profile_state FROM public.profiles WHERE id=p_user FOR UPDATE;
  IF NOT FOUND OR profile_state='deleted' OR NOT public.lock_recoverable_account_identity(p_user) THEN
    RETURN jsonb_build_object('ok',false,'error','profile_unavailable');
  END IF;
  IF request.status='cancelled' THEN RETURN jsonb_build_object('ok',true,'alreadyRecovered',true,'accountStatus',profile_state); END IF;
  IF NOT is_admin AND clock_timestamp()>=request.requested_at+interval '90 days' THEN
    RETURN jsonb_build_object('ok',false,'error','self_recovery_expired');
  END IF;
  IF profile_state<>'deactivated' THEN RETURN jsonb_build_object('ok',false,'error','profile_changed'); END IF;
  UPDATE public.user_deletion_requests SET status='cancelled',cancelled_at=recovered,scheduled_at=NULL WHERE deletion_request_id=request.deletion_request_id;
  UPDATE public.profiles SET account_status=request.recovery_profile_status WHERE id=p_user;
  -- Restore the prior privacy preference only if it is still the suppression
  -- written by this request. A newer user preference must not be overwritten.
  UPDATE public.profile_privacy_settings SET allow_profile_discovery=request.recovery_discovery_allowed,updated_at=recovered
    WHERE user_id=p_user AND updated_at=request.requested_at AND allow_profile_discovery=false;
  INSERT INTO public.moderation_actions(target_user_id,performed_by,action_type,reason,metadata)
    VALUES(p_user,p_actor,'deleted_profile_recovered',btrim(p_reason),jsonb_build_object('deletion_request_id',request.deletion_request_id,'generation',request.recovery_generation,'actor_kind',CASE WHEN is_admin THEN 'admin' ELSE 'owner' END));
  RETURN jsonb_build_object('ok',true,'alreadyRecovered',false,'accountStatus',request.recovery_profile_status);
END;$fn$;

-- A committed claim is irreversible authorization to begin erasure. Restoration
-- never becomes available again after a partial failure. Executing claims are
-- not automatically stolen: an uncertain/crashed attempt needs reconciliation.
CREATE FUNCTION public.claim_account_permanent_deletion(p_actor uuid,p_user uuid,p_generation uuid,p_token uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE request public.user_deletion_requests%ROWTYPE;
BEGIN
  IF p_token IS NULL OR NULLIF(btrim(p_reason),'') IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active') OR EXISTS(
    SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended') AND
      (expires_at IS NULL OR expires_at>clock_timestamp())) THEN RETURN jsonb_build_object('ok',false,'error','admin_permanent_deletion_required'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||p_user::text,0));
  SELECT * INTO request FROM public.user_deletion_requests WHERE user_id=p_user FOR UPDATE;
  IF NOT FOUND OR request.recovery_generation IS DISTINCT FROM p_generation THEN RETURN jsonb_build_object('ok',false,'error','deletion_changed'); END IF;
  IF request.status NOT IN ('pending','failed') THEN RETURN jsonb_build_object('ok',false,'error','deletion_not_claimable'); END IF;
  UPDATE public.user_deletion_requests SET status='executing',execution_started_at=COALESCE(execution_started_at,clock_timestamp()),
    execution_token=p_token,execution_lease_expires_at='infinity'::timestamptz,executed_by=p_actor,scheduled_at=NULL WHERE deletion_request_id=request.deletion_request_id;
  INSERT INTO public.moderation_actions(target_user_id,performed_by,action_type,reason,metadata)
    VALUES(p_user,p_actor,'account_permanent_deletion_authorized',btrim(p_reason),jsonb_build_object('deletion_request_id',request.deletion_request_id,'generation',request.recovery_generation,'execution_token',p_token));
  RETURN jsonb_build_object('ok',true,'requestId',request.deletion_request_id,'token',p_token);
END;$fn$;

CREATE FUNCTION public.finish_account_deletion_attempt(p_request uuid,p_token uuid,p_success boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE request public.user_deletion_requests%ROWTYPE;
BEGIN
  SELECT * INTO request FROM public.user_deletion_requests WHERE deletion_request_id=p_request FOR UPDATE;
  IF NOT FOUND OR request.execution_token IS DISTINCT FROM p_token OR p_token IS NULL THEN RETURN false; END IF;
  IF p_success THEN RETURN request.status='completed' AND request.user_id IS NULL; END IF;
  IF request.status<>'executing' THEN RETURN false; END IF;
  UPDATE public.user_deletion_requests SET status='failed',execution_token=NULL,execution_lease_expires_at=NULL,failure_code='execution_incomplete',retry_count=retry_count+1 WHERE deletion_request_id=p_request;
  RETURN true;
END;$fn$;

-- A personally deactivated account is a different state from a deletion.
-- Reuse its existing account-state row, actor and original creation clock.
ALTER TABLE public.user_account_states ADD COLUMN self_deactivation_discovery_allowed boolean;
CREATE FUNCTION public.set_account_self_deactivation(p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE profile_state text; prior public.user_account_states%ROWTYPE; discovery boolean; changed timestamptz:=clock_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||p_user::text,0));
  IF EXISTS(SELECT 1 FROM public.user_deletion_requests WHERE user_id=p_user AND status IN ('pending','executing','failed')) THEN RETURN jsonb_build_object('ok',false,'error','profile_requires_recovery'); END IF;
  SELECT account_status INTO profile_state FROM public.profiles WHERE id=p_user FOR UPDATE;
  IF NOT FOUND OR profile_state NOT IN ('active','deactivated') OR NOT public.lock_recoverable_account_identity(p_user) THEN RETURN jsonb_build_object('ok',false,'error','profile_unavailable'); END IF;
  IF EXISTS(SELECT 1 FROM public.user_account_states WHERE user_id=p_user AND state IN ('banned','suspended') AND (expires_at IS NULL OR expires_at>changed)) THEN RETURN jsonb_build_object('ok',false,'error','recovery_forbidden'); END IF;
  SELECT * INTO prior FROM public.user_account_states WHERE user_id=p_user AND state='deactivated' FOR UPDATE;
  IF profile_state='deactivated' THEN
    IF prior.set_by IS DISTINCT FROM p_user THEN RETURN jsonb_build_object('ok',false,'error','self_deactivation_unverified'); END IF;
    RETURN jsonb_build_object('ok',true,'reactivateUntil',prior.created_at+interval '1 year');
  END IF;
  SELECT allow_profile_discovery INTO discovery FROM public.profile_privacy_settings WHERE user_id=p_user FOR UPDATE;
  INSERT INTO public.user_account_states(user_id,state,set_by,created_at,updated_at,reason,self_deactivation_discovery_allowed)
    VALUES(p_user,'deactivated',p_user,changed,changed,'Owner self-deactivation',COALESCE(discovery,true))
    ON CONFLICT(user_id,state) DO UPDATE SET set_by=p_user,created_at=changed,updated_at=changed,reason=excluded.reason,expires_at=NULL,self_deactivation_discovery_allowed=excluded.self_deactivation_discovery_allowed;
  UPDATE public.profiles SET account_status='deactivated' WHERE id=p_user;
  INSERT INTO public.profile_privacy_settings(user_id,allow_profile_discovery,updated_at) VALUES(p_user,false,changed)
    ON CONFLICT(user_id) DO UPDATE SET allow_profile_discovery=false,updated_at=changed;
  UPDATE public.circle_context_settings SET paused=true,updated_at=changed WHERE user_id=p_user;
  UPDATE public.circle_presence SET status='paused',updated_at=changed WHERE user_id=p_user AND status='active';
  RETURN jsonb_build_object('ok',true,'reactivateUntil',changed+interval '1 year');
END;$fn$;

CREATE FUNCTION public.reactivate_self_deactivated_account(p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE prior public.user_account_states%ROWTYPE; profile_state text; changed timestamptz:=clock_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||p_user::text,0));
  IF EXISTS(SELECT 1 FROM public.user_deletion_requests WHERE user_id=p_user AND status IN ('pending','executing','failed')) THEN RETURN jsonb_build_object('ok',false,'error','profile_requires_recovery'); END IF;
  SELECT account_status INTO profile_state FROM public.profiles WHERE id=p_user FOR UPDATE;
  IF NOT FOUND OR profile_state NOT IN ('active','deactivated') OR NOT public.lock_recoverable_account_identity(p_user) THEN RETURN jsonb_build_object('ok',false,'error','profile_unavailable'); END IF;
  IF EXISTS(SELECT 1 FROM public.user_account_states WHERE user_id=p_user AND state IN ('banned','suspended') AND (expires_at IS NULL OR expires_at>changed)) THEN RETURN jsonb_build_object('ok',false,'error','recovery_forbidden'); END IF;
  IF profile_state='active' THEN RETURN jsonb_build_object('ok',true,'alreadyReactivated',true); END IF;
  SELECT * INTO prior FROM public.user_account_states WHERE user_id=p_user AND state='deactivated' FOR UPDATE;
  IF NOT FOUND OR prior.set_by IS DISTINCT FROM p_user OR prior.self_deactivation_discovery_allowed IS NULL THEN RETURN jsonb_build_object('ok',false,'error','self_deactivation_unverified'); END IF;
  IF clock_timestamp()>=prior.created_at+interval '1 year' THEN RETURN jsonb_build_object('ok',false,'error','self_reactivation_expired'); END IF;
  DELETE FROM public.user_account_states WHERE id=prior.id;
  UPDATE public.profiles SET account_status='active' WHERE id=p_user;
  UPDATE public.profile_privacy_settings SET allow_profile_discovery=prior.self_deactivation_discovery_allowed,updated_at=changed
    WHERE user_id=p_user AND updated_at=prior.created_at AND allow_profile_discovery=false;
  INSERT INTO public.moderation_actions(target_user_id,performed_by,action_type,reason,metadata)
    VALUES(p_user,p_user,'self_deactivated_profile_reactivated','Owner requested reactivation',jsonb_build_object('deactivated_at',prior.created_at));
  RETURN jsonb_build_object('ok',true,'alreadyReactivated',false);
END;$fn$;
REVOKE ALL ON FUNCTION public.set_account_self_deactivation(uuid),public.reactivate_self_deactivated_account(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_account_self_deactivation(uuid),public.reactivate_self_deactivated_account(uuid) TO service_role;

-- Admin recovery is independent of the owner's one-year window and does not
-- revoke moderation sanctions. The reviewed state ID fences a stale admin form.
CREATE FUNCTION public.reactivate_deactivated_account_admin(p_actor uuid,p_user uuid,p_state_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE prior public.user_account_states%ROWTYPE; profile_state text; changed timestamptz:=clock_timestamp();
BEGIN
  IF NULLIF(btrim(p_reason),'') IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active') OR EXISTS(
    SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended') AND (expires_at IS NULL OR expires_at>changed)) THEN
    RETURN jsonb_build_object('ok',false,'error','recovery_forbidden');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||p_user::text,0));
  IF EXISTS(SELECT 1 FROM public.user_deletion_requests WHERE user_id=p_user AND status IN ('pending','executing','failed')) THEN RETURN jsonb_build_object('ok',false,'error','profile_requires_recovery'); END IF;
  SELECT account_status INTO profile_state FROM public.profiles WHERE id=p_user FOR UPDATE;
  IF NOT FOUND OR profile_state NOT IN ('active','deactivated') OR NOT public.lock_recoverable_account_identity(p_user) THEN RETURN jsonb_build_object('ok',false,'error','profile_unavailable'); END IF;
  IF profile_state='active' THEN RETURN jsonb_build_object('ok',true,'alreadyReactivated',true); END IF;
  SELECT * INTO prior FROM public.user_account_states WHERE user_id=p_user AND state='deactivated' FOR UPDATE;
  IF prior.id IS DISTINCT FROM p_state_id THEN RETURN jsonb_build_object('ok',false,'error','deactivation_changed'); END IF;
  -- Unknown legacy privacy preferences are never widened by recovery.
  DELETE FROM public.user_account_states WHERE id=prior.id;
  UPDATE public.profiles SET account_status='active' WHERE id=p_user;
  IF prior.self_deactivation_discovery_allowed IS NOT NULL THEN
    UPDATE public.profile_privacy_settings SET allow_profile_discovery=prior.self_deactivation_discovery_allowed,updated_at=changed
      WHERE user_id=p_user AND updated_at=prior.created_at AND allow_profile_discovery=false;
  END IF;
  INSERT INTO public.moderation_actions(target_user_id,performed_by,action_type,reason,metadata)
    VALUES(p_user,p_actor,'deactivated_profile_reactivated',btrim(p_reason),jsonb_build_object('deactivation_id',prior.id,'deactivated_by',prior.set_by,'deactivated_at',prior.created_at));
  RETURN jsonb_build_object('ok',true,'alreadyReactivated',false);
END;$fn$;
REVOKE ALL ON FUNCTION public.reactivate_deactivated_account_admin(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reactivate_deactivated_account_admin(uuid,uuid,uuid,text) TO service_role;

-- One read snapshot supplies the signed-in gate with server-calculated deadlines.
CREATE FUNCTION public.account_recovery_status(p_user uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
  SELECT jsonb_build_object(
    'userId',p.id,
    -- Recovery endpoints remain reachable, but inactive accounts cannot mint
    -- fresh media bearer authority. Legacy active profiles may still carry an
    -- irreversible deletion claim, so profile status alone is insufficient.
    'mediaAccessAllowed',p.account_status='active'
      AND (d.user_id IS NULL OR (d.status='cancelled' AND d.execution_started_at IS NULL))
      AND NOT EXISTS(SELECT 1 FROM public.user_account_states r WHERE r.user_id=p.id
        AND r.state IN ('banned','suspended','deactivated') AND (r.expires_at IS NULL OR r.expires_at>now())),
    'accountStatus',CASE WHEN p.account_status='deactivated' AND d.status IN ('pending','executing','failed') THEN 'pending_deletion' ELSE p.account_status END,
    'deletionScheduledAt',NULL,
    'selfRecoverableUntil',CASE WHEN d.status='pending' AND d.recovery_verified AND d.execution_started_at IS NULL THEN d.requested_at+interval '90 days' END,
    'reactivateUntil',CASE WHEN p.account_status='deactivated' AND COALESCE(d.status NOT IN ('pending','executing','failed'),true) AND s.set_by=p_user AND s.self_deactivation_discovery_allowed IS NOT NULL THEN s.created_at+interval '1 year' END)
  FROM public.profiles p
  LEFT JOIN public.user_deletion_requests d ON d.user_id=p.id
  LEFT JOIN public.user_account_states s ON s.user_id=p.id AND s.state='deactivated'
  WHERE p.id=p_user;
$fn$;
REVOKE ALL ON FUNCTION public.account_recovery_status(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.account_recovery_status(uuid) TO service_role;

-- Every reactivation path, including older app/API clients, must respect the
-- deletion authority. The trigger needs the private request state even when a
-- caller's RLS hides it; it returns no request data and performs no mutation.
CREATE FUNCTION public.guard_deleted_profile_reactivation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
  IF NEW.account_status='active' AND OLD.account_status IS DISTINCT FROM 'active' AND EXISTS(
    SELECT 1 FROM public.user_deletion_requests WHERE user_id=NEW.id AND status IN ('pending','executing','failed')) THEN
    RAISE EXCEPTION 'profile_requires_authorized_recovery' USING ERRCODE='42501';
  END IF;
  IF NEW.account_status='active' AND OLD.account_status IS DISTINCT FROM 'active' AND EXISTS(
    SELECT 1 FROM public.user_account_states WHERE user_id=NEW.id AND state='deactivated') THEN
    RAISE EXCEPTION 'profile_requires_authorized_reactivation' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;$fn$;
CREATE TRIGGER deleted_profile_reactivation_guard BEFORE UPDATE OF account_status ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_deleted_profile_reactivation();
REVOKE ALL ON FUNCTION public.guard_deleted_profile_reactivation() FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION public.request_recoverable_account_deletion(uuid),public.recover_deleted_account(uuid,uuid,uuid,text),
  public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text),public.finish_account_deletion_attempt(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_recoverable_account_deletion(uuid),public.recover_deleted_account(uuid,uuid,uuid,text),
  public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text),public.finish_account_deletion_attempt(uuid,uuid,boolean) TO service_role;
COMMIT;
