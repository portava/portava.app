-- 2550_discovery_trip_projection_consumer_flag.sql
--
-- Discovery consumes the Trip-owned TripDiscoveryProjection
-- (lib/tripDiscoveryProjection.ts) instead of reading `trips` itself — behind
-- ONE capability flag, seeded FALSE. Discovery-owned.
--
-- Spec: docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt
--   §1     "No Map, Compass, Telegraph, Discovery, Buddy, or UI component may
--          independently invent canonical trip state."
--   §19.1  every projection carries generatedAt, sourceTripVersion,
--          projectionSchemaVersion, freshness; consumers reject/degrade on an
--          incompatible one
--   §25    "Map, Compass, Discovery ... consume explicit Trip projections /
--          contracts rather than duplicating Trip semantics."
-- docs/architecture/census-discovery.md A10 (the duplication) / D3 (the fix).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2550
-- (Discovery consumer). Additive + idempotent. Safe to re-run.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- DEPENDENCY ORDER — READ BEFORE FLIPPING THE FLAG (NOT before applying it)
-- ══════════════════════════════════════════════════════════════════════════════
--   0037                  feature_flags. The ONLY precondition of THIS file.
--   2334 -> 2337 -> 2420  trips.version — required by the READERS the flag
--                         enables, NOT by this seed. TRIP_DISCOVERY_SOURCE_COLUMNS
--                         ends with `version`; both readers fail CLOSED on a
--                         resolved database error.
--
-- Production (ajrurzioarfkagpuxfnb), measured 2026-09-07: trips.version does
-- NOT exist (2420 unapplied; trip_events absent too), 43 trips, 12 of them
-- discoverable. This seed applies there safely and changes nothing. FLIPPING
-- THE FLAG THERE BEFORE 2420 WOULD MAKE EVERY TRIP SEARCH AND EVERY PLAN
-- SEARCH RETURN NOTHING — a PostgREST 42703 on a missing column, silent to
-- the user. The postcondition block below RAISES if the flag is TRUE on a
-- database without trips.version, so a re-run after a premature flip fails
-- loudly instead of leaving the outage in place.
-- portava-ci (hwokxgbmezheskbzskfr) has 2420 applied; the flag may be flipped
-- there for verification.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS CHANGES FOR A USER: NOTHING, UNTIL THE FLAG IS FLIPPED
-- ══════════════════════════════════════════════════════════════════════════════
-- One flag row. With it FALSE, absent, or unreadable, routes/discoverySearch.ts
-- searchTrips and searchPlans issue the SAME `trips` reads they issued before
-- this lane — same columns, predicates, order and range — and the projection
-- readers are never called. Pinned by
-- src/test/discoveryTripProjectionConsumer.test.ts. Reader:
-- lib/discoveryTripProjectionConsumer.ts (DISCOVERY_TRIP_PROJECTION_FLAG,
-- literal), through isFlagEnabled — fail-closed toward legacy.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT CHANGES WHEN IT IS FLIPPED — A POLICY CONSEQUENCE, STATED
-- ══════════════════════════════════════════════════════════════════════════════
-- The projection is built on toPrivateTripPreview, so the OWNER'S PRIVACY
-- TOGGLES APPLY TO A DISCOVERY SEARCHER:
--   show_exact_dates = false       → the card's startsAt is null
--   show_destination_city = false  → the card shows the country only
--   show_header_publicly = false   → the card shows the placeholder cover
-- Today Discovery ignores all three and shows the true date, city and cover of
-- every discoverable trip. Production 2026-09-07: 12 discoverable trips, 0 with
-- any toggle off — unobservable today, real the moment an owner sets one. This
-- is the Trips lane's deliberate choice (one non-member rule, one place) and
-- the more private direction; the consumer does not bypass it. Ordering and
-- date-bounding of the trips search still use the true start_date in SQL
-- (searchTripDiscoveryProjections). The plans search bounds on the
-- projection's startDate, so a hidden-date trip passes a time-intent bound
-- the way a trip with no start_date passes it today.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ══════════════════════════════════════════════════════════════════════════════
--   * Does not require 2420. The seed must be applicable to production as it
--     is, so the flag exists (FALSE) before the chain that makes it safe to
--     flip is applied.
--   * Does not create a projection table, worker or outbox consumer. The
--     projection is computed from the canonical row in-request
--     (freshness = "live"); there is no event-sourced pipeline behind it.
--   * Does not move the blocked / age-restricted / active-owner filters into
--     the projection. Those stay in Discovery, on ownerId.
--
-- Rollback: db/rollback/2026-09-07-2550-discovery-trip-projection-consumer-rollback.sql
-- RUNTIME EFFECT: NONE with the flag absent or false.

BEGIN;

-- ── 0. Preconditions ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags (0037) does not exist.';
  END IF;
  IF to_regclass('public.trips') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trips does not exist; there is nothing for the consumer to project.';
  END IF;
  -- NOTE, not a failure: the readers need trips.version (2420). Absent here
  -- means "seed the flag, never flip it on this database until 2420 lands".
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'version') THEN
    RAISE NOTICE '2550: trips.version is ABSENT on this database (2420 unapplied). discovery_trip_projection_enabled is seeded FALSE and MUST stay FALSE here until 2334 -> 2337 -> 2420 are applied; ON would return [] for every trips/plans search.';
  END IF;
END $$;

-- ── 1. Flag, seeded FALSE ─────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('discovery_trip_projection_enabled', false,
   'Discovery consumes the Trip-owned TripDiscoveryProjection (lib/tripDiscoveryProjection.ts; Trips spec §25, census-discovery A10/D3) for type=trips and type=plans search instead of reading `trips` itself. REQUIRES trips.version (migration 2420): both readers fail closed without it and every trips/plans search returns nothing. ON: the owner''s show_exact_dates / show_destination_city / show_header_publicly toggles apply to a Discovery searcher (they do not today). FALSE / absent / unreadable (the seed): the legacy `trips` reads in routes/discoverySearch.ts, byte-identical to before. Read fail-closed (isFlagEnabled) by lib/discoveryTripProjectionConsumer.ts. Enabling is an owner decision; on production only after 2420.')
ON CONFLICT (flag) DO NOTHING;

-- ── 2. Postconditions ─────────────────────────────────────────────────────────
DO $$
DECLARE
  present     integer;
  on_count    integer;
  has_version boolean;
  n_cols      integer;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
   WHERE flag = 'discovery_trip_projection_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly one discovery_trip_projection_enabled row, found %', present;
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'version')
    INTO has_version;

  SELECT count(*) INTO on_count FROM public.feature_flags
   WHERE flag = 'discovery_trip_projection_enabled' AND enabled = TRUE;

  -- The seed is FALSE. A re-run keeps an existing row (ON CONFLICT DO NOTHING),
  -- so the value may legitimately be TRUE on a database where an owner flipped
  -- it — but ONLY where the readers can run. TRUE without trips.version is a
  -- live outage of trips/plans search and is refused here, loudly.
  IF on_count <> 0 AND NOT has_version THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: discovery_trip_projection_enabled is TRUE but trips.version (2420) is absent — every trips/plans search returns [] in this state. Set it FALSE or apply 2334 -> 2337 -> 2420.';
  END IF;
  IF on_count <> 0 THEN
    RAISE NOTICE '2550: discovery_trip_projection_enabled was already TRUE on this database (re-run); left as found because trips.version exists.';
  END IF;

  -- Non-vacuous on a database WITH 2420: every column the contract selects
  -- (TRIP_DISCOVERY_SOURCE_COLUMNS in lib/tripDiscoveryProjection.ts) must
  -- exist on public.trips, or the readers 42703 the moment the flag is ON.
  -- Mirrors that constant literally; a drift between the two is this RAISE.
  IF has_version THEN
    SELECT count(*) INTO n_cols FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'trips'
       AND column_name IN ('id', 'owner_id', 'title', 'destination_city', 'destination_country', 'cover_url',
                           'start_date', 'end_date', 'status', 'visibility', 'show_in_discovery', 'show_exact_dates',
                           'show_destination_city', 'show_header_publicly', 'precise_location_visible', 'trip_type',
                           'open_to_meet', 'created_at', 'updated_at', 'version');
    IF n_cols <> 20 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: TRIP_DISCOVERY_SOURCE_COLUMNS names 20 trips columns; % exist here. The projection readers would fail closed with the flag ON.', n_cols;
    END IF;
  END IF;
END $$;

COMMIT;
