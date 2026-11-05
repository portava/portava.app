-- Created with supabase migration new map_private_controls, normalized to the
-- repository's ordered migration convention. No grants are enrolled here.
BEGIN;
CREATE TABLE public.map_personal_protected_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('home','work','school')),
  center_lat numeric(5,2) NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
  center_lng numeric(6,2) NOT NULL CHECK (center_lng BETWEEN -180 AND 180),
  radius_meters integer NOT NULL DEFAULT 1500 CHECK (radius_meters BETWEEN 1000 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,category)
);
ALTER TABLE public.map_personal_protected_places ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.map_personal_protected_places FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.map_personal_protected_places TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.map_personal_protected_places TO service_role;
CREATE POLICY protected_places_owner_read ON public.map_personal_protected_places
 FOR SELECT TO authenticated USING (owner_user_id=(SELECT auth.uid()));
CREATE POLICY protected_places_service ON public.map_personal_protected_places
 FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON TABLE public.map_personal_protected_places IS 'Explicit owner-selected coarse privacy areas only. No inferred address, name, sensor history or public projection. Coordinates rounded to .01 degrees and radius >=1km. One home/work/school designation each. Removed explicitly or on profile deletion. Suppresses that owner location and route contributions.';

CREATE TABLE public.map_navigation_contributions (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  from_zone_id uuid NOT NULL REFERENCES public.geo_zones(id) ON DELETE CASCADE,
  to_zone_id uuid NOT NULL REFERENCES public.geo_zones(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK(from_zone_id<>to_zone_id),
  CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '15 minutes')
);
CREATE INDEX map_navigation_contributions_expiry ON public.map_navigation_contributions(expires_at);
ALTER TABLE public.map_navigation_contributions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.map_navigation_contributions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.map_navigation_contributions TO service_role;
CREATE POLICY navigation_service ON public.map_navigation_contributions FOR ALL TO service_role USING(true) WITH CHECK(true);
COMMENT ON TABLE public.map_navigation_contributions IS 'Explicit route-flow opt-in only. Latest single zone-to-zone navigation intent per owner, overwriting previous; no raw coordinate, path history or public individual row. Readable for <=15m; TTL sweep deletes expired rows. Not evidence of actual movement.';

INSERT INTO public.feature_flags(flag,enabled) VALUES('map_route_flow_consent_enabled',false) ON CONFLICT(flag) DO NOTHING;

CREATE FUNCTION public.set_map_route_flow_consent(p_user_id uuid,p_enabled boolean,p_version text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role required'; END IF;
 IF p_enabled AND (p_version IS NULL OR length(p_version)<1 OR length(p_version)>64) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='disclosure version required'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text,4008));
 INSERT INTO public.route_flow_contribution_consent(user_id,enabled,consent_version,consented_at,withdrawn_at,updated_at)
 VALUES(p_user_id,p_enabled,CASE WHEN p_enabled THEN p_version ELSE NULL END,CASE WHEN p_enabled THEN now() ELSE NULL END,CASE WHEN p_enabled THEN NULL ELSE now() END,now())
 ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,
 consent_version=CASE WHEN p_enabled THEN p_version ELSE route_flow_contribution_consent.consent_version END,
 consented_at=CASE WHEN p_enabled THEN now() ELSE route_flow_contribution_consent.consented_at END,
 withdrawn_at=CASE WHEN p_enabled THEN NULL ELSE now() END,updated_at=now();
 IF NOT p_enabled THEN DELETE FROM public.map_navigation_contributions WHERE user_id=p_user_id; END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.set_map_route_flow_consent(uuid,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_map_route_flow_consent(uuid,boolean,text) TO service_role;

CREATE FUNCTION public.record_map_navigation_contribution(p_user_id uuid,p_version text,p_from uuid,p_to uuid,p_from_lat double precision,p_from_lng double precision,p_to_lat double precision,p_to_lng double precision)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role required'; END IF;
 IF p_from_lat IS NULL OR p_from_lng IS NULL OR p_to_lat IS NULL OR p_to_lng IS NULL OR p_from_lat NOT BETWEEN -90 AND 90 OR p_to_lat NOT BETWEEN -90 AND 90 OR p_from_lng NOT BETWEEN -180 AND 180 OR p_to_lng NOT BETWEEN -180 AND 180 THEN RETURN false; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text,4008));
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='map_route_flow_consent_enabled' AND enabled)
 OR NOT EXISTS(SELECT 1 FROM public.route_flow_contribution_consent WHERE user_id=p_user_id AND enabled AND withdrawn_at IS NULL AND consent_version=p_version) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.map_personal_protected_places p WHERE p.owner_user_id=p_user_id AND (
  12742000*asin(sqrt(least(1.0,power(sin(radians(p_from_lat-p.center_lat)/2),2)+cos(radians(p.center_lat))*cos(radians(p_from_lat))*power(sin(radians(p_from_lng-p.center_lng)/2),2))))<=p.radius_meters OR
  12742000*asin(sqrt(least(1.0,power(sin(radians(p_to_lat-p.center_lat)/2),2)+cos(radians(p.center_lat))*cos(radians(p_to_lat))*power(sin(radians(p_to_lng-p.center_lng)/2),2))))<=p.radius_meters)) THEN RETURN false; END IF;
 INSERT INTO public.map_navigation_contributions(user_id,from_zone_id,to_zone_id,observed_at,expires_at)
 VALUES(p_user_id,p_from,p_to,now(),now()+interval '15 minutes')
 ON CONFLICT(user_id) DO UPDATE SET from_zone_id=EXCLUDED.from_zone_id,to_zone_id=EXCLUDED.to_zone_id,observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at;
 RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.record_map_navigation_contribution(uuid,text,uuid,uuid,double precision,double precision,double precision,double precision) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_map_navigation_contribution(uuid,text,uuid,uuid,double precision,double precision,double precision,double precision) TO service_role;
CREATE FUNCTION public.set_map_personal_protected_place(p_user_id uuid,p_category text,p_lat double precision,p_lng double precision,p_radius integer)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role required'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text,4008));
 INSERT INTO public.map_personal_protected_places(owner_user_id,category,center_lat,center_lng,radius_meters)
 VALUES(p_user_id,p_category,round(p_lat::numeric,2),round(p_lng::numeric,2),p_radius)
 ON CONFLICT(owner_user_id,category) DO UPDATE SET center_lat=EXCLUDED.center_lat,center_lng=EXCLUDED.center_lng,radius_meters=EXCLUDED.radius_meters;
 DELETE FROM public.map_navigation_contributions WHERE user_id=p_user_id;
END $fn$;
REVOKE ALL ON FUNCTION public.set_map_personal_protected_place(uuid,text,double precision,double precision,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_map_personal_protected_place(uuid,text,double precision,double precision,integer) TO service_role;
CREATE FUNCTION public.purge_expired_map_navigation_contributions(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE removed integer;
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role required'; END IF;
 WITH expired AS (SELECT user_id FROM public.map_navigation_contributions WHERE expires_at<=now() ORDER BY expires_at LIMIT greatest(1,least(p_limit,2000)) FOR UPDATE SKIP LOCKED)
 DELETE FROM public.map_navigation_contributions n USING expired e WHERE n.user_id=e.user_id AND n.expires_at<=now();
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN removed;
END $fn$;
REVOKE ALL ON FUNCTION public.purge_expired_map_navigation_contributions(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_map_navigation_contributions(integer) TO service_role;
COMMIT;
