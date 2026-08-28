/**
 * Compass API routes
 *
 * GET /api/compass/me/context
 *   Returns the calling user's current Compass context state, resolved intent mode,
 *   and a safe public subset of their Compass profile.
 *   Auth required. Gated by COMPASS_ENABLED flag.
 *
 * GET /api/compass/feed
 *   Returns the first page of all Compass sections.
 *   Auth required. Gated by COMPASS_ENABLED and COMPASS_FEED_ENABLED flags.
 *   Query params:
 *     cursor   — base64url pagination cursor from a previous response
 *
 * GET /api/compass/feed/section/:section
 *   Returns a single named section.
 *   Auth required. Gated by COMPASS_ENABLED.
 *   Query params:
 *     cursor   — pagination cursor
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError, canEditPlan, isAcceptedTripMember } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import { isCompassEnabled, isEnabled } from "../compass/flags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { getCompassProfile } from "../compass/CompassProfileService.js";
import { logCompassImpression } from "../lib/rankLog.js";
import { buildCompassContext, defaultSignals } from "../compass/CompassContextEngine.js";
import { resolveLocalHour, parseTzOffsetParam } from "../lib/localTime.js";
import { timeOfDayForHour } from "./compassHome.js";
import { deriveIntentMode } from "../compass/CompassIntentModeEngine.js";
import { wrapUgc } from "../compass/CompassStructuredContext.js";
import {
  buildStructuredCompassContext,
  formatStructuredContextLines,
  buildModeWeightingLines,
} from "../compass/CompassStructuredContext.js";
import { buildDestinationContextLines } from "../compass/CompassGraphEngine.js";
import { buildFeed, buildSection, SECTION_NAMES, type SectionName, type FeedPage } from "../compass/CompassFeedBuilder.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hydrateCompassItems } from "../compass/CompassItemHydrator.js";
import {
  buildFrontLoadPayload,
  buildPreloadManifest,
  recordNavigationEvent,
  type NetworkHint,
  type BatteryHint,
} from "../compass/CompassFrontLoadEngine.js";
import { getCachedFeed, setCachedFeed } from "../compass/CompassCacheEngine.js";
import {
  resolveExplanation,
  isSensitiveKey,
  decodeRecommendationToken,
  encodeRecommendationToken,
} from "../compass/CompassExplanationEngine.js";
import { buildWhyThisText, presentableFactors } from "../compass/CompassRecommendationEngine.js";
import {
  processFeedback,
  FEEDBACK_ACTIONS,
  type FeedbackAction,
} from "../compass/CompassFeedbackEngine.js";
import { triggerOnDemandScan } from "../lib/compassAbuseScanScheduler.js";
import type {
  CompassContextResponse,
  CompassFallbackResponse,
  CompassProfilePublic,
} from "../compass/types.js";
import {
  buildFallbackFeed,
  isFallbackModeEnabled,
} from "../compass/CompassFallbackFeedBuilder.js";
import { logSearchNudge } from "../compass/CompassSearchDecayService.js";
import {
  TRIP_SURFACE_TYPES,
  PASSPORT_SURFACE_TYPES,
  passesTripFilter,
  passesPassportFilter,
} from "../compass/CompassSurfaceFilters.js";
import { buildUiBlocks, type CompassUiBlock } from "../compass/CompassUiBlocks.js";
import {
  listMemories,
  teachMemory,
  updateMemory,
  forgetMemory,
  isCircleMember,
  buildMemoryPromptBlock,
  compressConversationIfDue,
  MEMORY_SCOPES,
  type MemoryScope,
} from "../compass/CompassMemoryService.js";
import { buildLiveChatContextLines }             from "../compass/CompassLiveEngine.js";
import { buildTripContextLines }                 from "../compass/CompassTripContext.js";
import { getOpenAI }                             from "../lib/openai.js";
import { COMPASS_ASK_PROMPT, COMPASS_ASK_PROMPT_VERSION } from "../lib/prompts/compass-v1.js";
import {
  getOrCreateConversation,
  loadHistory,
  appendMessage,
  touchConversation,
}                                                from "../services/compass/CompassConversationService.js";
import { classify as classifyIntent, type IntentClassification } from "../services/compass/CompassIntentClassifier.js";
import { getWeatherContext as getWeatherForAsk }  from "../lib/weatherCache.js";
import {
  COMPASS_TOOL_DEFINITIONS,
  COMPASS_TOOLS_PROMPT_ADDENDUM,
  executeCompassTool,
  type AddToTripProposal,
  type ToolExecution,
} from "../compass/CompassTools.js";
import { buildCompassContext as buildLocationCompassContext } from "../services/location/CompassLocationContext.js";

const router = Router();

/* ── Traveler-local hour ─────────────────────────────────────────────────────
 * Time-of-day context must follow the traveler's clock, not the server's.
 * Same resolution as Compass Home (lib/localTime.ts):
 *   client tzOffsetMinutes (query or body) → stored timezone → UTC.
 * Never throws — falls back to the raw UTC hour on any failure.
 */
/* Test hook: the feed response doesn't expose its internal context, so tests
 * observe the last computed feed signals here. */
let _lastFeedContext: { hourUtc: number; contextState: string } | null = null;
export function _getLastFeedContext(): { hourUtc: number; contextState: string } | null {
  return _lastFeedContext;
}

/**
 * Feed/section cache keys must include the client's tz offset so a traveler
 * crossing a time-of-day boundary (or switching timezones) is never served a
 * cached payload built for the previous local-hour bucket. Mirrors
 * compassHome's homeCacheKey, which keys by `tzOffsetMinutes ?? "auto"`.
 *
 * When the client sends NO offset ("auto"), the offset alone can't partition
 * time-of-day: the resolved local hour (from the traveler's stored timezone)
 * may cross a bucket boundary within the cache TTL, briefly serving the
 * previous bucket's styling. So the "auto" path additionally keys by the
 * resolved time-of-day bucket (morning/afternoon/evening/night).
 */
export function feedCacheKey(
  prefix: "feed" | `section:${string}`,
  cursor: string | undefined,
  tzOffsetMinutes: number | null,
  resolvedLocalHour?: number | null,
): string {
  const tzPart =
    tzOffsetMinutes !== null
      ? typeof resolvedLocalHour === "number" && Number.isFinite(resolvedLocalHour)
        ? `${tzOffsetMinutes}-${timeOfDayForHour(resolvedLocalHour)}`
        : String(tzOffsetMinutes)
      : typeof resolvedLocalHour === "number" && Number.isFinite(resolvedLocalHour)
        ? `auto-${timeOfDayForHour(resolvedLocalHour)}`
        : "auto";
  return `${prefix}:tz${tzPart}:${cursor ?? "first_page"}`;
}

function tzOffsetForRequest(req: { query?: unknown; body?: unknown }): number | null {
  try {
    const raw =
      (req.query as any)?.tzOffsetMinutes ?? (req.body as any)?.tzOffsetMinutes;
    return parseTzOffsetParam(raw);
  } catch {
    return null;
  }
}

async function localHourForRequest(
  sc: any,
  userId: string,
  req: { query?: unknown; body?: unknown },
): Promise<number> {
  try {
    const raw =
      (req.query as any)?.tzOffsetMinutes ?? (req.body as any)?.tzOffsetMinutes;
    return await resolveLocalHour(sc, userId, parseTzOffsetParam(raw));
  } catch {
    return new Date().getUTCHours();
  }
}

// ── Feed recommendation enrichment ────────────────────────────────────────────
// Generates HMAC-signed recommendationId tokens for each feed item, adds them
// to the response payload (so the client can call /why), and returns DB rows
// ready for pre-registration in compass_served_recommendations.
//
// Tokens are generated exactly once per item — same token used for both the
// response and the DB write (no double-generation).

export interface RecommendationRow {
  user_id:           string;
  recommendation_id: string;
  explanation_key:   string;
  item_id:           string;
  item_type:         string;
  section_name:      string;
  /** Phase 7 — grounded ranking snapshot { compassMatch, communityScore, factors } */
  ranking_factors:   Record<string, unknown> | null;
}

/** Build the Phase 7 ranking snapshot stored alongside a served recommendation. */
function rankingSnapshot(item: {
  compassMatch?: number;
  communityScore?: number;
  rankingFactors?: unknown[];
}): Record<string, unknown> | null {
  if (typeof item.compassMatch !== "number" && typeof item.communityScore !== "number") return null;
  return {
    compassMatch:   item.compassMatch   ?? null,
    communityScore: item.communityScore ?? null,
    factors:        Array.isArray(item.rankingFactors) ? item.rankingFactors.slice(0, 8) : [],
  };
}

export function enrichFeedWithRecommendationIds(
  userId: string,
  feed:   FeedPage,
): { enrichedFeed: object; registrationRows: RecommendationRow[] } {
  const registrationRows: RecommendationRow[] = [];

  const enrichedSections = feed.sections.map((section) => ({
    ...section,
    items: section.items.map((item) => {
      const token = encodeRecommendationToken({
        userId,
        itemId:         String(item.item.id ?? ""),
        itemType:       String(item.item.type ?? ""),
        sectionName:    item.section,
        explanationKey: item.explanationKey,
      });
      registrationRows.push({
        user_id:           userId,
        recommendation_id: token,
        explanation_key:   item.explanationKey,
        item_id:           String(item.item.id ?? ""),
        item_type:         String(item.item.type ?? ""),
        section_name:      item.section,
        ranking_factors:   rankingSnapshot(item),
      });
      return { ...item, recommendationId: token };
    }),
  }));

  return { enrichedFeed: { ...feed, sections: enrichedSections }, registrationRows: dedupeByRecommendationId(registrationRows) };
}

/**
 * Tokens are deterministic (HMAC over user/item/section/key), so the same item
 * appearing twice in one page yields duplicate recommendation_ids. Postgres
 * rejects an upsert batch containing duplicates of the ON CONFLICT key
 * ("cannot affect row a second time", code 21000) — which would silently drop
 * the WHOLE registration batch. Dedupe before writing.
 */
export function dedupeByRecommendationId(rows: RecommendationRow[]): RecommendationRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.recommendation_id)) return false;
    seen.add(r.recommendation_id);
    return true;
  });
}

// ── Chat uiBlock recommendation enrichment ────────────────────────────────────
// Attaches a signed recommendationToken to every hydrated place/event entity in
// the /api/compass/ask uiBlocks (same HMAC token scheme as the feed), and
// returns registration rows for compass_served_recommendations so chat-card
// "viewed" outcomes attribute to this serving — not just the item id.
// Mutates the blocks in place; deduped rows are ready to upsert.

const CHAT_SECTION_NAME = "compass_chat";

export function enrichUiBlocksWithRecommendationTokens(
  userId: string,
  blocks: CompassUiBlock[],
): RecommendationRow[] {
  const rows: RecommendationRow[] = [];

  const attach = (entity: { id: string; recommendationToken?: string }, itemType: "place" | "event") => {
    if (!entity.id) return;
    if (!entity.recommendationToken) {
      const explanationKey = `${CHAT_SECTION_NAME}:${itemType}`;
      entity.recommendationToken = encodeRecommendationToken({
        userId,
        itemId:         entity.id,
        itemType,
        sectionName:    CHAT_SECTION_NAME,
        explanationKey,
      });
      rows.push({
        user_id:           userId,
        recommendation_id: entity.recommendationToken,
        explanation_key:   explanationKey,
        item_id:           entity.id,
        item_type:         itemType,
        section_name:      CHAT_SECTION_NAME,
        ranking_factors:   null,
      });
    }
  };

  for (const blk of blocks) {
    if (blk.type === "place_cards" || blk.type === "map") {
      for (const p of blk.places) attach(p, "place");
    } else if (blk.type === "event_cards") {
      for (const e of blk.events) attach(e, "event");
    } else if (blk.type === "comparison") {
      for (const r of blk.rows) {
        if (r.place) attach(r.place, "place");
        if (r.event) attach(r.event, "event");
      }
    }
  }
  return dedupeByRecommendationId(rows);
}

router.get("/compass/me/context", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  // Feature flag gate
  const enabled = await isCompassEnabled(sc);
  if (!enabled) {
    const fallback: CompassFallbackResponse = {
      fallback: true,
      contextState: "normal",
      intentMode: { primary: "explore_now", secondary: [] },
    };
    req.log.info({ userId: user.id }, "compass: COMPASS_ENABLED=false, returning fallback");
    res.json(fallback);
    return;
  }

  try {
    // Build profile (cached 2 min per user)
    const profile = await getCompassProfile(sc, user.id);

    // Build signals from profile (traveler's local clock + profile booleans)
    const signals = defaultSignals(profile, await localHourForRequest(sc, user.id, req));

    // Compute context and intent mode
    const context    = buildCompassContext(profile, signals);
    const intentMode = deriveIntentMode(context);

    // Safe public subset — no block counts, no raw scores
    const publicProfile: CompassProfilePublic = {
      userId:          profile.userId,
      budgetStyle:     profile.budgetStyle,
      travelStyles:    profile.travelStyles,
      safetyPreference: profile.safetyPreference,
      currentCity:     profile.currentCity,
      trustLevel:      profile.trustLevel,
      hasActiveTrip:   profile.hasActiveTrip,
      hasActiveBooking: profile.hasActiveBooking,
    };

    const response: CompassContextResponse = {
      contextState: context.contextState,
      intentMode,
      profile: publicProfile,
      computedAt: context.computedAt,
    };

    res.json(response);
  } catch (err) {
    req.log.error({ err }, "compass: context computation failed");
    // COMPASS_FALLBACK_MODE_ENABLED check is intentionally omitted here —
    // we always return a safe fallback on unexpected errors.
    const fallback: CompassFallbackResponse = {
      fallback: true,
      contextState: "normal",
      intentMode: { primary: "explore_now", secondary: [] },
    };
    res.json(fallback);
  }
});

// ── Feed query schema ─────────────────────────────────────────────────────────

const feedQuerySchema = z.object({
  cursor: z.string().optional(),
});

// ── GET /api/compass/feed ─────────────────────────────────────────────────────

router.get("/compass/feed", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const enabled = await isCompassEnabled(sc);
  if (!enabled) {
    res.json({
      sections:  [],
      nextCursor: null,
      fallback:   true,
    });
    return;
  }

  // Check COMPASS_FEED_ENABLED flag
  let feedEnabled = false;
  try {
    const { data } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "COMPASS_FEED_ENABLED")
      .maybeSingle();
    feedEnabled = Boolean((data as any)?.enabled);
  } catch (err) {
    req.log?.warn({ err }, "Compass feed: COMPASS_FEED_ENABLED flag lookup failed — degrading to empty feed");
  }

  if (!feedEnabled) {
    res.json({ sections: [], nextCursor: null, fallback: true });
    return;
  }

  // Check COMPASS_FALLBACK_MODE_ENABLED — proactively return safe fallback
  // before even attempting the full pipeline.
  const fallbackModeOn = await isFallbackModeEnabled(sc);
  if (fallbackModeOn) {
    const profile = await getCompassProfile(sc, user.id).catch((err) => {
      req.log?.warn({ err, userId: user.id }, "Compass feed: profile fetch failed in fallback-mode path — proceeding with null profile");
      return null;
    });
    const result  = await buildFallbackFeed(sc, user.id, profile, "fallback_mode_enabled");
    res.json(result);
    return;
  }

  const parsed = feedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }
  const { cursor } = parsed.data;

  try {
    const tzOffset  = tzOffsetForRequest(req);
    const localHour = await localHourForRequest(sc, user.id, req);
    const cacheKey  = feedCacheKey("feed", cursor, tzOffset, localHour);

    // Read-through: return cached payload if still fresh
    const cached = await getCachedFeed(sc, user.id, cacheKey, "feed");
    if (cached) { res.json(cached); return; }

    // Load profile + settings + recent context in parallel
    const [profile, settingsRow, recentCtxRow] = await Promise.all([
      getCompassProfile(sc, user.id),
      sc.from("compass_settings").select("*").eq("user_id", user.id).maybeSingle(),
      sc.from("compass_recent_context").select("signals").eq("user_id", user.id).maybeSingle(),
    ]);

    // Apply compass_settings toggles to signals so disabled data sources are
    // not used in the ranking pipeline for this request.
    const settings = (settingsRow.data ?? {}) as Record<string, boolean>;
    const rawSignals = defaultSignals(profile, localHour);
    // Gate trip-data signals when user has disabled trip-data personalisation
    if (settings.use_trip_data === false) {
      rawSignals.activeTripNow           = false;
      rawSignals.upcomingTripWithin48h   = false;
      rawSignals.hasFutureTripScheduled  = false;
      rawSignals.activeBooking           = false;
    }
    const signals  = rawSignals;
    const context  = buildCompassContext(profile, signals);
    _lastFeedContext = { hourUtc: signals.hourUtc, contextState: context.contextState };

    // Hydrate candidates, applying settings gates that affect candidate selection:
    //   use_location=false + use_chosen_city=false → skip city-biased fetching
    //   (pass a profile copy with currentCity=null so the hydrator fetches globally)
    const hydrateProfile =
      settings.use_location === false && settings.use_chosen_city === false
        ? { ...profile, currentCity: null as string | null }
        : profile;
    const items = await hydrateCompassItems(sc, hydrateProfile);

    // Apply type-based candidate gates driven by settings toggles.
    const excludeTypes = new Set<string>();
    if (settings.show_buddy_recommendations === false)  excludeTypes.add("buddy");
    if (settings.show_people_recommendations === false) excludeTypes.add("user");

    // Filter out session-suppressed items (not_now actions written to
    // compass_recent_context.signals.session_suppressed_ids as raw item IDs).
    const sessionSuppressedIds = new Set<string>(
      ((recentCtxRow.data?.signals as any)?.session_suppressed_ids as string[]) ?? [],
    );
    const candidateItems = items.filter(
      (item) =>
        !sessionSuppressedIds.has(item.id) &&
        (excludeTypes.size === 0 || !excludeTypes.has(item.type ?? "")),
    );

    const feed = await buildFeed(candidateItems, profile, context, sc, cursor ?? null);

    // Enrich feed with signed recommendationId tokens per item.
    // The client uses these tokens to call GET /api/compass/why/:recommendationId.
    // Tokens are pre-registered in compass_served_recommendations
    // so the /why endpoint can do an authoritative DB lookup.
    const { enrichedFeed, registrationRows } = enrichFeedWithRecommendationIds(user.id, feed);

    // Await pre-registration so that a subsequent /why call on any returned
    // recommendationId is guaranteed to find the row — no race window.
    if (registrationRows.length > 0) {
      const { error: regError } = await sc
        .from("compass_served_recommendations")
        .upsert(registrationRows, { onConflict: "recommendation_id" });
      if (regError) {
        req.log.error({ err: regError }, "compass/feed: served-recommendation registration failed");
      }
    }

    // Write-through: cache the result (fire-and-forget — never blocks response)
    void setCachedFeed(sc, user.id, cacheKey, "feed", enrichedFeed);
    res.json(enrichedFeed);
  } catch (err) {
    req.log.error({ err }, "compass/feed: build failed, using fallback");
    const profile = await getCompassProfile(sc, user.id).catch(() => null);
    const result  = await buildFallbackFeed(sc, user.id, profile, "build_error");
    res.json(result);
  }
});

// ── GET /api/compass/feed/section/:section ────────────────────────────────────

router.get("/compass/feed/section/:section", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const enabled = await isCompassEnabled(sc);
  if (!enabled) {
    res.json({ section: null, nextCursor: null, fallback: true, compassEnabled: false });
    return;
  }

  const sectionParam = req.params.section as string;
  if (!SECTION_NAMES.includes(sectionParam as SectionName)) {
    sendError(res, "invalid_payload", `Unknown section '${sectionParam}'`);
    return;
  }

  // Proactive fallback-mode check — same gate as the feed endpoint.
  // On flag or error we include safeItems (the safe content set) alongside
  // the section-schema envelope so clients receive actual safe content.
  const fallbackModeOn = await isFallbackModeEnabled(sc);
  if (fallbackModeOn) {
    req.log.info({ userId: user.id }, "compass/feed/section: COMPASS_FALLBACK_MODE_ENABLED, returning section fallback");
    const profile  = await getCompassProfile(sc, user.id).catch(() => null);
    const fallback = await buildFallbackFeed(sc, user.id, profile, "section_fallback_mode_enabled");
    res.json({ section: null, nextCursor: null, fallback: true, compassEnabled: false, safeItems: fallback.safeItems });
    return;
  }

  const parsed = feedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }
  const { cursor } = parsed.data;

  try {
    const sectionTzOffset  = tzOffsetForRequest(req);
    const sectionLocalHour = await localHourForRequest(sc, user.id, req);
    const cacheKey = feedCacheKey(`section:${sectionParam}`, cursor, sectionTzOffset, sectionLocalHour);

    // Read-through: return cached payload if still fresh
    const cached = await getCachedFeed(sc, user.id, cacheKey, "section");
    if (cached) { res.json(cached); return; }

    // Load profile + settings + recent context in parallel (same gates as /feed)
    const [profile, sectionSettingsRow, sectionCtxRow] = await Promise.all([
      getCompassProfile(sc, user.id),
      sc.from("compass_settings").select("*").eq("user_id", user.id).maybeSingle(),
      sc.from("compass_recent_context").select("signals").eq("user_id", user.id).maybeSingle(),
    ]);

    const sectionSettings = (sectionSettingsRow.data ?? {}) as Record<string, boolean>;
    const sectionRawSignals = defaultSignals(profile, sectionLocalHour);
    if (sectionSettings.use_trip_data === false) {
      sectionRawSignals.activeTripNow          = false;
      sectionRawSignals.upcomingTripWithin48h  = false;
      sectionRawSignals.hasFutureTripScheduled = false;
      sectionRawSignals.activeBooking          = false;
    }
    const signals  = sectionRawSignals;
    const context  = buildCompassContext(profile, signals);

    const sectionHydrateProfile =
      sectionSettings.use_location === false && sectionSettings.use_chosen_city === false
        ? { ...profile, currentCity: null as string | null }
        : profile;
    const items = await hydrateCompassItems(sc, sectionHydrateProfile);

    // Apply type-gate and session-suppression filters (same logic as /feed)
    const sectionExcludeTypes = new Set<string>();
    if (sectionSettings.show_buddy_recommendations === false)  sectionExcludeTypes.add("buddy");
    if (sectionSettings.show_people_recommendations === false) sectionExcludeTypes.add("user");
    const sectionSuppressedIds = new Set<string>(
      ((sectionCtxRow.data?.signals as any)?.session_suppressed_ids as string[]) ?? [],
    );
    const candidateItems = items.filter(
      (item) =>
        !sectionSuppressedIds.has(item.id) &&
        (sectionExcludeTypes.size === 0 || !sectionExcludeTypes.has(item.type ?? "")),
    );

    const result = await buildSection(
      sectionParam as SectionName,
      candidateItems,
      profile,
      context,
      sc,
      cursor ?? null,
    );

    // Enrich items with signed recommendation tokens (same pattern as full feed).
    // Wrap in `sections[]` format so clients share one response envelope.
    const registrationRows: RecommendationRow[] = [];
    const enrichedItems = (result.section?.items ?? []).map((item: any) => {
      const token = encodeRecommendationToken({
        userId:         user.id,
        itemId:         String(item.item?.id ?? item.id ?? ""),
        itemType:       String(item.item?.type ?? item.type ?? ""),
        sectionName:    sectionParam,
        explanationKey: item.explanationKey,
      });
      registrationRows.push({
        user_id:           user.id,
        recommendation_id: token,
        explanation_key:   item.explanationKey,
        item_id:           String(item.item?.id ?? item.id ?? ""),
        item_type:         String(item.item?.type ?? item.type ?? ""),
        section_name:      sectionParam,
        ranking_factors:   rankingSnapshot(item),
      });
      return { ...item, recommendationId: token };
    });

    // Pre-register tokens (fire-and-forget — /why route does authoritative lookup)
    const dedupedRows = dedupeByRecommendationId(registrationRows);
    if (dedupedRows.length > 0) {
      void sc.from("compass_served_recommendations")
        .upsert(dedupedRows, { onConflict: "recommendation_id" })
        .then(({ error }) => {
          if (error) req.log.error({ err: error }, "compass/feed/section: served-recommendation registration failed");
        });
    }

    const sectionPayload = result.section
      ? { ...result.section, items: enrichedItems }
      : null;

    const response = {
      sections:   sectionPayload ? [sectionPayload] : [],
      nextCursor: result.nextCursor,
      fallback:   false,
      compassEnabled: true,
    };

    // Write-through: cache the result (fire-and-forget)
    void setCachedFeed(sc, user.id, cacheKey, "section", response);
    res.json(response);
  } catch (err) {
    // On unhandled error, return section-schema fields + safe fallback content.
    // `section: null` is the consistent fallback signal; `safeItems` carries
    // actual safe content so the client degrades gracefully rather than showing
    // an empty screen.
    req.log.error({ err }, "compass/feed/section: build failed, using fallback");
    const profile  = await getCompassProfile(sc, user.id).catch((profileErr) => {
      req.log?.warn({ err: profileErr, userId: user.id }, "compass/feed/section: fallback profile fetch failed — proceeding with null profile");
      return null;
    });
    const fallback = await buildFallbackFeed(sc, user.id, profile, "section_build_error").catch((fallbackErr) => {
      req.log?.error({ err: fallbackErr, userId: user.id }, "compass/feed/section: fallback feed build itself failed — returning empty safeItems");
      return { safeItems: [] };
    });
    res.json({ section: null, nextCursor: null, fallback: true, safeItems: fallback.safeItems });
  }
});

// ── Front-load query/body schemas ─────────────────────────────────────────────

const networkHintValues = ["wifi", "cellular", "slow", "offline"] as const;
const batteryHintValues = ["normal", "low"] as const;

const frontloadQuerySchema = z.object({
  network: z.enum(networkHintValues).optional(),
  battery: z.enum(batteryHintValues).optional(),
});

const navigationEventSchema = z.object({
  screen:      z.string().min(1).max(120),
  occurred_at: z.string().datetime().optional(),
  // Optional context hints — recorded for future analytics; not yet consumed by
  // recordNavigationEvent but accepted so client payloads are not rejected.
  event_type:  z.string().max(80).optional(),
  city:        z.string().max(200).optional(),
});

// ── GET /api/compass/frontload ─────────────────────────────────────────────────
// Returns the Tier 0 + Tier 1 (and higher, network-permitting) payload in one
// response so the client can pre-cache the data before the user taps any screen.

router.get("/compass/frontload", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  // Hints may arrive as query params (preferred) or request headers (e.g. from
  // native clients that set headers before the URL is fully constructed).
  const networkFromHeader = req.headers['x-network-hint'];
  const batteryFromHeader = req.headers['x-battery-hint'];

  const parsed = frontloadQuerySchema.safeParse({
    network: req.query.network ?? (typeof networkFromHeader === 'string' ? networkFromHeader : undefined),
    battery: req.query.battery ?? (typeof batteryFromHeader === 'string' ? batteryFromHeader : undefined),
  });
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }

  try {
    const profile = await getCompassProfile(sc, user.id);
    const payload = await buildFrontLoadPayload(sc, user.id, profile, {
      networkHint: parsed.data.network as NetworkHint | undefined,
      batteryHint: parsed.data.battery as BatteryHint | undefined,
    });
    res.json(payload);
  } catch (err) {
    req.log.error({ err }, "compass/frontload: build failed");
    sendError(res, "server_not_configured", "Front-load build failed");
  }
});

// ── GET /api/compass/preload-manifest ─────────────────────────────────────────
// Returns the prioritized list of Tier 2 URLs the client should prefetch.

router.get("/compass/preload-manifest", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  try {
    // Derive base URL from the request
    const proto   = req.headers["x-forwarded-proto"] ?? "https";
    const host    = req.headers["x-forwarded-host"] ?? req.headers.host ?? "";
    const baseUrl = `${proto}://${host}`;

    const manifest = await buildPreloadManifest(sc, user.id, baseUrl);
    res.json({ manifest });
  } catch (err) {
    req.log.error({ err }, "compass/preload-manifest: build failed");
    res.json({ manifest: [] });
  }
});

// ── POST /api/compass/frontload/event ─────────────────────────────────────────
// Records a client navigation event to improve future preload ranking.

router.post("/compass/frontload/event", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const parsed = navigationEventSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const occurredAt = parsed.data.occurred_at
    ? new Date(parsed.data.occurred_at)
    : new Date();

  await recordNavigationEvent(sc, user.id, parsed.data.screen, occurredAt);
  res.status(200).json({ ok: true });
});

/* ─────────────────────────────────────────────────────────────────────────
 * PUT /api/compass/me/boost-visibility
 * Body: { enabled: boolean }
 *
 * Persists the "boost my visibility when active" preference.
 * Written to compass_active_user_scores.boost_visibility_enabled.
 * Upserts the row so the preference is honoured even before the first
 * score-compute run.
 * ─────────────────────────────────────────────────────────────────────── */
const boostVisibilitySchema = z.object({ enabled: z.boolean() });

router.put("/compass/me/boost-visibility", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const parsed = boostVisibilitySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", "Body must be { enabled: boolean }");
    return;
  }

  const { error } = await sc
    .from("compass_active_user_scores")
    .upsert(
      { user_id: user.id, boost_visibility_enabled: parsed.data.enabled },
      { onConflict: "user_id" },
    );

  if (error) {
    req.log.warn({ err: error, userId: user.id }, "compass: boost-visibility upsert failed");
    sendError(res, "db_error", "Could not save preference", { exposeDetail: true });
    return;
  }

  res.status(200).json({ ok: true, enabled: parsed.data.enabled });
});

// ── GET /api/compass/why/:recommendationId ────────────────────────────────────
// Returns a human-readable "Why am I seeing this?" string for a recommendation.
// The recommendationId is the opaque base64url token produced by
// CompassExplanationEngine.encodeRecommendationToken (attached to each FeedItem).
//
// Data-source note: This endpoint uses `compass_served_recommendations` (migration
// 0055) as the authoritative Phase 5 registry of served items and their explanation
// keys. `compass_served_recommendations` is distinct from `compass_recommendation_scores`
// (migration 0052), which is a Phase 2 debug log of per-viewer scoring components.
// Using the served-recommendations table ensures the /why lookup is tied to an actual
// delivery event and carries the correct explanation_key for the rendered feed position,
// rather than a raw score snapshot that may have been computed without final section
// assignment or category-weight adjustments.

router.get("/compass/why/:recommendationId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { recommendationId } = req.params;
  if (!recommendationId || typeof recommendationId !== "string") {
    sendError(res, "invalid_payload", "Missing recommendationId");
    return;
  }

  // Step 1: Verify HMAC signature — proves token was issued by this server.
  // Forged or tampered tokens return null before any DB access.
  const token = decodeRecommendationToken(recommendationId);
  if (!token || token.userId !== user.id) {
    res.json({ explanation: "Recommendation not found or not available for your account." });
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    // Service client unavailable — return generic rather than accepting client data
    res.json({ explanation: "Based on your travel preferences and recent activity." });
    return;
  }

  try {
    // Step 2: Authoritative DB lookup — recommendation must have been served via the feed.
    // The feed route pre-registers all served recommendations in compass_served_recommendations.
    // If the row doesn't exist, the recommendation was never served to this user.
    const { data: row } = await sc
      .from("compass_served_recommendations")
      .select("explanation_key, ranking_factors")
      .eq("recommendation_id", recommendationId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!row) {
      res.json({ explanation: "Recommendation not found or not available for your account." });
      return;
    }

    // Step 3: Record the lookup timestamp (non-blocking)
    sc.from("compass_served_recommendations")
      .upsert(
        { recommendation_id: recommendationId, user_id: user.id, explanation_looked_up_at: new Date().toISOString() },
        { onConflict: "recommendation_id" },
      )
      .then(() => {}, () => {});

    // Step 4: Resolve explanation from the *stored* key (not from client-provided token)
    const explanationKey = (row as any).explanation_key as string;

    const profile = await getCompassProfile(sc, user.id).catch(() => null);
    const city = profile?.currentCity ?? null;

    const templateExplanation = await resolveExplanation(explanationKey, sc, city);

    // Phase 7 — factor-grounded explanation. When the served row carries a
    // ranking snapshot, the "Why this?" text is generated from the ACTUAL
    // ranking factors (never model-invented). Sensitive explanation keys stay
    // on the generic template and expose no factors (privacy rule).
    if (!isSensitiveKey(explanationKey)) {
      const snapshot = (row as any).ranking_factors as {
        compassMatch?: number | null;
        communityScore?: number | null;
        factors?: { key: string; label: string; weight: number; detail?: string }[];
      } | null;
      if (snapshot && Array.isArray(snapshot.factors)) {
        const grounded = buildWhyThisText(snapshot.factors as any);
        res.json({
          explanation:    grounded ?? templateExplanation,
          // Same sensitive-key policy as the sentence: never leak
          // moderation/safety factors through the raw payload.
          factors:        presentableFactors(snapshot.factors as any).slice(0, 5),
          compassMatch:   snapshot.compassMatch   ?? null,
          communityScore: snapshot.communityScore ?? null,
        });
        return;
      }
    }

    res.json({ explanation: templateExplanation });
  } catch (err) {
    req.log.error({ err }, "compass/why: resolution failed");
    res.json({ explanation: "Based on your travel preferences and recent activity." });
  }
});

// ── POST /api/compass/ask ─────────────────────────────────────────────────────
// Phase-1 conversational Compass endpoint.
//
// Changes from the legacy handler:
//   • Real multi-turn history via compass_conversations + compass_conversation_messages
//   • Actual LLM call (gpt-5-mini) with full history + context block — no string templates
//   • Intent classifier decides routing: "itinerary" at ≥0.6 confidence takes the
//     itinerary branch; everything else takes the conversation/tool loop
//   • Dynamic quick-actions proposed by the model, validated against a server-side whitelist
//   • Versioned system prompt (COMPASS_ASK_PROMPT_VERSION logged per request)
//   • Honest fallbacks — no canned fake recommendations on any error path
//   • Opt-in SSE streaming via body.stream=true
//
// Deprecated: body.conversationContext is accepted but ignored when conversationId is present.
// Deprecated: body.mode — replaced by classifier-derived intent routing.

const ALLOWED_QUICK_ACTION_TYPES = new Set([
  "addTrip", "buildItinerary", "askCommunity", "explore",
  "viewEvent", "viewPlace", "startPoll", "shareTip",
  "openMap", "viewPassport", "findBuddy", "viewTrips",
]);

const HONEST_FALLBACK_MESSAGE =
  "Compass AI assistant is temporarily unavailable. Please try again shortly.";

/**
 * Shown when the tool-calling loop found results but both the forced-final
 * round and the summarise re-prompt returned empty content. Distinct from
 * HONEST_FALLBACK_MESSAGE (which implies a server outage) — here the model
 * responded but produced no text, so the phrasing is gentler.
 */
const SUMMARISE_EMPTY_FALLBACK_MESSAGE =
  "I found some results but had trouble putting them into words. Try asking again.";

/**
 * Injected as a system message when the intent classifier decides "itinerary"
 * (confidence ≥ 0.6). Steers the model into the structured itinerary payload
 * path already defined in COMPASS_ASK_PROMPT (payload type "itinerary" —
 * destination + days). All other intents take the normal conversation/tool loop.
 */
const ITINERARY_INTENT_DIRECTIVE =
  'The user is asking for an itinerary. Build a day-by-day plan and set payload to the "itinerary" type from the response format (destination + days, each day with a label and highlights). Use tools first when you need real places to ground the plan.';

const askBodySchema = z.object({
  prompt:              z.string().min(1).max(1000),
  city:                z.string().max(80).optional(),
  conversationId:      z.string().uuid().optional(),
  /** Phase 6: circle context — circle memories are only injected when this is
   *  set AND the caller is a verified member of that circle. */
  circleOwnerId:       z.string().uuid().optional(),
  /** @deprecated accepted but ignored when conversationId is present */
  conversationContext: z.string().max(600).optional(),
  stream:              z.boolean().default(false),
});

function _parseModelResponse(raw: string): {
  message:      string;
  payload:      Record<string, unknown> | null;
  quickActions: Array<{ label: string; actionType: string; params?: Record<string, unknown> }>;
} {
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "");
  try {
    const p = JSON.parse(cleaned);
    const message =
      typeof p.message === "string" ? p.message.slice(0, 2000) : raw.slice(0, 2000);
    const payload =
      p.payload && typeof p.payload === "object" && !Array.isArray(p.payload)
        ? (p.payload as Record<string, unknown>)
        : null;
    const rawActions = Array.isArray(p.quickActions) ? p.quickActions : [];
    const quickActions = rawActions
      .filter((a: any) =>
        typeof a.label === "string" && ALLOWED_QUICK_ACTION_TYPES.has(a.actionType))
      .slice(0, 4)
      .map((a: any) => ({
        label:      String(a.label).slice(0, 60),
        actionType: String(a.actionType),
        ...(a.params && typeof a.params === "object"
          ? { params: a.params as Record<string, unknown> }
          : {}),
      }));
    return { message, payload, quickActions };
  } catch {
    // Not JSON — treat entire response as plain message
    return { message: raw.slice(0, 2000), payload: null, quickActions: [] };
  }
}

// ── Phase 4: tool-calling loop ────────────────────────────────────────────────
// The model requests tools, the server executes them (privacy-guarded), the
// result is fed back, and the loop iterates until the model produces a final
// answer or the round budget is exhausted. Candidates stay tool-sourced.

const MAX_TOOL_ROUNDS = 5;

/**
 * Safeguard for the "silent reply" failure mode: when gpt-5-mini ends a
 * tool-calling sequence without producing text on the forced-final round,
 * re-prompt once with an explicit summarise instruction so the client always
 * receives a visible reply.
 *
 * Called only when `finalRaw === ""` after the loop exits. Non-fatal: returns
 * `""` if the re-prompt also fails, so the caller can still emit a graceful
 * fallback rather than crash.
 */
const SUMMARISE_PROMPT =
  "Based on what you just found, please give a direct, helpful reply to the traveler. Be concise.";

async function summariseFallback(
  convo:    any[],
  log:      { warn: (o: object, m: string) => void },
  userId:   string,
  onDelta?: (delta: string) => void,
  signal?:  AbortSignal,
): Promise<string> {
  log.warn(
    { userId },
    "compass/ask: empty final turn — re-prompting with summarise instruction",
  );
  const opts = {
    model:                 "gpt-5-mini",
    max_completion_tokens: 1200,
    // Low reasoning effort: this is a text-only re-prompt after the model
    // already reasoned through tool calls in the previous round. At default
    // reasoning effort, gpt-5-mini can spend its entire completion-token
    // budget on hidden reasoning tokens and return empty visible content —
    // the exact "empty final turn" case this function exists to recover
    // from. "low" leaves enough budget for actual output text.
    reasoning_effort:      "low" as const,
    messages: [
      ...convo,
      { role: "user", content: SUMMARISE_PROMPT },
    ],
    // No tools — text-only summarise turn.
  };
  try {
    if (onDelta) {
      const streamed = await streamModelRound(opts as any, onDelta, signal);
      return streamed.content;
    }
    const completion = await getOpenAI().chat.completions.create(opts as any);
    const msg = (completion as any).choices?.[0]?.message;
    return String(msg?.content ?? "");
  } catch (err) {
    // A client disconnect during the summarise round must still abort the
    // request and suppress persistence — rethrow so the SSE handler sees it.
    if (err instanceof ClientDisconnectedError || signal?.aborted) throw err;
    return "";
  }
}

/**
 * Thrown when the SSE client disconnects mid-answer. The upstream OpenAI
 * stream is aborted (no further token spend) and NOTHING is persisted —
 * a partial answer must never land in compass_conversation_messages.
 */
export class ClientDisconnectedError extends Error {
  constructor() { super("client_disconnected"); this.name = "ClientDisconnectedError"; }
}

interface ToolLoopOutcome {
  finalRaw:  string;
  toolLog:   ToolExecution[];
  proposals: AddToTripProposal[];
}

/**
 * Run one streamed model round, forwarding content deltas via onDelta.
 * Returns the reconstructed assistant message (content + tool_calls).
 *
 * Content deltas are forwarded live ONLY while no tool-call delta has been
 * seen in this round — in practice the model emits either tool calls or
 * content, and tool-call deltas arrive first when present, so a tool round
 * stays invisible to the SSE client while a final answer streams token-by-token.
 */
async function streamModelRound(
  opts:    Record<string, unknown>,
  onDelta: (delta: string) => void,
  /** Aborts the upstream OpenAI stream (e.g. on client disconnect). */
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: any[] }> {
  const streamResp = await getOpenAI().chat.completions.create(
    {
      ...opts,
      stream: true,
    } as any,
    signal ? ({ signal } as any) : undefined,
  );

  let content = "";
  const toolCallsByIndex = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();

  for await (const chunk of streamResp as any) {
    // Belt-and-braces: the SDK's { signal } already aborts the underlying
    // request, but mocks / older transports may keep yielding — bail out
    // explicitly so an aborted round never completes.
    if (signal?.aborted) throw new ClientDisconnectedError();
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    for (const tc of (delta.tool_calls ?? []) as any[]) {
      const idx = tc.index ?? 0;
      const existing = toolCallsByIndex.get(idx) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.function.name += tc.function.name;
      if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      toolCallsByIndex.set(idx, existing);
    }

    const text: string = delta.content ?? "";
    if (text) {
      content += text;
      // Suppress live emission once any tool-call delta has appeared —
      // tool rounds must stay invisible to streaming clients.
      if (toolCallsByIndex.size === 0) onDelta(text);
    }
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, tc]) => tc);
  return { content, toolCalls };
}

async function runToolCallingLoop(
  sc:       SupabaseClient,
  userId:   string,
  profile:  Awaited<ReturnType<typeof getCompassProfile>> | null,
  messages: Array<Record<string, unknown>>,
  log:      { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
  /** When set, model rounds are streamed and final-answer content deltas are
   *  forwarded live (tool rounds stay silent). Used by the SSE branch. */
  onDelta?: (delta: string) => void,
  /** Aborts model calls when the SSE client disconnects mid-answer. */
  signal?:  AbortSignal,
): Promise<ToolLoopOutcome> {
  const convo: any[] = [...messages];
  const toolLog: ToolExecution[] = [];
  const proposals: AddToTripProposal[] = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) throw new ClientDisconnectedError();
    const forceFinal = round === MAX_TOOL_ROUNDS;
    const requestOpts = {
      model: "gpt-5-mini",
      max_completion_tokens: 1200,
      // Low reasoning effort keeps the completion-token budget available for
      // actual visible output. At default effort, gpt-5-mini can burn the
      // whole budget on hidden reasoning tokens and return empty content —
      // forcing the summariseFallback re-prompt on every single request and
      // roughly doubling response time (this was the root cause of the
      // Compass chat feeling like it hung: ~30s round trips, sometimes with
      // no real answer even after the fallback). "low" cut reasoning tokens
      // from ~700 to <100 in testing with no loss of answer quality.
      reasoning_effort: "low" as const,
      messages: convo,
      ...(forceFinal
        ? {}
        : { tools: COMPASS_TOOL_DEFINITIONS as any, tool_choice: "auto" as const }),
    };

    let msg: any;
    let toolCalls: any[];
    if (onDelta) {
      const streamed = await streamModelRound(requestOpts, onDelta, signal);
      toolCalls = streamed.toolCalls;
      msg = {
        role: "assistant",
        content: streamed.content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
    } else {
      const completion = await getOpenAI().chat.completions.create(requestOpts as any);
      msg = (completion as any).choices?.[0]?.message;
      toolCalls = msg?.tool_calls ?? [];
    }

    if (!toolCalls.length || forceFinal) {
      let finalRaw = String(msg?.content ?? "");
      // Safeguard: when the model ends a tool-calling sequence without any
      // closing text (common with gpt-5-mini after heavy tool rounds), re-prompt
      // once with an explicit summarise instruction so the client always receives
      // a visible reply — never a silent empty message.
      if (!finalRaw) {
        finalRaw = await summariseFallback(convo, log, userId, onDelta, signal);
      }
      return { finalRaw, toolLog, proposals };
    }

    convo.push(msg);
    for (const tc of toolCalls) {
      const name = tc?.function?.name ?? "unknown";
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc?.function?.arguments ?? "{}"); } catch { /* empty args */ }

      const result = await executeCompassTool(sc, userId, profile as any, name, args);
      toolLog.push({ name, arguments: args, result });
      const proposal = (result as any)?.proposal;
      if (name === "add_to_trip" && proposal?.proposalId) proposals.push(proposal as AddToTripProposal);

      log.info({ userId, tool: name }, "compass/ask: tool executed");
      convo.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  // Unreachable, but keeps TS happy.
  return { finalRaw: "", toolLog, proposals };
}

/** Truncate tool results so the persisted payload stays bounded. */
function _boundedToolLog(toolLog: ToolExecution[]): Array<Record<string, unknown>> {
  return toolLog.map((t) => {
    let resultJson = "";
    try { resultJson = JSON.stringify(t.result); } catch { resultJson = "\"<unserializable>\""; }
    const truncated = resultJson.length > 4000;
    return {
      name:      t.name,
      arguments: t.arguments,
      result:    truncated ? { truncated: true, preview: resultJson.slice(0, 4000) } : t.result,
    };
  });
}

router.post("/compass/ask", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  // ── Feature-flag gate ─────────────────────────────────────────────────────
  const compassEnabled = await isCompassEnabled(sc).catch(() => false);
  if (!compassEnabled) {
    req.log.info({ userId: user.id }, "compass/ask: COMPASS_ENABLED=false");
    res.json({
      conversationId: null,
      message:        HONEST_FALLBACK_MESSAGE,
      payload:        null,
      quickActions:   [],
      promptVersion:  COMPASS_ASK_PROMPT_VERSION,
      fallback:       true,
      fallbackReason: "compass_disabled",
    });
    return;
  }

  const parsed = askBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid request");
    return;
  }
  const { prompt, city, conversationId: incomingConvId, circleOwnerId, stream } = parsed.data;

  // ── Conversation resolve ──────────────────────────────────────────────────
  let conversationId: string;
  try {
    conversationId = await getOrCreateConversation(sc, user.id, incomingConvId);
  } catch (err) {
    req.log.error({ err, userId: user.id }, "compass/ask: conversation resolve failed");
    res.json({
      conversationId: null,
      message:        HONEST_FALLBACK_MESSAGE,
      payload:        null,
      quickActions:   [],
      promptVersion:  COMPASS_ASK_PROMPT_VERSION,
      fallback:       true,
      fallbackReason: "conversation_error",
    });
    return;
  }

  // ── History load ──────────────────────────────────────────────────────────
  let history: Awaited<ReturnType<typeof loadHistory>> = [];
  try {
    history = await loadHistory(sc, conversationId);
  } catch { /* non-fatal — proceed with empty history */ }

  // ── Intent classification (classifier decides) ────────────────────────────
  // Promoted out of shadow mode: "itinerary" at ≥0.6 confidence takes the
  // itinerary branch (structured day-by-day payload); everything else —
  // including classifier null/error/low confidence — falls through to the
  // normal conversation/tool loop.
  let intentResult: IntentClassification | null = null;
  try {
    intentResult = await classifyIntent(prompt);
  } catch { /* non-fatal — treated as no classification */ }
  const isItineraryIntent =
    intentResult !== null &&
    intentResult.intent === "itinerary" &&
    intentResult.confidence >= 0.6;

  // ── Action intent (Phase 4) ───────────────────────────────────────────────
  // Actions no longer short-circuit: the tool-calling loop lets the model
  // PROPOSE actions via add_to_trip (never execute — the user must confirm).
  // The classified intent is still logged and returned for observability.

  // ── Build context block ───────────────────────────────────────────────────
  const effectiveCity = city ?? "";
  let locationCtx: Awaited<ReturnType<typeof buildLocationCompassContext>> | null = null;
  let weatherBrief:          string   | null = null;
  let followedHashtagSlugs:  string[]        = [];
  let topItemsContext:        string[]        = [];
  let structuredLines:        string[]        = [];
  let modeWeightingLines:     string[]        = [];

  try { locationCtx = await buildLocationCompassContext(auth.client, user.id); } catch { /* */ }

  const wxCity = effectiveCity || locationCtx?.currentCity || null;
  if (wxCity) {
    try { const wx = await getWeatherForAsk(wxCity); weatherBrief = wx?.briefSummary ?? null; }
    catch { /* non-fatal */ }
  }

  try {
    const { data: followRows } = await sc
      .from("user_hashtag_follows")
      .select("hashtags(slug)")
      .eq("user_id", user.id)
      .limit(15);
    followedHashtagSlugs = ((followRows ?? []) as any[])
      .map((r: any) => r.hashtags?.slug)
      .filter(Boolean) as string[];
  } catch { /* non-fatal */ }

  // Compass pipeline items — injected as named context for the LLM to reference.
  try {
    const profile    = await getCompassProfile(sc, user.id);
    const effProfile = effectiveCity ? { ...profile, currentCity: effectiveCity } : profile;
    const signals    = defaultSignals(effProfile, await localHourForRequest(sc, user.id, req));
    const ctx        = buildCompassContext(effProfile, signals);
    const rawItems   = await hydrateCompassItems(sc, effProfile);
    const { section: feedSection } = await buildSection("for_you", rawItems, effProfile, ctx, sc);
    topItemsContext = feedSection.items.slice(0, 5).map((itm: any) => {
      const d    = (itm.item ?? {}) as Record<string, unknown>;
      // `title` here can be raw UGC (a post body, a host-entered event title), so
      // wrap it in <portava:ugc> like every other UGC path and cap its length \u2014
      // otherwise an attacker's public post ranked into for_you is injected into
      // the /ask prompt as trusted, "Verified" instructions.
      const name = wrapUgc(String(d.title ?? d.name ?? d.type ?? "place").slice(0, 200));
      const cat  = String(d.category ?? d.type ?? "");
      const ic   = String(d.city ?? "");
      return `\u2022 ${name}${cat ? ` (${cat})` : ""}${ic ? ` \u2014 ${ic}` : ""}`;
    });
  } catch { /* non-fatal — proceed without pipeline items */ }

  // ── Phase 3: structured context (circles, bookings, Passport history) ─────
  // All sources are privacy-guarded inside buildStructuredCompassContext():
  // no coordinates are ever selected, blocked/blocker/muted users are
  // filtered out, and user-generated text is wrapped in <portava:ugc> tags.
  // Derived UI modes are made explicit for prompt weighting.
  let guardProfile: Awaited<ReturnType<typeof getCompassProfile>> | null = null;
  try {
    const profile    = await getCompassProfile(sc, user.id);
    const effProfile = effectiveCity ? { ...profile, currentCity: effectiveCity } : profile;
    guardProfile     = effProfile;
    const signals    = defaultSignals(effProfile, await localHourForRequest(sc, user.id, req));
    const ctx        = buildCompassContext(effProfile, signals);
    const intentMode = deriveIntentMode(ctx);
    modeWeightingLines = buildModeWeightingLines(ctx.contextState, intentMode);
    const structured = await buildStructuredCompassContext(sc, effProfile);
    structuredLines  = formatStructuredContextLines(structured);
  } catch { /* non-fatal — proceed without structured context */ }

  const locLine = locationCtx?.currentCity
    ? `${locationCtx.currentCity}${locationCtx.currentCountry ? `, ${locationCtx.currentCountry}` : ""}`
    : effectiveCity || "unspecified";

  const ctxLines: string[] = ["[Context \u2014 city-level only, no coordinates]"];
  ctxLines.push(`Location: ${locLine}`);
  if (locationCtx?.upcomingTripCity)
    ctxLines.push(`Upcoming trip: ${locationCtx.upcomingTripCity}${locationCtx.upcomingTripCountry ? `, ${locationCtx.upcomingTripCountry}` : ""}`);
  if (followedHashtagSlugs.length > 0)
    ctxLines.push(`Interests: ${followedHashtagSlugs.map((s) => `#${s}`).join(", ")}`);
  if (weatherBrief)
    ctxLines.push(`Weather: ${weatherBrief}`);
  if (topItemsContext.length > 0)
    ctxLines.push(`Verified nearby places:\n${topItemsContext.join("\n")}`);

  // ── Always-on trip grounding ──────────────────────────────────────────────
  // Grounds every chat turn in the user's active/upcoming trip. Skipped while
  // a Compass Live session is active: live-session lines (fetched here,
  // appended below in their usual slot) already ground the chat in the current
  // trip — don't double-ground. Never fatal.
  let liveLines: string[] = [];
  try { liveLines = await buildLiveChatContextLines(sc, user.id); } catch { /* non-fatal */ }
  if (liveLines.length === 0) {
    try {
      const tripLines = await buildTripContextLines(sc, user.id);
      if (tripLines.length > 0) ctxLines.push("[Trip context]", ...tripLines);
    } catch { /* non-fatal — proceed without trip context */ }
  }

  ctxLines.push(...structuredLines);
  ctxLines.push(...modeWeightingLines);

  // ── Phase 15: Destination World Model + city-confidence honesty ───────────
  // Per-city time-sliced rhythm (Friday night ≠ Monday morning) and an honest
  // data-depth line so deep cities answer confidently and thin cities say so.
  // Aggregates only — no user ids, handles, or coordinates. Never fatal.
  try {
    const wmCity = effectiveCity || locationCtx?.currentCity || null;
    const destinationLines = await buildDestinationContextLines(sc, wmCity);
    ctxLines.push(...destinationLines);
  } catch { /* non-fatal — proceed without destination model */ }

  // ── Phase 6: layered memory injection (bounded, structured insights only) ─
  // Circle memories require verified membership of the named circle; group
  // facts never cross circles. Never fatal.
  try {
    const memoryLines = await buildMemoryPromptBlock(sc, user.id, {
      conversationId,
      circleOwnerId: circleOwnerId ?? null,
    });
    ctxLines.push(...memoryLines);
  } catch { /* non-fatal — proceed without memory */ }

  // ── Phase 12: live-session grounding ──────────────────────────────────────
  // While a live session is active, chat answers are grounded in the rolling
  // session context (current stop, next plan item, timing). Fetched above so
  // the trip block can defer to it; appended here to keep its position. Empty
  // outside a session — chat is unchanged when Live is off. Never fatal.
  ctxLines.push(...liveLines);

  const userMessageWithContext = `${prompt}\n\n${ctxLines.join("\n")}`;

  // ── Build messages array ──────────────────────────────────────────────────
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: COMPASS_ASK_PROMPT },
    { role: "system", content: COMPASS_TOOLS_PROMPT_ADDENDUM },
    // Itinerary branch: classifier-decided (see intent classification above).
    ...(isItineraryIntent
      ? [{ role: "system" as const, content: ITINERARY_INTENT_DIRECTIVE }]
      : []),
    ...history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
    { role: "user",   content: userMessageWithContext },
  ];

  // Persist user message (non-fatal)
  try { await appendMessage(sc, conversationId, "user", prompt); } catch { /* */ }

  req.log.info(
    {
      userId:        user.id,
      conversationId,
      historyTurns:  history.length,
      promptVersion: COMPASS_ASK_PROMPT_VERSION,
      intent:        intentResult?.intent,
      confidence:    intentResult?.confidence,
    },
    "compass/ask: LLM call",
  );

  // ── SSE streaming ─────────────────────────────────────────────────────────
  if (stream) {
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.flushHeaders();
    // Client-disconnect handling: if the SSE client drops mid-answer we abort
    // the upstream OpenAI stream (no further token spend) and persist NOTHING —
    // a half-generated assistant message must never reach
    // compass_conversation_messages. A fully generated answer that completes
    // before the disconnect is still persisted normally.
    const clientAbort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) clientAbort.abort();
    });
    try {
      // Tool rounds run silently server-side; the FINAL model round streams
      // its content token-by-token as delta events (same contract as before
      // Phase 4). The done event still carries the parsed message fields.
      const { finalRaw, toolLog, proposals } = await runToolCallingLoop(
        sc, user.id, guardProfile, messages as any, req.log,
        (delta) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ delta })}\n\n`); },
        clientAbort.signal,
      );
      const _parsed = _parseModelResponse(finalRaw);
      const message      = finalRaw === "" ? SUMMARISE_EMPTY_FALLBACK_MESSAGE : _parsed.message;
      const payload      = _parsed.payload;
      const quickActions = _parsed.quickActions;
      // Phase 5: validate + hydrate model-declared UI blocks against tool candidates.
      // outMeta tracks how many model-declared ids were not found in the tool log
      // (hallucinated references). When no blocks were declared, synthesis runs
      // from the tool log and droppedInventedIds stays 0.
      const uiBlockMeta = { droppedInventedIds: 0 };
      const uiBlocks = await buildUiBlocks(sc, payload, toolLog, uiBlockMeta).catch(() => []);
      // Attach signed recommendation tokens + pre-register served recommendations
      // so chat-card "viewed" outcomes attribute to this serving.
      const uiBlockRegRows = enrichUiBlocksWithRecommendationTokens(user.id, uiBlocks);
      if (uiBlockRegRows.length > 0) {
        // Non-fatal: a registration failure must never break the chat reply.
        try {
          void sc.from("compass_served_recommendations")
            .upsert(uiBlockRegRows, { onConflict: "recommendation_id" })
            .then(({ error }) => {
              if (error) req.log.error({ err: error }, "compass/ask stream: served-recommendation registration failed");
            });
        } catch (regErr) {
          req.log.error({ err: regErr }, "compass/ask stream: served-recommendation registration failed");
        }
      }
      const persistedPayload: Record<string, unknown> | undefined =
        payload || toolLog.length > 0 || proposals.length > 0
          ? {
              ...(payload ? { payload } : {}),
              ...(toolLog.length > 0 ? { toolCalls: _boundedToolLog(toolLog) } : {}),
              ...(proposals.length > 0 ? { pendingProposals: proposals } : {}),
              ...(uiBlocks.length > 0 ? { uiBlocks } : {}),
            }
          : undefined;
      try {
        await appendMessage(sc, conversationId, "assistant", message, persistedPayload, COMPASS_ASK_PROMPT_VERSION);
        await touchConversation(sc, conversationId);
      } catch { /* non-fatal */ }
      // Phase 6: bounded-cadence memory compression (fire-and-forget)
      compressConversationIfDue(sc, user.id, conversationId).catch(() => {});
      res.write(`data: ${JSON.stringify({ done: true, conversationId, promptVersion: COMPASS_ASK_PROMPT_VERSION, payload, quickActions, pendingProposals: proposals, uiBlocks, meta: { droppedInventedIds: uiBlockMeta.droppedInventedIds }, intent: intentResult })}\n\n`);
      res.end();
    } catch (err) {
      if (clientAbort.signal.aborted) {
        // Client went away mid-answer: upstream aborted, nothing persisted.
        req.log.info({ userId: user.id, conversationId }, "compass/ask stream: client disconnected, model call aborted");
        res.end();
        return;
      }
      req.log.error({ err, userId: user.id }, "compass/ask stream failed");
      res.write(`data: ${JSON.stringify({ error: true, message: HONEST_FALLBACK_MESSAGE })}\n\n`);
      res.end();
    }
    return;
  }

  // ── Non-streaming (default) ───────────────────────────────────────────────
  try {
    const { finalRaw, toolLog, proposals } = await runToolCallingLoop(
      sc, user.id, guardProfile, messages as any, req.log,
    );
    const _parsed = _parseModelResponse(finalRaw);
    const message      = finalRaw === "" ? SUMMARISE_EMPTY_FALLBACK_MESSAGE : _parsed.message;
    const payload      = _parsed.payload;
    const quickActions = _parsed.quickActions;
    // Phase 5: validate + hydrate model-declared UI blocks against tool candidates.
    // outMeta tracks how many model-declared ids were not found in the tool log
    // (hallucinated references). When no blocks were declared, synthesis runs
    // from the tool log and droppedInventedIds stays 0.
    const uiBlockMeta = { droppedInventedIds: 0 };
    const uiBlocks = await buildUiBlocks(sc, payload, toolLog, uiBlockMeta).catch(() => []);
    // Attach signed recommendation tokens + pre-register served recommendations
    // so chat-card "viewed" outcomes attribute to this serving.
    const uiBlockRegRows = enrichUiBlocksWithRecommendationTokens(user.id, uiBlocks);
    if (uiBlockRegRows.length > 0) {
      // Non-fatal: a registration failure must never break the chat reply.
      try {
        void sc.from("compass_served_recommendations")
          .upsert(uiBlockRegRows, { onConflict: "recommendation_id" })
          .then(({ error }) => {
            if (error) req.log.error({ err: error }, "compass/ask: served-recommendation registration failed");
          });
      } catch (regErr) {
        req.log.error({ err: regErr }, "compass/ask: served-recommendation registration failed");
      }
    }
    const persistedPayload: Record<string, unknown> | undefined =
      payload || toolLog.length > 0 || proposals.length > 0
        ? {
            ...(payload ? { payload } : {}),
            ...(toolLog.length > 0 ? { toolCalls: _boundedToolLog(toolLog) } : {}),
            ...(proposals.length > 0 ? { pendingProposals: proposals } : {}),
            ...(uiBlocks.length > 0 ? { uiBlocks } : {}),
          }
        : undefined;
    try {
      await appendMessage(sc, conversationId, "assistant", message, persistedPayload, COMPASS_ASK_PROMPT_VERSION);
      await touchConversation(sc, conversationId);
    } catch { /* non-fatal */ }
    // Phase 6: bounded-cadence memory compression (fire-and-forget)
    compressConversationIfDue(sc, user.id, conversationId).catch(() => {});
    res.json({ conversationId, message, payload: payload ?? null, quickActions, pendingProposals: proposals, uiBlocks, meta: { droppedInventedIds: uiBlockMeta.droppedInventedIds }, promptVersion: COMPASS_ASK_PROMPT_VERSION, intent: intentResult });
  } catch (err) {
    req.log.error({ err, userId: user.id }, "compass/ask: LLM call failed");
    res.json({
      conversationId,
      message:        HONEST_FALLBACK_MESSAGE,
      payload:        null,
      quickActions:   [],
      promptVersion:  COMPASS_ASK_PROMPT_VERSION,
      fallback:       true,
      fallbackReason: "ai_error",
    });
  }
});

// ── Phase 4: add_to_trip proposal confirmation flow ──────────────────────────
// The model can only PROPOSE trip additions (add_to_trip tool). The proposal
// lives in the assistant message payload. Execution happens exclusively here,
// after an explicit user confirmation, with full server-side re-authorization.

const proposalActionSchema = z.object({
  conversationId: z.string().uuid(),
});

interface FoundProposal {
  proposal: AddToTripProposal;
}

/** Proposals are confirmable for 24h after the proposal message was created. */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

async function findPendingProposal(
  sc: SupabaseClient,
  userId: string,
  conversationId: string,
  proposalId: string,
): Promise<FoundProposal | { error: "not_found" | "already_resolved" | "expired" }> {
  // Conversation must belong to the caller.
  const { data: conv } = await sc
    .from("compass_conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!conv) return { error: "not_found" };

  const { data: msgs } = await sc
    .from("compass_conversation_messages")
    .select("payload, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(50);

  let proposal: AddToTripProposal | null = null;
  let proposalCreatedAt: string | null = null;
  for (const m of (msgs ?? []) as any[]) {
    const p = m.payload as Record<string, unknown> | null;
    if (!p) continue;
    const resolved = Array.isArray(p.resolvedProposals) ? (p.resolvedProposals as string[]) : [];
    if (resolved.includes(proposalId)) return { error: "already_resolved" };
    if (!proposal && Array.isArray(p.pendingProposals)) {
      const hit = (p.pendingProposals as any[]).find((pr) => pr?.proposalId === proposalId);
      if (hit) {
        proposal = hit as AddToTripProposal;
        proposalCreatedAt = typeof m.created_at === "string" ? m.created_at : null;
      }
    }
  }
  if (!proposal) return { error: "not_found" };

  // Time-based expiry: a proposal older than the TTL must never execute.
  // A missing/unparsable created_at is treated as expired — fail closed.
  const createdMs = proposalCreatedAt ? Date.parse(proposalCreatedAt) : NaN;
  if (!Number.isFinite(createdMs) || Date.now() - createdMs > PROPOSAL_TTL_MS) {
    return { error: "expired" };
  }

  return { proposal };
}

router.post("/compass/proposals/:proposalId/confirm", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const parsed = proposalActionSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "conversationId is required"); return; }
  const { conversationId } = parsed.data;
  const { proposalId } = req.params;

  const found = await findPendingProposal(sc, user.id, conversationId, proposalId);
  if ("error" in found) {
    if (found.error === "already_resolved") { sendError(res, "conflict", "This proposal was already confirmed or declined"); return; }
    if (found.error === "expired") { sendError(res, "gone", "This proposal has expired — ask Compass again if you still want to add it"); return; }
    sendError(res, "not_found", "Proposal not found");
    return;
  }
  const { proposal } = found;

  // Re-authorize at execution time — membership/permissions may have changed.
  const member = await isAcceptedTripMember(sc, proposal.tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to add items"); return; }
  const permitted = await canEditPlan(sc, proposal.tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You don't have permission to add items to this plan"); return; }

  // Duplicate guard for catalog places (same rule as the plan route).
  if (proposal.placeId) {
    const { data: existing } = await sc
      .from("trip_plan_items")
      .select("id")
      .eq("trip_id", proposal.tripId)
      .eq("source_type", "place")
      .eq("source_id", proposal.placeId)
      .is("removed_at", null)
      .maybeSingle();
    if (existing) { sendError(res, "conflict", "This place is already in your trip plan"); return; }
  }

  const { data: item, error } = await sc
    .from("trip_plan_items")
    .insert({
      trip_id:       proposal.tripId,
      creator_id:    user.id,
      title:         proposal.title,
      category:      proposal.category || "activity",
      status:        "tentative",
      source_type:   proposal.placeId ? "place" : "compass",
      source_id:     proposal.placeId ?? proposal.proposalId,
      day_date:      proposal.dayDate ?? null,
      sort_order:    0,
      visibility:    "members",
    })
    .select("*")
    .single();
  if (error) {
    req.log.error({ err: error }, "compass/proposals confirm: insert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  // Record resolution so the proposal cannot be executed twice.
  try {
    await appendMessage(
      sc, conversationId, "assistant",
      `Added "${proposal.title}" to your trip.`,
      { resolvedProposals: [proposalId], proposalOutcome: { proposalId, status: "confirmed", itemId: (item as any)?.id ?? null } },
      COMPASS_ASK_PROMPT_VERSION,
    );
    await touchConversation(sc, conversationId);
  } catch { /* non-fatal */ }

  res.status(201).json({ status: "confirmed", proposalId, item });
});

router.post("/compass/proposals/:proposalId/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const parsed = proposalActionSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "conversationId is required"); return; }
  const { conversationId } = parsed.data;
  const { proposalId } = req.params;

  const found = await findPendingProposal(sc, user.id, conversationId, proposalId);
  if ("error" in found) {
    if (found.error === "already_resolved") { sendError(res, "conflict", "This proposal was already confirmed or declined"); return; }
    if (found.error === "expired") { sendError(res, "gone", "This proposal has expired — no action needed"); return; }
    sendError(res, "not_found", "Proposal not found");
    return;
  }

  try {
    await appendMessage(
      sc, conversationId, "assistant",
      "Okay — I won't add that to your trip.",
      { resolvedProposals: [proposalId], proposalOutcome: { proposalId, status: "declined" } },
      COMPASS_ASK_PROMPT_VERSION,
    );
    await touchConversation(sc, conversationId);
  } catch { /* non-fatal */ }

  res.json({ status: "declined", proposalId });
});

// ── POST /api/compass/feedback ────────────────────────────────────────────────
// Accepts user feedback on a Compass recommendation and updates preferences.

const feedbackBodySchema = z.object({
  recommendationId: z.string().min(1),
  action:           z.enum([...FEEDBACK_ACTIONS] as [FeedbackAction, ...FeedbackAction[]]),
  itemType:         z.string().min(1).max(60),
  category:         z.string().max(80).optional(),
  hashtag:          z.string().max(120).optional(),
  topic:            z.string().max(120).optional(),
  /** ID of the content author / target user — required for `report` and `block` actions so the abuse scanner can be triggered immediately. */
  targetUserId:     z.string().uuid().optional(),
});

router.post("/compass/feedback", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = feedbackBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  try {
    const result = await processFeedback(sc, user.id, parsed.data);
    res.json({ updated: result.updated });

    // ── Dual-write canonical actions to compass_feedback ───────────────────
    // compass_feedback stores the discrete UI-level actions users take on
    // recommendations (what they tap in the overflow menu). These are a
    // subset of the broader FEEDBACK_ACTIONS preference-weight events.
    // Write is fire-and-forget — never blocks the response.
    const COMPASS_FEEDBACK_ACTION_MAP: Partial<Record<FeedbackAction, string>> = {
      not_interested:  "not_interested",
      report:          "report",
      too_expensive:   "too_expensive",
      hide_user:       "hide",
      not_my_vibe:     "wrong_vibe",
      hide_this:       "hide",
      wrong_city:      "wrong_city",
      already_went:    "already_went",
      not_safe:        "not_safe",
      not_now:         "not_now",
    };
    const { action, recommendationId, itemType, targetUserId } = parsed.data;
    const mappedAction = COMPASS_FEEDBACK_ACTION_MAP[action];
    if (mappedAction) {
      sc.from("compass_feedback")
        .insert({
          user_id:           user.id,
          item_id:           recommendationId,
          item_type:         itemType,
          action:            mappedAction,
          recommendation_id: recommendationId,
          metadata:          targetUserId ? { targetUserId } : {},
        })
        .then(undefined, (err: unknown) => {
          req.log?.warn({ err }, "compass/feedback: dual-write to compass_feedback failed");
        });
    }

    // ── On-demand abuse scan ───────────────────────────────────────────────
    // When a user reports or blocks another user, immediately trigger a
    // scoped abuse scan for the target so the AbuseDefenseEngine can act
    // on the signal before the next scheduled batch window.
    if (targetUserId && (action === "report" || action === "block")) {
      triggerOnDemandScan(targetUserId);
    }
  } catch (err) {
    req.log.error({ err }, "compass/feedback: processing failed");
    sendError(res, "db_error", "Could not process feedback", { exposeDetail: true });
  }
});

// ── GET /api/compass/me/preferences ──────────────────────────────────────────
// Returns the authenticated user's Compass personalisation preferences.
// Creates a blank row on first access so callers never get null.

router.get("/compass/me/preferences", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const { data, error } = await sc
    .from("compass_user_preferences")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    req.log.warn({ err: error, userId: user.id }, "compass/me/preferences: read failed");
    sendError(res, "db_error", "Could not load preferences", { exposeDetail: true });
    return;
  }

  res.json({ preferences: data ?? { user_id: user.id } });
});

// ── PATCH /api/compass/me/preferences ────────────────────────────────────────
// Partially updates the user's Compass personalisation preferences.

const patchPreferencesSchema = z.object({
  interests:                z.array(z.string().max(60)).max(30).optional(),
  travel_styles:            z.array(z.string().max(60)).max(10).optional(),
  preferred_languages:      z.array(z.string().max(20)).max(10).optional(),
  hidden_categories:        z.array(z.string().max(80)).max(50).optional(),
  muted_hashtags:           z.array(z.string().max(120)).max(200).optional(),
  exclude_budget_styles:    z.array(z.string().max(60)).max(10).optional(),
  category_weights:         z.record(z.string(), z.number().min(0).max(10)).optional(),
  notification_preferences: z.record(z.string(), z.boolean()).optional(),
  boost_visibility_enabled: z.boolean().optional(),
  location_privacy_mode:    z.string().max(40).optional(),
  delayed_post_default:     z.boolean().optional(),
  visibility_sub_controls:  z.record(z.string(), z.boolean()).optional(),
  safety_preference:        z.string().max(40).optional(),
  rent_buddy_discoverable:  z.boolean().optional(),
});

router.patch("/compass/me/preferences", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = patchPreferencesSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const { error } = await sc
    .from("compass_user_preferences")
    .upsert({ ...parsed.data, user_id: user.id }, { onConflict: "user_id" });

  if (error) {
    req.log.warn({ err: error, userId: user.id }, "compass/me/preferences: upsert failed");
    sendError(res, "db_error", "Could not save preferences", { exposeDetail: true });
    return;
  }

  const { data: updated } = await sc
    .from("compass_user_preferences")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  res.json({ preferences: updated ?? { user_id: user.id, ...parsed.data } });
});

// ── Phase 6: Compass Remembers — layered memory CRUD ──────────────────────────
// GET    /compass/me/memories            — list (optional ?scope=)
// POST   /compass/me/memories/teach      — "Teach My Compass": statement → structured preference
// PATCH  /compass/me/memories/:memoryId  — edit content/category
// DELETE /compass/me/memories/:memoryId  — forget
// All ownership-scoped to the caller; circle memories always carry their circle.

router.get("/compass/me/memories", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const scopeRaw = typeof req.query.scope === "string" ? req.query.scope : undefined;
  if (scopeRaw && !MEMORY_SCOPES.includes(scopeRaw as MemoryScope)) {
    sendError(res, "invalid_payload", "Invalid scope");
    return;
  }
  try {
    const memories = await listMemories(sc, auth.user.id, scopeRaw as MemoryScope | undefined);
    res.json({ memories });
  } catch (err) {
    req.log.error({ err, userId: auth.user.id }, "compass/me/memories: list failed");
    sendError(res, "db_error", "Could not load memories", { exposeDetail: true });
  }
});

const teachMemorySchema = z.object({
  statement:     z.string().min(1).max(600),
  circleOwnerId: z.string().uuid().optional(),
});

router.post("/compass/me/memories/teach", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const parsed = teachMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { statement, circleOwnerId } = parsed.data;

  // Circle-scoped teaching requires verified membership of that circle.
  if (circleOwnerId) {
    const member = await isCircleMember(sc, auth.user.id, circleOwnerId).catch(() => false);
    if (!member) {
      sendError(res, "forbidden", "Not a member of that circle");
      return;
    }
  }

  try {
    const memory = await teachMemory(sc, auth.user.id, statement, { circleOwnerId: circleOwnerId ?? null });
    if (!memory) { sendError(res, "invalid_payload", "Nothing to remember from that statement"); return; }
    res.status(201).json({ memory });
  } catch (err) {
    req.log.error({ err, userId: auth.user.id }, "compass/me/memories/teach failed");
    sendError(res, "db_error", "Could not save that memory", { exposeDetail: true });
  }
});

const patchMemorySchema = z.object({
  content:  z.string().min(1).max(600).optional(),
  category: z.string().max(40).optional(),
}).refine((b) => b.content !== undefined || b.category !== undefined, {
  message: "Provide content or category",
});

router.patch("/compass/me/memories/:memoryId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const parsed = patchMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  try {
    const memory = await updateMemory(sc, auth.user.id, req.params.memoryId, parsed.data);
    if (!memory) { sendError(res, "not_found", "Memory not found"); return; }
    res.json({ memory });
  } catch (err) {
    req.log.error({ err, userId: auth.user.id }, "compass/me/memories: patch failed");
    sendError(res, "db_error", "Could not update memory", { exposeDetail: true });
  }
});

router.delete("/compass/me/memories/:memoryId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  try {
    const removed = await forgetMemory(sc, auth.user.id, req.params.memoryId);
    if (!removed) { sendError(res, "not_found", "Memory not found"); return; }
    res.json({ forgotten: true });
  } catch (err) {
    req.log.error({ err, userId: auth.user.id }, "compass/me/memories: delete failed");
    sendError(res, "db_error", "Could not forget memory", { exposeDetail: true });
  }
});

// ── Memory + Experience Intelligence — retrieval, Rediscovery, feedback ───────
// Read side over the projected memory contract (migrations 2183-2188). All three
// derive the caller from auth.uid() — the service_role SQL functions take the id
// as a parameter, so the route MUST pass the authenticated user's own id and
// never a client-supplied one. Empty until the memory_projection flag + projector
// populate the tables.
const MEMORY_SURFACES = ["compass", "discovery", "passport"] as const;

// GET /api/compass/me/memory?surface=compass&limit=20 — ranked memories (§10)
router.get("/compass/me/memory", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }
  const surfaceRaw = typeof req.query.surface === "string" ? req.query.surface : "compass";
  const surface = (MEMORY_SURFACES as readonly string[]).includes(surfaceRaw) ? surfaceRaw : "compass";
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));
  try {
    const { data, error } = await sc.rpc("memory_retrieve", {
      p_user_id: auth.user.id, p_surface: surface, p_limit: limit,
    });
    if (error) throw error;
    res.json({ memories: data ?? [] });
  } catch (err) {
    req.log.error({ err, userId: auth.user.id }, "compass/me/memory: retrieve failed");
    sendError(res, "db_error", "Could not load memory", { exposeDetail: true });
  }
});

// GET /api/compass/me/memory/rediscover?city=Lisbon&limit=20 — Rediscovery (§8)
router.get("/compass/me/memory/rediscover", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }
  const city = typeof req.query.city === "string" ? req.query.city.trim() : "";
  if (!city) { sendError(res, "invalid_payload", "city is required"); return; }
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));
  try {
    const { data, error } = await sc.rpc("memory_rediscover", {
      p_user_id: auth.user.id, p_city: city, p_limit: limit,
    });
    if (error) throw error;
    res.json({ rediscover: data ?? [] });
  } catch (err) {
    req.log.error({ err, userId: auth.user.id }, "compass/me/memory/rediscover failed");
    sendError(res, "db_error", "Could not load rediscovery", { exposeDetail: true });
  }
});

// POST /api/compass/me/memory/feedback — hide/forget/already_known/... (§17)
const memoryFeedbackSchema = z.object({
  kind:         z.enum(["hide", "forget", "incorrect", "not_interested", "already_known"]),
  projectionId: z.string().uuid().optional(),
  subjectType:  z.string().min(1).max(40).optional(),
  subjectId:    z.string().min(1).max(200).optional(),
}).refine((b) => b.projectionId !== undefined || (b.subjectType !== undefined && b.subjectId !== undefined), {
  message: "Provide projectionId, or both subjectType and subjectId",
});
router.post("/compass/me/memory/feedback", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }
  const parsed = memoryFeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { kind, projectionId, subjectType, subjectId } = parsed.data;
  try {
    const { error } = await sc.from("memory_feedback").insert({
      user_id: auth.user.id,
      kind,
      projection_id: projectionId ?? null,
      subject_type: subjectType ?? null,
      subject_id: subjectId ?? null,
    });
    // The dedupe unique index makes a repeat signal idempotent — treat as success.
    if (error && (error as { code?: string }).code !== "23505") throw error;
    res.status(201).json({ recorded: true });
  } catch (err) {
    req.log.error({ err, userId: auth.user.id }, "compass/me/memory/feedback failed");
    sendError(res, "db_error", "Could not record feedback", { exposeDetail: true });
  }
});

// ── GET /api/compass/me/active-reward ─────────────────────────────────────────
// Returns the authenticated user's active-user tier, earned badges, and a
// plain-English visibility status message. Raw score is never exposed.

const TIER_LABELS: Record<string, string> = {
  active_traveler:           "Active Traveler",
  local_guide:               "Local Guide",
  city_connector:            "City Connector",
  city_ambassador_candidate: "City Ambassador Candidate",
};

function buildVisibilityMessage(tier: string, badges: string[]): string {
  if (badges.includes("safety_champion"))      return "Your safety-first approach is building trust across the community.";
  if (badges.includes("trusted_guide"))        return "Your trusted reviews are helping more travelers discover great places.";
  if (badges.includes("city_ambassador_candidate")) return "You're one of the most active travelers in your city — your posts are reaching a wider audience.";
  if (badges.includes("social_connector"))     return "Your connections are expanding your reach to travelers in your network.";
  if (badges.includes("consistent_explorer"))  return "Your consistent activity is keeping your content visible to nearby travelers.";
  switch (tier) {
    case "city_ambassador_candidate": return "Your activity is reaching a wide audience across the city.";
    case "city_connector":            return "Your helpful posts are reaching more travelers around you.";
    case "local_guide":               return "Keep sharing — your posts are gaining more local visibility.";
    default:                          return "Start posting and connecting to grow your travel visibility.";
  }
}

router.get("/compass/me/active-reward", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const nowIso = new Date().toISOString();
  const [scoreRes, badgeRes] = await Promise.all([
    sc
      .from("compass_active_user_scores")
      .select("tier, boost_visibility_enabled")
      .eq("user_id", user.id)
      .maybeSingle(),
    // Badges are persisted by the reward engine into compass_active_user_badges;
    // derive the badge list from eligible, non-expired rows.
    sc
      .from("compass_active_user_badges")
      .select("badge_type, expires_at")
      .eq("user_id", user.id)
      .eq("eligible", true),
  ]);

  if (scoreRes.error) {
    req.log.warn({ err: scoreRes.error, userId: user.id }, "compass/me/active-reward: read failed");
    sendError(res, "db_error", "Could not load active reward", { exposeDetail: true });
    return;
  }
  if (badgeRes.error) {
    req.log.warn({ err: badgeRes.error, userId: user.id }, "compass/me/active-reward: badge read failed");
    sendError(res, "db_error", "Could not load active reward", { exposeDetail: true });
    return;
  }

  const data   = scoreRes.data;
  const tier   = (data as any)?.tier ?? "active_traveler";
  const badges = [
    ...new Set(
      ((badgeRes.data ?? []) as Array<{ badge_type: string; expires_at: string | null }>)
        .filter((b) => b.badge_type && (!b.expires_at || b.expires_at > nowIso))
        .map((b) => b.badge_type),
    ),
  ];
  const boost  = (data as any)?.boost_visibility_enabled !== false;

  res.json({
    tier,
    tierLabel:         TIER_LABELS[tier] ?? "Active Traveler",
    badges,
    visibilityMessage: buildVisibilityMessage(tier, badges),
    boostEnabled:      boost,
  });
});

// ── GET /api/compass/context ──────────────────────────────────────────────────
// Returns the user's persisted recent context session from compass_recent_context.
// Returns { context: null } when no session exists or the session has expired.

router.get("/compass/context", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const now = new Date().toISOString();
  const { data, error } = await sc
    .from("compass_recent_context")
    .select("context_state, intent_mode, city, country, signals, client_hints, expires_at, updated_at")
    .eq("user_id", user.id)
    .gt("expires_at", now)
    .maybeSingle();

  if (error) {
    req.log.warn({ err: error, userId: user.id }, "compass/context GET: read failed");
    sendError(res, "db_error", "Could not load context", { exposeDetail: true });
    return;
  }

  res.json({ context: data ?? null });
});

// ── POST /api/compass/context ─────────────────────────────────────────────────
// Upserts a context session for the user. TTL is 4 hours from submission.

const contextBodySchema = z.object({
  context_state: z.string().max(60).optional(),
  intent_mode:   z.string().max(60).optional(),
  city:          z.string().max(200).optional(),
  country:       z.string().max(200).optional(),
  signals:       z.record(z.unknown()).optional(),
  client_hints:  z.record(z.unknown()).optional(),
});

router.post("/compass/context", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = contextBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 4 * 60 * 60 * 1_000).toISOString();

  const { error } = await sc
    .from("compass_recent_context")
    .upsert(
      {
        user_id:       user.id,
        context_state: parsed.data.context_state ?? "normal",
        intent_mode:   parsed.data.intent_mode   ?? "explore_now",
        city:          parsed.data.city          ?? null,
        country:       parsed.data.country       ?? null,
        signals:       parsed.data.signals       ?? {},
        client_hints:  parsed.data.client_hints  ?? {},
        expires_at:    expiresAt,
        updated_at:    now.toISOString(),
      },
      { onConflict: "user_id" },
    );

  if (error) {
    req.log.warn({ err: error, userId: user.id }, "compass/context POST: upsert failed");
    sendError(res, "db_error", "Could not save context", { exposeDetail: true });
    return;
  }

  res.status(201).json({ ok: true, expires_at: expiresAt });
});

// ── DELETE /api/compass/context ───────────────────────────────────────────────
// Clears the user's persisted context session (e.g., on logout / mode reset).

router.delete("/compass/context", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const { error } = await sc
    .from("compass_recent_context")
    .delete()
    .eq("user_id", user.id);

  if (error) {
    req.log.warn({ err: error, userId: user.id }, "compass/context DELETE: delete failed");
    sendError(res, "db_error", "Could not delete context", { exposeDetail: true });
    return;
  }

  // Also reset feedback-derived ranking signals (category weights + ignored items)
  // so the feed starts fresh. Interests and travel style (user-authored) are
  // preserved — only machine-learned penalty/boost signals are cleared.
  await sc
    .from("compass_user_preferences")
    .update({ category_weights: {}, ignored_item_ids: [] })
    .eq("user_id", user.id);

  res.status(200).json({ ok: true });
});

// ── GET /api/compass/settings ─────────────────────────────────────────────────
// Returns the user's Compass privacy/data-use settings from compass_settings.
// On first access, returns the default settings (all enabled).

const DEFAULT_COMPASS_SETTINGS = {
  use_location:                true,
  use_chosen_city:             true,
  use_trip_data:               true,
  use_saved_items:             true,
  use_history:                 true,
  show_buddy_recommendations:  true,
  show_people_recommendations: true,
  allow_smart_notifications:   true,
  onboarding_completed:        false,
};

const SETTINGS_SELECT_COLS =
  "use_location, use_chosen_city, use_trip_data, use_saved_items, use_history, " +
  "show_buddy_recommendations, show_people_recommendations, allow_smart_notifications, " +
  "onboarding_completed, onboarding_completed_at, updated_at";

router.get("/compass/settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const [settingsResult, locResult] = await Promise.all([
    sc.from("compass_settings").select(SETTINGS_SELECT_COLS).eq("user_id", user.id).maybeSingle(),
    sc.from("user_location_state").select("city").eq("user_id", user.id).maybeSingle(),
  ]);
  const { data, error } = settingsResult;

  if (error) {
    req.log.warn({ err: error, userId: user.id }, "compass/settings GET: read failed");
    sendError(res, "db_error", "Could not load settings", { exposeDetail: true });
    return;
  }

  // Include current_city (from user_location_state) so mobile clients can
  // use it as a real city signal (e.g., cold-start onboarding gate).
  const settingsBase = (data ?? { user_id: user.id, ...DEFAULT_COMPASS_SETTINGS }) as Record<string, unknown>;
  const settingsPayload = {
    ...settingsBase,
    current_city: locResult.data?.city ?? null,
  };
  res.json({ settings: settingsPayload });
});

// ── PATCH /api/compass/settings ───────────────────────────────────────────────
// Partially updates the user's Compass privacy/data-use settings.

const patchSettingsSchema = z.object({
  use_location:                z.boolean().optional(),
  use_chosen_city:             z.boolean().optional(),
  use_trip_data:               z.boolean().optional(),
  use_saved_items:             z.boolean().optional(),
  use_history:                 z.boolean().optional(),
  show_buddy_recommendations:  z.boolean().optional(),
  show_people_recommendations: z.boolean().optional(),
  allow_smart_notifications:   z.boolean().optional(),
  onboarding_completed:        z.boolean().optional(),
});

router.patch("/compass/settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = patchSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  if (Object.keys(parsed.data).length === 0) {
    sendError(res, "invalid_payload", "No settings fields provided");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const upsertData: Record<string, unknown> = {
    user_id:    user.id,
    ...parsed.data,
    updated_at: new Date().toISOString(),
  };

  // When marking onboarding complete, stamp the timestamp
  if (parsed.data.onboarding_completed === true) {
    upsertData["onboarding_completed_at"] = new Date().toISOString();
  }

  const { error } = await sc
    .from("compass_settings")
    .upsert(upsertData, { onConflict: "user_id" });

  if (error) {
    req.log.warn({ err: error, userId: user.id }, "compass/settings PATCH: upsert failed");
    sendError(res, "db_error", "Could not save settings", { exposeDetail: true });
    return;
  }

  const { data: updated } = await sc
    .from("compass_settings")
    .select(SETTINGS_SELECT_COLS)
    .eq("user_id", user.id)
    .maybeSingle();

  res.json({ settings: updated ?? { user_id: user.id, ...DEFAULT_COMPASS_SETTINGS, ...parsed.data } });
});

// ── POST /api/compass/analytics ───────────────────────────────────────────────
// Writes a lightweight client-side analytics event to compass_analytics_events.
// Accepted events: compass_card_viewed, compass_card_tapped,
//   compass_feedback_submitted, compass_settings_changed,
//   compass_onboarding_completed, compass_onboarding_skipped.
// Private fields (coordinates, PII) are stripped before write.

const ALLOWED_ANALYTICS_EVENTS = [
  "compass_card_viewed",
  "compass_card_tapped",
  "compass_feedback_submitted",
  "compass_settings_changed",
  "compass_onboarding_completed",
  "compass_onboarding_skipped",
] as const;

const analyticsBodySchema = z.object({
  event_name:             z.enum(ALLOWED_ANALYTICS_EVENTS),
  compass_engine_version: z.string().max(40).optional(),
  item_id:                z.string().max(255).optional(),
  item_type:              z.string().max(60).optional(),
  section_name:           z.string().max(80).optional(),
  city:                   z.string().max(200).optional(),
  metadata:               z.record(z.unknown()).optional(),
});

router.post("/compass/analytics", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = analyticsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  // Strip any private/sensitive keys from metadata before persisting
  const safeMetadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data.metadata ?? {})) {
    const lower = k.toLowerCase();
    if (lower.includes("lat") || lower.includes("lng") || lower.includes("location") ||
        lower.includes("coord") || lower.includes("email") || lower.includes("phone") ||
        lower.includes("token") || lower.includes("password")) {
      continue;
    }
    safeMetadata[k] = v;
  }

  sc.from("compass_analytics_events")
    .insert({
      user_id:                user.id,
      event_name:             parsed.data.event_name,
      compass_engine_version: parsed.data.compass_engine_version ?? "1.0",
      item_id:                parsed.data.item_id ?? null,
      item_type:              parsed.data.item_type ?? null,
      section_name:           parsed.data.section_name ?? null,
      city:                   parsed.data.city ?? null,
      metadata:               safeMetadata,
    })
    .then(undefined, (err: unknown) => {
      req.log?.warn({ err }, "compass/analytics: insert failed");
    });

  res.status(202).json({ ok: true });
});

// ── POST /api/compass/signals/search ─────────────────────────────────────────
// Fire-and-forget search-signal ingestion.
// Nudges compass_user_preferences.category_weights (+1) for the searched
// category so subsequent For You / Compass feeds reflect search intent.
// Always returns { ok: true } — never blocks the caller.

const searchSignalBodySchema = z.object({
  /** Raw search query text (used for logging; not stored verbatim). */
  query:    z.string().min(1).max(500),
  /** City / destination context of the search (optional). */
  city:     z.string().max(200).optional().nullable(),
  /**
   * Discovery category the user searched within, e.g. "food", "nightlife".
   * When present and not "for_you" / "all", the weight for this category
   * is nudged +1 (clamped to ±10, matching the outcome-feedback nudge size).
   */
  category: z.string().max(100).optional().nullable(),
});

router.post("/compass/signals/search", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = searchSignalBodySchema.safeParse(req.body);
  if (!parsed.success) {
    // Best-effort endpoint — invalid body is not an error the client needs to retry.
    res.status(202).json({ ok: true });
    return;
  }

  const { category } = parsed.data;

  // Respond immediately — weight nudge runs detached so the search flow is never blocked.
  res.status(202).json({ ok: true });

  // Only nudge weights for explicit, non-personalised categories.
  if (!category || category === "for_you" || category === "all") return;

  const sc = getServiceClient();
  if (!sc) return;

  (async () => {
    try {
      const { data } = await sc
        .from("compass_user_preferences")
        .select("category_weights")
        .eq("user_id", user.id)
        .maybeSingle();
      const weights: Record<string, number> =
        ((data as any)?.category_weights as Record<string, number>) ?? {};
      // Nudge +1 toward the searched category, clamped to [-10, +10].
      const prevWeight = weights[category] ?? 0;
      weights[category] = Math.max(-10, Math.min(10, prevWeight + 1));
      // Track only the effective delta: when the weight was already at +10 the
      // clamp means appliedDelta=0 and we must NOT log it — search_weight must
      // reflect real contribution, never clamped-out attempts.
      const appliedDelta = weights[category] - prevWeight;
      const { error } = await sc
        .from("compass_user_preferences")
        .upsert(
          { user_id: user.id, category_weights: weights, updated_at: new Date().toISOString() },
          { onConflict: "user_id" },
        );
      if (!error) {
        req.log?.debug(
          { userId: user.id, category, newWeight: weights[category], appliedDelta },
          "compass/signals/search: category weight nudged",
        );
        // Record the effective nudge in the search-signal decay log so the
        // profile service can time-decay this contribution after
        // SEARCH_SIGNAL_DECAY_DAYS.  logSearchNudge is a no-op when
        // appliedDelta=0 (weight was already at the ±10 clamp).
        await logSearchNudge(sc, user.id, category, appliedDelta);
      }
    } catch (err) {
      req.log?.warn({ err }, "compass/signals/search: weight nudge failed (non-fatal)");
    }
  })();
});

// ── POST /api/compass/report ──────────────────────────────────────────────────
// Dedicated abuse report endpoint for Compass recommendations.
// Writes to compass_feedback (action=report) and triggers the abuse scanner.

const reportBodySchema = z.object({
  recommendationId: z.string().min(1),
  itemId:           z.string().min(1),
  itemType:         z.string().min(1).max(60),
  targetUserId:     z.string().uuid().optional(),
  reason:           z.enum([
    "spam", "inappropriate", "dangerous", "misleading",
    "harassment", "fake_profile", "other",
  ]),
  details:          z.string().max(500).optional(),
});

router.post("/compass/report", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = reportBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const { error } = await sc
    .from("compass_feedback")
    .insert({
      user_id:           user.id,
      item_id:           parsed.data.itemId,
      item_type:         parsed.data.itemType,
      action:            "report",
      recommendation_id: parsed.data.recommendationId,
      metadata: {
        reason:       parsed.data.reason,
        details:      parsed.data.details ?? null,
        targetUserId: parsed.data.targetUserId ?? null,
      },
    });

  if (error) {
    req.log.warn({ err: error, userId: user.id }, "compass/report: insert failed");
    sendError(res, "db_error", "Could not save report", { exposeDetail: true });
    return;
  }

  // Trigger immediate abuse scan when target user is known
  if (parsed.data.targetUserId) {
    triggerOnDemandScan(parsed.data.targetUserId);
  }

  req.log?.info(
    { userId: user.id, itemId: parsed.data.itemId, reason: parsed.data.reason },
    "compass/report: submitted",
  );

  res.status(201).json({ ok: true });
});

// ── GET /api/compass/recommendations ─────────────────────────────────────────
// Returns up to `limit` Compass recommendations for a given surface.
// Used by the Search screen when results are empty (surface=search), the trip
// detail screen (surface=trip), the Passport tab (surface=passport), and other
// surfaces that need a quick recommendation list without the full feed pipeline.
//
// Query params:
//   surface   — "search" | "discovery" | "for_you" | "trip" | "passport" (default: "for_you")
//   q         — raw search query (used for lightweight intent hint)
//   city      — override the user's current city
//   limit     — max items to return (default 6, max 20)
//   startDate — ISO date string for trip surface date-range filter (inclusive)
//   endDate   — ISO date string for trip surface date-range filter (inclusive)

const recommendationsQuerySchema = z.object({
  surface:   z.string().max(40).optional(),
  q:         z.string().max(400).optional(),
  city:      z.string().max(200).optional(),
  limit:     z.coerce.number().int().min(1).max(20).default(6),
  startDate: z.string().max(30).optional(),
  endDate:   z.string().max(30).optional(),
  tripId:    z.string().uuid().optional(),
  sessionId: z.string().max(100).optional(),
});

router.get("/compass/recommendations", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const parsed = recommendationsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }

  const { surface = "for_you", q, city, limit, startDate, endDate, tripId, sessionId } = parsed.data;
  // Preserve a client-supplied sessionId for funnel grouping; otherwise mint
  // one for this request batch so every skip-ranking pipeline below still
  // logs an attributable session_id instead of silently dropping it.
  const effectiveSessionId = sessionId ?? randomUUID();
  const nowMs = Date.now();

  // Feature-flag gate — silently return empty list when Compass is off.
  const enabled = await isCompassEnabled(sc);
  if (!enabled) {
    res.json({ recommendations: [], surface });
    return;
  }

  try {
    const profile = await getCompassProfile(sc, user.id);

    // ── surface=buddy ─────────────────────────────────────────────────────────
    // Separate query pipeline — skip the full Compass feed entirely.
    if (surface === "buddy") {
      // Settings gate (defense-in-depth; frontend also checks before calling)
      const { data: settingsRow } = await sc
        .from("compass_settings")
        .select("show_buddy_recommendations")
        .eq("user_id", user.id)
        .maybeSingle();
      if (settingsRow && (settingsRow as any).show_buddy_recommendations === false) {
        res.json({ recommendations: [], surface, disabled: true });
        return;
      }

      // Bidirectional block set — fail-closed: any error returns empty list
      const buddyBlockedIds = new Set<string>();
      try {
        const { data: blkRows, error: blkErr } = await sc
          .from("blocks")
          .select("blocked_id, blocker_id")
          .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);
        if (blkErr) {
          res.json({ recommendations: [], surface, error: "block_check_failed" });
          return;
        }
        for (const bRow of (blkRows ?? []) as any[]) {
          if (bRow.blocker_id === user.id) buddyBlockedIds.add(bRow.blocked_id);
          if (bRow.blocked_id === user.id) buddyBlockedIds.add(bRow.blocker_id);
        }
      } catch {
        res.json({ recommendations: [], surface, error: "block_check_failed" });
        return;
      }

      const effectiveCity = city ?? profile.currentCity ?? null;

      // Rent-a-Buddy is a real-world meetup service — a buddy in another
      // city can never actually be booked "today" by this viewer. The
      // directory (rent-a-buddy/search) already scopes to the viewer's
      // city; Compass must agree, or it advertises buddies the directory
      // (correctly) says don't exist here. No effectiveCity => no
      // recommendations, matching the directory's "enter a city" state.
      if (!effectiveCity) {
        res.json({ recommendations: [], surface, sessionId: effectiveSessionId });
        return;
      }

      const { data: buddyRows } = await sc
        .from("rent_buddy_profiles")
        .select(
          "id, user_id, display_name, city, country, categories, languages, " +
          "hourly_rate_usd, status, verified, average_rating, review_count, " +
          "cover_photo_url, admin_status, risk_hold",
        )
        .eq("status", "active")
        .ilike("city", effectiveCity);

      const ADULT_CATS = new Set(["escort", "adult", "dating", "romantic", "sexual"]);

      // Pre-filter candidates before availability lookup
      const candidateBuddies = ((buddyRows ?? []) as any[]).filter((b) =>
        b.verified &&
        !buddyBlockedIds.has(b.user_id) &&
        b.admin_status === "active" &&
        !b.risk_hold &&
        !((b.categories ?? []) as string[]).map((c: string) => c.toLowerCase()).some((c: string) => ADULT_CATS.has(c))
      );

      // Fetch availability for ALL candidates BEFORE scoring so it influences rank
      type AvailStatus = "available_today" | "available_this_week" | "not_available";
      const availMap = new Map<string, AvailStatus>();
      for (const b of candidateBuddies) availMap.set(b.id, "not_available");
      if (candidateBuddies.length > 0) {
        const nowDate     = new Date(nowMs);
        const todayStr    = nowDate.toISOString().slice(0, 10);
        const nextWeekStr = new Date(nowDate.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
        const { data: availRows } = await sc
          .from("rent_buddy_availability")
          .select("buddy_id, date")
          .in("buddy_id", candidateBuddies.map((b: any) => b.id))
          .eq("is_available", true)
          .gte("date", todayStr)
          .lte("date", nextWeekStr);
        for (const r of (availRows ?? []) as any[]) {
          if (r.date === todayStr) {
            availMap.set(r.buddy_id, "available_today");
          } else if (availMap.get(r.buddy_id) !== "available_today") {
            availMap.set(r.buddy_id, "available_this_week");
          }
        }
      }

      type BuddyEntry = {
        id: string; userId: string; score: number;
        reasonCode: string; row: any;
      };
      const scoredBuddies: BuddyEntry[] = [];

      for (const b of candidateBuddies) {
        let score = 0;

        const availStatus = availMap.get(b.id) ?? "not_available";
        const cats = ((b.categories ?? []) as string[]).map((c: string) => c.toLowerCase());

        // Availability bonus (top-tier ranking signal — today > this week)
        if (availStatus === "available_today")          score += 35;
        else if (availStatus === "available_this_week") score += 20;

        // City match (25 pts)
        if (effectiveCity && b.city &&
            b.city.toLowerCase() === effectiveCity.toLowerCase()) score += 25;

        // Trust proxy: verified + rating + review volume
        if (b.verified) score += 20;
        score += ((b.average_rating ?? 0) / 5) * 15;
        score += Math.min(b.review_count ?? 0, 10);

        // Language overlap (10 pts)
        const bLangs = ((b.languages ?? []) as string[]).map((l: string) => l.toLowerCase());
        const vLangs = (profile.preferredLanguages ?? []).map((l: string) => l.toLowerCase());
        if (vLangs.length > 0 && bLangs.some((l: string) => vLangs.includes(l))) score += 10;

        // Category overlap with viewer travel styles (10 pts)
        const vStyles = (profile.travelStyles ?? []).map((s: string) => s.toLowerCase());
        const catOverlap = cats.filter((c: string) => vStyles.includes(c));
        if (catOverlap.length > 0) score += 10;

        // Reason code — availability takes priority over city; "city_match" ≠ "available"
        let reasonCode = "verified_buddy";
        if (availStatus === "available_today") {
          reasonCode = "available_today";
        } else if (availStatus === "available_this_week") {
          reasonCode = "available_this_week";
        } else if (effectiveCity && b.city &&
                   b.city.toLowerCase() === effectiveCity.toLowerCase()) {
          reasonCode = "city_match";
        } else if (catOverlap.length > 0) {
          reasonCode = `category_${catOverlap[0]}`;
        } else if (vLangs.length > 0 && bLangs.some((l: string) => vLangs.includes(l))) {
          reasonCode = "language_match";
        }

        scoredBuddies.push({ id: b.id, userId: b.user_id, score, reasonCode, row: b });
      }

      scoredBuddies.sort((a, b) => b.score - a.score);

      const buddyRecommendations = scoredBuddies.slice(0, limit).map((s) => ({
        id:       s.id,
        type:     "buddy",
        category: ((s.row.categories ?? []) as string[])[0] ?? "city",
        title:    s.row.display_name ?? null,
        reason:   buildBuddyReasonText(s.reasonCode, s.row.city ?? effectiveCity, {
          languages: s.row.languages,
        }),
        city:     s.row.city ?? effectiveCity ?? null,
        data: {
          userId:             s.userId,
          verified:           s.row.verified,
          averageRating:      s.row.average_rating ?? null,
          reviewCount:        s.row.review_count ?? 0,
          languages:          s.row.languages ?? [],
          categories:         s.row.categories ?? [],
          coverPhotoUrl:      s.row.cover_photo_url ?? null,
          hourlyRateUsd:      s.row.hourly_rate_usd ?? null,
          availabilityStatus: (availMap.get(s.id) ?? "not_available") as AvailStatus,
          reasonCode:         s.reasonCode,
        },
      }));

      void logCompassImpression(buddyRecommendations, user.id, effectiveSessionId);
      res.json({ recommendations: buddyRecommendations, surface, sessionId: effectiveSessionId });
      return;
    }

    // ── surface=traveler ──────────────────────────────────────────────────────
    if (surface === "traveler") {
      // Settings gate
      const { data: travSettingsRow } = await sc
        .from("compass_settings")
        .select("show_people_recommendations")
        .eq("user_id", user.id)
        .maybeSingle();
      if (travSettingsRow && (travSettingsRow as any).show_people_recommendations === false) {
        res.json({ recommendations: [], surface, disabled: true });
        return;
      }

      // Bidirectional block set — fail-closed: any error returns empty list
      const travBlockedIds = new Set<string>();
      try {
        const { data: blkRows, error: blkErr } = await sc
          .from("blocks")
          .select("blocked_id, blocker_id")
          .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);
        if (blkErr) {
          res.json({ recommendations: [], surface, error: "block_check_failed" });
          return;
        }
        for (const bRow of (blkRows ?? []) as any[]) {
          if (bRow.blocker_id === user.id) travBlockedIds.add(bRow.blocked_id);
          if (bRow.blocked_id === user.id) travBlockedIds.add(bRow.blocker_id);
        }
      } catch {
        res.json({ recommendations: [], surface, error: "block_check_failed" });
        return;
      }

      const effectiveCity = city ?? profile.currentCity ?? null;

      const { data: travelerRows } = await sc
        .from("profiles")
        .select(
          "id, username, display_name, name, avatar_url, show_profile_picture_publicly, home_city, home_country, " +
          "spoken_languages, interests, verified, account_status, is_private, created_at",
        )
        .neq("id", user.id)
        .in("account_status", ["active"])
        .limit(50);

      // Pre-filter blocked users to obtain candidate IDs for batch signal queries
      const travCandidates = ((travelerRows ?? []) as any[]).filter((p) => !travBlockedIds.has(p.id));
      const travCandidateIds = travCandidates.map((p: any) => p.id as string);

      // ── Mutual connections (batch) ──────────────────────────────────────────
      // People who both the viewer and the traveler follow
      const mutualCountMap = new Map<string, number>();
      if (travCandidateIds.length > 0) {
        const { data: aliceFollowRows } = await sc
          .from("user_follows")
          .select("following_id")
          .eq("follower_id", user.id);
        const aliceFollowsSet = new Set<string>(
          ((aliceFollowRows ?? []) as any[]).map((r: any) => r.following_id as string),
        );
        if (aliceFollowsSet.size > 0) {
          const { data: mutualRows } = await sc
            .from("user_follows")
            .select("follower_id, following_id")
            .in("following_id", travCandidateIds)
            .in("follower_id", [...aliceFollowsSet]);
          for (const r of (mutualRows ?? []) as any[]) {
            mutualCountMap.set(r.following_id, (mutualCountMap.get(r.following_id) ?? 0) + 1);
          }
        }
      }

      // ── Upcoming destination overlap (batch) ────────────────────────────────
      // Travelers heading to the same cities as the viewer's upcoming trips
      const destOverlapSet = new Set<string>();
      if (travCandidateIds.length > 0) {
        const nowStr = new Date(nowMs).toISOString().slice(0, 10);
        const { data: aliceTripRows } = await sc
          .from("trips")
          .select("destination_city")
          .eq("owner_id", user.id)
          .in("status", ["upcoming", "active"])
          .gte("end_date", nowStr);
        const aliceDestinations = new Set<string>(
          ((aliceTripRows ?? []) as any[])
            .map((t: any) => (t.destination_city as string)?.toLowerCase().trim())
            .filter(Boolean),
        );
        if (aliceDestinations.size > 0) {
          const { data: travTripRows } = await sc
            .from("trips")
            .select("owner_id, destination_city")
            .in("owner_id", travCandidateIds)
            .in("status", ["upcoming", "active"])
            .in("visibility", ["public", "friends"])
            .gte("end_date", nowStr);
          for (const t of (travTripRows ?? []) as any[]) {
            const dest = (t.destination_city as string)?.toLowerCase().trim();
            if (dest && aliceDestinations.has(dest)) destOverlapSet.add(t.owner_id);
          }
        }
      }

      type TravelerEntry = {
        id: string; score: number; reasonCode: string;
        sharedInterests: string[]; row: any;
      };
      const scoredTravelers: TravelerEntry[] = [];

      for (const p of travCandidates) {
        let score = 0;

        // Mutual connections (20 pts max — capped at 5 shared connections × 4 pts)
        const mutualCount = mutualCountMap.get(p.id) ?? 0;
        score += Math.min(mutualCount * 4, 20);

        // Destination overlap (15 pts — heading to the same city)
        if (destOverlapSet.has(p.id)) score += 15;

        // Shared interest overlap (30 pts max)
        const pInterests = ((p.interests ?? []) as string[]).map((i: string) => i.toLowerCase());
        const vStyles    = (profile.travelStyles ?? []).map((s: string) => s.toLowerCase());
        const sharedInterests = pInterests.filter((i: string) => vStyles.includes(i));
        const overlapRatio =
          vStyles.length > 0 && pInterests.length > 0
            ? sharedInterests.length / Math.max(vStyles.length, pInterests.length)
            : 0;
        score += overlapRatio * 30;

        // City overlap (20 pts)
        if (effectiveCity && p.home_city &&
            p.home_city.toLowerCase() === effectiveCity.toLowerCase()) score += 20;

        // Language match (15 pts)
        const pLangs = ((p.spoken_languages ?? []) as string[]).map((l: string) => l.toLowerCase());
        const vLangs = (profile.preferredLanguages ?? []).map((l: string) => l.toLowerCase());
        if (vLangs.length > 0 && pLangs.some((l: string) => vLangs.includes(l))) score += 15;

        // Activity freshness proxy via created_at (10 pts max)
        if (p.created_at) {
          const ageDays = (nowMs - new Date(p.created_at).getTime()) / 86_400_000;
          score += Math.max(0, 10 * Math.pow(2, -ageDays / 90));
        }

        // Verified (10 pts)
        if (p.verified) score += 10;

        // Reason code — mutual > destination > interests > city > language
        let reasonCode = "similar_interests";
        if (mutualCount > 0) {
          reasonCode = "mutual_connections";
        } else if (destOverlapSet.has(p.id)) {
          reasonCode = "destination_overlap";
        } else if (sharedInterests.length > 0) {
          reasonCode = "shared_interests";
        } else if (effectiveCity && p.home_city &&
                   p.home_city.toLowerCase() === effectiveCity.toLowerCase()) {
          reasonCode = "city_overlap";
        } else if (vLangs.length > 0 && pLangs.some((l: string) => vLangs.includes(l))) {
          reasonCode = "language_match";
        }

        scoredTravelers.push({
          id:              p.id,
          score,
          reasonCode,
          sharedInterests: sharedInterests.slice(0, 3),
          row:             p,
        });
      }

      scoredTravelers.sort((a, b) => b.score - a.score);

      const topTravSlice = scoredTravelers.slice(0, limit);
      const topTravIds   = topTravSlice.map((s) => s.id);

      // Batch-check which travelers the viewer already follows
      const followingSet  = new Set<string>();
      const friendSet     = new Set<string>();
      const requestedSet  = new Set<string>();
      if (topTravIds.length > 0) {
        const { data: followRows } = await sc
          .from("user_follows")
          .select("following_id")
          .eq("follower_id", user.id)
          .in("following_id", topTravIds);
        for (const r of (followRows ?? []) as any[]) followingSet.add(r.following_id);

        // Friend set — user_friendships stores the normalized (min, max) pair
        // (see normalizedFriendshipPair in lib/friendDecisions.ts), so which
        // side `user.id` lands on depends on UUID comparison; both directions
        // must be queried. Mirrors discoverySearch's friendSet construction.
        const [friendsAsA, friendsAsB] = await Promise.all([
          sc.from("user_friendships").select("user_b").eq("user_a", user.id).in("user_b", topTravIds),
          sc.from("user_friendships").select("user_a").eq("user_b", user.id).in("user_a", topTravIds),
        ]);
        for (const r of (friendsAsA.data ?? []) as any[]) friendSet.add(r.user_b as string);
        for (const r of (friendsAsB.data ?? []) as any[]) friendSet.add(r.user_a as string);

        // For private profiles not yet followed, check for a pending follow request
        const privateUnfollowed = topTravSlice
          .filter((s) => s.row.is_private && !followingSet.has(s.id))
          .map((s) => s.id);
        if (privateUnfollowed.length > 0) {
          const { data: reqRows } = await sc
            .from("friend_requests")
            .select("recipient_id")
            .eq("requester_id", user.id)
            .eq("status", "pending")
            .in("recipient_id", privateUnfollowed);
          for (const r of (reqRows ?? []) as any[]) requestedSet.add(r.recipient_id);
        }
      }

      // Universal display-name rule: real names only for opted-in travelers.
      const allowedTravNames = await nameVisibilitySet(sc, topTravSlice.map((s) => s.id));
      const travelerRecommendations = topTravSlice.map((s) => {
        const nameOk = allowedTravNames.has(s.id);
        const isPrivate = s.row.is_private ?? false;
        const isFollowing = followingSet.has(s.id);
        const isFriend = friendSet.has(s.id);
        // Avatar gate (mirrors discoverySearch): a private account the viewer
        // already follows behaves like a public one, and a public account's
        // owner can still opt out via show_profile_picture_publicly (default
        // true). The !avatarPrivate term closes the private-avatar leak.
        const avatarPrivate = isPrivate && !isFollowing;
        const showAvatar = isFollowing || isFriend || s.row.show_profile_picture_publicly !== false;
        const followStatus: "following" | "requested" | "not_following" =
          followingSet.has(s.id) ? "following"
          : requestedSet.has(s.id) ? "requested"
          : "not_following";
        return {
          id:       s.id,
          type:     "traveler",
          category: "traveler",
          // Universal display-name rule: hidden names fall back to @username
          // (and to null for private non-followed profiles, which suppress it).
          title: nameOk
            ? ((s.row.display_name ?? s.row.name ?? s.row.username ?? null) as string | null)
            : (isPrivate && !followingSet.has(s.id)
              ? null
              : ((s.row.username ?? null) as string | null)),
          reason:   buildTravelerReasonText(s.reasonCode, isPrivate ? [] : s.sharedInterests, isPrivate ? null : (s.row.home_city ?? null)),
          city:     isPrivate ? null : ((s.row.home_city ?? null) as string | null),
          data: {
            userId:          s.id,
            // Private profiles: suppress identifying details until followed
            username:        isPrivate ? null : ((s.row.username ?? null) as string | null),
            displayName:     nameOk ? ((s.row.display_name ?? s.row.name ?? null) as string | null) : null,
            avatarUrl:       (!avatarPrivate && showAvatar) ? ((s.row.avatar_url ?? null) as string | null) : null,
            homeCity:        isPrivate ? null : ((s.row.home_city ?? null) as string | null),
            isPrivate,
            verified:        s.row.verified ?? false,
            sharedInterests: isPrivate ? [] : s.sharedInterests,
            reasonCode:      s.reasonCode,
            followStatus,
          },
        };
      });

      void logCompassImpression(travelerRecommendations, user.id, effectiveSessionId);
      res.json({ recommendations: travelerRecommendations, surface, sessionId: effectiveSessionId });
      return;
    }

    // Allow caller to override the context city.
    const effectiveProfile = city ? { ...profile, currentCity: city } : profile;

    const signals = defaultSignals(
      effectiveProfile as typeof profile,
      await localHourForRequest(sc, user.id, req),
    );
    const context = buildCompassContext(effectiveProfile as typeof profile, signals);
    const items   = await hydrateCompassItems(sc, effectiveProfile as typeof profile);

    // Choose section and type whitelist by surface
    const sectionName: SectionName =
      surface === "search" ? "compass_picks" : "for_you";

    const { section: feedSection } = await buildSection(
      sectionName,
      items,
      effectiveProfile as typeof profile,
      context,
      sc,
    );

    let candidateItems: any[] = feedSection?.items ?? [];

    // ── Surface-specific post-filtering ──────────────────────────────────────

    if (surface === "trip") {
      // passesTripFilter: type whitelist + visibility + date-range (see CompassSurfaceFilters.ts)
      candidateItems = candidateItems.filter((fi: any) => passesTripFilter(fi, startDate, endDate));

      // Member-list signal: when tripId is supplied, fetch trip members and boost items
      // authored by or attended by a trip member (surface them first in the ranked list).
      if (tripId) {
        try {
          const { data: memberRows } = await sc
            .from("trip_members")
            .select("user_id")
            .eq("trip_id", tripId);

          const memberSet = new Set<string>(
            ((memberRows ?? []) as any[]).map((r: any) => r.user_id as string),
          );

          if (memberSet.size > 0) {
            // Partition: member-authored items first, then the rest (stable relative order)
            const memberItems = candidateItems.filter((fi: any) => {
              const inner = fi.item ?? fi;
              const authorId = inner.authorId ?? inner.data?.host_id ?? inner.data?.submitted_by;
              return authorId && memberSet.has(authorId);
            });
            const otherItems = candidateItems.filter((fi: any) => {
              const inner = fi.item ?? fi;
              const authorId = inner.authorId ?? inner.data?.host_id ?? inner.data?.submitted_by;
              return !(authorId && memberSet.has(authorId));
            });
            candidateItems = [...memberItems, ...otherItems];
          }
        } catch {
          // Non-fatal: member signal is best-effort; continue without it
        }
      }
    } else if (surface === "passport") {
      // Load block list — fail-CLOSED: on any error, return empty to prevent leaking blocked users
      let blockedIds: Set<string>;
      try {
        const { data: blocks, error: blocksErr } = await sc
          .from("blocks")
          .select("blocked_id")
          .eq("blocker_id", user.id);
        if (blocksErr) {
          req.log.warn({ err: blocksErr }, "compass/recommendations: block-list fetch failed; returning empty");
          res.json({ recommendations: [], surface });
          return;
        }
        blockedIds = new Set<string>();
        for (const b of (blocks ?? []) as any[]) {
          if (b.blocked_id) blockedIds.add(b.blocked_id);
        }
      } catch (err) {
        req.log.warn({ err }, "compass/recommendations: block-list fetch threw; returning empty");
        res.json({ recommendations: [], surface });
        return;
      }

      candidateItems = candidateItems.filter((fi: any) => passesPassportFilter(fi, blockedIds));
    }

    const topItems = candidateItems.slice(0, limit);

    const recommendations = topItems.map((fi: any) => {
      const inner = fi.item ?? fi;
      const type  = String(inner.type ?? fi.type ?? "");
      return {
        id:       String(inner.id ?? fi.id ?? ""),
        type,
        category: String(inner.category ?? fi.category ?? ""),
        title:    inner.title ?? fi.title ?? null,
        reason:   buildReasonText(type, fi.explanationKey, city ?? profile.currentCity ?? null),
        city:     inner.city ?? (inner.data?.city as string | undefined) ?? city ?? profile.currentCity ?? null,
        data:     inner.data ?? null,
      };
    });

    // ── Static trip-surface items: safety note + language tip ─────────────────
    // Appended after scored items, up to limit. Scope to trip surface only.
    if (surface === "trip") {
      const effectiveCity = city ?? profile.currentCity ?? null;
      const remaining = limit - recommendations.length;

      if (remaining > 0 && effectiveCity) {
        recommendations.push({
          id:       `static_safety_tip_${effectiveCity.toLowerCase().replace(/\s+/g, "_")}`,
          type:     "safety_tip",
          category: "safety",
          title:    `Safety Note — ${effectiveCity}`,
          reason:   `Check current travel advisories and local emergency contacts for ${effectiveCity} before you go.`,
          city:     effectiveCity,
          data:     null,
        });
      }

      if (remaining > 1 && effectiveCity) {
        // Simple city → primary language lookup for common travel destinations
        const CITY_LANG: Record<string, string> = {
          "tokyo": "ja",     "osaka": "ja",     "kyoto": "ja",
          "paris": "fr",     "lyon": "fr",       "marseille": "fr",
          "berlin": "de",    "munich": "de",     "hamburg": "de",
          "madrid": "es",    "barcelona": "es",  "seville": "es",
          "rome": "it",      "milan": "it",      "naples": "it",
          "beijing": "zh",   "shanghai": "zh",   "guangzhou": "zh",
          "seoul": "ko",     "busan": "ko",
          "moscow": "ru",    "saint petersburg": "ru",
          "istanbul": "tr",  "ankara": "tr",
          "bangkok": "th",   "chiang mai": "th", "phuket": "th",
          "jakarta": "id",   "bali": "id",       "surabaya": "id",
          "ho chi minh city": "vi", "hanoi": "vi",
          "mumbai": "hi",    "delhi": "hi",      "jaipur": "hi",
          "cairo": "ar",     "dubai": "ar",      "abu dhabi": "ar", "riyadh": "ar",
          "amsterdam": "nl", "rotterdam": "nl",
          "warsaw": "pl",    "krakow": "pl",
          "lisbon": "pt",    "porto": "pt",     "sao paulo": "pt", "rio de janeiro": "pt",
          "athens": "el",    "stockholm": "sv",
          "manila": "fil",   "cebu": "fil",
        };
        const LANG_NAMES: Record<string, string> = {
          ja: "Japanese", fr: "French", de: "German", es: "Spanish",
          it: "Italian", zh: "Chinese (Mandarin)", ko: "Korean",
          ru: "Russian", tr: "Turkish", th: "Thai", id: "Indonesian",
          vi: "Vietnamese", hi: "Hindi", ar: "Arabic", nl: "Dutch",
          pl: "Polish", pt: "Portuguese", el: "Greek", sv: "Swedish",
          fil: "Filipino (Tagalog)",
        };
        const destLang = CITY_LANG[effectiveCity.toLowerCase()] ?? null;
        const userLangs = new Set(
          ((profile as any).preferred_languages ?? []).map((l: string) => l.toLowerCase().split("-")[0]),
        );
        const isEnglishUser = userLangs.size === 0 || userLangs.has("en");
        const isDestEnglish = !destLang || destLang === "en";

        if (destLang && LANG_NAMES[destLang] && !userLangs.has(destLang) && !(isEnglishUser && isDestEnglish)) {
          const langName = LANG_NAMES[destLang];
          recommendations.push({
            id:       `static_language_tip_${effectiveCity.toLowerCase().replace(/\s+/g, "_")}`,
            type:     "language_tip",
            category: "language",
            title:    `${langName} Spoken Here`,
            reason:   `${effectiveCity} is primarily ${langName}-speaking. A few phrases like "hello" and "thank you" go a long way!`,
            city:     effectiveCity,
            data:     null,
          });
        }
      }
    }

    void logCompassImpression(recommendations, user.id, effectiveSessionId);
    res.json({ recommendations, surface, sessionId: effectiveSessionId });
  } catch (err) {
    req.log.error({ err }, "compass/recommendations: build failed");
    res.json({ recommendations: [], surface });
  }
});

// ── POST /api/compass/create-suggestions ─────────────────────────────────────
// Returns up to 3 category/vibe suggestions for an event being created, derived
// from keyword matching against the draft title.
// Used by the Create Event screen to show dismissible category chip hints.
//
// Body: { type: "event", titleDraft: string }
// Response: { suggestions: Array<{ category: string; vibe: string; reason: string }> }

const createSuggestionsSchema = z.object({
  type:       z.literal("event"),
  titleDraft: z.string().min(1).max(400),
});

// Keyword → category map (longest match wins; keywords are substrings lowercased)
const CATEGORY_KEYWORDS: Array<{ category: string; vibe: string; keywords: string[]; reason: string }> = [
  { category: "Hiking",        vibe: "adventure",   keywords: ["hike", "hik", "trail", "trek", "mountain", "climb", "summit", "waterfall"],        reason: "Outdoor adventure vibes from your title" },
  { category: "Beach & Water", vibe: "chill",       keywords: ["beach", "surf", "swim", "ocean", "sea", "island", "snorkel", "dive", "boat"],      reason: "Beach or water activity detected" },
  { category: "Food & Drinks", vibe: "social",      keywords: ["food", "eat", "dinner", "lunch", "brunch", "breakfast", "restaurant", "cafe", "coffee", "cook", "taste", "wine", "beer", "bbq", "grill", "feast"], reason: "Food or drink event vibe" },
  { category: "Nightlife",     vibe: "party",       keywords: ["night", "party", "club", "dance", "dj", "rave", "bar hop", "pub", "drinks", "karaoke", "fiesta"], reason: "Nightlife energy in your title" },
  { category: "Music",         vibe: "culture",     keywords: ["music", "concert", "band", "live", "show", "festival", "gig", "acoustic", "jam", "sing"], reason: "Music or performance theme" },
  { category: "Culture",       vibe: "explore",     keywords: ["museum", "art", "gallery", "culture", "history", "heritage", "temple", "church", "tour", "exhibit", "craft"], reason: "Cultural experience theme" },
  { category: "Sports",        vibe: "active",      keywords: ["sport", "game", "match", "football", "basketball", "volleyball", "run", "marathon", "cycling", "bike", "yoga", "fitness", "workout", "gym", "tennis", "badminton"], reason: "Active or sports theme" },
  { category: "Photography",   vibe: "creative",    keywords: ["photo", "photoshoot", "shoot", "sunset", "sunrise", "lightroom", "golden hour", "portrait"], reason: "Photography or visual art" },
  { category: "Adventure",     vibe: "thrill",      keywords: ["adventure", "extreme", "skydiv", "paraglid", "zipline", "rappel", "abseil", "caving", "bungee"], reason: "Thrill-seeking adventure" },
  { category: "Wellness",      vibe: "relaxed",     keywords: ["yoga", "meditat", "spa", "wellness", "retreat", "mindful", "breathwork", "detox", "pilates"], reason: "Wellness or self-care theme" },
  { category: "Social",        vibe: "community",   keywords: ["meetup", "network", "socializ", "hangout", "chill", "mingle", "connect", "community", "expat", "traveler meetup", "language exchange"], reason: "Social gathering vibe" },
  { category: "Shopping",      vibe: "explore",     keywords: ["shop", "market", "bazaar", "flea", "vintage", "thrift", "swap", "mall"],            reason: "Shopping or market visit" },
  { category: "Nature",        vibe: "chill",       keywords: ["nature", "forest", "garden", "park", "wildlife", "bird", "picnic", "scenic", "botanical"], reason: "Nature outing detected" },
];

function inferEventCategories(titleDraft: string): Array<{ category: string; vibe: string; reason: string }> {
  const lower = titleDraft.toLowerCase();
  const matched: Array<{ category: string; vibe: string; reason: string; score: number }> = [];

  for (const entry of CATEGORY_KEYWORDS) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (lower.includes(kw)) score += kw.length; // longer matches score higher
    }
    if (score > 0) matched.push({ category: entry.category, vibe: entry.vibe, reason: entry.reason, score });
  }

  matched.sort((a, b) => b.score - a.score);
  return matched.slice(0, 3).map(({ category, vibe, reason }) => ({ category, vibe, reason }));
}

router.post("/compass/create-suggestions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const parsed = createSuggestionsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const { titleDraft } = parsed.data;
  const suggestions = inferEventCategories(titleDraft);

  res.json({ suggestions, type: "event" });
});

// ── Buddy reason text ─────────────────────────────────────────────────────────
function buildBuddyReasonText(
  reasonCode: string,
  city: string | null,
  buddyData: Record<string, unknown>,
): string {
  if (reasonCode === "available_today") return city ? `Available today in ${city}` : "Available today";
  if (reasonCode === "available_this_week") return city ? `Available this week in ${city}` : "Available this week";
  if (reasonCode === "city_match" && city) return `Based in ${city}`;
  if (reasonCode.startsWith("category_")) {
    const cat = reasonCode.replace("category_", "");
    const CAT_LABELS: Record<string, string> = {
      nightlife: "nightlife", city: "city exploring", language: "language support",
      shopping: "shopping", arrival: "airport arrival", content: "content creation",
      adventure: "group adventures", food: "food & dining", nature: "nature trips",
      culture: "cultural tours", wellness: "wellness", other: "local experiences",
    };
    return `Verified buddy for ${CAT_LABELS[cat] ?? cat}`;
  }
  if (reasonCode === "language_match") {
    const langs = (buddyData.languages as string[] | undefined) ?? [];
    return langs.length > 0 ? `Speaks ${langs.slice(0, 2).join(" & ")}` : "Language match";
  }
  return "Verified buddy";
}

// ── Traveler reason text ──────────────────────────────────────────────────────
function buildTravelerReasonText(
  reasonCode: string,
  sharedInterests: string[],
  city: string | null,
): string {
  if (reasonCode === "mutual_connections") return "People you both follow";
  if (reasonCode === "destination_overlap") return "Heading to the same destination";
  if (reasonCode === "shared_interests" && sharedInterests.length > 0) {
    return `Shared interests: ${sharedInterests.slice(0, 2).join(", ")}`;
  }
  if (reasonCode === "city_overlap" && city) return `Also travels to ${city}`;
  if (reasonCode === "language_match") return "Language match";
  return "Similar travel style";
}

// ── Reason text helper ────────────────────────────────────────────────────────
function buildReasonText(type: string, explanationKey: string | undefined, city: string | null): string {
  if (explanationKey) {
    if (type === "event") return "Upcoming event matching your interests";
    if (type === "place" || type === "hidden_gem") return "Hidden gem near your destination";
    if (type === "user" || type === "traveler") return "Traveler you may want to follow";
  }
  if (city) return `Top pick in ${city}`;
  return "Recommended for you";
}

// ── GET /api/compass/debug/recommendations ────────────────────────────────────
// Admin-only debug view of recent served recommendations.
// Returns the last 100 rows from compass_served_recommendations for a user,
// or across all users if no userId query param is provided.

router.get("/compass/debug/recommendations", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  // Admin gate: must have profiles.role = 'admin'
  const { data: profileRow, error: profileErr } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profileErr || !profileRow || (profileRow as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const targetUserId = typeof req.query.userId === "string" ? req.query.userId : null;
  const limit        = Math.min(Number(req.query.limit ?? 100), 200);

  let query = sc
    .from("compass_served_recommendations")
    .select("recommendation_id, user_id, item_id, item_type, section_name, explanation_key, created_at, explanation_looked_up_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (targetUserId) {
    query = query.eq("user_id", targetUserId);
  }

  const { data, error } = await query;

  if (error) {
    req.log.warn({ err: error }, "compass/debug/recommendations: read failed");
    sendError(res, "db_error", "Could not load recommendations", { exposeDetail: true });
    return;
  }

  res.json({
    recommendations: data ?? [],
    count:           (data ?? []).length,
    filter_user_id:  targetUserId,
  });
});

// ── GET /api/compass/telegraph ─────────────────────────────────────────────
// Returns up to 4 Compass recommendation cards relevant to a chat thread.
// Used by the Ask Compass chip in the Telegraph compose bar.
//
// Query params:
//   threadId — the message thread UUID (required)
//
// Auth required.
// Feature-flag gated: compass_telegraph (COMPASS_TELEGRAPH flag).
// Rate-limited: 5 requests per minute per user.
//
// Privacy rules:
//   - Only returns content accessible to ALL thread participants.
//   - Private/invite-only items are excluded.
//   - Blocked user content is excluded.
//   - The caller must be an active member of the thread.

const TELEGRAPH_SURFACE_TYPES = new Set(["event", "place", "hidden_gem", "activity"]);
const TELEGRAPH_RATE_LIMIT    = 5;
const TELEGRAPH_WINDOW_MS     = 60_000; // 1 minute

const telegraphQuerySchema = z.object({
  threadId: z.string().uuid({ message: "threadId must be a valid UUID" }),
});

router.get("/compass/telegraph", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  // Feature flag gate
  const telegraphEnabled = await isEnabled(sc, "COMPASS_TELEGRAPH").catch(() => false);
  if (!telegraphEnabled) {
    sendError(res, "feature_disabled", "compass_telegraph feature is not enabled");
    return;
  }

  // Rate limit: 5 requests per minute per user
  const rl = checkRateLimit("compass_telegraph", user.id, TELEGRAPH_RATE_LIMIT, TELEGRAPH_WINDOW_MS);
  if (!rl.allowed) {
    res.status(429).json({
      error:        "rate_limited",
      message:      "Too many Compass requests — please wait a moment.",
      retryAfterMs: rl.retryAfterMs,
    });
    return;
  }

  // Validate threadId
  const parsed = telegraphQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid threadId");
    return;
  }
  const { threadId } = parsed.data;

  // Verify caller is an active member of the thread
  const { data: membership } = await sc
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", threadId)
    .eq("user_id", user.id)
    .is("left_at", null)
    .maybeSingle();

  if (!membership) {
    sendError(res, "forbidden", "Not a member of this thread");
    return;
  }

  try {
    // Load all active thread participants
    const { data: memberRows } = await sc
      .from("message_thread_members")
      .select("user_id")
      .eq("thread_id", threadId)
      .is("left_at", null);

    const participantIds: string[] = (memberRows as any[] ?? []).map((r: any) => r.user_id as string);

    // Resolve city context:
    // 1. Trip city (if this is a trip thread)
    // 2. Participants' home cities
    let cityContext: string | null = null;
    let tripId: string | null = null;

    const { data: threadRow } = await sc
      .from("message_threads")
      .select("thread_type, trip_id")
      .eq("id", threadId)
      .maybeSingle();

    tripId = (threadRow as any)?.trip_id ?? null;

    if (tripId) {
      const { data: tripRow } = await sc
        .from("trips")
        .select("destination_city")
        .eq("id", tripId)
        .maybeSingle();
      cityContext = (tripRow as any)?.destination_city ?? null;
    }

    // Fallback: use viewer's Compass profile city, or participants' cities
    if (!cityContext) {
      const profile = await getCompassProfile(sc, user.id).catch(() => null);
      cityContext = profile?.currentCity ?? null;
    }

    if (!cityContext && participantIds.length > 0) {
      const { data: profileRows } = await sc
        .from("profiles")
        .select("home_city")
        .in("id", participantIds.filter((id) => id !== user.id));
      const cities = ((profileRows as any[]) ?? [])
        .map((r: any) => r.home_city as string | null)
        .filter(Boolean);
      cityContext = cities[0] ?? null;
    }

    // Load caller's Compass profile for scoring/filtering
    const viewerProfile = await getCompassProfile(sc, user.id).catch(() => null);
    const effectiveProfile = viewerProfile
      ? (cityContext ? { ...viewerProfile, currentCity: cityContext } : viewerProfile)
      : null;

    if (!effectiveProfile) {
      // Return empty gracefully when profile is unavailable
      res.json({ cards: [], city: cityContext });
      return;
    }

    // Hydrate compass items (uses city context from the profile)
    const rawItems = await hydrateCompassItems(sc, effectiveProfile);

    // Filter to telegraph-eligible types and public-only.
    // Deny-by-default: items without an explicit visibility === "public" are
    // excluded so missing metadata never inadvertently surfaces private content.
    const eligible = rawItems.filter((item) => {
      if (!TELEGRAPH_SURFACE_TYPES.has(item.type)) return false;
      const vis = (item as any).data?.visibility ?? (item as any).visibility;
      if (vis !== "public") return false;
      return true;
    });

    // Score and rank via the pipeline
    const signals = defaultSignals(effectiveProfile, await localHourForRequest(sc, user.id, req));
    const context = buildCompassContext(effectiveProfile, signals);

    // Build section to get scored, ranked items
    const { section: feedSection } = await buildSection(
      "for_you",
      eligible,
      effectiveProfile,
      context,
      sc,
    );

    // Take up to 4 cards, projecting to a safe public shape
    const cards = (feedSection?.items ?? []).slice(0, 4).map((fi: any) => {
      const inner = fi.item ?? fi;
      return {
        id:          String(inner.id ?? fi.id ?? ""),
        type:        String(inner.type ?? fi.type ?? ""),
        title:       inner.title ?? fi.title ?? null,
        city:        inner.city ?? inner.data?.city ?? cityContext ?? null,
        category:    inner.category ?? inner.data?.category ?? null,
        description: inner.description ?? inner.data?.description ?? inner.blurb ?? inner.data?.blurb ?? null,
        imageUrl:    inner.imageUrl ?? inner.image_url ?? inner.data?.imageUrl ?? null,
        // Include public-safe subset of data — no private/exact-location fields
        data: (() => {
          const d: Record<string, unknown> = {};
          const src = inner.data ?? {};
          for (const key of ["title", "city", "category", "type", "startsAt", "rating", "neighborhood", "venueType"]) {
            if (src[key] !== undefined) d[key] = src[key];
          }
          return Object.keys(d).length > 0 ? d : undefined;
        })(),
      };
    });

    req.log?.info({ userId: user.id, threadId, cardCount: cards.length, city: cityContext }, "compass/telegraph: served");
    res.json({ cards, city: cityContext });
  } catch (err) {
    req.log?.error({ err }, "compass/telegraph: build failed");
    // Always fail open — return empty cards rather than an error
    res.json({ cards: [], city: null });
  }
});

export default router;
