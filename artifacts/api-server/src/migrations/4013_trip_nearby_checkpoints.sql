-- Created by supabase migration new (20261105135428), normalized to repo order.
-- OD-TRIP-6 / OD-MAP-5: explicit, temporary trip consent; no location payload.
BEGIN;
CREATE TABLE public.trip_nearby_sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
 trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
 consent_version text NOT NULL CHECK(consent_version='trip-nearby-v1'),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 token_hash text, token_expires_at timestamptz, epoch_start timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
 CHECK(token_expires_at IS NULL OR token_expires_at<=expires_at)
);
CREATE TABLE public.trip_nearby_epochs (
 trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
 epoch_start timestamptz NOT NULL, service_uuid uuid NOT NULL DEFAULT gen_random_uuid(),
 expires_at timestamptz NOT NULL, PRIMARY KEY(trip_id,epoch_start),
 CHECK(expires_at=epoch_start+interval '1 minute')
);
CREATE TABLE public.trip_nearby_revocations (
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,session_id uuid NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',PRIMARY KEY(user_id,session_id)
);
CREATE INDEX trip_nearby_revocations_expiry ON public.trip_nearby_revocations(expires_at);
CREATE TABLE public.trip_nearby_observations (
 observer_session_id uuid NOT NULL REFERENCES public.trip_nearby_sessions(id) ON DELETE CASCADE,
 subject_session_id uuid NOT NULL REFERENCES public.trip_nearby_sessions(id) ON DELETE CASCADE,
 proximity text NOT NULL CHECK(proximity IN('very_close','nearby','within_area','weak')),
 observed_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 PRIMARY KEY(observer_session_id,subject_session_id), CHECK(observer_session_id<>subject_session_id),
 CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '1 minute')
);
CREATE INDEX trip_nearby_sessions_expiry ON public.trip_nearby_sessions(expires_at);
CREATE INDEX trip_nearby_epochs_expiry ON public.trip_nearby_epochs(expires_at);
CREATE INDEX trip_nearby_observations_expiry ON public.trip_nearby_observations(expires_at);
CREATE INDEX trip_nearby_sessions_token ON public.trip_nearby_sessions(token_hash) WHERE token_hash IS NOT NULL;
ALTER TABLE public.trip_nearby_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_nearby_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_nearby_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_nearby_revocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trip_nearby_sessions,public.trip_nearby_epochs,public.trip_nearby_observations,public.trip_nearby_revocations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.trip_nearby_sessions,public.trip_nearby_epochs,public.trip_nearby_observations,public.trip_nearby_revocations TO service_role;
CREATE POLICY trip_nearby_sessions_service ON public.trip_nearby_sessions FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY trip_nearby_epochs_service ON public.trip_nearby_epochs FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY trip_nearby_observations_service ON public.trip_nearby_observations FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY trip_nearby_revocations_service ON public.trip_nearby_revocations FOR ALL TO service_role USING(true) WITH CHECK(true);
COMMENT ON TABLE public.trip_nearby_observations IS 'Latest direct foreground Bluetooth peer checkpoint only, not GPS or proof of presence. Per observer/subject session, expires within60sec; no trajectory/history. Rechecked against both current consents, account state, accepted membership and blocks on every read. No public or secondary-use reader.';
INSERT INTO public.feature_flags(flag,enabled) VALUES('trip_nearby_checkpoints_enabled',false) ON CONFLICT(flag) DO NOTHING;

CREATE FUNCTION public.trip_nearby_member_eligible(p_actor uuid,p_trip uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $fn$
 SELECT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=p_actor AND p.account_status='active')
 AND NOT EXISTS(SELECT 1 FROM public.user_account_states s WHERE s.user_id=p_actor AND s.state IN('banned','suspended') AND(s.expires_at IS NULL OR s.expires_at>now()))
 AND NOT EXISTS(SELECT 1 FROM public.trip_crew_location_preferences p WHERE p.user_id=p_actor AND p.trip_id=p_trip AND p.ghost_mode_enabled IS DISTINCT FROM false)
 AND EXISTS(SELECT 1 FROM public.trips t WHERE t.id=p_trip AND t.status IN('planning','upcoming','active') AND
  (t.owner_id=p_actor OR EXISTS(SELECT 1 FROM public.trip_members m WHERE m.trip_id=t.id AND m.user_id=p_actor AND m.status='accepted' AND m.role IN('owner','co_host','member','viewer'))))
$fn$;
REVOKE ALL ON FUNCTION public.trip_nearby_member_eligible(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trip_nearby_member_eligible(uuid,uuid) TO service_role;

CREATE FUNCTION public.trip_nearby_command(p_actor uuid,p_trip uuid,p_action text,p_session uuid,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE own public.trip_nearby_sessions; peer public.trip_nearby_sessions; service uuid; epoch timestamptz;
 token text; ttl integer; peers jsonb; seen timestamptz; lease_end timestamptz;
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role required'; END IF;
 IF p_actor IS NULL OR p_trip IS NULL OR p_session IS NULL THEN RAISE EXCEPTION 'invalid nearby session'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor::text,4013));
 -- Revocation must work after removal from a trip and with the feature disabled.
 IF p_action='stop' THEN
  -- A stop that wins the lock before an in-flight start must cancel it too.
  INSERT INTO public.trip_nearby_revocations(user_id,session_id) VALUES(p_actor,p_session) ON CONFLICT DO NOTHING;
  DELETE FROM public.trip_nearby_sessions WHERE id=p_session AND user_id=p_actor AND trip_id=p_trip;
  RETURN jsonb_build_object('state','stopped');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='trip_nearby_checkpoints_enabled' AND enabled) THEN RETURN jsonb_build_object('state','disabled'); END IF;
 IF NOT public.trip_nearby_member_eligible(p_actor,p_trip) THEN RETURN jsonb_build_object('state','unavailable'); END IF;
 IF EXISTS(SELECT 1 FROM public.trip_nearby_revocations WHERE user_id=p_actor AND session_id=p_session AND expires_at>now()) THEN RETURN jsonb_build_object('state','unavailable'); END IF;
 IF p_action='start' THEN
  ttl := (p_payload->>'durationMinutes')::integer;
  IF ttl IS NULL OR ttl<1 OR ttl>15 OR p_payload->>'consentVersion' IS DISTINCT FROM 'trip-nearby-v1' THEN RAISE EXCEPTION 'explicit bounded consent required'; END IF;
  SELECT * INTO own FROM public.trip_nearby_sessions WHERE id=p_session;
  IF FOUND THEN
   IF own.user_id<>p_actor OR own.trip_id<>p_trip OR own.expires_at<=now() THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  ELSE
   DELETE FROM public.trip_nearby_sessions WHERE user_id=p_actor;
   INSERT INTO public.trip_nearby_sessions(id,user_id,trip_id,consent_version,expires_at)
   VALUES(p_session,p_actor,p_trip,'trip-nearby-v1',now()+make_interval(mins=>ttl));
  END IF;
 END IF;
 SELECT * INTO own FROM public.trip_nearby_sessions WHERE id=p_session AND user_id=p_actor AND trip_id=p_trip FOR UPDATE;
 IF NOT FOUND OR own.expires_at<=now() THEN RETURN jsonb_build_object('state','unavailable'); END IF;
 IF p_action='observe' THEN
  IF p_payload->>'token' IS NULL OR p_payload->>'proximity' IS NULL OR p_payload->>'token' !~ '^[a-f0-9]{64}$' OR p_payload->>'proximity' NOT IN('very_close','nearby','within_area','weak') THEN RAISE EXCEPTION 'invalid checkpoint'; END IF;
  seen := (p_payload->>'observedAt')::timestamptz;
  IF seen IS NULL OR seen<now()-interval '15 seconds' OR seen>now()+interval '5 seconds' THEN RETURN jsonb_build_object('state','active','accepted',false); END IF;
  SELECT * INTO peer FROM public.trip_nearby_sessions WHERE token_hash=encode(sha256(convert_to(p_payload->>'token','UTF8')),'hex') AND trip_id=p_trip AND token_expires_at>now() AND expires_at>now();
  IF NOT FOUND OR peer.user_id=p_actor OR NOT public.trip_nearby_member_eligible(peer.user_id,p_trip)
   OR EXISTS(SELECT 1 FROM public.blocks WHERE(blocker_id=p_actor AND blocked_id=peer.user_id) OR(blocker_id=peer.user_id AND blocked_id=p_actor))
   OR EXISTS(SELECT 1 FROM public.circle_member_visibility_overrides WHERE context_type='trip' AND context_id=p_trip AND hidden AND((user_id=p_actor AND target_user_id=peer.user_id AND direction='hide_from_me') OR(user_id=peer.user_id AND target_user_id=p_actor AND direction='hide_me_from')))
   THEN RETURN jsonb_build_object('state','active','accepted',false); END IF;
  -- The server stamps freshness; a caller clock cannot extend retention.
  IF NOT EXISTS(SELECT 1 FROM public.trip_nearby_observations WHERE observer_session_id=own.id AND subject_session_id=peer.id)
   AND (SELECT count(*) FROM public.trip_nearby_observations WHERE observer_session_id=own.id)>=64 THEN RETURN jsonb_build_object('state','active','accepted',false); END IF;
  INSERT INTO public.trip_nearby_observations(observer_session_id,subject_session_id,proximity,expires_at)
  VALUES(own.id,peer.id,p_payload->>'proximity',least(now()+interval '1 minute',own.expires_at,peer.expires_at))
  ON CONFLICT(observer_session_id,subject_session_id) DO UPDATE SET proximity=EXCLUDED.proximity,observed_at=now(),expires_at=EXCLUDED.expires_at;
  RETURN jsonb_build_object('state','active','accepted',true);
 END IF;
 IF p_action NOT IN('start','renew','read') THEN RAISE EXCEPTION 'invalid nearby action'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('userId',s.user_id,'handle',p.handle,'proximity',o.proximity,'observedAt',o.observed_at,'expiresAt',o.expires_at) ORDER BY o.observed_at DESC),'[]'::jsonb) INTO peers
 FROM public.trip_nearby_observations o JOIN public.trip_nearby_sessions s ON s.id=o.subject_session_id JOIN public.profiles p ON p.id=s.user_id
 WHERE o.observer_session_id=own.id AND o.expires_at>now() AND s.expires_at>now() AND s.trip_id=p_trip
 AND public.trip_nearby_member_eligible(s.user_id,p_trip)
 AND NOT EXISTS(SELECT 1 FROM public.blocks WHERE(blocker_id=p_actor AND blocked_id=s.user_id) OR(blocker_id=s.user_id AND blocked_id=p_actor))
 AND NOT EXISTS(SELECT 1 FROM public.circle_member_visibility_overrides WHERE context_type='trip' AND context_id=p_trip AND hidden AND((user_id=p_actor AND target_user_id=s.user_id AND direction='hide_from_me') OR(user_id=s.user_id AND target_user_id=p_actor AND direction='hide_me_from')));
 IF p_action='read' THEN RETURN jsonb_build_object('state','active','sessionId',own.id,'expiresAt',own.expires_at,'serverNow',now(),'peers',peers); END IF;
 epoch := date_trunc('minute',now());
 INSERT INTO public.trip_nearby_epochs(trip_id,epoch_start,expires_at) VALUES(p_trip,epoch,epoch+interval '1 minute') ON CONFLICT DO NOTHING;
 SELECT service_uuid INTO service FROM public.trip_nearby_epochs WHERE trip_id=p_trip AND epoch_start=epoch;
 token := replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
 lease_end := least(own.expires_at,epoch+interval '1 minute');
 UPDATE public.trip_nearby_sessions SET token_hash=encode(sha256(convert_to(token,'UTF8')),'hex'),token_expires_at=lease_end,epoch_start=epoch WHERE id=own.id;
 RETURN jsonb_build_object('state','active','sessionId',own.id,'expiresAt',own.expires_at,'serverNow',now(),'peers',peers,'lease',jsonb_build_object('serviceUuid',service,'characteristicUuid','8c541bd6-c12b-4f73-8f4f-568b374daf25','token',token,'expiresAt',lease_end));
END $fn$;
REVOKE ALL ON FUNCTION public.trip_nearby_command(uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trip_nearby_command(uuid,uuid,text,uuid,jsonb) TO service_role;

CREATE FUNCTION public.purge_trip_nearby_expired(p_limit integer DEFAULT 500) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE n integer; total integer:=0;
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role required'; END IF;
 WITH expired AS(SELECT id FROM public.trip_nearby_sessions WHERE expires_at<=now() LIMIT greatest(1,least(p_limit,2000)) FOR UPDATE SKIP LOCKED)
 DELETE FROM public.trip_nearby_sessions s USING expired e WHERE s.id=e.id; GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 WITH expired AS(SELECT trip_id,epoch_start FROM public.trip_nearby_epochs WHERE expires_at<=now() LIMIT greatest(1,least(p_limit,2000)) FOR UPDATE SKIP LOCKED)
 DELETE FROM public.trip_nearby_epochs s USING expired e WHERE s.trip_id=e.trip_id AND s.epoch_start=e.epoch_start;GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 WITH expired AS(SELECT observer_session_id,subject_session_id FROM public.trip_nearby_observations WHERE expires_at<=now() LIMIT greatest(1,least(p_limit,2000)) FOR UPDATE SKIP LOCKED)
 DELETE FROM public.trip_nearby_observations s USING expired e WHERE s.observer_session_id=e.observer_session_id AND s.subject_session_id=e.subject_session_id;GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 WITH expired AS(SELECT user_id,session_id FROM public.trip_nearby_revocations WHERE expires_at<=now() LIMIT greatest(1,least(p_limit,2000)) FOR UPDATE SKIP LOCKED)
 DELETE FROM public.trip_nearby_revocations s USING expired e WHERE s.user_id=e.user_id AND s.session_id=e.session_id;GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 RETURN total;
END $fn$;
REVOKE ALL ON FUNCTION public.purge_trip_nearby_expired(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.purge_trip_nearby_expired(integer) TO service_role;
COMMIT;
