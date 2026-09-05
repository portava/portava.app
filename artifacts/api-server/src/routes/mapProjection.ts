/**
 * GET /api/map/projection — the Map Intelligence Gateway (Map spec §19).
 *
 *   flag: map_projection_enabled (OFF by default; fail-soft)
 *
 * ONE call that returns the viewport's MapObjects, already ranked by the §31
 * priority ladder, instead of the five independent per-layer fetches the client
 * merges today. Spec §19's pipeline, in order:
 *
 *   Canonical Systems → Map Projection Service → Map Objects → Map Ranking
 *   → Privacy / Eligibility → Viewport Aggregation → Mobile Renderer
 *
 * PRIVACY POSTURE — identical to /api/map/search, deliberately
 * =============================================================
 * This route NEVER re-decides who or what is visible. It calls each entity
 * type's existing privacy-complete source and lib/mapProjection only shapes the
 * already-safe rows:
 *
 *   travelers → listMapTravelers        (opt-in + coarsening + block filter)
 *   gems      → findNearbyGems + applyGemPrivacyBatch
 *   events    → loadNearbyEvents        (same gates as GET /api/events/nearby,
 *                                        incl. show_exact_location redaction)
 *   circle    → readCircleLocations     (kill switch + membership + blocks +
 *                                        affirmative consent + master switch +
 *                                        SERVER-SIDE coarsening)
 *   trips     → loadViewerTrips         (accepted-membership scope, then the
 *                                        shared toAuthorizedTripView DTO)
 *
 * The block set is resolved ONCE, fail-closed: if it cannot be read, nobody is
 * returned. That single set is handed to every people-bearing source —
 * listMapTravelers and readCircleLocations both take it — so this request can
 * never end up with two different answers to "who is blocked". Objects are
 * passed through `servableOnly` before serialization, so anything at privacy
 * rung 'none' or without renderable geometry is dropped at the boundary
 * whatever produced it.
 *
 * WHY THE CIRCLE LAYER IS THE ONE THAT MATTERED
 * =============================================
 * Its coordinates are people. `readCircleLocations` coarsens every position
 * with `coarsenPosition` BEFORE returning it, so the coarse coordinate is what
 * this route shapes and serializes — the precise one never reaches the
 * projection, let alone the wire. The client's post-fetch ±0.01° jitter
 * (coarsenForFriend) sits on top of that and is cosmetic; a client-side
 * coarsening step could never have protected anything, because the value it
 * "protects" has already been delivered to the device.
 *
 * SCOPE — all six layers now arrive through the gateway
 * =====================================================
 * Buddies were the last hold-out, and for a real reason: their visibility rules
 * (the rent_buddy_enabled flag, then status/admin_status), their public column
 * allow-list (BUDDY_PUBLIC_COLUMNS) and their private-field strip
 * (stripBuddyPrivateFields → mapBuddyPublicProfile) were module-private to
 * routes/rentABuddy.ts, interleaved with marketplace ranking, pagination and an
 * outbound Nominatim geocode. Restating "which buddy fields are public" here
 * would have created exactly the second implementation this route exists to
 * remove. So the privacy-complete part was EXTRACTED into lib/buddyMapRead —
 * one BUDDY_PUBLIC_COLUMNS, one stripBuddyPrivateFields, shared by the
 * marketplace and this route — while ranking, pagination and the geocode stayed
 * behind in the marketplace, where they belong.
 *
 *   buddies   → readBuddyMapPins       (feature flag + status/admin_status +
 *                                       blocks + meetup-base-only, no geocode)
 *
 * `sources` names what actually arrived through the gateway, so nobody has to
 * guess which path a layer took.
 *
 * §10 CROWD FLOW — THE LAYER NOTHING COULD ASK FOR
 * ================================================
 * §10 was fully built and completely unreachable: `produceZoneTransitions` and
 * `deriveCrowdFlow` had no caller in src/routes, so no client could ever be
 * served a flow however many gates it cleared. This route is that surface.
 *
 *   flows     → produceZoneTransitions  (per-family consent, freshness, zone
 *                                        granularity enforced by type)
 *               → deriveCrowdFlow       (§10's four gates: privacy/k, freshness,
 *                                        multiple signal families, density)
 *
 * IT IS A `crowd_flow` KIND IN THIS GATEWAY, NOT AN ENDPOINT OF ITS OWN. §19
 * says the client must not reconstruct Portava's intelligence rules, and a
 * bespoke /api/map/crowd-flow would have skipped §31 ranking, the §24
 * protection gate, viewport aggregation and privacy-class stamping — the exact
 * bypass src/test/gatewayBypassGuard.test.ts exists to catch, which is why
 * `produceZoneTransitions` is now registered there with this file as its only
 * approved caller.
 *
 * THE ZONE MODEL IS THIS ROUTE'S JOB, AND ONLY THIS ROUTE'S. The producer takes
 * `resolveZoneId`, `resolveZoneForPoint` and `zoneCentroids` from its caller and
 * REFUSES rather than approximating an endpoint to a coordinate when they are
 * missing. `loadFlowZones` + `loadViewportPlaces` + lib/mapProjection's
 * `buildFlowZoneModel` supply them from curated `geo_zones` geography; every
 * endpoint that resolves to no zone is dropped. NO GATE CONSTANT IS TOUCHED
 * HERE — MIN_SIGNAL_FAMILIES, the k floor, maxGroupShare and the freshness
 * bound all stay where they are and say what they said.
 *
 * WHAT IT SERVES TODAY: NOTHING, AND THAT IS THE CORRECT ANSWER.
 * `map_crowd_flow_enabled` is seeded FALSE and both contribution-consent tables
 * are empty, so `crowdFlow.refusal` reads `flag_off` and no flow object exists.
 * An empty flow layer for that reason is indistinguishable from an empty flow
 * layer caused by broken wiring — which is why `crowdFlow` reports refusals and
 * counts, and why src/test/mapCrowdFlowLayer.test.ts drives a synthetic cohort
 * that CLEARS every gate through this route and asserts the object arrives.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { fetchBlockedSet } from "../lib/blocks.js";
import { listMapTravelers } from "../lib/mapTravelers.js";
import { readCircleLocations } from "../lib/circleLocationsRead.js";
import { readBuddyMapPins } from "../lib/buddyMapRead.js";
import { toAuthorizedTripView } from "../lib/privacy/tripSerializers.js";
import { findNearbyGems } from "../services/hiddenGems/HiddenGemDiscoveryService.js";
import { applyGemPrivacyBatch } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";
import { readLiveClaims, toLiveClaimEnvelope } from "../lib/liveClaimRead.js";
import { loadNearbyEvents } from "./mapSearch.js";
import { aggregateForViewport, bboxContains, deriveCrowdFlow, type BBox } from "../lib/mapAggregation.js";
import { applyProtection, type ProtectedZone } from "../lib/protectedLocations.js";
import { CROWD_FLOW_FLAG, produceZoneTransitions } from "../lib/crowdFlowProducer.js";
import { readMeetingPoints } from "../lib/mapProducers/meetingPointProducer.js";
import { readMemoryPins } from "../lib/mapProducers/memoryProducer.js";
import { readSafetyNotices } from "../lib/mapProducers/safetyNoticeProducer.js";
import { readSavedPlacePins } from "../lib/mapProducers/savedPlaceProducer.js";
import { deriveEventCauseHypotheses } from "../lib/mapProducers/eventContextProducer.js";
import { loadViewportPlaceRows, projectPlace } from "../lib/mapProjectPlace.js";
import {
  WORLD_INTELLIGENCE_FLAG,
  WORLD_INTELLIGENCE_KINDS,
  bandCarriesWorldIntelligence,
  type WorldIntelligenceRefusal,
} from "../lib/mapProducers/worldIntelligence.js";
import { deriveWorldPulse, type WorldPulseReport } from "../lib/mapProducers/worldPulseProducer.js";
import { readTravelerFlowEdges, type TravelerFlowReport } from "../lib/mapProducers/travelerFlowProducer.js";
import { readCityModels, type CityModelReport } from "../lib/mapProducers/cityModelProducer.js";
import { readPersonalCityPins, type PersonalCityReport } from "../lib/mapProducers/personalCityProducer.js";

/**
 * Compile-time pin for the flag literal used at the crowd-flow call site.
 * The literal exists so check:flag-polarity can resolve it; this makes renaming
 * the constant a TYPE ERROR rather than a silently-diverging second spelling.
 */
const CROWD_FLOW_FLAG_PIN: "map_crowd_flow_enabled" = CROWD_FLOW_FLAG;
void CROWD_FLOW_FLAG_PIN;
/** The same pin for §36 Phase 7's flag (migration 2291). */
const WORLD_INTELLIGENCE_FLAG_PIN: "map_world_intelligence_enabled" = WORLD_INTELLIGENCE_FLAG;
void WORLD_INTELLIGENCE_FLAG_PIN;
import { type MapObject, type MapObjectKind } from "../lib/mapObjects.js";
import {
  FLOW_ZONE_TYPES,
  bboxToCenterRadius,
  buildFlowZoneModel,
  countAdjacentActiveEvents,
  enrichWithLiveClaims,
  filterKinds,
  indexPlaceZones,
  paginate,
  parseBbox,
  parseCityGeographies,
  parseFlowZones,
  parseKinds,
  projectBuddy,
  projectCircleMember,
  projectEvent,
  projectGem,
  projectTraveler,
  projectTrip,
  rankObjects,
  servableOnly,
  withholdCoarsenableAggregates,
  type CityGeographyParseResult,
  type FlowZone,
  type TripViewLike,
} from "../lib/mapProjection.js";

const router = Router();

/**
 * §24 protected zones.
 *
 * FAIL-CLOSED IS SUBTLE HERE, so it is spelled out: `applyProtection([], ...)`
 * with an empty zone list is an IDENTITY PASS — it means "no protection policy
 * exists", not "the policy could not be read". Returning [] on a read failure
 * would therefore silently disable the gate exactly when the database is
 * unhealthy. So a failed read returns null, and the caller answers with the
 * empty envelope instead of serving unprotected objects.
 *
 * Cached briefly: the table is tiny and effectively static, and a per-request
 * read on a polled endpoint would be pure waste. 30s mirrors the flag cache.
 */
const ZONE_CACHE_TTL_MS = 30_000;
let _zoneCache: { zones: ProtectedZone[]; at: number } | null = null;

export function _clearProtectedZoneCache(): void { _zoneCache = null; }

async function loadProtectedZones(sc: any): Promise<ProtectedZone[] | null> {
  if (_zoneCache && Date.now() - _zoneCache.at < ZONE_CACHE_TTL_MS) return _zoneCache.zones;
  const { data, error } = await sc
    .from("protected_zones")
    .select("id, category, action, privacy_floor, shape, center_lat, center_lng, radius_meters, ring, jurisdiction, policy_ref")
    .eq("active", true);
  if (error || !Array.isArray(data)) return null;

  const zones: ProtectedZone[] = [];
  for (const row of data as any[]) {
    const base = {
      id: String(row.id),
      category: String(row.category),
      action: row.action ?? undefined,
      privacyFloor: row.privacy_floor ?? undefined,
      jurisdiction: row.jurisdiction ?? undefined,
      policyRef: row.policy_ref ?? undefined,
    };
    if (row.shape === "circle") {
      zones.push({
        ...base,
        shape: "circle",
        center: { lat: Number(row.center_lat), lng: Number(row.center_lng) },
        radiusMeters: Number(row.radius_meters),
      } as ProtectedZone);
    } else {
      // A malformed ring stays in the list on purpose: applyProtection treats
      // unparseable geometry as SUPPRESS, which is the safe direction. Dropping
      // the row here would quietly turn a broken policy into no policy.
      zones.push({ ...base, shape: "polygon", ring: row.ring } as ProtectedZone);
    }
  }
  _zoneCache = { zones, at: Date.now() };
  return zones;
}

/**
 * §10 flow zones (`geo_zones`).
 *
 * Same fail-closed shape as `loadProtectedZones` and for the same reason: null
 * means "could not be read", [] means "there are none", and the caller must not
 * confuse them — a crowd flow anchored on a zone model we failed to read would
 * be a flow anchored on nothing.
 *
 * Cached briefly: curated geography changes on a human timescale, and this
 * endpoint is polled on every camera settle. `nowMs` is passed IN rather than
 * read here, so the whole handler still has exactly one clock read.
 */
const FLOW_ZONE_CACHE_TTL_MS = 30_000;
const MAX_FLOW_ZONE_ROWS = 2_000;
let _flowZoneCache: { zones: FlowZone[]; at: number } | null = null;

export function _clearFlowZoneCache(): void { _flowZoneCache = null; }

async function loadFlowZones(sc: any, nowMs: number): Promise<FlowZone[] | null> {
  if (_flowZoneCache && nowMs - _flowZoneCache.at < FLOW_ZONE_CACHE_TTL_MS) {
    return _flowZoneCache.zones;
  }
  const { data, error } = await sc
    .from("geo_zones")
    .select("id, name, zone_type, center_lat, center_lng, radius_meters, polygon_geojson")
    .in("zone_type", FLOW_ZONE_TYPES as string[])
    .limit(MAX_FLOW_ZONE_ROWS);
  if (error || !Array.isArray(data)) return null;
  const zones = parseFlowZones(data as any[]);
  _flowZoneCache = { zones, at: nowMs };
  return zones;
}

/**
 * §36 Phase 7's CITY model (`geo_zones` where zone_type = 'city').
 *
 * A SECOND, NARROWER read rather than a filter over `loadFlowZones`, and the
 * difference is not tidiness. `loadFlowZones` is scoped to the viewport and
 * carries `neighborhood` rows too; Phase 7 needs city rows ONLY (a
 * neighbourhood-to-neighbourhood "intercity" edge would be a within-city
 * trajectory), and it needs the row's display NAME, which `FlowZone`
 * deliberately discards. `parseCityGeographies` does the label + join-key work
 * and reuses §10's own geometry validation for everything else.
 *
 * Fail-closed the same way: null means "could not be read", [] means "there are
 * none", and the caller must not confuse them.
 */
const CITY_ZONE_CACHE_TTL_MS = 30_000;
const MAX_CITY_ZONE_ROWS = 2_000;
let _cityZoneCache: { parsed: CityGeographyParseResult; at: number } | null = null;

export function _clearCityZoneCache(): void { _cityZoneCache = null; }

async function loadCityZones(sc: any, nowMs: number): Promise<CityGeographyParseResult | null> {
  if (_cityZoneCache && nowMs - _cityZoneCache.at < CITY_ZONE_CACHE_TTL_MS) {
    return _cityZoneCache.parsed;
  }
  const { data, error } = await sc
    .from("geo_zones")
    .select("id, name, zone_type, center_lat, center_lng, radius_meters, polygon_geojson")
    .eq("zone_type", "city")
    .limit(MAX_CITY_ZONE_ROWS);
  if (error || !Array.isArray(data)) return null;
  const parsed = parseCityGeographies(data as any[]);
  _cityZoneCache = { parsed, at: nowMs };
  return parsed;
}

/**
 * Places inside the viewport, for the ORIGIN half of a next-stop contribution.
 *
 * A contributor answers the trail prompt while standing at a PLACE
 * (`intel_observations.subject_id`), and lib/crowdFlowProducer asks the caller
 * to turn that place id into a zone. This read is what makes that answerable:
 * public place geography, viewport-scoped like every other layer here, and it
 * NEVER touches a person — `places` holds no user column that this select could
 * reach. The rows are consumed by `indexPlaceZones`, which keeps ids only.
 *
 * Bounded and read-failure-safe: null means the index could not be built, which
 * costs origins and therefore flows — the fail-closed direction.
 */
const MAX_INDEXED_PLACES = 1_000;

async function loadViewportPlaces(sc: any, bbox: BBox): Promise<any[] | null> {
  const { data, error } = await sc
    .from("places")
    .select("id, latitude, longitude")
    .eq("status", "active")
    .is("merged_into_place_id", null)
    .gte("latitude", bbox.south)
    .lte("latitude", bbox.north)
    .gte("longitude", bbox.west)
    .lte("longitude", bbox.east)
    .limit(MAX_INDEXED_PLACES);
  if (error || !Array.isArray(data)) return null;
  return data as any[];
}

/**
 * The zone model is scoped to the viewport, grown by one viewport on each side
 * so that an edge whose MIDPOINT the client can see still has both of its
 * endpoints in the model. Zones outside it resolve to nothing, so a hop that
 * leaves the neighbourhood of the request is dropped rather than half-resolved.
 */
function expandBbox(b: BBox): BBox {
  const dLat = Math.max(0, b.north - b.south);
  const dLng = Math.max(0, b.east - b.west);
  return {
    west: b.west - dLng,
    south: Math.max(-90, b.south - dLat),
    east: b.east + dLng,
    north: Math.min(90, b.north + dLat),
  };
}

/**
 * What the crowd flow layer did, in counts.
 *
 * `refusal` and `familyRefusals` are the machine-readable answer to the
 * question this layer would otherwise be unable to answer: an empty flow layer
 * because §10's gates said no looks EXACTLY like an empty flow layer because
 * the wiring is broken, and only one of those is fine.
 *
 * `withheld` is a TOTAL, deliberately without the per-gate breakdown that would
 * be so much more useful to a developer. A breakdown would describe the shape
 * of the cohorts that did NOT clear the floor — "two edges were held back
 * because one party dominated" is a statement about a specific group of people
 * in the viewport the client chose. The bare count follows the same rule (and
 * the same reasoning) as `aggregation.suppressedForKAnonymity` and
 * `protection`: enough to prove something was withheld, not enough to describe
 * it. The per-gate reasons exist on the server, where lib/mapAggregation
 * returns them.
 */
interface CrowdFlowReport {
  refusal: string | null;
  familyRefusals: Record<string, string | null>;
  zoneModel: {
    zones: number;
    ambiguousNames: number;
    indexedPlaces: number;
    placeIndexFailed: boolean;
  };
  transitions: number;
  published: number;
  withheld: number;
  withheldForProtection: number;
  /**
   * §10 "inferred cause": what lib/mapProducers/eventContextProducer proposed
   * from the events adjacent to the flow zones, and how many published flows
   * actually carry an `inferred` half. Counts only. `eventsReadFailed` is the
   * difference between "no adjacent event" and "we could not look" — a null
   * inferred half for the second reason must not read as the first.
   */
  inferredCause: {
    events: number;
    eventsReadFailed: boolean;
    hypotheses: number;
    attached: number;
  };
}

/**
 * What each of the four M5 producer layers did, in counts, mirroring
 * `crowdFlow`: a null entry means the kind was not requested; a `refusal`
 * names why a producer declined to read (flag off, gates closed, read failure)
 * so an empty layer is never ambiguous between "nothing here" and "we could
 * not tell". `collected` is the count BEFORE the §24 gate and aggregation —
 * the objects that were handed to the pipeline, not the objects served.
 */
type ProducerLayerReport = { refusal: string | null; collected: number };
interface ProducerReports {
  meeting_point: ProducerLayerReport | null;
  memory: ProducerLayerReport | null;
  safety_notice: ProducerLayerReport | null;
  saved_place: ProducerLayerReport | null;
}

/**
 * §36 Phase 7 World Intelligence, in counts and refusals — the same discipline
 * `CrowdFlowReport` established, for the same reason: an empty world layer
 * because the gates said no looks EXACTLY like an empty world layer because the
 * wiring is broken.
 *
 * Per-producer entries are null when that kind was not requested. `refusal` is
 * the layer-wide answer: `flag_off` (migration 2291's seed), `band_not_eligible`
 * (the camera is below the city band, where none of these kinds exists) or
 * `no_city_model` (no curated `geo_zones` city geography covers this viewport).
 *
 * Every count here is a COUNT. Naming which city withheld which time band, or
 * which pair withheld an edge, would describe the shape of the cohorts that did
 * not clear the floor — the rule `aggregation.suppressedForKAnonymity` and
 * `protection` already follow.
 */
interface WorldIntelligenceReport {
  refusal: WorldIntelligenceRefusal | null;
  cityModelGeography: { cities: number; ambiguousKeys: number; unusable: number } | null;
  worldPulse: WorldPulseReport | null;
  travelerFlow: TravelerFlowReport | null;
  cityModels: CityModelReport | null;
  personalCities: PersonalCityReport | null;
  /** Phase 7 objects §24 withheld rather than coarsened, and then suppressed. */
  withheldForProtection: number;
}

/**
 * The viewer's own trips, scoped exactly as GET /api/trips/me scopes them.
 *
 * WHY THIS READ IS HERE AND NOT EXTRACTED
 * =======================================
 * The trips layer has no leftover privacy logic to extract: its FIELD-level
 * discipline — which trip columns an authorized viewer may see — already lives
 * in the shared `toAuthorizedTripView` DTO, and that is what this calls. The
 * only thing restated is the SCOPE predicate: "rows in trip_members for this
 * user whose role is not 'invited'". An invited-but-not-accepted member must
 * NOT get the authorized view, so that `.neq("role", "invited")` is the whole
 * privacy decision, and src/test/mapProjectionLayers.test.ts pins it against
 * GET /api/trips/me's own output over the same data rather than trusting that
 * two copies of one predicate will stay in step.
 *
 * Failure returns null (not []) so the caller can leave the layer OUT of
 * `sources` rather than claim an empty trips layer it never successfully read.
 */
async function loadViewerTrips(sc: any, viewerId: string): Promise<TripViewLike[] | null> {
  const { data: memberRows, error: memErr } = await sc
    .from("trip_members")
    .select("trip_id, role")
    .eq("user_id", viewerId)
    .neq("role", "invited");
  if (memErr) return null;

  const tripIds = ((memberRows ?? []) as any[]).map((r) => r.trip_id as string);
  if (tripIds.length === 0) return [];

  const { data: trips, error: tripsErr } = await sc
    .from("trips")
    .select("*")
    .in("id", tripIds)
    .not("status", "is", null);
  if (tripsErr) return null;

  return ((trips ?? []) as any[]).map(toAuthorizedTripView) as unknown as TripViewLike[];
}

router.get(
  "/map/projection",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }

    // ONE clock read for the whole handler. Mixing Date.now() with a no-arg
    // new Date() in one function is a split clock: two reads that can straddle
    // a tick, so `generatedAt` could precede the freshness the same response
    // reports. src/test/splitClockGuard.test.ts enforces this.
    const nowMs = Date.now();
    const generatedAt = new Date(nowMs).toISOString();

    // Fail-soft: an unknown or disabled flag yields an explicitly empty,
    // explicitly disabled envelope — the client keeps its legacy per-layer path
    // rather than rendering a blank map.
    if (!(await isFlagEnabled(sc, "map_projection_enabled"))) {
      res.json({
        enabled: false,
        objects: [],
        viewport: null,
        total: 0,
        nextCursor: null,
        sources: [],
        aggregation: null,
        protection: null,
        liveEnrichment: null,
        crowdFlow: null,
        producers: null,
        places: null,
        worldIntelligence: null,
        generatedAt,
      });
      return;
    }

    // The map re-queries on camera settle, so this is polled. Bounded, but
    // generous enough for normal panning.
    const rl = checkRateLimit("map_projection", user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }

    const bbox = parseBbox(req.query.bbox);
    if (!bbox) {
      sendError(
        res,
        "invalid_payload",
        "bbox=w,s,e,n is required, must be in range, and must not be inverted or cross the antimeridian",
      );
      return;
    }
    const { lat, lng, radiusKm } = bboxToCenterRadius(bbox);

    const zoomRaw = Number(req.query.zoom);
    const zoom = Number.isFinite(zoomRaw) ? Math.min(22, Math.max(0, zoomRaw)) : 12;

    const kinds = parseKinds(req.query.kinds);
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 100;
    const cursor = req.query.cursor ? String(req.query.cursor) : null;

    // ONE shared, fail-closed block set for every source. If it cannot be read,
    // nobody is returned — matching /api/map/search.
    const blockedSet = await fetchBlockedSet(sc, user.id);
    if (blockedSet === null) {
      res.json({
        enabled: true,
        objects: [],
        viewport: { bbox, zoom },
        total: 0,
        nextCursor: null,
        sources: [],
        aggregation: null,
        protection: null,
        liveEnrichment: null,
        crowdFlow: null,
        producers: null,
        places: null,
        worldIntelligence: null,
        generatedAt,
      });
      return;
    }

    const collected: (MapObject | null)[] = [];
    const sources: string[] = [];

    const wantKind = (k: MapObjectKind) => !kinds || kinds.includes(k);

    const tasks: Promise<void>[] = [];

    if (wantKind("social_zone")) {
      tasks.push(
        (async () => {
          const travelers = await listMapTravelers(sc, {
            viewerId: user.id,
            lat,
            lng,
            radiusKm,
            blockedSet,
          }).catch(() => []);
          for (const t of travelers) collected.push(projectTraveler(t));
          sources.push("travelers");
        })(),
      );
    }

    if (wantKind("hidden_gem")) {
      tasks.push(
        (async () => {
          const ranked = await findNearbyGems(sc, lat, lng, radiusKm, { limit: 100 }).catch(() => []);
          const notBlocked = ranked.filter(
            (r: any) => !r.gem?.submitted_by || !blockedSet.has(r.gem.submitted_by),
          );
          const safe = await applyGemPrivacyBatch(
            notBlocked.map((r: any) => r.gem),
            sc,
            user.id,
          ).catch(() => []);
          safe.forEach((g: any, i: number) =>
            collected.push(projectGem(g, notBlocked[i]?.distanceKm ?? null)),
          );
          sources.push("gems");
        })(),
      );
    }

    // ONE event read per request, shared by the `event` layer and the §10
    // inferred-cause producer. Both go through `loadNearbyEvents` — the SAME
    // privacy-complete source (visibility, friendship, eligibility, the shared
    // block set, show_exact_location redaction) — so a cause hypothesis can
    // only ever name an event the viewer could see as a pin anyway. `null`
    // means the read failed; the event layer keeps its historical "empty on
    // failure" behaviour, the cause producer reports it.
    let eventsOnce: Promise<any[] | null> | null = null;
    const loadEventsOnce = (): Promise<any[] | null> => {
      if (!eventsOnce) {
        eventsOnce = loadNearbyEvents(sc, user.id, lat, lng, radiusKm, blockedSet).catch(() => null);
      }
      return eventsOnce;
    };

    if (wantKind("event")) {
      tasks.push(
        (async () => {
          const events = (await loadEventsOnce()) ?? [];
          for (const ev of events) collected.push(projectEvent(ev, nowMs));
          sources.push("events");
        })(),
      );
    }

    // ── M5 producers — the four kinds §18 declared and nothing produced ──────
    //
    // Each read is the ONE privacy-complete reader for its kind (registered in
    // src/test/gatewayBypassGuard.test.ts with this file as its only approved
    // caller). This route hands each one the viewer's SESSION id and the
    // viewport, and decides nothing about who may see what: that decision is
    // the producer's, and the object then goes through the same servable →
    // enrich → §24 gate → aggregate → rank pipeline as every other layer.
    const producers: ProducerReports = {
      meeting_point: null,
      memory: null,
      safety_notice: null,
      saved_place: null,
    };

    if (wantKind("meeting_point")) {
      tasks.push(
        (async () => {
          // Participants only: scoped to the trips the viewer belongs to, and
          // expiring at the meeting time (lib/mapProducers/meetingPointProducer).
          const read = await readMeetingPoints(sc, user.id, { bbox, now: nowMs }).catch(() => null);
          if (!read) { producers.meeting_point = { refusal: "read_threw", collected: 0 }; return; }
          if (!read.ok) { producers.meeting_point = { refusal: read.reason, collected: 0 }; return; }
          for (const p of read.points) collected.push(p);
          producers.meeting_point = { refusal: null, collected: read.points.length };
          sources.push("meeting_points");
        })(),
      );
    }

    if (wantKind("memory")) {
      tasks.push(
        (async () => {
          // Owner only, coarse: `user.id` is the SESSION identity — the memory
          // read takes it as the owner and returns that owner's private memory,
          // so it must never come from a query parameter (the 2182 lesson).
          const read = await readMemoryPins(sc, user.id, { bbox }).catch(() => null);
          if (!read) { producers.memory = { refusal: "read_threw", collected: 0 }; return; }
          if (!read.ok) { producers.memory = { refusal: read.reason, collected: 0 }; return; }
          for (const p of read.pins) collected.push(p);
          producers.memory = { refusal: null, collected: read.pins.length };
          sources.push("memories");
        })(),
      );
    }

    if (wantKind("safety_notice")) {
      tasks.push(
        (async () => {
          // §5 / §24: the specialist-reviewed safety claim, at the top of the
          // §31 ladder and exempt from the §24 gate (lib/protectedLocations
          // PROTECTION_EXEMPT_KINDS) — which is exactly why the producer emits
          // no presence payload.
          const read = await readSafetyNotices(sc, { bbox, now: nowMs }).catch(() => null);
          if (!read) { producers.safety_notice = { refusal: "read_threw", collected: 0 }; return; }
          if (!read.ok) { producers.safety_notice = { refusal: read.reason, collected: 0 }; return; }
          for (const n of read.notices) collected.push(n);
          producers.safety_notice = { refusal: null, collected: read.notices.length };
          sources.push("safety");
        })(),
      );
    }

    if (wantKind("saved_place")) {
      tasks.push(
        (async () => {
          // §16 Saved layer: the viewer's own wishlist on public venue geography.
          const read = await readSavedPlacePins(sc, user.id, { bbox }).catch(() => null);
          if (!read) { producers.saved_place = { refusal: "read_threw", collected: 0 }; return; }
          if (!read.ok) { producers.saved_place = { refusal: read.reason, collected: 0 }; return; }
          for (const p of read.pins) collected.push(p);
          producers.saved_place = { refusal: null, collected: read.pins.length };
          sources.push("saved");
        })(),
      );
    }

    if (wantKind("crew_member")) {
      tasks.push(
        (async () => {
          // The SAME fail-closed block set every other people-bearing source
          // got. Passing it in also means this request cannot see two different
          // answers to "who is blocked" between the traveler and circle layers.
          const read = await readCircleLocations(sc, user.id, { blockedSet }).catch(() => null);
          // A read failure is NOT an empty circle: leaving the layer out of
          // `sources` is how the client learns the difference between "nobody
          // is sharing" and "we could not tell".
          if (!read || !read.ok) return;
          for (const m of read.locations) collected.push(projectCircleMember(m));
          sources.push("circle");
        })(),
      );
    }

    if (wantKind("buddy_zone")) {
      tasks.push(
        (async () => {
          // The SAME fail-closed block set every other people-bearing source
          // got. A buddy is a person, so this layer cannot be allowed to
          // disagree with the traveler and circle layers about who is blocked.
          const read = await readBuddyMapPins(sc, user.id, {
            lat,
            lng,
            radiusKm,
            blockedSet,
          }).catch(() => null);
          // A read failure is NOT an empty marketplace: leaving the layer out
          // of `sources` is how the client learns the difference between "no
          // buddies here" and "we could not tell".
          if (!read || !read.ok) return;
          for (const b of read.pins) collected.push(projectBuddy(b));
          sources.push("buddies");
        })(),
      );
    }

    if (wantKind("trip_stop")) {
      tasks.push(
        (async () => {
          const trips = await loadViewerTrips(sc, user.id).catch(() => null);
          if (trips === null) return;
          for (const t of trips) collected.push(projectTrip(t));
          sources.push("trips");
        })(),
      );
    }

    // Canonical places (lib/mapProjectPlace). A public venue has no
    // privacy-complete reader to route through — `places` holds no user column
    // — so the viewport read IS the source; §24, §31 and enrichment all happen
    // in the shared pipeline below, exactly as for every other kind. A read
    // failure leaves the layer out of `sources` (not an empty layer), and a
    // capped read is REPORTED via `places.truncated` rather than served as the
    // whole viewport.
    const placesReport: { report: { rows: number; projected: number; truncated: boolean } | null } = {
      report: null,
    };
    if (wantKind("place")) {
      tasks.push(
        (async () => {
          const read = await loadViewportPlaceRows(sc, bbox).catch(() => null);
          if (read === null) return;
          let projected = 0;
          for (const row of read.rows) {
            const obj = projectPlace(row);
            if (obj) projected += 1;
            collected.push(obj);
          }
          placesReport.report = { rows: read.rows.length, projected, truncated: read.truncated };
          sources.push("places");
        })(),
      );
    }

    // §10 Crowd Flow. The producer and the consumer both already existed and
    // nothing could ask for them: `deriveCrowdFlow` and `produceZoneTransitions`
    // had no caller in src/routes at all, so a fully-gated, fully-tested map
    // surface could never reach a client. This is that surface, and it is HERE
    // rather than at an endpoint of its own on purpose — a bespoke
    // /api/map/crowd-flow would skip §31 ranking, the §24 protection gate,
    // viewport aggregation and privacy-class stamping, which is precisely the
    // regression src/test/gatewayBypassGuard.test.ts exists to catch.
    //
    // (Held in a box rather than a bare `let` because the report is filled in
    // by the task closure below, which control-flow analysis cannot see.)
    const crowdFlow: { report: CrowdFlowReport | null } = { report: null };
    if (wantKind("crowd_flow")) {
      tasks.push(
        (async () => {
          const report: CrowdFlowReport = {
            refusal: null,
            familyRefusals: {},
            zoneModel: { zones: 0, ambiguousNames: 0, indexedPlaces: 0, placeIndexFailed: false },
            transitions: 0,
            published: 0,
            withheld: 0,
            withheldForProtection: 0,
            inferredCause: { events: 0, eventsReadFailed: false, hypotheses: 0, attached: 0 },
          };
          crowdFlow.report = report;

          // The flag is checked HERE as well as inside readCrowdFlowSignals so
          // that a disabled layer costs nothing: no zone read, no place read,
          // and no cohort assembled for an outcome that cannot be published.
          // A LITERAL, not CROWD_FLOW_FLAG: check:flag-polarity resolves flag
          // arguments statically, and a constant defeats it — it then cannot
          // tell whether this flag is a privacy stop, which is exactly the
          // question worth answering for this layer. CROWD_FLOW_FLAG is still
          // imported and pinned by CROWD_FLOW_FLAG_PIN below, so the literal
          // and the constant cannot drift apart silently.
          if (!(await isFlagEnabled(sc, "map_crowd_flow_enabled"))) {
            report.refusal = "flag_off";
            return;
          }

          const allZones = await loadFlowZones(sc, nowMs).catch(() => null);
          if (allZones === null) {
            // Unreadable geography is NOT absent geography — see loadFlowZones.
            report.refusal = "zone_read_failed";
            return;
          }
          const near = expandBbox(bbox);
          const zones = allZones.filter((z) => bboxContains(near, z.centroid.lat, z.centroid.lng));
          if (zones.length === 0) {
            // Without a zone model the producer refuses rather than falling
            // back to a coordinate, which is the behaviour we want; say so
            // rather than reporting an empty layer.
            report.refusal = "no_zone_model";
            return;
          }

          const placeRows = await loadViewportPlaces(sc, bbox).catch(() => null);
          const model = buildFlowZoneModel(zones, indexPlaceZones(placeRows, zones));
          report.zoneModel = {
            zones: model.centroids.size,
            ambiguousNames: model.ambiguousNames,
            indexedPlaces: model.indexedPlaces,
            // A failed place read costs the next-stop family its ORIGINS, which
            // silently shrinks the layer. "0 places indexed because the read
            // failed" and "0 places indexed because there are none here" are
            // different facts and are reported as different facts.
            placeIndexFailed: placeRows === null,
          };

          // §10 "inferred cause". The hypotheses are proposed from the events
          // adjacent to the flow zones in space and time — the `event_context`
          // family, which lib/crowdFlowProducer admits ONLY through this door
          // (a MovementSignal carrying it is rejected at intake). A hypothesis
          // can explain a flow the observed families published; it cannot
          // create one, strengthen one, or set a flow state — `dispersing` and
          // `unusual` stay explicitly-flagged facts (the recorded ruling in
          // lib/crowdFlowProducer.ts), and nothing here proposes them.
          const events = await loadEventsOnce();
          const causes = deriveEventCauseHypotheses(events ?? [], zones, { now: nowMs });
          report.inferredCause.events = causes.considered;
          report.inferredCause.eventsReadFailed = events === null;
          report.inferredCause.hypotheses = causes.hypotheses.length;

          // read → derive → attach cause. Every gate below is the producer's
          // and lib/mapAggregation's; this route supplies the zone model, the
          // clock and the cause hypotheses, and decides nothing about who may
          // be counted.
          const produced = await produceZoneTransitions(sc, {
            now: nowMs,
            zoneCentroids: model.centroids,
            resolveZoneId: model.resolveZoneId,
            resolveZoneForPoint: model.resolveZoneForPoint,
            causeHypotheses: causes.hypotheses,
          }).catch(() => null);
          if (!produced) {
            report.refusal = "produce_failed";
            return;
          }
          report.refusal = produced.refusal;
          report.familyRefusals = { ...produced.familyRefusals };
          report.transitions = produced.transitions.length;

          const flow = deriveCrowdFlow(produced.transitions, { now: nowMs });
          report.published = flow.flows.length;
          report.withheld = flow.rejected.length;
          for (const f of flow.flows) {
            if ((f.payload as { inferred?: unknown } | undefined)?.inferred != null) {
              report.inferredCause.attached += 1;
            }
            collected.push(f);
          }

          // A refusal means we never looked, so the layer must not appear in
          // `sources` claiming an empty answer it did not obtain.
          if (produced.refusal === null) sources.push("crowd_flow");
        })(),
      );
    }

    await Promise.all(tasks);

    // §19 order: shape → drop the unservable → rank → (aggregate) → page.
    let objects = servableOnly(collected);

    // §9 / Table 7 event-adjacency source. Captured from the servable set BEFORE
    // filterKinds so an "Active event nearby" line still appears on a place when
    // the client has toggled the Events layer OFF — the event still explains the
    // place's busyness even when its own marker is not drawn. These are the same
    // event objects this request already loaded and shaped; nothing new is read.
    const activeEvents = objects.filter((o) => o.kind === "event");

    objects = filterKinds(objects, kinds);

    // Attach already-computed live claims. Bounded and REPORTED — a capped
    // enrichment must never read as "no live intelligence here".
    const enrichment = await enrichWithLiveClaims(
      objects,
      async (subjectId) => {
        // NO CAST. The previous `as unknown as LiveClaimLike[]` here is what let
        // the two shapes drift: the envelope's `sourceCountBucket` is nullable
        // (withheld for sponsored / official / imported — §37), LiveClaimLike
        // re-declared it as always-present, and the double cast told the compiler
        // to stop caring. A sponsored claim then rendered as "A few recent
        // traveler reports". Structural assignability is the check now; if the
        // envelope ever diverges again this line, and the pin in lib/mapProjection,
        // both go red.
        const claims = await readLiveClaims(sc, subjectId);
        return claims.map(toLiveClaimEnvelope);
      },
      {
        now: nowMs,
        // §9 contextual evidence. Only event-adjacency is sourced here: it is
        // derivable, for free, from the events already in hand. Qualified-media
        // is DELIBERATELY not sourced — the media→observation evidence table is
        // write-only (authenticated holds no read grant, no read path selects
        // from it, and routes/mapObservations records that a read path may not
        // be added without a moderation ruling). `applyLiveClaims` accepts and
        // renders qualified-media the moment a lawful source is ruled in; until
        // then this route leaves it absent rather than opening that read path.
        evidence: (obj) => {
          const count = countAdjacentActiveEvents(obj, activeEvents, nowMs);
          return count > 0 ? { eventNearby: { count } } : null;
        },
      },
    );
    objects = enrichment.objects;

    // §24 — the last gate before anything is counted or serialized. It runs
    // AFTER enrichment (which could otherwise re-attach live signals to an
    // object that is about to be coarsened) and BEFORE aggregation (so a
    // protected object never contributes to a cell's cohort). Everything
    // downstream only coarsens or reorders, so nothing can re-sharpen this.
    const zones = await loadProtectedZones(sc);
    if (zones === null) {
      // See loadProtectedZones: an unreadable policy is NOT an absent policy.
      res.json({
        enabled: true,
        objects: [],
        viewport: { bbox, zoom },
        total: 0,
        nextCursor: null,
        sources: [],
        aggregation: null,
        protection: null,
        liveEnrichment: null,
        crowdFlow: null,
        producers: null,
        places: null,
        worldIntelligence: null,
        generatedAt,
      });
      return;
    }
    // §24, one step ahead of the gate, for `crowd_flow` only: inside a
    // protected zone a flow is WITHHELD rather than coarsened, because a
    // coarsened flow would keep — in `payload.observed` — exactly the cohort
    // size and observation time that coarsening exists to strip. See
    // lib/mapProjection.withholdCoarsenableAggregates. This only ever removes
    // objects, and `applyProtection` below is still the gate.
    const flowGate = withholdCoarsenableAggregates(objects, zones);
    objects = flowGate.objects;
    if (crowdFlow.report) {
      crowdFlow.report.withheldForProtection = flowGate.withheld;
      crowdFlow.report.published = Math.max(0, crowdFlow.report.published - flowGate.withheld);
    }

    const protection = applyProtection(objects, zones);
    objects = protection.objects;

    // §31 viewport aggregation. At wide zoom many objects collapse into
    // activity zones; below the k-anonymity floor a cell is SUPPRESSED rather
    // than drawn as a small zone that would reveal a lone person's position.
    // Every collapse and suppression is reported — a silently shrunk result is
    // indistinguishable from an empty city.
    const aggregation = aggregateForViewport(objects, { bbox, zoom });
    let finalObjects = aggregation.objects;

    // ── §36 Phase 7 World Intelligence ──────────────────────────────────────
    //
    // IT RUNS HERE, AFTER AGGREGATION, AND THAT POSITION IS THE DESIGN.
    // World Pulse summarizes the §31 aggregation's OWN OUTPUT — the
    // `activity_zone` objects `summarizeCell` just emitted, each of which
    // already cleared the cohort floor — and the city model's `topZones` reads
    // the same objects. Producing them earlier would mean summarizing raw
    // contributors, which is the one thing §36 Phase 7's brief forbids ("built
    // from ALREADY-AGGREGATED sources ... never from individual presence").
    //
    // Running after aggregation does NOT mean running after §24. Everything
    // Phase 7 produces goes through the same two gates every other kind went
    // through, in the same order, against the same `zones` list:
    // withhold-rather-than-coarsen for the aggregate kinds, then
    // `applyProtection`. It is then ranked with everything else, so a Phase 7
    // object cannot outrank a safety notice.
    //
    // The four kinds are also NEVER_AGGREGATED_KINDS, so re-running the
    // aggregation over them would be a no-op — they are appended rather than
    // re-binned, which keeps `aggregation`'s own counts describing exactly the
    // objects it was given.
    const worldIntelligence: { report: WorldIntelligenceReport | null } = { report: null };
    const wantsWorldIntelligence = WORLD_INTELLIGENCE_KINDS.some((k) => wantKind(k));
    if (wantsWorldIntelligence) {
      const report: WorldIntelligenceReport = {
        refusal: null,
        cityModelGeography: null,
        worldPulse: null,
        travelerFlow: null,
        cityModels: null,
        personalCities: null,
        withheldForProtection: 0,
      };
      worldIntelligence.report = report;

      // The flag is checked HERE as well as inside each producer so a disabled
      // capability costs nothing: no city-zone read, no plan read, no stamp
      // read. A LITERAL, not the constant, so check:flag-polarity can resolve
      // it — WORLD_INTELLIGENCE_FLAG_PIN below stops the two drifting apart.
      if (!(await isFlagEnabled(sc, "map_world_intelligence_enabled"))) {
        report.refusal = "flag_off";
      } else if (!bandCarriesWorldIntelligence(aggregation.band)) {
        // §17: none of these kinds exists below the city band. Say so rather
        // than reporting an empty layer that looks like a broken one.
        report.refusal = "band_not_eligible";
      } else {
        const cityParse = await loadCityZones(sc, nowMs).catch(() => null);
        if (cityParse === null) {
          // Unreadable geography is NOT absent geography — see loadCityZones.
          report.refusal = "read_failed";
        } else {
          report.cityModelGeography = {
            cities: cityParse.cities.length,
            ambiguousKeys: cityParse.ambiguousKeys,
            unusable: cityParse.unusable,
          };
          // The city model is grown by one viewport on each side, exactly as
          // §10's flow zones are, so a city→city edge whose MIDPOINT is on
          // screen still has both endpoints in the model.
          const near = expandBbox(bbox);
          const viewportCities = cityParse.cities.filter((c) =>
            bboxContains(near, c.centroid.lat, c.centroid.lng),
          );

          const produced: MapObject[] = [];

          if (wantKind("world_pulse")) {
            // PURE, and its only input is the aggregation output above.
            const pulse = deriveWorldPulse(aggregation.objects, { bbox, zoom });
            report.worldPulse = pulse.report;
            for (const p of pulse.pulses) produced.push(p);
            sources.push("world_pulse");
          }

          if (wantKind("traveler_flow")) {
            const flow = await readTravelerFlowEdges(sc, {
              now: nowMs,
              // The city model, injected. The producer REFUSES rather than
              // approximating an endpoint to a coordinate without it.
              resolveCityForPoint: (pt) => {
                for (const c of viewportCities) {
                  try {
                    if (c.contains(pt.lat, pt.lng)) return c.id;
                  } catch { /* an unusable shape covers nothing */ }
                }
                return null;
              },
              cityCentroids: new Map(viewportCities.map((c) => [c.id, c.centroid])),
              cityLabels: new Map(viewportCities.map((c) => [c.id, c.label])),
            }).catch(() => null);
            if (!flow) {
              report.travelerFlow = {
                refusal: "read_failed", hops: 0, hopsSkipped: 0,
                transitions: 0, published: 0, withheld: 0,
              };
            } else {
              report.travelerFlow = flow.report;
              for (const e of flow.edges) produced.push(e);
              // A refusal means we never looked, so the layer must not appear
              // in `sources` claiming an empty answer it did not obtain.
              if (flow.report.refusal === null) sources.push("traveler_flow");
            }
          }

          if (wantKind("city_model")) {
            const read = await readCityModels(sc, {
              bbox,
              cities: viewportCities,
              // This request's own already-k-gated activity zones. Their
              // cohorts are re-published as BUCKETS by the producer, never as
              // the counts these objects carry.
              activityZones: aggregation.objects.filter((o) => o.kind === "activity_zone"),
            }).catch(() => null);
            if (!read) {
              report.cityModels = {
                cities: viewportCities.length, capped: false, modelsRead: 0,
                published: 0, slicesWithheld: 0, slicesPublished: 0,
              };
            } else if (!read.ok) {
              if (report.refusal === null) report.refusal = read.reason;
            } else {
              report.cityModels = read.report;
              for (const m of read.models) produced.push(m);
              sources.push("city_models");
            }
          }

          if (wantKind("personal_city")) {
            // `user.id` is the SESSION identity — the personal city read takes
            // it as the owner and returns that owner's own history, so it must
            // never come from a query parameter (the 2182 lesson).
            const read = await readPersonalCityPins(sc, user.id, {
              bbox,
              cities: viewportCities,
            }).catch(() => null);
            if (read && read.ok) {
              report.personalCities = read.report;
              for (const p of read.pins) produced.push(p);
              sources.push("personal_cities");
            }
          }

          // The SAME §24 gate, in the SAME order, against the SAME zone list.
          const servableProduced = servableOnly(produced);
          const wiGate = withholdCoarsenableAggregates(servableProduced, zones);
          const wiProtection = applyProtection(wiGate.objects, zones);
          // servableOnly again AFTER protection: coarsening can drop an object
          // to a rung that must not be serialized, and that decision is made
          // downstream of the gate.
          const wiSurvived = servableOnly(wiProtection.objects);
          // A COUNT of what §24 removed — withheld plus suppressed plus dropped
          // for an unusable coarsened rung, as one number. Which zone removed
          // which object is exactly what `ProtectionReport` refuses to say.
          report.withheldForProtection = servableProduced.length - wiSurvived.length;
          finalObjects = [...finalObjects, ...wiSurvived];
        }
      }
    }

    const ranked = rankObjects(finalObjects, { lat, lng });
    const { page, nextCursor } = paginate(ranked, cursor, limit);

    res.json({
      enabled: true,
      objects: page,
      viewport: { bbox, zoom, center: { lat, lng }, radiusKm },
      total: ranked.length,
      nextCursor,
      sources,
      aggregation: {
        band: aggregation.band,
        cellSizeDegrees: aggregation.cellSizeDegrees,
        aggregated: aggregation.aggregated,
        individual: aggregation.individual,
        dropped: aggregation.dropped,
        suppressedForKAnonymity: aggregation.suppressedForKAnonymity,
        zones: aggregation.zones,
      },
      // Counts only, by construction — naming WHICH zone hid what would
      // re-leak the location the gate just removed.
      protection: protection.report,
      liveEnrichment: {
        considered: enrichment.considered,
        enriched: enrichment.enriched,
        skipped: enrichment.skipped,
      },
      // Null when the layer was not requested. Otherwise counts + refusals, so
      // "no flows" is never ambiguous between "the gates said no" and "nothing
      // asked". See CrowdFlowReport.
      crowdFlow: crowdFlow.report,
      // Per-producer refusals + pre-gate counts for the four M5 kinds. See
      // ProducerReports: null per entry when that kind was not requested.
      producers,
      // Null when the layer was not requested or could not be read (then it is
      // also absent from `sources`). Otherwise the row count and whether the
      // bounded read was a SAMPLE of the viewport — see lib/mapProjectPlace.
      places: placesReport.report,
      // Null when no Phase 7 kind was requested. Otherwise counts + refusals,
      // so "no world intelligence" is never ambiguous between "the gates said
      // no", "the flag is off" and "nothing asked". See WorldIntelligenceReport.
      worldIntelligence: worldIntelligence.report,
      generatedAt,
    });
  }),
);

export default router;
