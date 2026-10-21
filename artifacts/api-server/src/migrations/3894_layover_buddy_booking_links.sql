-- L273: service-only certified context for the existing Rent-a-Buddy checkout.
-- Depends only on pre3894 profiles, rent_buddy_bookings, layover_sessions and feature_flags.
-- No later migration alters these objects. 3930 identity is checked by the API, not assumed by this DDL.
-- Category remains TEXT; this migration does not activate Rent-a-Buddy or change payment authority.
-- Rollback: db/rollback/2026-10-18-3894-layover-buddy-booking-links-rollback.sql (refuses data/history/drift).
BEGIN;
DO $pre$ BEGIN
 IF to_regclass('public.rent_buddy_bookings') IS NULL OR to_regclass('public.layover_sessions') IS NULL OR to_regclass('public.feature_flags') IS NULL THEN
  RAISE EXCEPTION 'PRECONDITION FAILED (3894): booking, layover and feature flag tables required';
 END IF;
END $pre$;
CREATE TABLE public.layover_buddy_booking_links(
 booking_id uuid PRIMARY KEY REFERENCES public.rent_buddy_bookings(id) ON DELETE CASCADE,
 layover_session_id uuid NOT NULL REFERENCES public.layover_sessions(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 certified_end_by timestamptz NOT NULL,
 earliest_start_at timestamptz NOT NULL,
 timezone text NOT NULL CHECK(length(timezone)>0),
 certification jsonb NOT NULL CHECK(jsonb_typeof(certification)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(earliest_start_at<certified_end_by)
);
CREATE INDEX layover_buddy_booking_links_session_idx ON public.layover_buddy_booking_links(layover_session_id);
CREATE INDEX layover_buddy_booking_links_user_idx ON public.layover_buddy_booking_links(user_id);
ALTER TABLE public.layover_buddy_booking_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_buddy_booking_links FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.layover_buddy_booking_links TO service_role;
CREATE POLICY layover_buddy_booking_links_service_only ON public.layover_buddy_booking_links FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE FUNCTION public.layover_buddy_link_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.layover_sessions WHERE id=NEW.layover_session_id AND user_id=NEW.user_id)
 OR NOT EXISTS(SELECT 1 FROM public.rent_buddy_bookings WHERE id=NEW.booking_id AND traveler_id=NEW.user_id AND category='layover') THEN
  RAISE EXCEPTION 'layover_buddy_owner_mismatch';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.booking_id<>OLD.booking_id OR NEW.layover_session_id<>OLD.layover_session_id OR NEW.user_id<>OLD.user_id OR NEW.timezone<>OLD.timezone OR NEW.created_at<>OLD.created_at OR NEW.certified_end_by>OLD.certified_end_by OR NEW.earliest_start_at<OLD.earliest_start_at) THEN
  RAISE EXCEPTION 'layover_buddy_context_immutable';
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_buddy_link_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER layover_buddy_link_guard BEFORE INSERT OR UPDATE ON public.layover_buddy_booking_links FOR EACH ROW EXECUTE FUNCTION public.layover_buddy_link_guard();
CREATE FUNCTION public.layover_buddy_booking_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE bound public.layover_buddy_booking_links%ROWTYPE; b public.rent_buddy_bookings%ROWTYPE; begins timestamptz;
BEGIN
 -- Deferred constraint: the atomic RPC inserts the booking and its context in the same transaction.
 SELECT * INTO b FROM public.rent_buddy_bookings WHERE id=NEW.id; IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO bound FROM public.layover_buddy_booking_links WHERE booking_id=b.id FOR SHARE;
 IF NOT FOUND THEN IF b.category='layover' THEN RAISE EXCEPTION 'layover_buddy_context_required'; ELSE RETURN NEW; END IF; END IF;
 IF b.category<>'layover' OR b.traveler_id<>bound.user_id OR b.start_time IS NULL OR b.duration_h<=0 THEN RAISE EXCEPTION 'layover_buddy_booking_identity'; END IF;
 IF TG_OP='UPDATE' AND (NEW.buddy_id<>OLD.buddy_id OR NEW.traveler_id<>OLD.traveler_id) THEN RAISE EXCEPTION 'layover_buddy_booking_identity'; END IF;
 IF b.status IN ('cancelled','cancelled_by_traveler','cancelled_by_buddy','declined','expired') THEN RETURN NEW; END IF;
 begins=(b.booking_date+b.start_time) AT TIME ZONE bound.timezone;
 IF begins<bound.earliest_start_at OR begins+b.duration_h*interval '1 hour'>=bound.certified_end_by THEN RAISE EXCEPTION 'layover_buddy_certified_deadline'; END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND (NEW.booking_date<>OLD.booking_date OR NEW.start_time IS DISTINCT FROM OLD.start_time OR NEW.duration_h<>OLD.duration_h)) THEN
  IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_buddy_specialist_enabled' AND enabled)
  OR NOT EXISTS(SELECT 1 FROM public.layover_sessions WHERE id=bound.layover_session_id AND user_id=bound.user_id AND status='active') THEN RAISE EXCEPTION 'layover_buddy_layover_unavailable'; END IF;
  -- Serialize all specialist scheduling for this buddy, including two concurrent checkouts.
  PERFORM 1 FROM public.rent_buddy_profiles WHERE id=b.buddy_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.rent_buddy_bookings other WHERE other.buddy_id=b.buddy_id AND other.id<>b.id AND other.status IN ('pending','requested','confirmed','scheduled','in_progress') AND other.booking_date=b.booking_date AND (other.start_time IS NULL OR (b.start_time<other.start_time+other.duration_h*interval '1 hour' AND b.start_time+b.duration_h*interval '1 hour'>other.start_time))) THEN RAISE EXCEPTION 'layover_buddy_already_booked'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_buddy_booking_guard() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER layover_buddy_booking_guard AFTER INSERT OR UPDATE ON public.rent_buddy_bookings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.layover_buddy_booking_guard();
CREATE FUNCTION public.layover_buddy_create_booking(p_booking jsonb,p_session_id uuid,p_user_id uuid,p_earliest_start timestamptz,p_end_by timestamptz,p_timezone text,p_certification jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE b public.rent_buddy_bookings%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_buddy_specialist_enabled' AND enabled)
 OR NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='rent_buddy_enabled' AND enabled) THEN RAISE EXCEPTION 'layover_buddy_disabled'; END IF;
 IF p_booking->>'category'<>'layover' OR (p_booking->>'traveler_id')::uuid<>p_user_id THEN RAISE EXCEPTION 'layover_buddy_booking_identity'; END IF;
 PERFORM 1 FROM public.rent_buddy_profiles WHERE id=(p_booking->>'buddy_id')::uuid FOR UPDATE;
 INSERT INTO public.rent_buddy_bookings(buddy_id,traveler_id,package_id,trip_id,booking_date,start_time,duration_h,group_size,city,country_code,category,notes,payment_mode,total_usd,deposit_usd,cash_balance_usd,is_test_booking,expires_at,status,safety_status,route_plan,updated_at)
 VALUES((p_booking->>'buddy_id')::uuid,p_user_id,(p_booking->>'package_id')::uuid,(p_booking->>'trip_id')::uuid,(p_booking->>'booking_date')::date,(p_booking->>'start_time')::time,(p_booking->>'duration_h')::numeric,(p_booking->>'group_size')::integer,p_booking->>'city',p_booking->>'country_code','layover',p_booking->>'notes',(p_booking->>'payment_mode')::public.rent_buddy_payment_mode,(p_booking->>'total_usd')::numeric,(p_booking->>'deposit_usd')::numeric,(p_booking->>'cash_balance_usd')::numeric,coalesce((p_booking->>'is_test_booking')::boolean,false),(p_booking->>'expires_at')::timestamptz,'requested','normal','[]'::jsonb,now()) RETURNING * INTO b;
 INSERT INTO public.layover_buddy_booking_links(booking_id,layover_session_id,user_id,certified_end_by,earliest_start_at,timezone,certification) VALUES(b.id,p_session_id,p_user_id,p_end_by,p_earliest_start,p_timezone,p_certification);
 RETURN to_jsonb(b);
END $fn$;
REVOKE ALL ON FUNCTION public.layover_buddy_create_booking(jsonb,uuid,uuid,timestamptz,timestamptz,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.layover_buddy_create_booking(jsonb,uuid,uuid,timestamptz,timestamptz,text,jsonb) TO service_role;
CREATE FUNCTION public.layover_buddy_accept_change(p_booking_id uuid,p_request_id uuid,p_actor_id uuid,p_note text,p_earliest_start timestamptz,p_end_by timestamptz,p_certification jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE b public.rent_buddy_bookings%ROWTYPE; c public.buddy_booking_change_requests%ROWTYPE;
BEGIN
 SELECT * INTO b FROM public.rent_buddy_bookings WHERE id=p_booking_id FOR UPDATE;
 SELECT * INTO c FROM public.buddy_booking_change_requests WHERE id=p_request_id AND booking_id=p_booking_id FOR UPDATE;
 IF b.id IS NULL OR c.id IS NULL OR c.status<>'pending' OR c.requested_by=p_actor_id OR b.category<>'layover' OR b.status NOT IN ('pending','requested','confirmed','scheduled') OR (p_actor_id<>b.traveler_id AND NOT EXISTS(SELECT 1 FROM public.rent_buddy_profiles WHERE id=b.buddy_id AND user_id=p_actor_id)) THEN RAISE EXCEPTION 'layover_change_forbidden'; END IF;
 IF c.change_field NOT IN ('date','start_time','duration_h') OR (c.change_field='duration_h' AND (c.proposed_value->>'duration_h')::numeric>b.duration_h) THEN RAISE EXCEPTION 'layover_checkout_required'; END IF;
 UPDATE public.layover_buddy_booking_links SET certified_end_by=p_end_by,earliest_start_at=p_earliest_start,certification=p_certification WHERE booking_id=b.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'layover_buddy_context_required'; END IF;
 UPDATE public.rent_buddy_bookings SET booking_date=CASE WHEN c.change_field='date' THEN (c.proposed_value->>'date')::date ELSE booking_date END,start_time=CASE WHEN c.change_field='start_time' THEN (c.proposed_value->>'start_time')::time ELSE start_time END,duration_h=CASE WHEN c.change_field='duration_h' THEN (c.proposed_value->>'duration_h')::numeric ELSE duration_h END,updated_at=now() WHERE id=b.id;
 UPDATE public.buddy_booking_change_requests SET status='approved',responded_by=p_actor_id,response_note=p_note,responded_at=now() WHERE id=c.id;
 RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_buddy_accept_change(uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.layover_buddy_accept_change(uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb) TO service_role;
INSERT INTO public.feature_flags(flag,enabled,description) VALUES('layover_buddy_specialist_enabled',false,'3894: verified layover specialist declaration and certified booking context; requires Rent-a-Buddy activation and live identity') ON CONFLICT(flag) DO NOTHING;
DO $post$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.layover_buddy_booking_links'::regclass AND relrowsecurity)
 OR has_table_privilege('authenticated','public.layover_buddy_booking_links','SELECT') OR has_function_privilege('anon','public.layover_buddy_create_booking(jsonb,uuid,uuid,timestamptz,timestamptz,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3894): service-only authority required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_buddy_specialist_enabled') THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3894): flag missing'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
