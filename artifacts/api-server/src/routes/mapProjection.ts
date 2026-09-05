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

/**
 * Compile-time pin for the flag literal used at the crowd-flow call site.
 * The literal exists so check:flag-polarity can resolve it; this makes renaming
 * the constant a TYPE ERROR rather than a silently-diverging second spelling.
 */
const CROWD_FLOW_FLAG_PIN: "map_crowd_flow_enabled" = CROWD_FLOW_FLAG;
void CROWD_FLOW_FLAG_PIN;
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
        generatedAt,
      });
      return;
    }
    // §24, one step ahead of the gate, for the kinds coarsening cannot help:
    // inside a protected zone a flow is WITHHELD rather than coarsened, because
    // a coarsened flow would keep — in `payload.observed` — exactly the cohort
    // size and observation time that coarsening exists to strip. See
    // lib/mapProjection.withholdCoarsenableAggregates; the policy itself is
    // protectedLocations.COARSEN_UNSAFE_KINDS, which the gate escalates on too.
    // This only ever removes objects, and `applyProtection` below is still the
    // gate — the pre-filter is here so the crowd-flow producer can report its
    // own withheld count.
    const flowGate = withholdCoarsenableAggregates(objects, zones);
    objects = flowGate.objects;
    if (crowdFlow.report) {
      // crowd_flow ONLY — the helper covers every COARSEN_UNSAFE kind, and this
      // producer's counter must report its own removals, not someone else's.
      const flowsWithheld = flowGate.withheldByKind.crowd_flow ?? 0;
      crowdFlow.report.withheldForProtection = flowsWithheld;
      crowdFlow.report.published = Math.max(0, crowdFlow.report.published - flowsWithheld);
    }

    const protection = applyProtection(objects, zones);
    objects = protection.objects;

    // §31 viewport aggregation. At wide zoom many objects collapse into
    // activity zones; below the k-anonymity floor a cell is SUPPRESSED rather
    // than drawn as a small zone that would reveal a lone person's position.
    // Every collapse and suppression is reported — a silently shrunk result is
    // indistinguishable from an empty city.
    const aggregation = aggregateForViewport(objects, { bbox, zoom });

    const ranked = rankObjects(aggregation.objects, { lat, lng });
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
      generatedAt,
    });
  }),
);

export default router;
