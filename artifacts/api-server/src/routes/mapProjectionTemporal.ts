/**
 * GET /api/map/projection/temporal — Map spec §15 Time Machine, server side.
 *
 *   flag: map_projection_enabled (OFF by default; fail-soft — the same gateway
 *         flag as GET /api/map/projection, because this IS the gateway asked a
 *         temporal question, not a second surface with its own switch).
 *
 * A SIBLING of routes/mapProjection.ts, not a bypass of it. §15 needs per-offset
 * state that the NOW projection cannot supply, and lib/temporalProjection is the
 * producer that had no caller — the exact shape of the §10 crowd-flow defect one
 * layer over. This route is that caller. Everything §15/§37 promise is enforced
 * in the pure producer and re-checked here; this file only READS rows and hands
 * them in, then runs the SAME §24 protection gate and §31 aggregation the NOW
 * gateway runs, so a temporal object can never reach the client having skipped a
 * privacy stage the live map applies.
 *
 * WHAT IT SERVES, BY MODE
 * =======================
 *   forecast (+30m/+60m/+120m, or a future named window):
 *     events        — loadNearbyEvents (the SAME gates as the NOW gateway,
 *                     incl. show_exact_location redaction), kept only when the
 *                     event's schedule window covers the target.
 *     itinerary     — the VIEWER'S OWN route stops whose planned window covers
 *                     the target. Self-planned intent; never another person's.
 *     accepted_plan — the crowd-flow accepted_plan family, AGGREGATED to zones
 *                     and published only when a cohort clears PRIVACY_THRESHOLD_V1,
 *                     gated behind map_crowd_flow_enabled exactly like §10 flow.
 *                     Today the flag is off and the consent table empty, so this
 *                     publishes nothing; the refusal is reported so "no predicted
 *                     crowds" is never ambiguous with broken wiring.
 *   historical (Yesterday / Last Friday / a past named window):
 *     Read from intel_state_snapshot_versions (migration 2273), never
 *     reconstructed. Empty until the projection scheduler has recorded a version
 *     covering the instant, so `history.available` is the honest signal the
 *     client shows as "no history yet" rather than an empty map.
 *   now: nothing — the client uses GET /api/map/projection for the present.
 *
 * §37 IS ENFORCED BY THE PRODUCER, NOT THIS FILE. Every forecast object is
 * kind 'prediction' with no observedAt and no live freshness; every historical
 * object is an observation with freshness 'historical'. This route cannot make
 * a prediction look like an observation because it never constructs either — it
 * hands rows to lib/temporalProjection and serves what comes back.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { fetchBlockedSet } from "../lib/blocks.js";
import { loadNearbyEvents } from "./mapSearch.js";
import { applyProtection, type ProtectedZone } from "../lib/protectedLocations.js";
import { aggregateForViewport, bboxContains, type BBox } from "../lib/mapAggregation.js";
import { deriveGroupKey, type GroupIdentity } from "../lib/intelGroupKey.js";
import { type MapObject, type MapObjectKind } from "../lib/mapObjects.js";
import {
  bboxToCenterRadius,
  buildFlowZoneModel,
  filterKinds,
  paginate,
  parseBbox,
  parseFlowZones,
  parseKinds,
  rankObjects,
  servableOnly,
  withholdCoarsenableAggregates,
  FLOW_ZONE_TYPES,
  type FlowZone,
} from "../lib/mapProjection.js";
import {
  parseTemporalTarget,
  projectForecast,
  projectHistory,
  type HistoricalPlaceGeometry,
  type PlanArrival,
  type SnapshotVersionRow,
  type TemporalTarget,
} from "../lib/temporalProjection.js";

const router = Router();

// ── §24 protected zones ───────────────────────────────────────────────────────
//
// Mirrors routes/mapProjection.ts's loader deliberately rather than importing
// it, for the reason lib/locateFriendsSession already records: reaching into
// another route's module-private cache to make a privacy decision would couple
// two surfaces' failure modes. The CONTRACT is what matters and it is identical
// — a read ERROR returns null ("policy unknown"), which the caller answers with
// nothing; an empty list is an identity pass (no policy exists). `applyProtection`
// is the single gate, and both routes call it.
const ZONE_CACHE_TTL_MS = 30_000;
let _zoneCache: { zones: ProtectedZone[]; at: number } | null = null;

export function _clearTemporalProtectedZoneCache(): void { _zoneCache = null; }

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
      zones.push({ ...base, shape: "polygon", ring: row.ring } as ProtectedZone);
    }
  }
  _zoneCache = { zones, at: Date.now() };
  return zones;
}

// ── §10 flow zones (geo_zones) — only the accepted_plan source needs them ─────
//
// Same fail-closed shape and same deliberate mirroring as above. null means
// "could not read"; [] means "there are none here". A predicted zone cohort
// anchored on a zone model we failed to read would be anchored on nothing.
const FLOW_ZONE_CACHE_TTL_MS = 30_000;
const MAX_FLOW_ZONE_ROWS = 2_000;
let _flowZoneCache: { zones: FlowZone[]; at: number } | null = null;

export function _clearTemporalFlowZoneCache(): void { _flowZoneCache = null; }

async function loadFlowZones(sc: any, nowMs: number): Promise<FlowZone[] | null> {
  if (_flowZoneCache && nowMs - _flowZoneCache.at < FLOW_ZONE_CACHE_TTL_MS) return _flowZoneCache.zones;
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

/** Grow the viewport by one on each side so a zone whose centroid the client can
 *  see still resolves even when the client's edge cuts through it. */
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

// ── The accepted_plan forecast source ─────────────────────────────────────────

/** Two closed intervals overlap? Inclusive at the endpoints. */
function windowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function toEpochMs(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

export type PlanArrivalRefusal =
  | "flag_off"
  | "no_group_key_secret"
  | "zone_read_failed"
  | "no_zone_model"
  | "read_failed";

interface PlanArrivalReadResult {
  arrivals: PlanArrival[];
  refusal: PlanArrivalRefusal | null;
  zones: number;
}

const MAX_ACCEPTED_PLANS = 500;

/**
 * Read accepted plans whose future stops fall in the target window, resolve each
 * stop's coordinate to a ZONE (the point never survives the resolver), and build
 * the per-arrival records the producer aggregates. The producer's privacy gate,
 * not this read, decides what publishes.
 *
 * Gated behind map_crowd_flow_enabled: the accepted_plan family and its consent
 * table (route_flow_contribution_consent) belong to §10 crowd flow, so a
 * predicted crowd rides the same switch a live crowd does. REFUSES before it
 * reads when it could produce nothing anyway — no HMAC secret means every
 * arrival would arrive with zero group credit, which pushes the gate's
 * independent-group floor further out of reach while looking like progress.
 */
async function readPlanArrivals(
  sc: any,
  target: TemporalTarget,
  nowMs: number,
  bbox: BBox,
): Promise<PlanArrivalReadResult> {
  const empty = (refusal: PlanArrivalRefusal | null, zones = 0): PlanArrivalReadResult => ({
    arrivals: [],
    refusal,
    zones,
  });

  // A LITERAL, not a constant: check:flag-polarity resolves flag arguments
  // statically. The same flag §10 crowd flow rides, for the same reason.
  if (!(await isFlagEnabled(sc, "map_crowd_flow_enabled"))) return empty("flag_off");

  // Probe the group-key derivation with the real function rather than re-reading
  // the env here — lib/intelGroupKey is the one authority on what a valid secret
  // is. No secret ⇒ no group credit ⇒ nothing could ever clear the group floor.
  try {
    if (!deriveGroupKey("probe", { kind: "solo", actorId: "probe" })) return empty("no_group_key_secret");
  } catch {
    return empty("no_group_key_secret");
  }

  const allZones = await loadFlowZones(sc, nowMs).catch(() => null);
  if (allZones === null) return empty("zone_read_failed");
  const near = expandBbox(bbox);
  const zones = allZones.filter((z) => bboxContains(near, z.centroid.lat, z.centroid.lng));
  if (zones.length === 0) return empty("no_zone_model");
  const model = buildFlowZoneModel(zones);

  try {
    // Accepted, still-current plans. status='active' AND accepted_at IS NOT NULL
    // states the invariant the 2224 CHECK constraint enforces rather than
    // trusting it is present in every environment.
    const { data: planRows, error: planErr } = await sc
      .from("route_plans")
      .select("id, trip_id, accepted_by_user_id, accepted_at, status")
      .eq("status", "active")
      .not("accepted_at", "is", null)
      .limit(MAX_ACCEPTED_PLANS);
    if (planErr || !Array.isArray(planRows)) return empty("read_failed", zones.length);

    const plans = (planRows as any[]).filter(
      (p) => p && p.accepted_by_user_id && p.accepted_at && p.status === "active",
    );
    if (plans.length === 0) return empty(null, zones.length);

    // Consent, per accepter — enabled AND not withdrawn. A consent-read FAILURE
    // leaves the set EMPTY (it can shrink a cohort, never inflate one).
    const actorIds = [...new Set(plans.map((p) => String(p.accepted_by_user_id)))];
    let consented = new Set<string>();
    const { data: consentRows, error: consentErr } = await sc
      .from("route_flow_contribution_consent")
      .select("user_id")
      .in("user_id", actorIds)
      .eq("enabled", true)
      .is("withdrawn_at", null);
    if (!consentErr && Array.isArray(consentRows)) {
      consented = new Set((consentRows as any[]).map((r) => String(r.user_id)));
    }
    const consentedPlans = plans.filter((p) => consented.has(String(p.accepted_by_user_id)));
    if (consentedPlans.length === 0) return empty(null, zones.length);

    const planById = new Map<string, any>(consentedPlans.map((p) => [String(p.id), p]));
    const planIds = [...planById.keys()];

    const { data: stopRows, error: stopErr } = await sc
      .from("route_stops")
      .select("id, route_plan_id, structured_location, planned_arrival_time, planned_departure_time")
      .in("route_plan_id", planIds)
      .not("planned_arrival_time", "is", null)
      .limit(2_000);
    if (stopErr || !Array.isArray(stopRows)) return empty("read_failed", zones.length);

    const arrivals: PlanArrival[] = [];
    for (const stop of stopRows as any[]) {
      const plan = planById.get(String(stop?.route_plan_id));
      if (!plan) continue;
      const arrive = toEpochMs(stop.planned_arrival_time);
      if (arrive === null) continue;
      const departRaw = toEpochMs(stop.planned_departure_time);
      const depart = departRaw !== null && departRaw >= arrive ? departRaw : arrive;
      if (!windowsOverlap(arrive, depart, target.windowStart, target.windowEnd)) continue;

      const loc = stop.structured_location as { lat?: unknown; lng?: unknown } | null | undefined;
      const lat = loc && typeof loc === "object" ? Number((loc as any).lat) : NaN;
      const lng = loc && typeof loc === "object" ? Number((loc as any).lng) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      // The coordinate quarantine: resolve to a zone or DROP. There is no
      // "fall back to the point" branch — the fallback is the §23/§37 leak.
      const zoneId = model.resolveZoneForPoint({ lat, lng });
      if (!zoneId) continue;
      const centroid = model.centroids.get(zoneId);
      if (!centroid) continue;

      const actorId = String(plan.accepted_by_user_id);
      const tripId = typeof plan.trip_id === "string" && plan.trip_id !== "" ? plan.trip_id : null;
      // A trip-linked plan is ONE party (crew token keyed on the trip); a plan
      // with no trip is its own independent group (solo). Scoped to the zone so
      // the same party is unlinkable across zones. Verbatim lib/intelGroupKey.
      const identity: GroupIdentity = tripId
        ? { kind: "crew", crewId: tripId }
        : { kind: "solo", actorId };
      const groupKey = deriveGroupKey(zoneId, identity);
      const acceptedAtMs = toEpochMs(plan.accepted_at);
      if (acceptedAtMs === null) continue;

      arrivals.push({ zoneId, zoneCentroid: centroid, actorId, groupKey, acceptedAtMs });
    }

    return { arrivals, refusal: null, zones: zones.length };
  } catch {
    return empty("read_failed", zones.length);
  }
}

// ── The viewer's own itinerary forecast source ────────────────────────────────

/** The viewer's own planned stops with a planned arrival — window-filtered by
 *  the producer. null means the read failed (the layer is then left out). */
async function loadViewerItineraryStops(sc: any, viewerId: string): Promise<any[] | null> {
  const { data: planRows, error: planErr } = await sc
    .from("route_plans")
    .select("id")
    .eq("owner_user_id", viewerId)
    .in("status", ["draft", "active"])
    .limit(200);
  if (planErr || !Array.isArray(planRows)) return null;
  const planIds = (planRows as any[]).map((p) => String(p.id));
  if (planIds.length === 0) return [];

  const { data: stops, error: stopErr } = await sc
    .from("route_stops")
    .select("id, title, structured_location, planned_arrival_time, planned_departure_time")
    .in("route_plan_id", planIds)
    .not("planned_arrival_time", "is", null)
    .limit(500);
  if (stopErr || !Array.isArray(stops)) return null;
  return stops as any[];
}

// ── The historical source (read, never reconstruct) ───────────────────────────

const MAX_HISTORY_PLACES = 1_000;
const MAX_HISTORY_VERSIONS = 2_000;

interface HistoryRead {
  rows: SnapshotVersionRow[] | null;
  placesById: Map<string, HistoricalPlaceGeometry>;
}

/**
 * Read the snapshot versions covering the target instant for the places in the
 * viewport, plus the geometry needed to place them. `rows: null` signals a read
 * FAILURE (place or version read), which projectHistory turns into
 * `available: false` — the honest "we could not read history", distinct from
 * "there is no history yet" (rows: []).
 */
async function readHistory(sc: any, bbox: BBox, target: TemporalTarget): Promise<HistoryRead> {
  const placesById = new Map<string, HistoricalPlaceGeometry>();

  // A geometry lookup for the history JOIN, not a place layer: these rows never
  // reach the client as places — projectHistory emits historical objects that
  // still pass through §24 protection and §31 aggregation below.
  const { data: placeRows, error: placeErr } = await sc
    .from("places")
    .select("id, name, latitude, longitude")
    .eq("status", "active")
    .is("merged_into_place_id", null)
    .gte("latitude", bbox.south)
    .lte("latitude", bbox.north)
    .gte("longitude", bbox.west)
    .lte("longitude", bbox.east)
    .limit(MAX_HISTORY_PLACES);
  if (placeErr || !Array.isArray(placeRows)) return { rows: null, placesById };

  for (const p of placeRows as any[]) {
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      placesById.set(String(p.id), { lat, lng, name: p.name ?? null });
    }
  }
  const placeIds = [...placesById.keys()];
  if (placeIds.length === 0) return { rows: [], placesById };

  const atIso = new Date(target.at).toISOString();
  const { data: versionRows, error: versionErr } = await sc
    .from("intel_state_snapshot_versions")
    .select("subject_id, claim_type, value, confidence_band, privacy_eligible, observed_at, expires_at")
    .in("subject_id", placeIds)
    .eq("privacy_eligible", true)
    .lte("observed_at", atIso)
    .gte("expires_at", atIso)
    .limit(MAX_HISTORY_VERSIONS);
  if (versionErr || !Array.isArray(versionRows)) return { rows: null, placesById };

  return { rows: versionRows as SnapshotVersionRow[], placesById };
}

// ── The route ─────────────────────────────────────────────────────────────────

router.get(
  "/map/projection/temporal",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }

    // ONE clock read for the whole handler (splitClockGuard).
    const nowMs = Date.now();
    const generatedAt = new Date(nowMs).toISOString();

    if (!(await isFlagEnabled(sc, "map_projection_enabled"))) {
      res.json({
        enabled: false,
        objects: [],
        viewport: null,
        target: null,
        total: 0,
        nextCursor: null,
        sources: [],
        aggregation: null,
        protection: null,
        forecast: null,
        history: null,
        generatedAt,
      });
      return;
    }

    const rl = checkRateLimit("map_projection_temporal", user.id, 60, 60_000);
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

    // The §15 control resolves on the CLIENT (it owns the timezone and calendar).
    // Relative offsets arrive as offsetMinutes; named windows as an explicit
    // [windowStartsAt, windowEndsAt] plus an optional `at`.
    const target = parseTemporalTarget(
      {
        offsetMinutes: req.query.offsetMinutes,
        at: req.query.at,
        windowStartsAt: req.query.windowStartsAt,
        windowEndsAt: req.query.windowEndsAt,
      },
      nowMs,
    );
    if (!target) {
      sendError(
        res,
        "invalid_payload",
        "provide offsetMinutes=N, or windowStartsAt & windowEndsAt (ISO), within range",
      );
      return;
    }

    const kinds = parseKinds(req.query.kinds);
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 100;
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const wantKind = (k: MapObjectKind) => !kinds || kinds.includes(k);

    // Fail-closed block set (only the event layer names people; keep the posture
    // identical to the NOW gateway all the same).
    const blockedSet = await fetchBlockedSet(sc, user.id);
    if (blockedSet === null) {
      res.json({
        enabled: true,
        objects: [],
        viewport: { bbox, zoom },
        target: { at: new Date(target.at).toISOString(), mode: target.mode },
        total: 0,
        nextCursor: null,
        sources: [],
        aggregation: null,
        protection: null,
        forecast: null,
        history: null,
        generatedAt,
      });
      return;
    }

    const collected: (MapObject | null)[] = [];
    const sources: string[] = [];
    let forecastReport:
      | { events: number; itinerary: number; plan: { published: number; withheld: number; refusal: PlanArrivalRefusal | null; refusals: Record<string, string> } }
      | null = null;
    let historyReport: { available: boolean; covering: number } | null = null;

    if (target.mode === "forecast" && wantKind("prediction")) {
      const [events, itineraryStops, planRead] = await Promise.all([
        loadNearbyEvents(sc, user.id, lat, lng, radiusKm, blockedSet).catch(() => [] as any[]),
        loadViewerItineraryStops(sc, user.id).catch(() => null),
        readPlanArrivals(sc, target, nowMs, bbox).catch(
          (): PlanArrivalReadResult => ({ arrivals: [], refusal: "read_failed", zones: 0 }),
        ),
      ]);

      const forecast = projectForecast(
        {
          events: events ?? [],
          itineraryStops: itineraryStops ?? [],
          planArrivals: planRead.arrivals,
        },
        target,
        nowMs,
      );
      for (const o of forecast.objects) collected.push(o);

      sources.push("events");
      if (itineraryStops !== null) sources.push("itinerary");
      // A refusal means we never assembled a cohort, so the layer must not claim
      // an empty answer it did not obtain.
      if (planRead.refusal === null) sources.push("accepted_plan");

      forecastReport = {
        events: forecast.events,
        itinerary: forecast.itinerary,
        plan: {
          published: forecast.plan.published,
          withheld: forecast.plan.withheld,
          refusal: planRead.refusal,
          refusals: forecast.plan.refusals,
        },
      };
    }

    if (target.mode === "historical" && wantKind("place")) {
      const read = await readHistory(sc, bbox, target).catch(
        (): HistoryRead => ({ rows: null, placesById: new Map() }),
      );
      const history = projectHistory(read.rows, read.placesById, target);
      for (const o of history.objects) collected.push(o);
      if (history.available) sources.push("history");
      historyReport = { available: history.available, covering: history.covering };
    }

    // §19 order: shape → drop the unservable → filter kinds → §24 → §31 → rank → page.
    let objects = servableOnly(collected);
    objects = filterKinds(objects, kinds);

    const zones = await loadProtectedZones(sc);
    if (zones === null) {
      // An unreadable §24 policy is NOT an absent policy — serve nothing.
      res.json({
        enabled: true,
        objects: [],
        viewport: { bbox, zoom },
        target: { at: new Date(target.at).toISOString(), mode: target.mode },
        total: 0,
        nextCursor: null,
        sources: [],
        aggregation: null,
        protection: null,
        forecast: forecastReport,
        history: historyReport,
        generatedAt,
      });
      return;
    }
    // §24, one step ahead of the gate, exactly as routes/mapProjection.ts does
    // it — and the step whose ABSENCE here was the defect. Every object this
    // route serves in forecast mode is a `prediction`, and coarsening a
    // prediction is not a weaker disclosure: `coarsenForZone` deletes the
    // top-level `count` and snaps the point to the zone anchor, but the object
    // reached the wire with `payload.cohort` and `payload.predictedFor` intact
    // — "20 people are due to arrive at this clinic at 13:00", which is the
    // §24 association disclosure restated one level down. `prediction` is now
    // in protectedLocations.COARSEN_UNSAFE_KINDS, so `applyProtection` below
    // would suppress it on its own; this pre-filter reports the removal in the
    // forecast block, where the client is already reading refusal counts.
    const predictionGate = withholdCoarsenableAggregates(objects, zones);
    objects = predictionGate.objects;

    const protection = applyProtection(objects, zones);
    objects = protection.objects;

    // The pre-filter's removals are folded into the protection report rather
    // than left silent. A silently shrunk result is indistinguishable from an
    // empty city, which is how a protection bug survives for months — the same
    // argument ProtectionReport makes for existing at all. Both counters move
    // together so `evaluated === allowed + coarsened + suppressed +
    // safetyExempt` still holds.
    if (predictionGate.withheld > 0) {
      protection.report.evaluated += predictionGate.withheld;
      protection.report.suppressed += predictionGate.withheld;
    }

    const aggregation = aggregateForViewport(objects, { bbox, zoom });
    const ranked = rankObjects(aggregation.objects, { lat, lng });
    const { page, nextCursor } = paginate(ranked, cursor, limit);

    res.json({
      enabled: true,
      objects: page,
      viewport: { bbox, zoom, center: { lat, lng }, radiusKm },
      target: {
        at: new Date(target.at).toISOString(),
        windowStartsAt: new Date(target.windowStart).toISOString(),
        windowEndsAt: new Date(target.windowEnd).toISOString(),
        mode: target.mode,
      },
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
      protection: protection.report,
      // Null unless this was a forecast request. Counts + the accepted_plan
      // refusal, so "no predicted crowds" is never ambiguous with broken wiring.
      forecast: forecastReport,
      // Null unless this was a historical request. `available: false` is the
      // honest "no history yet" the client renders instead of an empty map.
      history: historyReport,
      generatedAt,
    });
  }),
);

export default router;
