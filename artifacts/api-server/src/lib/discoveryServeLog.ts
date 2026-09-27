/**
 * discoveryServeLog — Stage 0 serve-point instrumentation for Discovery.
 *
 * WHY THIS EXISTS
 * ===============
 * `GET /discovery` has six paths that return places to a user. Exactly ONE of
 * them writes a `rank_events` row today (the cold-fetch legacy-rank path, via
 * logImpression at routes/discovery.ts:1433). The other five — both Cache A
 * layers, the stale-while-revalidate serve, the Compass candidate-cache hit and
 * the fresh Compass rank — respond and `return` before it.
 *
 * So there is no baseline. Any comparison of a new discovery engine against the
 * old one would be computed on the one serve point that scarcely ever executes.
 * Migration 0202_rank_events_live_page_watch_feed_surfaces.sql:17-21 records the
 * live confirmation: a production `SELECT surface, count(*) FROM rank_events`
 * returned only pulse / compass / events, with 'discovery' named among the
 * surfaces "written by the code but ZERO rows present" — and unlike living_page
 * and live_pulse, 'discovery' was already PERMITTED by the CHECK constraint
 * (0199:60, 0202:77). Its absence is not rejection. It is that path not running.
 *
 * This module gives every serve point a row, so the baseline describes what
 * users actually receive rather than one unrepresentative slice of it.
 *
 * INERT UNTIL SEEDED
 * ==================
 * Every write is gated on the `discovery_serve_log_enabled` flag, read through
 * `isFlagEnabled` — which is fail-closed, and returns false for a MISSING row.
 * The flag is deliberately not seeded by this change, so introducing this module
 * performs no production write of any kind and is behaviour-preserving. Turning
 * it on is a separate, deliberate step.
 *
 * ERRORS ARE LOGGED, NOT SWALLOWED
 * ================================
 * `logImpression` swallows insert failures silently. That is exactly how
 * living_page and watch_feed impressions were rejected by the surface CHECK for
 * an unknown period with the loss visible nowhere — the defect 0202 was written
 * to fix. This module logs a warning on failure so a rejected row is observable
 * instead of being lost on the floor. It still never throws: instrumentation
 * must not break a feed response.
 */
import { createHash, randomUUID } from "node:crypto";
import { isFlagEnabled } from "./featureFlags.js";
import { logger } from "./logger.js";
// `12` "Stop conditions" — this writer is the only instrument that knows whether
// an event actually landed, so it is the only place that can feed the two stop
// conditions Discovery can enforce. Recording is in-process and cannot throw.
import { recordServeLogOutcome } from "./discoveryStopConditions.js";
import { recordImpressionDistributionStats } from "../services/ranking/DiscoveryRankingService.js";
// `04` §5 "Recommendation denominator" — every served item must have a
// recommendation_id, and the nine-field minimum record must be recoverable from
// the row. Six fields were already columns here; these complete the other
// three without a migration. See lib/discoveryRecommendationId for why the
// Compass token could not be reused as-is.
import { recommendationIdFor } from "./discoveryRecommendationId.js";
import { DISCOVERY_MODEL_VERSION } from "./discoveryRankProvenance.js";  import { canonicalServedAt, serveIdFor, screenFeaturesForStorage, isDuplicateExposureReplay } from "./discoveryRecommendationRecord.js";  import { isMissingRecommendationIdSchema, noteRecommendationIdAbsent, recommendationIdSchemaAbsent, reportRankEventsRejection } from "./rankEventsProvenance.js";  /* DV-40 / §41.1. ON ONE LINE ON PURPOSE: eleven anchored doc citations point at fixed line numbers in this file (`:70`, `:415`, `:421`, `:426`, `:430`, `:444`, `:450`, `:466`, `:475`, `:477`), most of them in docs/architecture/census-discovery.md, and check:doc-citations fails an anchor whose text has moved. Inserting a line here would red that guard with no fix available in this lane. See the note at the foot of this file. */

/** Feature flag gating every write in this module. Absent row ⇒ disabled. */
export const DISCOVERY_SERVE_LOG_FLAG = "discovery_serve_log_enabled";

/**
 * The six serve points of `GET /discovery`, numbered as in the Phase −1
 * repository proof (docs/discovery/phase-minus-1-repository-proof.md §1a).
 *
 * The number is recorded on every row. Without it the data reproduces exactly
 * the blindness it is meant to remove: a row saying only "discovery served
 * this" cannot distinguish a ranked cold fetch from an unranked cache hit,
 * which is the entire distinction under study.
 */
export const DiscoveryServePoint = {
  CACHE_A_L1:             1,
  CACHE_A_L2_FRESH:       2,
  CACHE_A_L2_STALE:       3,
  CACHE_B_HIT:            4,
  COMPASS_FRESH_RANK:     5,
  COLD_FETCH_LEGACY_RANK: 6,
  // Stage 0b — the rest of the discovery surface (ruling D4=C). None of these
  // ranks or caches; they are instrumented because the baseline must describe
  // everything users receive, not only what the flag will govern (D4=A).
  FEED:                   7,
  SEARCH:                 8,
  SUGGEST:                9,
  // GET /discovery/community — curated community places for a city. It returns
  // items to a caller and was the last uninstrumented serve point on the
  // surface, which made the D4=C baseline incomplete by exactly one route: the
  // comparison would have been computed on traffic that is not everything users
  // receive, which is the specific error D4=C exists to prevent.
  // Like 7-9 it runs no ranker, so it is NOT part of the D5 denominator.
  COMMUNITY:              10,
  // Stage 0c — the two discovery surfaces that live OUTSIDE routes/discovery*.
  // Both return ranked results to a user and neither wrote a rank_events row of
  // any kind, so a Discovery analytics query could not see them at all: not
  // their impressions, and therefore not their outcomes either (the outcome
  // route resolves an outcome by finding the impression it belongs to, so a
  // surface with no impression row can never record one).
  //
  // HIDDEN_GEMS — routes/hiddenGems.ts. GET /hidden-gems runs
  // HiddenGemDiscoveryService.discoverGems (verification weight + saves +
  // visits + vibe-tag match) and GET /hidden-gems/nearby runs findNearbyGems.
  // Both rank. Both are in RANKED_IN_REQUEST below.
  HIDDEN_GEMS:            11,
  // MAP_SEARCH — routes/mapSearch.ts GET /map/search. Merges travelers, gems
  // and events, then rankResults() orders them and paginate() cuts the served
  // page. Ranked in-request.
  MAP_SEARCH:             12,
} as const;

export type DiscoveryServePointId =
  (typeof DiscoveryServePoint)[keyof typeof DiscoveryServePoint];

/**
 * Serve points that ran a ranker during THIS request.
 *
 * Serve points 7-9 are absent deliberately, and not by oversight: feed, search
 * and suggest contain no ranker call at all. A grep of routes/discoverySearch.ts
 * for rankCandidates / rankItemsForDiscovery / drsRankItems / logImpression
 * returns nothing, and /discovery/feed merges Overpass and DB output with no
 * scoring step (routes/discovery.ts:1667-1683).
 */
const RANKED_IN_REQUEST = new Set<number>([
  DiscoveryServePoint.COMPASS_FRESH_RANK,
  DiscoveryServePoint.COLD_FETCH_LEGACY_RANK,
  // 11 and 12 DO rank during the request — discoverGems / findNearbyGems for
  // hidden gems, rankResults for map search — so they belong here, unlike 7-10.
  DiscoveryServePoint.HIDDEN_GEMS,
  DiscoveryServePoint.MAP_SEARCH,
]);

/**
 * The item_kind values the CHECK constraint accepts
 * (0153_add_rank_events.sql:18). NULL is also accepted — 0197 dropped the NOT
 * NULL — and is the correct value for a served entity that is none of these,
 * such as a city, country, language or hashtag result from search.
 */
export type RankItemKind = "post" | "event" | "plan" | "buddy" | "place" | "gem";

/**
 * The same six values as a RUNTIME array.
 *
 * `04` §10.5 asks for the CHECK/enum constraints to be TESTED. A TypeScript
 * union cannot be tested: it is erased before anything runs, so no assertion can
 * compare it with the vocabulary `migrations/0153_add_rank_events.sql:18`
 * declares. The array is what makes the comparison possible, and the union above
 * is derived from it so the two cannot drift apart.
 */
export const RANK_ITEM_KINDS = [
  "post", "event", "plan", "buddy", "place", "gem",
] as const satisfies readonly RankItemKind[];

// ── `04` §3's last two required properties ───────────────────────────────────
//
// §3: "Every event write must be: schema-valid, attributable to a surface,
// observable on failure, idempotent where retried, VERSIONED, PRIVACY-
// CLASSIFIED." The first three are satisfied above and by the module header;
// idempotency needs a unique key this lane may not add (census-discovery
// DV-37 — a migration). These two do not.

/**
 * `04` §6 `schema_version` — which RECORD SHAPE produced this row.
 *
 * NOT the column §6 names: `rank_events` has thirteen columns and adding a
 * fourteenth is a migration (census-discovery DV-38). This is the same
 * accommodation §13.3 made for `04` §5's three missing fields and for the same
 * reason — `04` §6's own instruction is *"if the current table cannot represent
 * this safely, extend it by migration rather than introducing a competing event
 * store"*, and a competing store is the one outcome nobody wants. The jsonb the
 * row already writes is not a competing store.
 *
 * Why it matters even without a column: since §13.3 a row may or may not carry
 * `recommendationId`, `modelVersion` and `reasonCodes`, and an absent
 * `reasonCodes` means EITHER "written before that shape existed" OR "this serve
 * grounded no reason". Without a version stamp those two are the same row.
 *
 * BUMP THIS when the meaning of an existing key in `features` changes, or when
 * a key is removed. Adding a key does not require a bump — a reader that does
 * not know the key ignores it — but removing or REDEFINING one does, because a
 * reader that does know it will be wrong.
 */
export const DISCOVERY_EVENT_SCHEMA_VERSION = 1;

/**
 * `04` §3 "privacy-classified", named with `04` §11's own first layer.
 *
 * §11 lists four suggested layers — raw recent events, durable
 * aggregates/features, audit/security events, anonymised long-term statistics —
 * and then says *"exact retention must be decided with privacy/legal review"*.
 * So this is deliberately a CLASSIFICATION and not a retention rule: it states
 * which of §11's layers the row belongs to, which is a fact about the row, and
 * says nothing about how long it is kept, which is not this lane's to decide.
 *
 * The label is only worth having if it is TRUE, which is what
 * `classifyServeContext` below is for: a row claiming to be a plain behavioural
 * event while carrying a viewer's coordinates would be a worse artefact than an
 * unlabelled row, because a retention or export rule would then be applied to it
 * on the strength of a label nothing enforced.
 */
export const DISCOVERY_EVENT_PRIVACY_CLASS = "raw_behavioral_event";

/**
 * Context keys that carry, or could carry, a precise position.
 *
 * `lib/rankLog.ts:66-67` strips the same class of key from ITS features for
 * `04` §12 / spec §8, and this writer — which now feeds ten call sites across
 * four route files — did not. The rule lived here only as a JSDoc sentence on
 * `context` ("Never coordinates") and as a comment at two of the ten call sites.
 * A rule enforced by whoever remembers it is enforced until somebody does not.
 *
 * `distanceKm` is in the set because `rankLog` strips it: a distance from a
 * viewer to a known venue reconstructs the viewer. `radiusKm` is NOT — a search
 * radius is a request parameter, not a position, and it is the only spatial
 * diagnostic the baseline has.
 */
export const PRECISE_LOCATION_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "lat", "lng", "latitude", "longitude", "distancekm",
  "coords", "coordinates", "geo", "gps", "position", "point", "bbox",
]);

/** Suffixes that make a key a coordinate whatever it is prefixed with. */
const PRECISE_LOCATION_SUFFIXES = ["lat", "lng", "latitude", "longitude"] as const;

export interface ClassifiedServeContext {
  /** Context safe to store on a `raw_behavioral_event` row. */
  kept: Record<string, string | number | boolean | null>;
  /**
   * Keys withheld, under the CALLER'S OWN SPELLING so the offending call site
   * can be found by grep. Names only — never the values, which are the thing
   * being withheld.
   */
  dropped: string[];
}

/**
 * Split a caller's context into what may be stored and what may not.
 *
 * Pure, synchronous and total: no clock, no client, no throw.
 *
 * THE BIAS IS STATED. Matching is on the normalised key name, so a key whose
 * name does not say it is a coordinate is not caught — this is a vocabulary,
 * not an oracle, and it cannot inspect values. Where it errs it errs toward
 * dropping: a key ending in "lat" that is not a latitude loses a diagnostic,
 * and losing a diagnostic is recoverable in a way that storing a position is
 * not.
 */
export function classifyServeContext(
  context?: Record<string, string | number | boolean | null> | null,
): ClassifiedServeContext {
  const kept: Record<string, string | number | boolean | null> = {};
  const dropped: string[] = [];
  if (!context) return { kept, dropped };
  for (const [key, value] of Object.entries(context)) {
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const precise =
      PRECISE_LOCATION_CONTEXT_KEYS.has(norm) ||
      PRECISE_LOCATION_SUFFIXES.some((s) => norm.endsWith(s));
    if (precise) dropped.push(key);
    else kept[key] = value;
  }
  return { kept, dropped };
}

/** Minimal shape this module needs from a served item. */
export interface ServedItem {
  id: string;
  /**
   * Explicit kind. When omitted the id is used to infer place-vs-gem, which is
   * right for GET /discovery (every item there is a DiscoveryPlace) and wrong
   * for search, whose results are heterogeneous — so search passes this.
   */
  kind?: RankItemKind | null;
}

/**
 * Map a discovery search/suggest result `type` to an item_kind.
 *
 * Returns null for the taxonomic result types — hashtags, circles, stamps,
 * activities, cities, countries, languages, interests, vibes. These are real
 * served results and belong in the baseline, but none of them is one of the six
 * kinds the constraint allows, and inventing a kind for them would corrupt
 * every metric that groups by item_kind. NULL says "served, kind not
 * applicable", which is exactly true.
 */
export function searchTypeToItemKind(type: string): RankItemKind | null {
  switch (type) {
    // Plural forms: the /discovery/search and /discovery/suggest group types.
    case "travelers":
    case "buddies":     return "buddy";
    case "events":      return "event";
    case "trips":
    case "plans":       return "plan";
    case "places":      return "place";
    case "hidden_gems": return "gem";
    case "posts":       return "post";
    // Singular forms: MapSearchResult.resultType (lib/mapSearch.ts) uses
    // 'traveler' | 'gem' | 'event'. Mapped here rather than in a second
    // near-identical function so both surfaces classify one entity identically —
    // a map-search gem and a search-results gem must land on the same item_kind
    // or every per-kind rollup double-counts under two names.
    case "traveler":    return "buddy";
    case "gem":         return "gem";
    case "event":       return "event";
    case "place":       return "place";
    case "plan":
    case "trip":        return "plan";
    case "post":        return "post";
    default:            return null;
  }
}

export interface DiscoveryServeLogParams {
  userId:      string;
  servePoint:  DiscoveryServePointId;
  /** Items actually delivered to the client — after filtering AND pagination. */
  items:       readonly ServedItem[];
  /** Route path, for when Stage 0b widens this beyond GET /discovery. */
  route?:      string;
  sessionId?:  string;  /** The serve clock, when the CALLER already minted one (DC-22): the route derives the recommendation ids it puts on the RESPONSE from the same instant, and two clocks would mint two ids for one exposure. Omitted ⇒ read here, exactly as before. */ servedAt?: string;
  /** Free-form context, e.g. { destination, category }. Never coordinates. */
  context?:    Record<string, string | number | boolean | null>;
  /**
   * `04` §5 "reason codes" — the GROUNDED codes the ranker produced for each
   * item, keyed by item id. Absent for a serve point that ran no ranker, and an
   * item the ranker said nothing about gets `[]` rather than an invented code:
   * a reason nothing backs is worse on a denominator than no reason at all.
   */
  reasonCodesById?: Readonly<Record<string, readonly string[]>>;
}

// ── Flag read, with a short TTL cache ─────────────────────────────────────────
// isFlagEnabled issues a DB round-trip per call. These writes happen after the
// response is flushed so latency is not the concern; query volume is. A 30s TTL
// mirrors compass/flags.ts:9 and keeps this to at most two reads a minute.

const FLAG_TTL_MS = 30_000;
let _flagCache: { value: boolean; at: number } | null = null;

/** Invalidate the flag cache. Exported for tests. */
export function invalidateServeLogFlagCache(): void {
  _flagCache = null;
}

async function serveLogEnabled(sc: any): Promise<boolean> {
  if (_flagCache && Date.now() - _flagCache.at < FLAG_TTL_MS) {
    return _flagCache.value;
  }
  const value = await isFlagEnabled(sc, DISCOVERY_SERVE_LOG_FLAG);
  _flagCache = { value, at: Date.now() };
  return value;
}

/**
 * Map a DiscoveryPlace id to an `item_kind` the CHECK constraint accepts.
 *
 * rank_events.item_kind is CHECK (item_kind IN ('post','event','plan','buddy',
 * 'place','gem')) — 0153_add_rank_events.sql:18. Discovery ids are either
 * "db/<uuid>" for curated DB places or an OSM element string such as
 * "node/12345678". This mirrors the mapping the cold path already uses at
 * routes/discovery.ts:1329 so both paths classify a given place identically.
 */
function itemKindFor(id: string): "gem" | "place" {
  return id.startsWith("db/") ? "gem" : "place";
}

/**
 * Write one `impression` row per served item.
 *
 * Fire-and-forget: call WITHOUT `await`, and only AFTER the response has been
 * sent. Never throws.
 */
export async function logDiscoveryServe(
  sc:     any,
  params: DiscoveryServeLogParams,
): Promise<void> {
  // Declared OUTSIDE the try so the catch can see it, and LOCAL rather than
  // module-level because several serves are in flight at once — a module-level
  // counter would be clobbered by an interleaved call and attribute one serve's
  // item count to another's throw.
  let attemptedItems = 0;
  try {
    if (!sc) return;
    const { userId, servePoint, items, route, sessionId, context, reasonCodesById } = params;  const servedAtIn = params.servedAt;
    if (!userId || items.length === 0) return void (await logDiscoveryServeRequestOnly(sc, params));  // DV-06 / §48 — an anonymous serve, or a serve of nothing, writes NO rank_events row (user_id is NOT NULL; there is no item) but is still a REQUEST: one public.recommendations row, see the foot of this file.

    if (!(await serveLogEnabled(sc))) return;

    const servedAt = canonicalServedAt(servedAtIn ?? new Date().toISOString());
    // One session id for the whole batch — mirrors the "single open" semantics
    // callers rely on for funnel reconstruction (lib/rankLog.ts:97-100).
    const effectiveSessionId = sessionId ?? randomUUID(), serveId = serveIdFor({ userId, sessionId: effectiveSessionId, servedAt });  // DV-06 — the per-REQUEST id every row of this serve carries

    // `04` §3 "privacy-classified", enforced before anything is built. Done
    // ONCE per batch rather than per row: the context is one object shared by
    // every row of the serve, and classifying it per item would re-derive the
    // same answer N times and log the same warning N times.
    const classified = classifyServeContext(context), screened = screenFeaturesForStorage(classified.kept);  // DV-39 — a key no class covers is REFUSED, not stored
    if (classified.dropped.length > 0 || screened.refused.length > 0) {
      // Same rule as the insert-rejection branch below: a refusal nobody can
      // see is how a defect survives. Key NAMES only — the values are the thing
      // being withheld, and a warning that printed them would be the leak.
      logger.warn(
        { servePoint, route, droppedKeys: classified.dropped, refusedKeys: screened.refused },
        "discoveryServeLog: precise-location or unclassified keys withheld from features (04 §12, §3)",
      );
    }

    const rows = items.map((item, idx) => ({
      user_id:    userId,
      item_id:    item.id,
      item_kind:  item.kind !== undefined ? item.kind : itemKindFor(item.id),
      position:   idx,  ...(recommendationIdSchemaAbsent() ? {} : { recommendation_id: recommendationIdFor({ userId, sessionId: effectiveSessionId, servedAt, surface: "discovery", position: idx, itemId: item.id }), schema_version: DISCOVERY_EVENT_SCHEMA_VERSION, privacy_class: DISCOVERY_EVENT_PRIVACY_CLASS }),  // DV-38/DV-39 (§48): 2890's two columns are now WRITTEN, not defaulted, and ride the same latch — a database without 2890 answers 42703/PGRST204 exactly as one without 2891 does, and the legacy retry below omits all three. `04` §5 / census DV-40, DV-46, DSV2-12 — 2891's COLUMN, carrying exactly the token features.recommendationId carries below. A token in a jsonb key is a VALUE; a token in a column is a JOIN KEY that an index can arbitrate. 2891 was applied to portava-ci and to production on 2026-09-14, and that deployment record measured what a column with no writer is worth: "rows carrying a recommendation_id — 0". features.recommendationId is KEPT rather than moved, because every row written before this line carries it there and routes/rankEvents.ts reads column -> features -> derived in that order. The conditional spread is the same idiom routes/rankEvents.ts uses at its two update sites: once the latch says 2891 is absent here, the column is OMITTED from the payload rather than sent and retried, so the failed round-trip is paid once per process and not once per serve.
      features: {
        servePoint,
        route:  route ?? "GET /discovery",
        // Whether a ranker ran during THIS request. Serve point 4 replays a
        // stored Compass order and is deliberately `false`: the order came from
        // a ranker, but not from this request.
        rankedInRequest: RANKED_IN_REQUEST.has(servePoint),
        ...screened.kept,
        // `04` §5 — placed AFTER the context spread ON PURPOSE. These three are
        // the record, not decoration: a caller passing a `context` key of the
        // same name must not be able to overwrite the denominator with its own
        // value, and putting them first would let it.
        recommendationId: recommendationIdFor({
          userId, sessionId: effectiveSessionId, servedAt,
          surface: "discovery", position: idx, itemId: item.id,
        }),
        modelVersion: DISCOVERY_MODEL_VERSION,
        reasonCodes: reasonCodesById?.[item.id] ?? [],
        // `04` §3's last two properties, after the context spread for the same
        // reason the three above are: a caller must not be able to restate
        // which shape wrote the row or what class it belongs to.
        schemaVersion: DISCOVERY_EVENT_SCHEMA_VERSION,
        privacyClass: DISCOVERY_EVENT_PRIVACY_CLASS, serveId, servedCount: items.length,  // DV-06 — every exposure carries its REQUEST's denominator, not only its own existence
        // Present ONLY when something was withheld, so a present key always
        // means a call site sent a coordinate and an absent one is not an
        // ambiguous silence.
        ...(classified.dropped.length > 0 ? { privacyDropped: classified.dropped } : {}), ...(screened.refused.length > 0 ? { privacyRefused: screened.refused } : {}),
      },
      outcome:    "impression",
      served_at:  servedAt,
      surface:    "discovery",
      session_id: effectiveSessionId,
    }));

    attemptedItems = rows.length; await logDiscoveryServeRequest(sc, { userId, sessionId: effectiveSessionId, servedAt, servePoint, route, items, context: screened.kept });  // DV-06 — this request's own row, before its items'
    const { error } = await sc.from("rank_events").insert(rows);
    // DV-40's degrade path, and it is load-bearing: on a database WITHOUT 2891 the
    // column above is a PGRST204 and EVERY row of this serve is lost, which would
    // make adding a join key cost the telemetry it was added to make joinable. So
    // the batch is redone ONCE in the pre-2891 shape — column omitted, not nulled.
    const settled = error && isMissingRecommendationIdSchema(error) ? await retryServeRowsWithoutToken(sc, rows, { servePoint, route }) : settleReplay(error);  if (!settled.duplicate)  // DV-37 (§48): a REPLAY of this exact serve collides whole on 2891's (recommendation_id, outcome) index and writes nothing — the idempotency guarantee working, so it is neither a rejection nor a second landing, and it moves no denominator.
    recordServeLogOutcome({
      outcome: settled.error ? "rejected" : "landed",
      servedItems: rows.length,
      landedRows: settled.error ? 0 : rows.length,
    });  // `12` stop-condition evidence, recorded ONLY here and ONLY after an insert was actually attempted: a serve that wrote nothing because the flag was off returned above and is not a logging gap — it is the flag doing its job, and counting it would make the stop trip hardest while the feature is disabled.
    if (settled.error) {
      // Deliberately NOT silent — see the module header — and since census-discovery
      // §41.1, deliberately not merely LOUD. A warn is not a measurement, and every
      // writer of this table is fire-and-forget, so a constraint refusing a whole
      // surface reads like a surface nobody uses. COUNTED by the constraint that caused it:
      reportRankEventsRejection(logger, { writer: SERVE_LOG_WRITER, err: settled.error, rows: rows.length, extra: { servePoint, route } });
    } else if (!settled.duplicate) {
      // Exposure denominator — content_distribution_stats.eligible_impressions
      // mirrors the impression rows that landed (lib/rankLog.ts does the same
      // for the ranked writers). Still behind the flag above: with it off there
      // is no insert, so there is no increment either.
      await recordImpressionDistributionStats(sc, rows.map((r) => r.item_id), userId);
    }
  } catch (err) {
    // A throw AFTER the rows were built is an attempt that produced nothing, and
    // it is the failure mode most likely to be invisible: no `error` object, no
    // rejected row, no count anywhere. `attemptedItems` is set immediately before
    // the insert and reset after it, so a throw from anywhere else — the flag
    // read, the client lookup — records nothing and cannot manufacture a gap.
    if (attemptedItems > 0) {
      recordServeLogOutcome({ outcome: "threw", servedItems: attemptedItems, landedRows: 0 });
    }
    logger.warn({ err }, "discoveryServeLog: impression insert threw");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTE ON THE SHAPE OF THIS FILE'S RECENT EDITS
//
// The import at the top of this file and the `recommendation_id` key inside the
// row literal are crammed onto existing lines, which is not this repository's
// style and is not carelessness. ELEVEN anchored doc citations point at fixed
// line numbers here — `:70`, `:415`, `:421`, `:426`, `:430`, `:444`, `:450`,
// `:466`, `:475`, `:477` — across docs/discovery/ROADMAP.md,
// docs/discovery/compliance-v1.md and docs/architecture/census-discovery.md.
// `check:doc-citations` fails an anchor whose text is no longer at its line, and
// the census file is owned by another lane in this pass, so inserting a single
// line above 477 would red a guard with no fix available here.
//
// It is one edit to undo once those citations are re-anchored, and the proposed
// re-anchorings are filed with the census text this change ships with.
//
// DV-37 — HOW THIS WRITER IS IDEMPOTENT WITHOUT AN `ON CONFLICT` (census §48).
// An earlier note here said the write at :444 needed `.upsert(...)` to use
// 2891's index as its arbiter. It does not. Every row of a serve carries the
// token derived from that serve's own coordinates, and a PLAIN multi-row insert
// is one statement: replaying the same serve collides on the UNIQUE
// (recommendation_id, outcome) index and the WHOLE statement is refused 23505,
// writing nothing. That refusal IS the arbitration. `settleReplay` below reads
// it for what it is — a duplicate, not a rejection — so it is not counted as a
// lost write and does not move `eligible_impressions` a second time. A 23505 on
// any other constraint keeps the rejection path.
//
// WHY NOT `.upsert(rows, { onConflict, ignoreDuplicates: true })` — the
// ON CONFLICT DO NOTHING form this note used to propose. It is WEAKER here, and
// the reason is the outcome route: it UPDATES the impression row in place
// (impression → tap), which frees the pair (id, 'impression'). A replay after
// one item was tapped would, under DO NOTHING, skip the untouched rows and
// RE-INSERT the tapped item's impression — a second exposure for one serve,
// exactly the inflation DV-37 exists to prevent. The plain multi-row insert is
// one statement, so the untouched rows' collisions refuse the whole replay and
// the tapped item is not resurrected either (pinned on a real database by
// src/test/db/discoveryTelemetryIdempotency.db.test.ts). The boundary left,
// stated rather than hidden: a replay arriving after EVERY row of the serve
// has moved past 'impression' collides with nothing and would land. The serve
// log is written once, right after the response and before any outcome can
// arrive, and nothing in the tree retries it.
//
// A measured second reason: seventeen route suites fake this write as
// `.insert` and capture it; the property is proved on the harness instead of
// by editing their capture.
// ─────────────────────────────────────────────────────────────────────────────

/** This module's name in the rejection counter and in the schema latch. */
const SERVE_LOG_WRITER = "lib/discoveryServeLog.ts";

/**
 * Redo a refused serve batch in the pre-2891 shape.
 *
 * Called ONLY after `isMissingRecommendationIdSchema` has said that the refusal
 * was 42703 / PGRST204 / 42P10 — "this database has no `recommendation_id`" —
 * and never for a timeout, an RLS denial or a CHECK violation, each of which is
 * a real failure that must keep its own treatment.
 *
 * The column is OMITTED rather than sent as `null`: re-sending it is the same
 * failure a second time, and PostgREST rejects the payload on the key, not the
 * value. The rows are rebuilt as an explicit literal rather than spread-minus-a-
 * key so that `check:write-path-columns` can resolve the column list — a payload
 * the AST cannot read is invisible to the one check that compares a write list
 * against the live schema.
 *
 * Says so ONCE per process, naming the migration, then latches: a line per serve
 * would train a reader out of the one signal that says the migration is missing.
 */
async function retryServeRowsWithoutToken(
  sc:   any,
  rows: readonly any[],
  ctx:  { servePoint: number; route?: string },
): Promise<{ error: unknown; duplicate: boolean }> {
  if (!recommendationIdSchemaAbsent()) {
    logger.warn(
      { ...ctx, migration: "2891_rank_events_recommendation_id.sql" },
      "discoveryServeLog: rank_events.recommendation_id is unavailable — exposures are being " +
      "written WITHOUT a join key, so no outcome can be attributed to a ranking run until " +
      "2891 is applied here",
    );
  }
  noteRecommendationIdAbsent(SERVE_LOG_WRITER);
  const legacy = rows.map((r) => ({
    user_id:    r.user_id,
    item_id:    r.item_id,
    item_kind:  r.item_kind,
    position:   r.position,
    features:   r.features,
    outcome:    r.outcome,
    served_at:  r.served_at,
    surface:    r.surface,
    session_id: r.session_id,
  }));
  const { error } = await sc.from("rank_events").insert(legacy);
  // No token, so nothing for a replay to collide on: never a duplicate.
  return { error, duplicate: false };
}

/**
 * DV-37 — read an insert error for what it is.
 *
 * A 23505 on 2891's exposure index means this exact serve is already written:
 * `error` becomes null and `duplicate` true. Anything else is returned as it
 * came, including a 23505 on some other constraint, which is a real refusal.
 */
function settleReplay(error: unknown): { error: unknown; duplicate: boolean } {
  if (error && isDuplicateExposureReplay(error)) return { error: null, duplicate: true };
  return { error, duplicate: false };
}

// ═════════════════════════════════════════════════════════════════════════════
// DV-06 / DV-40 / §48 — THE PER-REQUEST RECORD (`public.recommendations`, 3376)
// ═════════════════════════════════════════════════════════════════════════════
//
// One row per served Discovery REQUEST, signed-in or anonymous. It is what makes
// a denominator countable per request, and it is the ONLY durable record of an
// anonymous serve: `rank_events.user_id` is NOT NULL, so an anonymous serve
// writes no item rows, and lib/discoveryRecommendationRecord.ts explains why it
// must not. Every item's nine-field record is recoverable from this row
// (`recommendationRecordsFromServeRequest`), with `user_id` null.
//
// Gated on the SAME flag as the item rows. Fire-and-forget: never throws.
// Idempotent: the id is `serveIdFor(exposure)` and the write goes through
// 3376's `record_discovery_serve_request`, an `INSERT … ON CONFLICT (id) DO
// NOTHING` that answers 'written' or 'duplicate' — so a replay writes nothing,
// raises nothing and logs no ERROR in Postgres.
//
// WHY AN RPC AND NOT `.from(...).insert(...)`: the conflict has to be resolved
// by the database, and the function is where ON CONFLICT lives without a
// client-side arbiter. A second, measured reason: seventeen route suites fake
// this client with an `insert` that captures EVERY table into one list and
// assert its length; the per-request row is a different table, and writing it
// through `.rpc` keeps those suites' claims about rank_events exactly as
// strong as they were rather than editing their capture.
//
// DEGRADES, ONCE, WHERE 3376 IS NOT APPLIED. Production has no such function
// until the migration is applied. A missing function (PostgREST PGRST202,
// Postgres 42883) or table (42P01, PGRST205) latches this writer off for the
// life of the process after ONE warning naming the migration — the item rows,
// the older and more important signal, do not depend on it either way.

/** 3376's table, function and file — named in every warning. */
export const SERVE_REQUEST_TABLE = "recommendations";
export const SERVE_REQUEST_RPC = "record_discovery_serve_request";
export const SERVE_REQUEST_MIGRATION = "3376_discovery_recommendations_per_request.sql";

let _serveRequestTable: "unknown" | "absent" = "unknown";
let _serveRequestAbsenceAnnounced = false;

/** Test seam: the latch is process-wide. */
export function _resetServeRequestTableLatch(): void {
  _serveRequestTable = "unknown";
  _serveRequestAbsenceAnnounced = false;
}

/** Is this error "3376 is not on this database" — its function or its table? */
export function isMissingServeRequestTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  const code = String(e?.code ?? "");
  if (code === "42P01" || code === "PGRST205" || code === "PGRST202" || code === "42883") return true;
  const msg = String(e?.message ?? "").toLowerCase();
  return (msg.includes(SERVE_REQUEST_TABLE) || msg.includes(SERVE_REQUEST_RPC))
    && (msg.includes("does not exist") || msg.includes("could not find"));
}

/** The shape one serve hands the per-request writer. */
export interface DiscoveryServeRequestParams {
  /** "" or null ⇔ anonymous. */
  userId:     string | null;
  sessionId:  string;
  servedAt:   string;
  servePoint: DiscoveryServePointId;
  route?:     string;
  items:      readonly ServedItem[];
  /** Already screened context; hashed, never stored. */
  context?:   Record<string, string | number | boolean | null>;
}

/**
 * `10` §3's context_hash: a digest of the SCREENED request context — never a
 * position, never the viewer. Null when there is no context to describe.
 */
export function serveContextHash(context?: Record<string, unknown> | null): string | null {
  if (!context) return null;
  const keys = Object.keys(context).sort();
  if (keys.length === 0) return null;
  const canonical = JSON.stringify(["portava:discovery:context:v1", keys.map((k) => [k, context[k] ?? null])]);
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 22);
}

/** Build the one row. Pure; exported so a test can hold the writer to the table's CHECKs. */
export function buildServeRequestRow(p: DiscoveryServeRequestParams): Record<string, unknown> {
  const userId = p.userId && p.userId.length > 0 ? p.userId : null;
  const servedAt = canonicalServedAt(p.servedAt);
  return {
    id:             serveIdFor({ userId, sessionId: p.sessionId, servedAt }),
    user_id:        userId,
    viewer_class:   userId ? "signed_in" : "anonymous",
    session_id:     p.sessionId,
    surface:        "discovery",
    serve_point:    p.servePoint,
    route:          p.route ?? null,
    model_version:  DISCOVERY_MODEL_VERSION,
    context_hash:   serveContextHash(p.context),
    served_count:   p.items.length,
    item_ids:       p.items.map((i) => String(i.id)),
    item_kinds:     p.items.map((i) => (i.kind !== undefined ? i.kind : itemKindFor(String(i.id))) ?? ""),
    served_at:      servedAt,
    schema_version: DISCOVERY_EVENT_SCHEMA_VERSION,
    privacy_class:  DISCOVERY_EVENT_PRIVACY_CLASS,
  };
}

/**
 * Write the per-request row. Never throws; gated on the serve-log flag.
 * Returns what happened so a test can assert it without reading a log.
 */
export async function logDiscoveryServeRequest(
  sc: any,
  p:  DiscoveryServeRequestParams,
): Promise<"written" | "duplicate" | "rejected" | "absent" | "skipped"> {
  try {
    if (_serveRequestTable === "absent") return "absent";
    if (!sc || typeof sc.rpc !== "function") return "skipped";
    if (!(await serveLogEnabled(sc))) return "skipped";
    const row = buildServeRequestRow(p);
    const { data, error } = await sc.rpc(SERVE_REQUEST_RPC, { p_row: row });
    if (!error) return data === "duplicate" ? "duplicate" : "written";
    if (isMissingServeRequestTable(error)) {
      // Two serves in flight can both reach here before either latches; one
      // line per process is the intent, so the announcement has its own flag.
      if (!_serveRequestAbsenceAnnounced) {
        _serveRequestAbsenceAnnounced = true;
        logger.warn(
          { migration: SERVE_REQUEST_MIGRATION, servePoint: p.servePoint, route: p.route },
          "discoveryServeLog: public.recommendations is unavailable — per-request denominators and " +
          "every ANONYMOUS serve go unrecorded until 3376 is applied here",
        );
      }
      _serveRequestTable = "absent";
      return "absent";
    }
    reportRankEventsRejection(logger, {
      writer: `${SERVE_LOG_WRITER} → ${SERVE_REQUEST_TABLE}`, err: error, rows: 1,
      extra: { servePoint: p.servePoint, route: p.route },
    });
    return "rejected";
  } catch (err) {
    logger.warn({ err }, "discoveryServeLog: per-request insert threw");
    return "rejected";
  }
}

/**
 * The path for a serve that writes NO item rows: an anonymous caller, or a
 * signed-in serve of nothing. Before §48 this returned without a trace, which
 * is how production's anonymous Discovery traffic left no record at all.
 *
 * The session is the route's own per-request id when it passed one (every
 * Discovery route mints it server-side) and a fresh one otherwise — never
 * anything a client supplied, so two anonymous rows cannot be linked.
 */
async function logDiscoveryServeRequestOnly(sc: any, params: DiscoveryServeLogParams): Promise<void> {
  if (!sc) return;
  const classified = classifyServeContext(params.context);
  await logDiscoveryServeRequest(sc, {
    userId:     params.userId && params.userId.length > 0 ? params.userId : null,
    sessionId:  params.sessionId ?? randomUUID(),
    servedAt:   params.servedAt ?? new Date().toISOString(),
    servePoint: params.servePoint,
    route:      params.route ?? "GET /discovery",
    items:      params.items,
    context:    screenFeaturesForStorage(classified.kept).kept,
  });
}
