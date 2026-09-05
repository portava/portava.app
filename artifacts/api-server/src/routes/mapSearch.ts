/**
 * Map search + Compass command routes.
 *
 *   GET  /api/map/search          — unified, normalized, viewport-bounded search
 *                                    across travelers + gems + events (flag:
 *                                    map_search_enabled)
 *   POST /api/map/compass-command — validated Compass→map command protocol
 *                                    (flag: map_compass_commands_enabled)
 *
 * Privacy: this layer NEVER re-decides who/what is visible. It calls each entity
 * type's existing privacy-complete source (listMapTravelers, findNearbyGems +
 * applyGemPrivacy, and the same block/friends/eligibility gates the events route
 * uses) and only normalizes the already-safe rows. Blocks are resolved once via
 * the shared bidirectional set and fail closed.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { fetchBlockedSet } from "../lib/blocks.js";
import { listMapTravelers } from "../lib/mapTravelers.js";
import { findNearbyGems } from "../services/hiddenGems/HiddenGemDiscoveryService.js";
import { applyGemPrivacyBatch } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";
import { checkEventEligibility } from "./events.js";
import {
  normalizeTraveler, normalizeGem, normalizeEvent,
  filterByQuery, rankResults, paginate, type MapSearchResult,
} from "../lib/mapSearch.js";
import {
  logDiscoveryServe, DiscoveryServePoint, searchTypeToItemKind,
} from "../lib/discoveryServeLog.js";
import { buildCommandsFromIntent } from "../lib/mapCommands.js";
import { forwardGeocode } from "../lib/geocodeForward.js";

const router = Router();

// ── events aggregation — reuses the SAME gates as GET /api/events/nearby ──────
/** Exported for testing: coordinate redaction must survive a refactor. */
export async function loadNearbyEvents(
  sc: any, viewerId: string, lat: number, lng: number, radiusKm: number, blockedSet: Set<string>,
): Promise<any[] | null> {
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const { data, error } = await sc
    .from("events")
    // `ends_at` is what projectEvent turns into the object's `expiresAt`, and
    // `expiresAt` is what stops a started event rendering as LIVE forever
    // (spec §37: "Do not let stale claims remain visually live"). It was absent
    // from this list, so every gateway-served event had expiresAt undefined.
    .select("id, host_id, title, location_name, location_lat, location_lng, show_exact_location, starts_at, ends_at, cover_url, visibility, state, age_min, age_max, trust_score_min, verified_only")
    .not("state", "in", '("draft","cancelled","archived")')
    .in("visibility", ["public", "friends_only"])
    .gte("location_lat", lat - latDelta).lte("location_lat", lat + latDelta)
    .gte("location_lng", lng - lngDelta).lte("location_lng", lng + lngDelta)
    .limit(60);
  // A read FAILURE is not an empty neighbourhood: return null so a caller that
  // needs the distinction (the §10 inferred-cause path reports eventsReadFailed)
  // can tell them apart. Callers that don't care coalesce null to [].
  if (error || !Array.isArray(data)) return null;
  const out: any[] = [];
  for (const ev of data as any[]) {
    if (blockedSet.has(ev.host_id)) continue;
    if (ev.visibility === "friends_only" && ev.host_id !== viewerId) {
      const { data: friendship } = await sc
        .from("user_friendships")
        .select("user_a")
        .or(`and(user_a.eq.${viewerId},user_b.eq.${ev.host_id}),and(user_b.eq.${viewerId},user_a.eq.${ev.host_id})`)
        .maybeSingle();
      if (!friendship) continue;
    }
    const elig = await checkEventEligibility(sc, ev, viewerId);
    if (!elig.ok) continue;
    // Honor show_exact_location, matching formatEvent(): a host who hid the exact
    // location must not have its coordinates echoed on the discovery map to
    // anyone but themselves. (Participants still see the exact spot in the event
    // detail via formatEvent; here they simply get no precise map pin.)
    if (ev.show_exact_location === false && ev.host_id !== viewerId) {
      ev.location_lat = null;
      ev.location_lng = null;
    }
    out.push(ev);
  }
  return out;
}

// ── GET /api/map/search ───────────────────────────────────────────────────────
router.get("/map/search", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const generatedAt = new Date().toISOString();
  if (!(await isFlagEnabled(sc, "map_search_enabled"))) {
    res.json({ enabled: false, results: [], viewport: null, total: 0, nextCursor: null, generatedAt });
    return;
  }

  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    sendError(res, "invalid_payload", "lat and lng are required and must be in range");
    return;
  }
  const radiusRaw = Number(req.query.radiusKm);
  const radiusKm = isFinite(radiusRaw) ? Math.min(200, Math.max(1, radiusRaw)) : 25;
  const query = req.query.q ? String(req.query.q) : null;
  const typesParam = req.query.types
    ? String(req.query.types).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const want = (t: string) => !typesParam || typesParam.includes(t);
  const limitRaw = Number(req.query.limit);
  const limit = isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 30;
  const cursor = req.query.cursor ? String(req.query.cursor) : null;

  // One shared, fail-closed block set for every source.
  const blockedSet = await fetchBlockedSet(sc, user.id);
  if (blockedSet === null) {
    res.json({ enabled: true, results: [], viewport: { lat, lng, radiusKm }, total: 0, nextCursor: null, generatedAt });
    return;
  }

  const results: MapSearchResult[] = [];
  const tasks: Promise<void>[] = [];

  if (want("traveler")) tasks.push((async () => {
    const travelers = await listMapTravelers(sc, { viewerId: user.id, lat, lng, radiusKm, blockedSet }).catch(() => []);
    for (const t of travelers) results.push(normalizeTraveler(t));
  })());

  if (want("gem")) tasks.push((async () => {
    const ranked = await findNearbyGems(sc, lat, lng, radiusKm, { limit: 60 }).catch(() => []);
    const notBlocked = ranked.filter((r: any) => !r.gem?.submitted_by || !blockedSet.has(r.gem.submitted_by));
    const safe = await applyGemPrivacyBatch(notBlocked.map((r: any) => r.gem), sc, user.id).catch(() => []);
    safe.forEach((g: any, i: number) => results.push(normalizeGem(g, notBlocked[i]?.distanceKm ?? null)));
  })());

  if (want("event")) tasks.push((async () => {
    const events = (await loadNearbyEvents(sc, user.id, lat, lng, radiusKm, blockedSet).catch(() => null)) ?? [];
    for (const ev of events) results.push(normalizeEvent(ev));
  })());

  await Promise.all(tasks);

  const filtered = filterByQuery(results, query);
  const rankedResults = rankResults(filtered, { lat, lng });
  const { page, nextCursor } = paginate(rankedResults, cursor, limit);

  res.json({
    enabled: true,
    results: page,
    viewport: { lat, lng, radiusKm },
    total: rankedResults.length,
    nextCursor,
    generatedAt,
  });

  // Serve point 12 — map discovery ranks (rankResults) and paginates, then
  // served `page` to a user while writing no rank_events row of any kind. It
  // was invisible to Discovery analytics, and an outcome could not be reported
  // against it either: POST /rank-events/outcome resolves an outcome by finding
  // the impression row it upgrades, so a surface with no impression row has no
  // outcome path at all.
  //
  // `page` and not `rankedResults`: an impression is what the viewer received,
  // not what the ranker considered. The same distinction the pulse denominator
  // was getting wrong.
  //
  // AFTER res.json and un-awaited: logDiscoveryServe never throws and is gated
  // on discovery_serve_log_enabled, so this adds no latency and cannot fail the
  // request. Coordinates are NOT logged (spec §8) — only the radius.
  void logDiscoveryServe(sc, {
    userId:     user.id,
    servePoint: DiscoveryServePoint.MAP_SEARCH,
    route:      "GET /map/search",
    items:      page.map((r) => ({ id: String(r.id), kind: searchTypeToItemKind(r.resultType) })),
    context:    { radiusKm, hasQuery: query !== null, resultCount: page.length },
  });
}));

// ── POST /api/map/compass-command ─────────────────────────────────────────────
const ALLOWED_KINDS = new Set(["go_to", "search", "select", "filter", "clear"]);

router.post("/map/compass-command", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  if (!(await isFlagEnabled(sc, "map_compass_commands_enabled"))) {
    res.json({ enabled: false, commands: [], explanation: "" });
    return;
  }

  const intent = (req.body ?? {}).intent;
  if (!intent || typeof intent !== "object" || typeof intent.kind !== "string" || !ALLOWED_KINDS.has(intent.kind)) {
    sendError(res, "invalid_payload", "intent with a valid kind (go_to|search|select|filter|clear) is required");
    return;
  }

  const { commands, explanation } = await buildCommandsFromIntent(intent, forwardGeocode);
  res.json({ enabled: true, commands, explanation });
}));

export default router;
