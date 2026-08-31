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
import { aggregateForViewport } from "../lib/mapAggregation.js";
import { applyProtection, type ProtectedZone } from "../lib/protectedLocations.js";
import { type MapObject, type MapObjectKind } from "../lib/mapObjects.js";
import {
  bboxToCenterRadius,
  enrichWithLiveClaims,
  filterKinds,
  paginate,
  parseBbox,
  parseKinds,
  projectBuddy,
  projectCircleMember,
  projectEvent,
  projectGem,
  projectTraveler,
  projectTrip,
  rankObjects,
  servableOnly,
  type LiveClaimLike,
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

    if (wantKind("event")) {
      tasks.push(
        (async () => {
          const events = await loadNearbyEvents(sc, user.id, lat, lng, radiusKm, blockedSet).catch(
            () => [],
          );
          for (const ev of events) collected.push(projectEvent(ev, nowMs));
          sources.push("events");
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

    await Promise.all(tasks);

    // §19 order: shape → drop the unservable → rank → (aggregate) → page.
    let objects = servableOnly(collected);
    objects = filterKinds(objects, kinds);

    // Attach already-computed live claims. Bounded and REPORTED — a capped
    // enrichment must never read as "no live intelligence here".
    const enrichment = await enrichWithLiveClaims(
      objects,
      async (subjectId) => {
        const claims = await readLiveClaims(sc, subjectId);
        return claims.map(toLiveClaimEnvelope) as unknown as LiveClaimLike[];
      },
      { now: nowMs },
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
        generatedAt,
      });
      return;
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
      generatedAt,
    });
  }),
);

export default router;
