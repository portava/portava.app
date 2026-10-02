/**
 * searchPage — the Map search sheet's field, served by the input gateway.
 *
 * census-discovery §80 (lane W10-S1), row A08 reason 3, register D-W10-S1-5.
 *
 * WHAT THIS IS
 * ============
 * The Map's search sheet (`travel-buddy-standalone/src/components/map/
 * MapSearchSheet.tsx`) used to run its own per-keystroke engine: two debounced
 * `GET /discovery/search` requests (the `type=all` fan-out and the `saved`
 * heading) per keystroke, off the shared input platform. GII `:8` says the
 * opposite — "Those surfaces consume it through a shared platform layer" — and
 * GII §13's phase 3 names the Map among Global Search's consumers.
 *
 * The sheet is now a FIELD of the `global_search` context, `map.search`, and
 * asks `POST /input-assistance/suggest`. The field owns its behaviour (GII §2:
 * "The field owns behavior; the Input Intelligence platform owns suggestion
 * intelligence"), and this field's behaviour is a SEARCH PAGE: §27's nine
 * headings, every row the sheet showed before, and the notices it showed —
 * not the typeahead's eight ranked suggestions.
 *
 * WHY THE SAME ROWS, AND HOW THAT IS HELD
 * =======================================
 * Candidate generation is the platform module's own: the same `searchAll`
 * fan-out and the same `dispatchSearchWithCoverage("saved")` the Discovery route
 * calls, behind the same fail-closed eligibility reads, followed by the same
 * §24 protected-zone pass (B04) before anything is projected. The query is
 * prepared exactly as `GET /discovery/search` prepares it — handle strip, the
 * platform's emoji strip (D-W10-S1-1), aliases, the PostgREST guard, the nearby
 * and time intents. That preparation is repeated here rather than shared with
 * the route, because the route's lines carry anchored citations in six
 * censuses; `test/inputAssistanceMapSearchPage.test.ts` runs both over one
 * fixture world and fails on any difference in the rows or the coverage.
 *
 * WHY THE NOTICES SURVIVE
 * =======================
 * The typeahead's contract is fail-soft: a failed type becomes no rows. The
 * sheet's contract is the opposite and was the whole of its DV-83 work — "a
 * refusal is not an empty result". So this page carries the coverage of each of
 * its two lanes in the Discovery refusal vocabulary (lib/discoveryRefusal.ts),
 * the same `class`/`code`/`coverage`/`failedSources` the route sends, on the
 * gateway envelope: `refusal` for the fan-out, `laneRefusals.saved` for the
 * saved heading. Nothing is dropped on the way to the projection.
 *
 * WHAT THE PROJECTION CARRIES
 * ===========================
 * An ordinary §42 entity suggestion, plus `mapResult`: the search wire type and
 * the five display fields the Map's adapter reads, and from `metadata` ONLY the
 * geometry keys it reads (`lat`, `lng`, `coordsPrecision`, `savedKind`,
 * `bounds`). Every position has already been through the §24 pass, so the
 * projection discloses no position `GET /discovery/search` would not.
 */
import { DiscoverySearchQueryParams } from "@workspace/api-zod";
import { fetchBlockedSet } from "../blocks";
import { logger } from "../logger";
import { discoveryRefusal, type DiscoveryRefusal } from "../discoveryRefusal";
import { protectSearchPage, protectSearchResults } from "../discoverySearchProtection";
import {
  FAN_SOURCES,
  searchAll,
  dispatchSearchWithCoverage,
  fetchAgeRestrictedSet,
  sanitizeQuery,
  type SearchResult,
} from "./searchCandidates";
import {
  applyAliases,
  parseNearbyIntent,
  parseTimeIntent,
  type SearchQueryContext,
} from "./searchQueryHelpers";
import { stripEmoji } from "./queryNormalizer";
import { projectSearchResult } from "./projection";
import type { EntityType, InputSuggestion, MapResultProjection } from "./types";

/** The field id the Map search sheet registers under `global_search`. */
export const MAP_SEARCH_FIELD_ID = "map.search";

/** The route string the gateway's refusals name, in the serve log's spelling. */
export const GATEWAY_ROUTE = "POST /input-assistance/suggest";

/** The page size the sheet always asked `GET /discovery/search` for (its default). */
export const MAP_SEARCH_PAGE_LIMIT = 20;

/** What one gateway serve returns once coverage is part of the answer. */
export interface GatewayServe {
  suggestions: InputSuggestion[];
  /** The answer's coverage, in the Discovery refusal vocabulary. Absent = complete. */
  refusal: DiscoveryRefusal | null;
  /** A field with more than one lane names each extra lane's coverage here. */
  laneRefusals?: { saved: DiscoveryRefusal | null };
}

export interface MapSearchPageParams {
  text: string;
  userId: string;
  lat: number | null;
  lng: number | null;
  city: string | null;
  tz: string | null;
}

/** `GET /discovery/search`'s own 400 text for a query with nothing searchable. */
export const QUERY_TOO_SHORT_MESSAGE = "q must be at least 2 characters after sanitization";

/** Only the geometry keys `searchAdapter.ts` reads. Never another metadata key. */
const MAP_METADATA_KEYS = ["lat", "lng", "coordsPrecision", "savedKind", "bounds"] as const;

function mapMetadata(m: Record<string, unknown> | null): MapResultProjection["metadata"] {
  if (!m || typeof m !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const k of MAP_METADATA_KEYS) if (k in m) out[k] = m[k];
  return out;
}

const SAVED_KIND_ENTITY: Record<string, EntityType> = {
  place: "place",
  event: "event",
  trip: "trip",
  hidden_gem: "hidden_gem",
  area: "city",
};

/** Project one served row: the §42 entity suggestion, plus the Map's placement. */
export function projectMapSearchRow(r: SearchResult, policyVersion: string, q: string): InputSuggestion {
  const mapResult: MapResultProjection = {
    serverType: r.type,
    subtitle: r.subtitle ?? null,
    locationPreview: r.locationPreview ?? null,
    destinationRoute: r.destinationRoute ?? null,
    startsAt: r.startsAt ?? null,
    metadata: mapMetadata(r.metadata),
  };
  if (r.type !== "saved") {
    return { ...projectSearchResult(r, "global_search", policyVersion, q), mapResult };
  }
  // `saved` is the viewer's own shelf, not a dispatchable entity type: its
  // entity is what was saved, as the server states it (`metadata.savedKind`).
  const kind = SAVED_KIND_ENTITY[String((r.metadata as { savedKind?: unknown } | null)?.savedKind ?? "place")] ?? "place";
  const s: InputSuggestion = {
    id: `global_search:saved:${r.id}`,
    type: "entity",
    context: "global_search",
    label: r.title,
    entityType: kind,
    entityId: r.id,
    action: { type: "open_entity", entityType: kind, entityId: r.id },
    source: "canonical",
    policyVersion,
    mapResult,
  };
  if (r.subtitle) s.subtitle = r.subtitle;
  if (r.destinationRoute) {
    s.destination = { route: r.destinationRoute, entityType: kind, entityId: r.id };
    s.canonicalUri = `portava:${r.destinationRoute}`;
  }
  return s;
}

/**
 * The query, prepared exactly as `GET /discovery/search` prepares it
 * (routes/discoverySearch.ts, the block after the zod parse). Null when there
 * is nothing searchable — the route's `400 invalid_payload`.
 */
export function prepareSearchQuery(
  rawQ: string,
  opts: { lat: number | null; lng: number | null; tz: string | null; city: string | null },
): { effectiveQ: string; ctx: SearchQueryContext } | null {
  const parsed = DiscoverySearchQueryParams.safeParse({ q: rawQ, type: "all" });
  if (!parsed.success) return null;
  const q0 = parsed.data.q;
  const isHandleQuery = q0.startsWith("@");
  const qAfterHandle = isHandleQuery ? q0.slice(1) : q0;
  const q = sanitizeQuery(applyAliases(stripEmoji(qAfterHandle)));
  if (q.length < 2) return null;

  const lat = opts.lat !== null && Number.isFinite(opts.lat) && opts.lat >= -90 && opts.lat <= 90 ? opts.lat : null;
  const lng = opts.lng !== null && Number.isFinite(opts.lng) && opts.lng >= -180 && opts.lng <= 180 ? opts.lng : null;
  const tz = typeof opts.tz === "string" && opts.tz.length <= 50 ? opts.tz : null;
  const userCity = typeof opts.city === "string" && opts.city.trim().length > 0 ? opts.city.trim().slice(0, 100) : null;

  const nearbyResult = parseNearbyIntent(q);
  const qAfterNearby = nearbyResult.nearbyIntent
    ? (nearbyResult.strippedQuery.trim().length >= 2 ? nearbyResult.strippedQuery : q)
    : q;
  const timeIntentResult = parseTimeIntent(qAfterNearby, tz);
  const effectiveQ = timeIntentResult.strippedQuery.trim().length >= 2 ? timeIntentResult.strippedQuery : qAfterNearby;
  const displayLabel = nearbyResult.nearbyIntent
    ? (lat !== null && lng !== null ? "Nearby" : "Nearby (enable location)")
    : (timeIntentResult.intent?.label ?? null);

  // The Map sends no intent chips and no trip, so those members are null — as
  // they are on the route when the client does not send them.
  const ctx: SearchQueryContext = {
    tripId: null,
    lat,
    lng,
    tz,
    startsAfter: timeIntentResult.intent?.startsAfter ?? null,
    startsBefore: timeIntentResult.intent?.startsBefore ?? null,
    timeLabel: displayLabel,
    nearbyIntent: nearbyResult.nearbyIntent,
    userCity: userCity ?? null,
    intentCategory: null,
    intentSocial: null,
    intentBudget: null,
    intentSafety: null,
    intentLocationHint: null,
  };
  return { effectiveQ, ctx };
}

/**
 * The Map search page: the `type=all` lane and the `saved` lane, each with its
 * own coverage, projected for the sheet. Never throws: a lane that fails is a
 * lane that REFUSED, and says so.
 */
export async function generateMapSearchPage(
  sc: any,
  p: MapSearchPageParams,
  policyVersion: string,
): Promise<GatewayServe> {
  const prepared = prepareSearchQuery(p.text, { lat: p.lat, lng: p.lng, tz: p.tz, city: p.city });
  if (!prepared) {
    // `validation` is the class the route's 400 is; the gateway keeps its 200
    // (the same reason `/discovery/suggest` does for `query_too_short`).
    const r = discoveryRefusal("validation", "query_too_short", GATEWAY_ROUTE);
    return { suggestions: [], refusal: r, laneRefusals: { saved: r } };
  }
  const { effectiveQ, ctx } = prepared;

  let blockedSet: Set<string> | null;
  let ageRestrictedSet: Set<string> | null;
  try {
    [blockedSet, ageRestrictedSet] = await Promise.all([fetchBlockedSet(sc, p.userId), fetchAgeRestrictedSet(sc)]);
  } catch (err) {
    logger.warn({ err }, "map search page: eligibility read threw");
    const r = discoveryRefusal("transient_db", "search_failed", GATEWAY_ROUTE);
    return { suggestions: [], refusal: r, laneRefusals: { saved: r } };
  }
  if (!blockedSet || !ageRestrictedSet) {
    // Fail-closed, and SAID: the route refuses both requests the sheet made.
    const r = discoveryRefusal("transient_db", "visibility_state_unreadable", GATEWAY_ROUTE);
    return { suggestions: [], refusal: r, laneRefusals: { saved: r } };
  }

  const [allLane, savedLane] = await Promise.all([
    (async () => {
      try {
        const page = await protectSearchPage(
          sc,
          await searchAll(sc, effectiveQ, p.userId, blockedSet, ageRestrictedSet, 0, MAP_SEARCH_PAGE_LIMIT, ctx),
          GATEWAY_ROUTE,
        );
        const refusal = page.unreadableSources.length > 0
          ? discoveryRefusal(
              "transient_db", "search_sources_unreadable", GATEWAY_ROUTE,
              page.unreadableSources.length === FAN_SOURCES.length ? "nothing" : "partial",
              page.unreadableSources,
            )
          : null;
        return { rows: page.results, refusal };
      } catch (err) {
        logger.warn({ err }, "map search page: the fan-out failed");
        return { rows: [] as SearchResult[], refusal: discoveryRefusal("transient_db", "search_failed", GATEWAY_ROUTE) };
      }
    })(),
    (async () => {
      try {
        const { results: raw, degradedSources } = await dispatchSearchWithCoverage(
          sc, effectiveQ, p.userId, blockedSet, ageRestrictedSet, "saved", 0, MAP_SEARCH_PAGE_LIMIT + 1, ctx,
        );
        const rows = await protectSearchResults(sc, raw.slice(0, MAP_SEARCH_PAGE_LIMIT), GATEWAY_ROUTE);
        const refusal = degradedSources.length > 0
          ? discoveryRefusal("transient_db", "search_sources_unreadable", GATEWAY_ROUTE, "partial", degradedSources)
          : null;
        return { rows, refusal };
      } catch (err) {
        logger.warn({ err }, "map search page: the saved lane failed");
        return { rows: [] as SearchResult[], refusal: discoveryRefusal("transient_db", "search_failed", GATEWAY_ROUTE) };
      }
    })(),
  ]);

  const suggestions = [...allLane.rows, ...savedLane.rows].map((r) => projectMapSearchRow(r, policyVersion, effectiveQ));
  return { suggestions, refusal: allLane.refusal, laneRefusals: { saved: savedLane.refusal } };
}
