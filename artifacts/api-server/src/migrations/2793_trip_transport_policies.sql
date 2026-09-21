-- 2793_trip_transport_policies.sql
--
-- Trips spec §7.4 — the route-availability check: "feasible by taxi but the
-- transport-mode policy says no taxi". census-trips TR137: *"No transport-mode
-- policy exists. services/routeOptimizer.ts:22 flags legs over 800 m for a
-- rideshare recommendation under the low_walking style — a suggestion inside
-- a route plan, not a policy check on a trip."*
--
-- This is the policy: one row per trip naming the modes the trip does NOT
-- use. services/trips/TripTransportPolicy.ts asks the travel-time provider
-- per mode and reports a hop that fits only by a disallowed mode as
-- TRIP_SPATIAL_ROUTE_UNAVAILABLE (Appendix B) — the exact sentence §7.4
-- gives. No row means no policy: every mode allowed, which is what the
-- feasibility route assumed until now, now stated rather than implied.
--
--   disallowed_modes  ⊆ {walk, drive, transit} — the vocabulary of
--                     services/trips/TravelTimeProvider.ts TRAVEL_MODES less
--                     "unknown", which is not a mode a policy can name.
--   note              why, in ≤ 300 characters, for the crew.
--
-- Written by the server alone (PUT /trips/:tripId/transport-policy, owner
-- only through §6.1 canEditTrip); read by the crew through RLS. Not a kernel
-- command: the policy is not trip state a projection replays, it is a
-- preference the feasibility check reads at request time, and bumping
-- trips.version for it would be wrong.
--
-- Additive: a new table. Applied on scripts/local-db; rehearsed by
-- src/test/db/tripTransportPolicies.db.test.ts.

DO $pre$
BEGIN
  IF to_regclass('public.trips') IS NULL THEN
    RAISE EXCEPTION '2793: public.trips does not exist';
  END IF;
  IF to_regclass('public.trip_transport_policies') IS NOT NULL THEN
    RAISE EXCEPTION '2793: trip_transport_policies already exists';
  END IF;
  IF to_regprocedure('authz.is_trip_crew(uuid)') IS NULL THEN
    RAISE EXCEPTION '2793: authz.is_trip_crew(uuid) is missing — the crew read policy needs it';
  END IF;
END
$pre$;

CREATE TABLE public.trip_transport_policies (
  trip_id          uuid        PRIMARY KEY REFERENCES public.trips(id) ON DELETE CASCADE,
  disallowed_modes text[]      NOT NULL DEFAULT '{}',
  note             text        NULL,
  updated_by       uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_transport_policies_modes_known
    CHECK (disallowed_modes <@ ARRAY['walk', 'drive', 'transit']::text[]),
  CONSTRAINT trip_transport_policies_note_length
    CHECK (note IS NULL OR char_length(note) <= 300)
);

COMMENT ON TABLE public.trip_transport_policies IS
  'Trips spec §7.4: the modes a trip does not use. A hop that fits only by a disallowed mode is TRIP_SPATIAL_ROUTE_UNAVAILABLE. No row = no policy = every mode allowed. Server-written (owner only); crew-readable.';

ALTER TABLE public.trip_transport_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_transport_policies_crew_select ON public.trip_transport_policies
  FOR SELECT TO authenticated USING (authz.is_trip_crew(trip_id));
REVOKE ALL ON public.trip_transport_policies FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_transport_policies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trip_transport_policies TO service_role;

DO $post$
BEGIN
  IF to_regclass('public.trip_transport_policies') IS NULL THEN
    RAISE EXCEPTION '2793: trip_transport_policies was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trip_transport_policies'::regclass) THEN
    RAISE EXCEPTION '2793: RLS is not enabled';
  END IF;
  IF has_table_privilege('authenticated', 'public.trip_transport_policies', 'INSERT')
     OR has_table_privilege('authenticated', 'public.trip_transport_policies', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.trip_transport_policies', 'DELETE') THEN
    RAISE EXCEPTION '2793: authenticated can write the policy directly';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trip_transport_policies_modes_known') THEN
    RAISE EXCEPTION '2793: the mode vocabulary CHECK is missing';
  END IF;
END
$post$;
