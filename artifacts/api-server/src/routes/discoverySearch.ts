/**
 * GET /api/discovery/search  — Unified cross-type search
 *
 * Contract defined in lib/api-spec/openapi.yaml (operationId: discoverySearch).
 * Query-param validation uses the generated DiscoverySearchQueryParams Zod schema
 * from @workspace/api-zod, supplemented by a server-side sanitization pass.
 *
 * Privacy rules (server-side, fail-closed):
 *   - Private accounts (is_private=true) the viewer does not follow are
 *     returned as a LOCKED PREVIEW (no avatar/location/matchedReason,
 *     canAccess=false) — never silently excluded, so a private account is
 *     discoverable everywhere or nowhere, matching /api/users/search. See
 *     searchTravelers (lib/inputAssistance/searchCandidates.ts, §70); this line said "excluded entirely", which
 *     the code has not done since the locked-preview contract landed.
 *   - Suspended/banned/deleted accounts excluded (account_status filter).
 *   - Profile-discovery opt-outs excluded (fail-closed on query error).
 *   - Blocked users excluded in both directions; block lookup failure is
 *     fail-closed — the entire search returns empty when block state is unknown.
 *   - Content owner/host account-status verified: events, trips, circles, and
 *     posts from suspended/banned/deleted owners are excluded.
 *   - Private trips/events/circles: only visibility='public' returned.
 *   - Plans: only items from public trips or caller-owned trips returned.
 *   - Moderation-removed content excluded (deleted/cancelled/banned statuses).
 *   - City/country aggregation only reads from active, non-private,
 *     non-blocked profiles so private/blocked signals cannot leak via geo.
 *   - Private fields (email, phone, location coords, safety data, verification)
 *     are never selected or included in any result.
 *   - Age-restricted content: profiles with user_privacy_settings.age_restriction_enabled=true
 *     are excluded entirely (fail-closed). Because viewer age is not available in
 *     the session, the endpoint cannot verify whether the viewer meets the age gate —
 *     so all age-restricted profiles are hidden from discovery. Content owned/hosted by
 *     an age-restricted profile is also excluded (events, trips, circles, posts).
 *     City/country aggregation excludes age-restricted profiles for the same reason.
 *     If the age-restricted set lookup fails, the search returns empty results
 *     (consistent with the block-state fail-closed pattern).
 *
 * Pagination:
 *   - Each per-type query fetches limit+1 rows from DB. hasMore is derived from
 *     overflow (results.length > limit), eliminating false-positive hasMore.
 *   - type=all: FAN_LIMIT=20 per bucket across all 17 types; merged round-robin;
 *     sliced at [offset, offset+limit]; hasMore when pool exceeds offset+limit.
 *
 * actionState per type:
 *   travelers/buddies → { isFollowing: boolean }
 *   events           → { isAttending: boolean }
 *   others           → null
 *
 * Rate limited: 30 req/min per user.
 */

import { Router } from "express";
import { DiscoverySearchQueryParams } from "@workspace/api-zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { checkRateLimit } from "../lib/rateLimit";
import { logger as rootLogger } from "../lib/logger";
import {
  applyAliases,
  matchTier,
  parseTimeIntent,
  parseNearbyIntent,
  type SearchQueryContext,
} from "./discoverySearchHelpers.js";
import type { CanonicalRow } from "../lib/canonicalLocations";
import { buildConsumerProjection } from "../services/passport/PassportConsumerProjections.js";
import { allowDiscoveryPersonCard } from "../services/passport/PassportConsumerAccess.js";
// The one bidirectional, fail-closed block reader (lib/blocks), shared with the
// search platform module and every other people-exposing surface.
import { fetchBlockedSet } from "../lib/blocks.js";
import {
  DiscoveryServePoint,
  searchTypeToItemKind,
} from "../lib/discoveryServeLog.js";
// D11 / `11` §9 — "A failure must not masquerade as success." One vocabulary for
// every Discovery refusal; see lib/discoveryRefusal.ts for why the status stays
// 200 and the refusal rides in the envelope. `logServeUnlessRefused` is
// deliberately used INSTEAD of logDiscoveryServe at the two serve points below:
// a refused response must not reach the exposure denominator.
import {
  discoveryRefusal,
  sendDiscoveryRefusal,
  logServeUnlessRefused,
} from "../lib/discoveryRefusal.js";
// census-discovery §70 (A08): search candidate generation — every per-type
// searcher, `dispatchSearch` and the `type=all` fan-out — is the platform
// layer's (lib/inputAssistance/searchCandidates.ts), which the input-assistance
// gateway imports too. This file is the Discovery routes over it.
import {
  FAN_SOURCES,
  searchAll,
  decodeCursor,
  encodeCursor,
  dispatchSearch,
  dispatchSearchWithCoverage,
  fetchAgeRestrictedSet,
  sanitizeQuery,
  canonicalToCityResult,
  mergeCitySuggestions,
  type SearchResult,
  type SearchType,
} from "../lib/inputAssistance/searchCandidates.js";

const router = Router();
const logger = rootLogger.child({ route: "discoverySearch" });

// ── Route handler ─────────────────────────────────────────────────────────────

router.get("/discovery/search", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  // Explicit presence check: zod.coerce.string() converts undefined to "undefined"
  // so we must guard before passing to the generated schema.
  if (req.query.q === undefined) {
    sendError(res, "invalid_payload", "q is required");
    return;
  }

  // Generated Zod validation (from @workspace/api-zod, derived from openapi.yaml)
  const parsed = DiscoverySearchQueryParams.safeParse({
    q:      req.query.q,
    type:   req.query.type,
    limit:  req.query.limit,
    cursor: req.query.cursor,
  });

  if (!parsed.success) {
    const first = parsed.error.errors[0];
    sendError(res, "invalid_payload", first?.message ?? "Invalid search parameters");
    return;
  }

  // Strip leading @ for handle-specific searches (e.g. @alice → alice)
  const rawQ = parsed.data.q;
  const isHandleQuery = rawQ.startsWith("@");
  const qAfterHandle = isHandleQuery ? rawQ.slice(1) : rawQ;

  // D-W10-S1-1 (§80, B02): the platform's emoji strip, then aliases, then sanitization
  let q = applyAliases(stripEmoji(qAfterHandle));
  // Apply PostgREST injection sanitization on top of Zod validation
  q = sanitizeQuery(q);
  if (q.length < 2) {
    sendError(res, "invalid_payload", "q must be at least 2 characters after sanitization");
    return;
  }

  // Parse optional location params — forwarded by the client only when permission is granted
  const rawLat = parseFloat(String(req.query.lat ?? ""));
  const rawLng = parseFloat(String(req.query.lng ?? ""));
  const lat = Number.isFinite(rawLat) && rawLat >= -90  && rawLat <= 90  ? rawLat : null;
  const lng = Number.isFinite(rawLng) && rawLng >= -180 && rawLng <= 180 ? rawLng : null;
  const tz  = typeof req.query.tz  === "string" && req.query.tz.length  <= 50 ? req.query.tz  : null;
  // Human-readable city name — mobile passes this alongside lat/lng for city-level boosting
  // of content types that have city text (events, travelers) but no lat/lng coordinate column.
  const userCity = typeof req.query.city === "string" && req.query.city.trim().length > 0
    ? req.query.city.trim().slice(0, 100) : null;

  // Parse proximity intent ("nearby", "near me") — strip it and flag ctx
  const nearbyResult = parseNearbyIntent(q);
  const qAfterNearby = nearbyResult.nearbyIntent
    ? (nearbyResult.strippedQuery.trim().length >= 2 ? nearbyResult.strippedQuery : q)
    : q;

  // Parse time intent — strip time keywords and derive UTC date bounds for events/trips
  const timeIntentResult = parseTimeIntent(qAfterNearby, tz);
  // Only use stripped query when it still meets the min-length requirement
  const effectiveQ = timeIntentResult.strippedQuery.trim().length >= 2
    ? timeIntentResult.strippedQuery
    : qAfterNearby;

  // Resolve the response timeLabel: nearby takes precedence over time intents for display
  const displayLabel = nearbyResult.nearbyIntent
    ? (lat !== null && lng !== null ? "Nearby" : "Nearby (enable location)")
    : (timeIntentResult.intent?.label ?? null);

  // ── Intent-boost params — forwarded by the mobile client's parseSearchIntent() ──
  // These are soft hints: they guide ranking and type-promotion, not hard exclusion.
  const VALID_INTENT_CATS = new Set(["nightlife", "food", "beach", "adventure", "culture"]);
  const VALID_INTENT_SOCIAL = new Set(["solo", "group", "crew"]);
  const rawIntentCat      = typeof req.query.intentCategory     === "string" ? req.query.intentCategory.trim()     : null;
  const rawIntentSocial   = typeof req.query.intentSocial       === "string" ? req.query.intentSocial.trim()       : null;
  const rawIntentBudget   = typeof req.query.intentBudget       === "string" ? req.query.intentBudget.trim()       : null;
  const rawIntentSafety   = typeof req.query.intentSafety       === "string" ? req.query.intentSafety.trim()       : null;
  const rawIntentLocHint  = typeof req.query.intentLocationHint === "string" ? req.query.intentLocationHint.trim() : null;

  // Trips §7.3 (TR133): a trip in context, for the event results. UUID or nothing.
  const rawTripId = typeof req.query.tripId === "string" ? req.query.tripId.trim() : "";
  const ctxTripId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawTripId) ? rawTripId : null;

  const ctx: SearchQueryContext = {
    tripId: ctxTripId,
    lat,
    lng,
    tz,
    startsAfter:         timeIntentResult.intent?.startsAfter  ?? null,
    startsBefore:        timeIntentResult.intent?.startsBefore ?? null,
    timeLabel:           displayLabel,
    nearbyIntent:        nearbyResult.nearbyIntent,
    userCity:            userCity ?? null,
    intentCategory:      rawIntentCat    && VALID_INTENT_CATS.has(rawIntentCat)      ? rawIntentCat    : null,
    intentSocial:        rawIntentSocial && VALID_INTENT_SOCIAL.has(rawIntentSocial) ? rawIntentSocial : null,
    intentBudget:        rawIntentBudget === "budget" ? "budget" : null,
    intentSafety:        rawIntentSafety === "true"   ? "true"   : null,
    intentLocationHint:  rawIntentLocHint && rawIntentLocHint.length <= 100 ? rawIntentLocHint : null,
  };

  const type = (parsed.data.type ?? "all") as SearchType;
  const limit = parsed.data.limit ?? 20;
  const cursor = parsed.data.cursor;

  // Rate limit: 30 req/min per user
  const rl = checkRateLimit("discovery_search", user.id, 30, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many search requests. Please wait and try again.");
    return;
  }

  const offset = decodeCursor(cursor);

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  try {
    // Fail-closed: unknown block or age-restriction state → serve NOTHING, never
    // leak content. `fetchBlockedSet` returns null for "could not be read", not
    // for "there are none", and the two must not be confused.
    //
    // D11: the fail-closed DIRECTION was always right and is unchanged. What was
    // wrong is that it was SILENT — the per-type search functions collapse a null
    // set to [], so a transient blocks-table failure left this route answering
    // `200 { results: [] }`, the same body it gives a query that genuinely
    // matches nothing. The read is refused explicitly now, so the caller is told
    // the difference instead of being handed a search result that is not one.
    const [blockedSet, ageRestrictedSet] = await Promise.all([
      fetchBlockedSet(sc, user.id),
      fetchAgeRestrictedSet(sc),
    ]);
    if (!blockedSet || !ageRestrictedSet) {
      sendDiscoveryRefusal(
        res,
        { results: [], nextCursor: null, hasMore: false, query: effectiveQ, type, timeLabel: ctx.timeLabel },
        discoveryRefusal("transient_db", "visibility_state_unreadable", "GET /discovery/search"),
      );
      return;
    }

    // Stage 0b — serve point 8. Search ranks nothing and logs nothing today; a
    // grep of this file for rankCandidates / rankItemsForDiscovery /
    // drsRankItems / logImpression returns nothing at all.
    const exposure = mintServeExposure(user.id), logSearchServe = (results: SearchResult[]) => {
      logServeUnlessRefused(res, sc, {
        userId: user.id, sessionId: exposure.sessionId, servedAt: exposure.servedAt,
        servePoint: DiscoveryServePoint.SEARCH,
        route: "GET /discovery/search",
        items: results.map((r) => ({ id: r.id, kind: searchTypeToItemKind(r.type) })),
        context: { type, offset, resultCount: results.length },
      });
    };

    if (type === "all") {
      const { results, hasMore, nextCursor, unreadableSources } =
        await protectSearchPage(sc, await searchAll(sc, effectiveQ, user.id, blockedSet, ageRestrictedSet, offset, limit, ctx));
      const body = { results: stampServedRecommendations(results, exposure), nextCursor, hasMore, query: effectiveQ, type, timeLabel: ctx.timeLabel };
      if (unreadableSources.length > 0) {
        // "partial" as long as ANY source answered, even when this page happens
        // to be empty: the buckets that were read are a real result, and their
        // emptiness is trustworthy. Only a fan-out where every source failed
        // carries "nothing" — an empty collection that is empty BECAUSE of the
        // failure, which is what that word means. `failedSources` says which
        // absences are not evidence of absence.
        sendDiscoveryRefusal(
          res,
          body,
          discoveryRefusal(
            "transient_db", "search_sources_unreadable", "GET /discovery/search",
            unreadableSources.length === FAN_SOURCES.length ? "nothing" : "partial",
            unreadableSources,
          ),
        );
      } else {
        res.status(200).json(body);
      }
      // Not suppressed on a partial: those items really were served, and
      // dropping them would under-count exposure — see logServeUnlessRefused.
      logSearchServe(results);
    } else {
      // Fetch limit+1 to detect hasMore without false positives
      const fetchLimit = limit + 1;
      const { results: raw, degradedSources } =
        await dispatchSearchWithCoverage(sc, effectiveQ, user.id, blockedSet, ageRestrictedSet, type, offset, fetchLimit, ctx);
      const hasMore = raw.length > limit;
      const results = await protectSearchResults(sc, raw.slice(0, limit));
      const nextCursor = hasMore ? encodeCursor(offset + limit) : null;
      const body = { results: stampServedRecommendations(results, exposure), nextCursor, hasMore, query: effectiveQ, type, timeLabel: ctx.timeLabel };
      if (degradedSources.length > 0) {
        // INTRA-TYPE PARTIAL. The `type=all` branch above has carried this since
        // 2026-09-14 for a whole bucket that failed; this is the same statement
        // one level down, for a table that failed INSIDE a bucket.
        //
        // `saved` is why it exists and is the only type that can reach it today:
        // its rows come from `wishlist_places` and `discovery_place_saves`, two
        // tables written by two paths that never write each other's, so one can
        // fail while the other answers. Before this, that answered
        // `200 { results: [...] }` with no `refusal` — a SHORT shelf presented
        // as a WHOLE one, on the single search heading whose contents the person
        // knows for a fact, because they are their own saves. Silence there is
        // not a small defect: it is the `11` §9 masquerade with some rows in
        // front of it, which is harder to notice than the empty version.
        //
        // "partial", never "nothing": rows WERE served and they are real.
        // Refusing whole here would be the untruth in the opposite direction,
        // and the total-outage case already has its own throw in `searchSaved`.
        sendDiscoveryRefusal(
          res,
          body,
          discoveryRefusal(
            "transient_db", "search_sources_unreadable", "GET /discovery/search",
            "partial", degradedSources,
          ),
        );
      } else {
        res.status(200).json(body);
      }
      // Not suppressed on a partial, for the same reason the `all` branch is
      // not: those items really were served, and dropping them from the serve
      // log would under-count exposure.
      logSearchServe(results);
    }
  } catch (err) {
    logger.warn({ err, q: effectiveQ, type }, "discovery/search failed");
    // D11 / `11` §9. Same body as before plus the one key that tells the caller
    // this is a failure and not a search that found nothing.
    sendDiscoveryRefusal(
      res,
      { results: [], nextCursor: null, hasMore: false, query: effectiveQ, type, timeLabel: null },
      discoveryRefusal("transient_db", "search_failed", "GET /discovery/search"),
    );
  }
});

// ── GET /api/discovery/suggest — grouped live typeahead ──────────────────────
//
// Lightweight sibling of /discovery/search for as-you-type assistance.
// Reuses dispatchSearch (same per-type query + privacy + ranking code paths —
// deliberately NOT a parallel search implementation) with small per-type
// limits, then merges canonical-location city suggestions so location rows
// normalize to the canonical registry instead of raw profile text.
//
// Groups are ordered by best match tier (exact > prefix > contains) so the
// group containing an exact hit surfaces first; ties keep the plan order
// below. Fail-soft: any internal error returns empty groups with 200 —
// typeahead must never surface an error state mid-keystroke.

const SUGGEST_PLAN: Array<{ type: Exclude<SearchType, "all">; label: string; limit: number }> = [
  { type: "travelers",   label: "Travelers",  limit: 4 },
  { type: "cities",      label: "Cities",     limit: 4 },
  { type: "hidden_gems", label: "Gems",       limit: 3 },
  { type: "events",      label: "Events",     limit: 3 },
  { type: "trips",       label: "Trips",      limit: 3 },
  { type: "buddies",     label: "Buddies",    limit: 3 },
  { type: "places",      label: "Places",     limit: 3 },
  { type: "hashtags",    label: "Hashtags",   limit: 3 },
  { type: "posts",       label: "Posts",      limit: 2 },
  { type: "stamps",      label: "Stamps",     limit: 2 },
  { type: "circles",     label: "Circles",    limit: 2 },
  { type: "plans",       label: "Plans",      limit: 2 },
  { type: "activities",  label: "Activities", limit: 2 },
  { type: "countries",   label: "Countries",  limit: 2 },
];

const MAX_SUGGEST_GROUPS = 8;

export interface SuggestGroupPayload {
  type: Exclude<SearchType, "all">;
  label: string;
  items: SearchResult[];
}

/**
 * Order groups so the one holding the best match leads. matchTier is
 * higher-is-better (3 exact > 2 prefix > 1 substring > 0 none), so groups
 * sort by descending best tier. Stable: equal best tiers keep SUGGEST_PLAN
 * order.
 */
export function orderSuggestGroups(
  groups: SuggestGroupPayload[],
  q: string,
): SuggestGroupPayload[] {
  return groups
    .map((g, i) => ({
      g,
      i,
      tier: g.items.length
        ? Math.max(...g.items.map((it) => matchTier(it.title, q, it.subtitle)))
        : -1,
    }))
    .sort((a, b) => (b.tier - a.tier) || (a.i - b.i))
    .map((x) => x.g);
}

router.get("/discovery/suggest", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const rawInput = typeof req.query.q === "string" ? req.query.q : "";
  // @handle queries suggest people only, mirroring /discovery/search behavior
  const isHandleQuery = rawInput.startsWith("@");
  const q = sanitizeQuery(applyAliases(stripEmoji(isHandleQuery ? rawInput.slice(1) : rawInput))).slice(0, 80);
  if (q.length < 2) {
    // `11` §9 class 1, VALIDATION — and the one place in this lane where a
    // validation refusal is NOT a 4xx. This fires on every keystroke of a
    // typeahead; a 400 here would turn normal typing into a stream of client
    // errors, and the input is not invalid, it is merely not yet enough. So the
    // 200 stays and the refusal names why the groups are empty. Contrast
    // /discovery/search, whose `q` is a required parameter and whose
    // `invalid_payload` 400 is left exactly as it is.
    sendDiscoveryRefusal(
      res,
      { query: q, groups: [] },
      discoveryRefusal("validation", "query_too_short", "GET /discovery/suggest"),
    );
    return;
  }

  // Separate bucket from discovery_search: typeahead legitimately fires more
  // often (client debounces at 250ms and caches, but fast typists still burst).
  const rl = checkRateLimit("discovery_suggest", user.id, 90, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many suggestion requests. Please wait.");
    return;
  }

  const latRaw = parseFloat(String(req.query.lat));
  const lat = Number.isFinite(latRaw) && Math.abs(latRaw) <= 90 ? latRaw : null;
  const lngRaw = parseFloat(String(req.query.lng));
  const lng = Number.isFinite(lngRaw) && Math.abs(lngRaw) <= 180 ? lngRaw : null;
  const city = typeof req.query.city === "string"
    ? (sanitizeQuery(req.query.city).slice(0, 100) || null)
    : null;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  try {
    // Fail-closed: if block/age-restriction state is unknown, return no
    // suggestions at all — including canonical city rows — rather than
    // guessing. (The per-type search functions would already collapse to []
    // on null sets; the early return keeps canonical merging equally strict.)
    const [blockedSet, ageRestrictedSet] = await Promise.all([
      fetchBlockedSet(sc, user.id),
      fetchAgeRestrictedSet(sc),
    ]);
    if (!blockedSet || !ageRestrictedSet) {
      // D11: the early return and its fail-closed direction are unchanged; only
      // the silence is fixed. This body used to be byte-identical to the two
      // others this route can send (too-short query, and the catch below), which
      // is the row C14 certified as correct and the owner's D11 ruling
      // supersedes.
      sendDiscoveryRefusal(
        res,
        { query: q, groups: [] },
        discoveryRefusal("transient_db", "visibility_state_unreadable", "GET /discovery/suggest"),
      );
      return;
    }

    const ctx: SearchQueryContext = { lat, lng, userCity: city, nearbyIntent: false };
    const plan = isHandleQuery
      ? SUGGEST_PLAN.filter((p) => p.type === "travelers" || p.type === "buddies")
      : SUGGEST_PLAN;

    // The same back door `searchAll` had: a REJECTED type became an empty group,
    // indistinguishable from a type that was read and matched nothing, so a
    // typeahead could lose a whole category to an outage and say nothing about
    // it. Collected by PLAN INDEX rather than pushed, so the names come out in
    // plan order however the parallel reads finish.
    const unreadableAt = new Array<string | null>(plan.length).fill(null);
    const [typedResults, canonicalRows] = await Promise.all([
      Promise.all(plan.map((p, i) =>
        dispatchSearch(sc, q, user.id, blockedSet, ageRestrictedSet, p.type, 0, p.limit, ctx)
          .catch((err: unknown) => {
            logger.warn({ err, type: p.type, q }, "discovery/suggest: type unreadable");
            unreadableAt[i] = p.type;
            return [] as SearchResult[];
          }),
      )),
      isHandleQuery
        ? Promise.resolve([] as CanonicalRow[])
        : readCanonicalCitySuggestions(sc, q, 4),
    ]);

    // Cross-group dedupe by entity id: a profile must not appear in both
    // Travelers and Buddies; a discovery_place must not appear in both
    // Places and Activities. First group in plan order wins.
    const seenIds = new Set<string>();
    const groups: SuggestGroupPayload[] = [];
    plan.forEach((p, i) => {
      let items = typedResults[i] ?? [];
      if (p.type === "cities") {
        items = mergeCitySuggestions(canonicalRows.map(canonicalToCityResult), items, p.limit);
      }
      items = items.filter((it) => {
        if (seenIds.has(it.id)) return false;
        seenIds.add(it.id);
        return true;
      }).slice(0, p.limit);
      if (items.length > 0) groups.push({ type: p.type, label: p.label, items });
    });

    const servedGroups = orderSuggestGroups(await protectSuggestGroups(sc, groups), q).slice(0, MAX_SUGGEST_GROUPS);
    const unreadableTypes = unreadableAt.filter((t): t is string => t !== null);
    const exposure = mintServeExposure(user.id), body = { query: q, groups: stampSuggestGroupsServed(servedGroups, exposure) };
    if (unreadableTypes.length > 0) {
      // "partial" while ANY type answered: those groups are real, and
      // `useSearchSuggestions` renders and caches a partial for exactly that
      // reason while refusing to cache a "nothing". Only a fan-out where every
      // type failed carries "nothing".
      sendDiscoveryRefusal(
        res,
        body,
        discoveryRefusal(
          "transient_db", "suggest_sources_unreadable", "GET /discovery/suggest",
          unreadableTypes.length === plan.length ? "nothing" : "partial",
          [...unreadableTypes, ...canonicalFoldFailures(canonicalRows)],
        ),
      );
    } else if (!sendCanonicalFoldDegraded(res, body, canonicalRows)) {
      res.status(200).json(body);
    }
    // Stage 0b — serve point 9. Flattened in the order the groups are served,
    // so `position` reflects what the user actually saw top to bottom.
    logServeUnlessRefused(res, sc, {
      userId: user.id, sessionId: exposure.sessionId, servedAt: exposure.servedAt,
      servePoint: DiscoveryServePoint.SUGGEST,
      route: "GET /discovery/suggest",
      items: servedGroups.flatMap((g) =>
        g.items.map((it) => ({ id: it.id, kind: searchTypeToItemKind(g.type) })),
      ),
      context: { groupCount: servedGroups.length },
    });
  } catch (err) {
    logger.warn({ err, q }, "discovery/suggest failed");
    sendDiscoveryRefusal(
      res,
      { query: q, groups: [] },
      discoveryRefusal("transient_db", "suggest_failed", "GET /discovery/suggest"),
    );
  }
});

// ── GET /api/discovery/people/:userId/passport ────────────────────────────────
//
// §21 TABLE 22, Discovery row: "identity, verification, availability, Open to
// Plans, shared context, permitted trust summary". That is the discovery_card
// variant verbatim, so this route builds NOTHING — it authorises the request and
// returns what the one Passport assembler produced for this viewer (§35).
//
// The search list above ranks people; this is the card one of those rows opens.
// The two agree by construction: the same subject the list withholds
// (`allow_profile_discovery = false`, or age-restricted) is refused here by the
// shared gate, and blocking / account status are settled inside the assembler,
// which answers a blocked relationship with the variant's restricted shape
// rather than a 404 — the client must not be able to tell "blocked" from
// "does not exist" by the status code.
router.get("/discovery/people/:userId/passport", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { userId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    sendError(res, "invalid_payload", "Invalid user id");
    return;
  }

  const rl = checkRateLimit("discovery_person_card", user.id, 60, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many requests. Please wait.");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const gate = await withDiscoveryInvisibleGate(sc, userId, user.id, await allowDiscoveryPersonCard(sc, userId)); // §53 A24 — the shared gate, then Invisible for every viewer but the subject (lib/discoveryPeoplePrivacy.ts)
  if (!gate.allowed) { if (gate.reason === "check_failed") sendError(res, "degraded_unavailable", "Could not establish whether this person is discoverable. Please try again."); else sendError(res, "not_found", "User not found"); return; }

  try {
    const passport = await buildConsumerProjection(sc, "discovery_card", userId, user.id);
    if (!passport) { sendError(res, "not_found", "User not found"); return; }
    res.status(200).json({ passport });
  } catch (err) {
    logger.warn({ err, userId }, "discovery person card projection failed");
    sendError(res, "db_error", "Could not load person card");
  }
});

export default router;

// ── Re-exports (census-discovery §70) ─────────────────────────────────────────
// Everything this file exported before the move, unchanged in name and
// identity: each is the platform module's own binding, not a copy
// (searchPlatformBoundary.test.ts B3 pins that).
export {
  sanitizeQuery,
  GEM_SEARCHABLE_STATUSES,
  gemSearchPosition,
  fetchBlockedSet,
  fetchAgeRestrictedSet,
  DISCOVERY_BUDDY_LAUNCH_GATE_FLAG,
  invalidateBuddyLaunchGateCache,
  buddiesWithheldByLaunchGate,
  dispatchSearch,
  dispatchSearchWithCoverage,
  canonicalToCityResult,
  mergeCitySuggestions,
  DiscoverySearchReadError,
} from "../lib/inputAssistance/searchCandidates.js";
export type {
  SearchType,
  SearchResult,
  GemSearchPosition,
  DispatchCoverage,
} from "../lib/inputAssistance/searchCandidates.js";

// ─────────────────────────────────────────────────────────────────────────────
// census-discovery §46 — B01, B04 and DV-40's serve points 8 and 9.
//
// IMPORTED HERE, AT THE END OF THE FILE, for the reason the block above gives:
// this file carries anchored citations from several censuses, and an import
// added at the top would move every one of them. ES import declarations are
// hoisted, so where they are written is a reading matter and nothing else.
// Each call site above is an in-place edit of an existing line.
//
//   B01 — the stored diacritic fold (migration 2220's `search_key`) is what
//         the suggest Cities group and the centroid lookup match on now, with a
//         named, partial degrade where the column is absent.
//   B04 — §24's protected-place gate runs over every served position, behind
//         `discovery_search_protected_zones_enabled` (3366, seeded FALSE).
//   DV-40 — one exposure per request; every served item carries the
//         `recommendationId` the serve log writes for it.
// ─────────────────────────────────────────────────────────────────────────────
import {
  canonicalFoldFailures,
  readCanonicalCitySuggestions,
  sendCanonicalFoldDegraded,
} from "../lib/discoverySearchCanonical.js";
import { protectSearchPage, protectSearchResults, protectSuggestGroups } from "../lib/discoverySearchProtection.js";
import { mintServeExposure, stampServedRecommendations } from "../lib/discoveryRecommendationRecord.js";
import { stampSuggestGroupsServed } from "../lib/discoverySearchExposure.js";

// ─────────────────────────────────────────────────────────────────────────────
// census-discovery §53 — the person card's gate (A24, Invisible mode).
//
// The other §53 call sites (searchTravelers' opt-out read and buddy
// eligibility, B03 and D11) moved with searchTravelers to
// lib/inputAssistance/searchCandidates.ts in §70, and their imports with them.
// ─────────────────────────────────────────────────────────────────────────────
import { withDiscoveryInvisibleGate } from "../lib/discoveryPeoplePrivacy.js";

// ─────────────────────────────────────────────────────────────────────────────
// census-discovery §80 — B02 (register D-W10-S1-1). Discovery's search key takes
// the shared platform's field-context emoji rule: `global_search` is a lookup
// field, so an emoji is stripped from the KEY (never from what the user sees),
// by the same function the input gateway uses. Applied at the two edits above.
// ─────────────────────────────────────────────────────────────────────────────
import { stripEmoji } from "../lib/inputAssistance/queryNormalizer.js";
