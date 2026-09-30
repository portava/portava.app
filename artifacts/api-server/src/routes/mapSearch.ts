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
import { isFlagEnabled } from "../lib/featureFlags.js"; import { readFlagState } from "../lib/capability/schemaCapability.js";  // census-discovery §107 (D-W11X2-71)
import { fetchBlockedSet } from "../lib/blocks.js";
import { listMapTravelersRead } from "../lib/mapTravelers.js";
import { findNearbyGems } from "../services/hiddenGems/HiddenGemDiscoveryService.js";
import { applyGemPrivacyBatch } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";
import { checkEventEligibility } from "./events.js";
import {
  normalizeTraveler, normalizeGem, normalizeEvent,
  filterByQuery, rankResults, paginate, type MapSearchResult,
} from "../lib/mapSearch.js";
import {
  logDiscoveryServe, DiscoveryServePoint, searchTypeToItemKind,
} from "../lib/discoveryServeLog.js";  import { stampServedRecommendations, exposureForResponse, serveClockOf } from "../lib/discoveryRecommendationRecord.js";  // census-discovery §48 — serve point 12's response carries the ids its serve-log rows do
import { buildCommandsFromIntent } from "../lib/mapCommands.js"; import { EVENT_CAUSE_DEFAULT_DURATION_MINUTES } from "../lib/mapProducers/eventContextProducer.js";  // census-discovery §113 (D-W11X2-132): the forward window's assumed duration
import { forwardGeocode } from "../lib/geocodeForward.js";

const router = Router();

// ── events aggregation — reuses the SAME gates as GET /api/events/nearby ──────

/**
 * Optional NARROWING for `loadNearbyEvents`. Nothing about the privacy gates
 * changes; this only shrinks the candidate row set BEFORE the per-row pass.
 *
 * WHY IT EXISTS. The per-row pass is not free: for every candidate row it may
 * run a friendship read plus `checkEventEligibility` (staff role, block, ban,
 * trust-gate flag). A caller that only cares about events which are ON NOW —
 * the Wall's Live For You strip has a sub-500 ms first-page budget (Wall spec
 * TABLE 4) — would otherwise pay that pass for 60 rows to keep one. A caller
 * that wants the whole neighbourhood (the Map gateway) simply omits this and
 * the query is byte-for-byte what it was.
 *
 * The predicate is "could this be on, or about to start": start no later than
 * `startsBeforeIso`, and either an end at or after `nowIso`, or a start no
 * earlier than `openEndedStartsAfterIso` (the caller's assumed duration for an
 * event with no usable end). A multi-day event that started last week is
 * therefore kept, which a naive range on `starts_at` alone would have dropped.
 *
 * IT IS A SUPERSET, NOT A MIRROR. The second branch is deliberately NOT
 * `and(ends_at.is.null, …)`. `eventContextProducer.eventPhaseAt` — the canonical
 * derivation the Wall's strip runs over these rows — ignores an `ends_at` that is
 * not strictly after `starts_at` and substitutes the assumed duration, so a row
 * with a malformed end (at or before its start) can still be `ongoing`. Keying
 * the fallback on `ends_at IS NULL` dropped exactly those rows before the per-row
 * pass ever saw them. PostgREST cannot compare two columns, so the honest shape
 * is the wider one: keep anything that starts inside the assumed-duration window
 * regardless of its end. That admits a handful of rows the per-row pass will
 * reject (a valid end that already passed), and admits EVERY row that pass would
 * accept — narrowing must never cost a candidate.
 */
export interface NearbyEventsWindow {
  nowIso: string;
  startsBeforeIso?: string;  // census-discovery §113 (D-W11X2-132): omitted = no upper bound (the NOW gateway and map search read every event not yet over)
  openEndedStartsAfterIso: string;
}

/** Exported for testing: coordinate redaction must survive a refactor. */
export async function loadNearbyEvents(
  sc: any, viewerId: string, lat: number, lng: number, radiusKm: number, blockedSet: Set<string>,
  opts: { window?: NearbyEventsWindow; limit?: number } = {},
): Promise<any[] | null> {
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  let q = sc
    .from("events")
    // `ends_at` is what projectEvent turns into the object's `expiresAt`, and
    // `expiresAt` is what stops a started event rendering as LIVE forever
    // (spec §37: "Do not let stale claims remain visually live"). It was absent
    // from this list, so every gateway-served event had expiresAt undefined.
    .select("id, host_id, title, location_name, location_lat, location_lng, show_exact_location, starts_at, ends_at, cover_url, visibility, state, age_min, age_max, trust_score_min, verified_only")
    .not("state", "in", '("draft","cancelled","archived")')
    .in("visibility", ["public", "friends_only"])
    .gte("location_lat", lat - latDelta).lte("location_lat", lat + latDelta)
    .gte("location_lng", lng - lngDelta).lte("location_lng", lng + lngDelta);
  const w = opts.window;
  if (w) {
    // census-discovery §113 (D-W11X2-132): the upper bound on the start is optional (a forward window has none).
    q = (w.startsBeforeIso ? q.lte("starts_at", w.startsBeforeIso) : q)
      .or(`ends_at.gte.${w.nowIso},starts_at.gte.${w.openEndedStartsAfterIso}`);
  }
  const scanCap = Math.max(1, Math.min(opts.limit ?? 60, 60)); const { data: scanned, error } = await q.order("starts_at", { ascending: true }).limit(scanCap + 1);  // §113 (DV-83, D-W11X2-132): soonest first, and one row past the cap so a cut scan is known
  // A read FAILURE is not an empty neighbourhood: return null so a caller that
  // needs the distinction (the §10 inferred-cause path reports eventsReadFailed)
  // can tell them apart. Callers that don't care coalesce null to [].
  if (error || !Array.isArray(scanned)) return null; const scanCut = scanned.length > scanCap; const data = scanned.slice(0, scanCap);  // §113: the per-row gates and every caller's filters run after this cut
  const out: any[] = []; let withheldUnchecked = 0;  // census-discovery §110 (DV-83, D-W11X2-93): rows a gate withheld because its read FAILED
  for (const ev of data as any[]) {
    if (blockedSet.has(ev.host_id)) continue;
    if (ev.visibility === "friends_only" && ev.host_id !== viewerId) {
      const { data: friendship, error: friendshipErr } = await sc
        .from("user_friendships")
        .select("user_a")
        .or(`and(user_a.eq.${viewerId},user_b.eq.${ev.host_id}),and(user_b.eq.${viewerId},user_a.eq.${ev.host_id})`)
        .maybeSingle();
      if (friendshipErr) { withheldUnchecked++; continue; } if (!friendship) continue;  // §110: an unread friendship is withheld, and counted — never "not a friend"
    }
    const elig = await checkEventEligibility(sc, ev, viewerId);
    if (!elig.ok) { if (elig.unread) withheldUnchecked++; continue; }  // §110: a gate that could not be read is counted, not folded into "ineligible"
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
  if (withheldUnchecked > 0) WITHHELD_UNCHECKED.set(out, withheldUnchecked); if (scanCut) SCAN_CUT.add(out); return out;
}

/**
 * One source's contribution to a search answer.
 *
 * `refusal` names WHY a source produced nothing, or is null when it genuinely
 * had nothing to give. The two are different facts and the envelope must not
 * conflate them: an empty neighbourhood is an answer, an unreadable table is
 * not. Mirrors ProducerLayerReport in routes/mapProjection.ts.
 */
interface SourceReport {
  refusal: string | null;
  collected: number; /** §110 (D-W11X2-93): present only when rows were withheld because a gate could not be read */ withheldUnchecked?: number;
}

// ── GET /api/map/search ───────────────────────────────────────────────────────
router.get("/map/search", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const generatedAt = new Date().toISOString();
  const mapSearchFlag = await readFlagState(sc, "map_search_enabled"); if (mapSearchFlag === "unreadable") { res.json({ enabled: false, refusal: "flag_unreadable", results: [], viewport: null, total: 0, nextCursor: null, sources: null, generatedAt }); return; } if (mapSearchFlag !== "on") {  // census-discovery §107 (DV-83, D-W11X2-71): an UNREAD flag is named, never the flag-off body — was: if (!(await isFlagEnabled(sc, "map_search_enabled"))) {
    res.json({ enabled: false, results: [], viewport: null, total: 0, nextCursor: null, sources: null, generatedAt });
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
  //
  // `enabled: false` WITH A NAMED REFUSAL, not `enabled: true, results: []`.
  // "Nothing matched your search" is a claim about the world, and an unreadable
  // `blocks` table cannot support it: the honest answer is that the server
  // cannot tell whether it is safe to show anything. The gateway
  // (routes/mapProjection.ts) reached the same conclusion for the §24 policy —
  // the client treats an `enabled: true` answer as authoritative and stops
  // asking — and `blocks` failing is the more ordinary event of the two.
  //
  // `fetchBlockedSet` returns null for a READ FAILURE precisely so this caller
  // can tell it from "this user blocks nobody"; serving an empty payload threw
  // that distinction away at the last step.
  const blockedSet = await fetchBlockedSet(sc, user.id);
  if (blockedSet === null) {
    res.json({
      enabled: false,
      refusal: "block_set_unreadable",
      results: [], viewport: { lat, lng, radiusKm }, total: 0, nextCursor: null, sources: null, generatedAt,
    });
    return;
  }

  const results: MapSearchResult[] = [];
  const tasks: Promise<void>[] = [];

  // PER-SOURCE REFUSALS, so "empty" and "broken" stay distinguishable.
  //
  // `loadNearbyEvents` returns null for a READ FAILURE specifically so a caller
  // "that needs the distinction can tell them apart" — and this route used to
  // answer it with `?? []`, collapsing "the events table could not be read"
  // into "there are no events near you". That is a confident claim about the
  // world assembled from a query that did not answer, and nothing in the
  // response let a client or an operator tell the two apart.
  //
  // Refusing the WHOLE request would be worse than the defect: one broken
  // table would blank a search three healthy sources could still answer. The
  // gateway next door already settled this shape — `producers` and
  // `crowdFlow.refusal` in routes/mapProjection.ts report per-layer refusals
  // for exactly this reason — so map search reports the same way. `null` means
  // the caller did not ask for that source, which is not the same fact as
  // having collected nothing from it.
  const sources: Record<string, SourceReport | null> = { traveler: null, gem: null, event: null };

  if (want("traveler")) tasks.push((async () => {
    // GAP CLOSED. This used to read: "listMapTravelers returns a bare array and
    // has no failure channel, so a failed read inside it is already
    // indistinguishable from an empty one before this route sees it … closing
    // that needs listMapTravelers' signature to change". It has changed — the
    // function now returns null for a failed read, a failed privacy query, or
    // an unknown block state — so a null here is a genuine refusal and not
    // merely "nothing was thrown".
    const read = await listMapTravelersRead(sc, { viewerId: user.id, lat, lng, radiusKm, blockedSet })
      .catch(() => null);
    if (read === null) { sources.traveler = { refusal: "travelers_unreadable", collected: 0 }; return; }
    for (const t of read.travelers) results.push(normalizeTraveler(t));
    sources.traveler = { refusal: read.truncated ? "travelers_capped" : null, collected: read.travelers.length };  // §113 (DV-83, D-W11X2-129): a cut scan is not a complete source
  })());

  if (want("gem")) tasks.push((async () => {
    // Same gap as travelers: findNearbyGems returns a bare array.
    const found = await findNearbyGems(sc, lat, lng, radiusKm, { limit: 60 }).catch(() => null); const ranked = found === null ? null : found.ranked;  // §113 (D-W11X2-131)
    if (ranked === null) { sources.gem = { refusal: "gems_threw", collected: 0 }; return; }
    const notBlocked = ranked.filter((r: any) => !r.gem?.submitted_by || !blockedSet.has(r.gem.submitted_by));
    const safe = await applyGemPrivacyBatch(notBlocked.map((r: any) => r.gem), sc, user.id).catch(() => null);
    // The privacy batch failing is NOT "no gems". Reporting it separately keeps
    // a privacy-filter outage from reading as a quiet neighbourhood.
    if (safe === null) { sources.gem = { refusal: "gem_privacy_unavailable", collected: 0 }; return; }
    safe.forEach((g: any, i: number) => results.push(normalizeGem(g, notBlocked[i]?.distanceKm ?? null)));
    sources.gem = { refusal: found!.truncated ? "gems_capped" : null, collected: safe.length };  // §113 (DV-83, D-W11X2-131): a cut gem scan is not a complete source
  })());

  if (want("event")) tasks.push((async () => {
    // The one source that DOES carry the distinction. null is a read failure.
    const events = await loadNearbyEvents(sc, user.id, lat, lng, radiusKm, blockedSet, { window: forwardEventsWindow(Date.now()) }).catch(() => null);  // §113 (D-W11X2-132): events not yet over
    if (events === null) { sources.event = { refusal: "events_unreadable", collected: 0 }; return; }
    for (const ev of events) results.push(normalizeEvent(ev));
    const unchecked = nearbyEventsWithheldUnchecked(events); sources.event = unchecked > 0 ? { refusal: "event_gates_unreadable", collected: events.length, withheldUnchecked: unchecked } : nearbyEventsScanCut(events) ? { refusal: "events_capped", collected: events.length } : { refusal: null, collected: events.length };  // §110 (DV-83, D-W11X2-93): rows withheld unchecked are not a complete source
  })());

  await Promise.all(tasks);

  const filtered = filterByQuery(results, query);
  const rankedResults = rankResults(filtered, { lat, lng });
  const { page, nextCursor } = paginate(rankedResults, cursor, limit);

  res.json({
    enabled: true,
    results: stampServedRecommendations(page.map((r) => ({ ...r, id: String(r.id) })), exposureForResponse(res, user.id)),  // §48 DV-40 — each result carries its exposure id
    viewport: { lat, lng, radiusKm },
    total: rankedResults.length,
    nextCursor,
    sources,
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
    route:      "GET /map/search", ...serveClockOf(exposureForResponse(res, user.id)),  // §48 — the SAME exposure the response carries
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

// ── census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-93): what a gate withheld UNCHECKED ──
//
// Every row `loadNearbyEvents` reads passes per-event gates that fail CLOSED on a failed read (the
// friends-only friendship read; `checkEventEligibility`'s ban, verified, trust and age reads). Failing
// closed is right — an unreadable gate must not admit — but the row is then missing for a reason
// that is not a fact about the event, so the caller must be able to say so. The count rides beside
// the array (a WeakMap, so a healthy array and every body built from it are unchanged).
const WITHHELD_UNCHECKED = new WeakMap<object, number>();

/** How many rows `loadNearbyEvents` withheld because a gate could not be read (0 when none, or for any other array). */
export function nearbyEventsWithheldUnchecked(rows: unknown): number {
  return rows && typeof rows === "object" ? (WITHHELD_UNCHECKED.get(rows as object) ?? 0) : 0;
}

// ── census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-132): a scan cut at its cap ──
//
// `loadNearbyEvents` reads its rows soonest-first and one past its cap. When the extra row came back, the scan was
// CUT: the per-row gates and every caller's filters (the query, the forecast window, the live check) ran over the
// first `scanCap` rows only, so no caller may state the answer as complete. The mark rides beside the array, as the
// withheld count does, so a healthy array and every body built from it are unchanged.
const SCAN_CUT = new WeakSet<object>();

/** Whether `loadNearbyEvents` cut its scan at the cap for this answer (false for any other value). */
export function nearbyEventsScanCut(rows: unknown): boolean {
  return !!rows && typeof rows === "object" && SCAN_CUT.has(rows as object);
}

/**
 * The window for a caller that shows what is on or ahead (GET /map/search, the NOW gateway): an event whose end is
 * not yet past, or — with no usable end — one that started within the assumed duration. No upper bound on the start.
 */
export function forwardEventsWindow(nowMs: number): NearbyEventsWindow {
  return {
    nowIso: new Date(nowMs).toISOString(),
    openEndedStartsAfterIso: new Date(nowMs - EVENT_CAUSE_DEFAULT_DURATION_MINUTES * 60_000).toISOString(),
  };
}

/**
 * The window for the temporal forecast: a superset of `projectEventForecast`'s rule (the event's
 * [starts, ends-or-starts] interval overlaps the target's [windowStart, windowEnd]).
 */
export function forecastEventsWindow(target: { windowStart: number; windowEnd: number }): NearbyEventsWindow {
  return {
    nowIso: new Date(target.windowStart).toISOString(),
    startsBeforeIso: new Date(target.windowEnd).toISOString(),
    openEndedStartsAfterIso: new Date(target.windowStart).toISOString(),
  };
}
