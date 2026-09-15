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
import { randomUUID } from "node:crypto";
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
import { DISCOVERY_MODEL_VERSION } from "./discoveryRankProvenance.js";  import { isMissingRecommendationIdSchema, noteRecommendationIdAbsent, recommendationIdSchemaAbsent, reportRankEventsRejection } from "./rankEventsProvenance.js";  /* DV-40 / §41.1. ON ONE LINE ON PURPOSE: eleven anchored doc citations point at fixed line numbers in this file (`:70`, `:415`, `:421`, `:426`, `:430`, `:444`, `:450`, `:466`, `:475`, `:477`), most of them in docs/architecture/census-discovery.md, and check:doc-citations fails an anchor whose text has moved. Inserting a line here would red that guard with no fix available in this lane. See the note at the foot of this file. */

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
    if (!userId || items.length === 0) return;

    if (!(await serveLogEnabled(sc))) return;

    const servedAt = servedAtIn ?? new Date().toISOString();
    // One session id for the whole batch — mirrors the "single open" semantics
    // callers rely on for funnel reconstruction (lib/rankLog.ts:97-100).
    const effectiveSessionId = sessionId ?? randomUUID();

    // `04` §3 "privacy-classified", enforced before anything is built. Done
    // ONCE per batch rather than per row: the context is one object shared by
    // every row of the serve, and classifying it per item would re-derive the
    // same answer N times and log the same warning N times.
    const classified = classifyServeContext(context);
    if (classified.dropped.length > 0) {
      // Same rule as the insert-rejection branch below: a refusal nobody can
      // see is how a defect survives. Key NAMES only — the values are the thing
      // being withheld, and a warning that printed them would be the leak.
      logger.warn(
        { servePoint, route, droppedKeys: classified.dropped },
        "discoveryServeLog: precise-location keys withheld from features (04 §12)",
      );
    }

    const rows = items.map((item, idx) => ({
      user_id:    userId,
      item_id:    item.id,
      item_kind:  item.kind !== undefined ? item.kind : itemKindFor(item.id),
      position:   idx,  ...(recommendationIdSchemaAbsent() ? {} : { recommendation_id: recommendationIdFor({ userId, sessionId: effectiveSessionId, servedAt, surface: "discovery", position: idx, itemId: item.id }) }),  // `04` §5 / census DV-40, DV-46, DSV2-12 — 2891's COLUMN, carrying exactly the token features.recommendationId carries below. A token in a jsonb key is a VALUE; a token in a column is a JOIN KEY that an index can arbitrate. 2891 was applied to portava-ci and to production on 2026-09-14, and that deployment record measured what a column with no writer is worth: "rows carrying a recommendation_id — 0". features.recommendationId is KEPT rather than moved, because every row written before this line carries it there and routes/rankEvents.ts reads column -> features -> derived in that order. The conditional spread is the same idiom routes/rankEvents.ts uses at its two update sites: once the latch says 2891 is absent here, the column is OMITTED from the payload rather than sent and retried, so the failed round-trip is paid once per process and not once per serve.
      features: {
        servePoint,
        route:  route ?? "GET /discovery",
        // Whether a ranker ran during THIS request. Serve point 4 replays a
        // stored Compass order and is deliberately `false`: the order came from
        // a ranker, but not from this request.
        rankedInRequest: RANKED_IN_REQUEST.has(servePoint),
        ...classified.kept,
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
        privacyClass: DISCOVERY_EVENT_PRIVACY_CLASS,
        // Present ONLY when something was withheld, so a present key always
        // means a call site sent a coordinate and an absent one is not an
        // ambiguous silence.
        ...(classified.dropped.length > 0 ? { privacyDropped: classified.dropped } : {}),
      },
      outcome:    "impression",
      served_at:  servedAt,
      surface:    "discovery",
      session_id: effectiveSessionId,
    }));

    attemptedItems = rows.length;
    const { error } = await sc.from("rank_events").insert(rows);
    // DV-40's degrade path, and it is load-bearing: on a database WITHOUT 2891 the
    // column above is a PGRST204 and EVERY row of this serve is lost, which would
    // make adding a join key cost the telemetry it was added to make joinable. So
    // the batch is redone ONCE in the pre-2891 shape — column omitted, not nulled.
    const settled = error && isMissingRecommendationIdSchema(error) ? await retryServeRowsWithoutToken(sc, rows, { servePoint, route }) : { error };
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
    } else {
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
// WHAT COULD NOT BE DONE FOR THE SAME REASON, stated because it is the larger
// half of DV-37 and a reader should not have to infer the gap:
//
//   The write at line 444 is still a plain `.insert(rows)`. 2891's UNIQUE index
//   over (recommendation_id, outcome) is now WRITABLE from here — every row
//   carries the token — but it is not yet the ARBITER, because an `ON CONFLICT`
//   needs `.upsert(rows, { onConflict: ... })` and the anchor at :444 is the
//   literal text `const { error } = await sc.from("rank_even`, which pins both
//   the statement's line AND its first forty-two characters. routes/rankEvents.ts
//   HAS the arbiter on all three of its write paths, so the index has one caller;
//   this writer is the second, and the change is four lines once :444 is free.
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
): Promise<{ error: unknown }> {
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
  return { error };
}
