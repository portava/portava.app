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
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import { isCompassEnabled, isEnabled } from "../compass/flags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { getCompassProfile } from "../compass/CompassProfileService.js";
import { buildCompassContext, defaultSignals } from "../compass/CompassContextEngine.js";
import { deriveIntentMode } from "../compass/CompassIntentModeEngine.js";
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
  decodeRecommendationToken,
  encodeRecommendationToken,
} from "../compass/CompassExplanationEngine.js";
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
import {
  TRIP_SURFACE_TYPES,
  PASSPORT_SURFACE_TYPES,
  passesTripFilter,
  passesPassportFilter,
} from "../compass/CompassSurfaceFilters.js";

const router = Router();

// ── Feed recommendation enrichment ────────────────────────────────────────────
// Generates HMAC-signed recommendationId tokens for each feed item, adds them
// to the response payload (so the client can call /why), and returns DB rows
// ready for pre-registration in compass_served_recommendations.
//
// Tokens are generated exactly once per item — same token used for both the
// response and the DB write (no double-generation).

interface RecommendationRow {
  user_id:           string;
  recommendation_id: string;
  explanation_key:   string;
  item_id:           string;
  item_type:         string;
  section_name:      string;
}

function enrichFeedWithRecommendationIds(
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
      });
      return { ...item, recommendationId: token };
    }),
  }));

  return { enrichedFeed: { ...feed, sections: enrichedSections }, registrationRows };
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

    // Build signals from profile (server clock + profile booleans)
    const signals = defaultSignals(profile);

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
  } catch { /* degrade gracefully */ }

  if (!feedEnabled) {
    res.json({ sections: [], nextCursor: null, fallback: true });
    return;
  }

  // Check COMPASS_FALLBACK_MODE_ENABLED — proactively return safe fallback
  // before even attempting the full pipeline.
  const fallbackModeOn = await isFallbackModeEnabled(sc);
  if (fallbackModeOn) {
    const profile = await getCompassProfile(sc, user.id).catch(() => null);
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
    const cacheKey = `feed:${cursor ?? "first_page"}`;

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
    const rawSignals = defaultSignals(profile);
    // Gate trip-data signals when user has disabled trip-data personalisation
    if (settings.use_trip_data === false) {
      rawSignals.activeTripNow           = false;
      rawSignals.upcomingTripWithin48h   = false;
      rawSignals.hasFutureTripScheduled  = false;
      rawSignals.activeBooking           = false;
    }
    const signals  = rawSignals;
    const context  = buildCompassContext(profile, signals);

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
      await sc
        .from("compass_served_recommendations")
        .upsert(registrationRows, { onConflict: "recommendation_id" });
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
    const cacheKey = `section:${sectionParam}:${cursor ?? "first_page"}`;

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
    const sectionRawSignals = defaultSignals(profile);
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
      });
      return { ...item, recommendationId: token };
    });

    // Pre-register tokens (fire-and-forget — /why route does authoritative lookup)
    if (registrationRows.length > 0) {
      void sc.from("compass_served_recommendations")
        .upsert(registrationRows, { onConflict: "recommendation_id" });
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
    const profile  = await getCompassProfile(sc, user.id).catch(() => null);
    const fallback = await buildFallbackFeed(sc, user.id, profile, "section_build_error").catch(() => ({ safeItems: [] }));
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
    sendError(res, "db_error", "Could not save preference");
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
      .select("explanation_key")
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

    const explanation = await resolveExplanation(explanationKey, sc, city);
    res.json({ explanation });
  } catch (err) {
    req.log.error({ err }, "compass/why: resolution failed");
    res.json({ explanation: "Based on your travel preferences and recent activity." });
  }
});

// ── POST /api/compass/ask ─────────────────────────────────────────────────────
// Conversational AI-buddy endpoint: takes a natural-language travel prompt and
// returns an AiRecommendation shaped object using the compass pipeline.

const askBodySchema = z.object({
  prompt: z.string().min(1).max(400),
  city:   z.string().max(80).optional(),
  mode:   z.enum(["recommend", "itinerary"]).default("recommend"),
});

function _extractDayCount(prompt: string): number {
  const m = prompt.match(/(\d+)[- ]day/i);
  return m && m[1] ? Math.min(Math.max(parseInt(m[1], 10), 2), 7) : 3;
}

function _itemLabel(item: Record<string, unknown> | null | undefined): string {
  return String(item?.title ?? item?.category ?? item?.type ?? "local spot");
}

function _itemCity(item: Record<string, unknown> | null | undefined): string {
  return String(item?.city ?? "");
}

function _buildFallbackRec(city: string, isItinerary: boolean): Record<string, unknown> {
  if (isItinerary) {
    return {
      id:               `ask_${Date.now()}`,
      bestPick:         `3-Day Itinerary: ${city}`,
      why:              "Arrive, settle in, explore the neighbourhood. Try a local food market in the evening.",
      whyLabel:         "Day 1",
      socialProof:      "Key sights, street food, and a cultural spot. Ask locals for their go-to.",
      socialProofLabel: "Day 2",
      tradeoff:         "Day trip or deeper local exploration. Perfect for a slow morning before heading out.",
      tradeoffLabel:    "Day 3",
      usedPostIds:      [],
      nextActions:      [{ label: "Add to trip", kind: "addTrip" }],
    };
  }
  return {
    id:          `ask_${Date.now()}`,
    bestPick:    city,
    why:         "Based on your travel preferences and community activity.",
    socialProof: "Trending with travelers this week.",
    usedPostIds: [],
    nextActions: [
      { label: "Add to trip",       kind: "addTrip" },
      { label: "Build itinerary",   kind: "buildItinerary" },
      { label: "Ask community",     kind: "askCommunity" },
    ],
  };
}

router.post("/compass/ask", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const parsed = askBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid request");
    return;
  }
  const { prompt, city, mode } = parsed.data;

  const isItinerary =
    mode === "itinerary" ||
    /itinerary|day[\s-]by[\s-]day|day\s+trip|schedule|full\s+plan|\d+[\s-]day/i.test(prompt);

  try {
    const profile = await getCompassProfile(sc, user.id);
    const signals = defaultSignals(profile);
    const context = buildCompassContext(profile, signals);

    // If caller specified a city, blend it in for scoring/hydration
    const effectiveProfile = city
      ? ({ ...profile, currentCity: city } as typeof profile)
      : profile;

    const rawItems = await hydrateCompassItems(sc, effectiveProfile);

    const { section: feedSection } = await buildSection(
      "for_you",
      rawItems,
      effectiveProfile,
      context,
      sc,
    );

    const topItems = feedSection.items.slice(0, 3);

    if (topItems.length === 0) {
      const profileAny = profile as unknown as Record<string, unknown>;
      const fallbackCity = city ?? String(profileAny.currentCity ?? "your destination");
      res.json(_buildFallbackRec(fallbackCity, isItinerary));
      return;
    }

    const top    = topItems[0] as unknown as Record<string, unknown>;
    const second = topItems[1] as unknown as (Record<string, unknown> | undefined);
    const third  = topItems[2] as unknown as (Record<string, unknown> | undefined);

    const item0  = (top.item    ?? {}) as Record<string, unknown>;
    const item1  = second ? ((second.item ?? {}) as Record<string, unknown>) : null;
    const item2  = third  ? ((third.item  ?? {}) as Record<string, unknown>) : null;

    const topTitle   = _itemLabel(item0);
    const topCity    = _itemCity(item0) || city || "";
    const tags       = (item0.interestTags as string[] | undefined) ?? [];
    const interests  = tags.slice(0, 3);

    let bestPick: string;
    let why: string;
    let whyLabel: string | undefined;
    let socialProof: string;
    let socialProofLabel: string | undefined;
    let tradeoff: string | undefined;
    let tradeoffLabel: string | undefined;
    let nextActions: Array<{ label: string; kind: string }>;

    if (isItinerary) {
      const dayCount  = _extractDayCount(prompt);
      const dest      = topCity || topTitle;
      bestPick        = `${dayCount}-Day Itinerary: ${dest}`;
      whyLabel        = "Day 1";
      socialProofLabel = "Day 2";

      why = item1
        ? `${topTitle} in the morning. Afternoon: ${_itemLabel(item1)}.`
        : `Explore ${topTitle}. Morning activity, local lunch, neighbourhood walk.`;

      socialProof = item1
        ? `${_itemLabel(item1)}${_itemCity(item1) ? ` · ${_itemCity(item1)}` : ""}. ${item2 ? `Then: ${_itemLabel(item2)}.` : ""}`.trim()
        : `Flexibility day — follow local tips from traveler posts and your saves.`;

      if (dayCount >= 3) {
        tradeoffLabel = "Day 3";
        tradeoff = item2
          ? `${_itemLabel(item2)}${_itemCity(item2) ? ` · ${_itemCity(item2)}` : ""} — great as a final day or day trip.`
          : `Day trip or slow exploration. Check community posts for hidden gems near ${dest}.`;
      }

      nextActions = [{ label: "Add to trip", kind: "addTrip" }];
    } else {
      bestPick = topCity ? `${topTitle} · ${topCity}` : topTitle;

      why = interests.length
        ? `Matches your ${interests.join(" + ")} interests${topCity ? ` — ${topCity} is active this week` : ""}.`
        : `Top pick based on your travel profile${topCity ? ` in ${topCity}` : ""}.`;

      socialProof = item1
        ? `${_itemLabel(item1)} is also trending with travelers sharing your style.`
        : `Traveler interest in ${topCity || "this area"} is high this week.`;

      tradeoff = item2
        ? `${_itemLabel(item2)} is worth considering as a day trip or alternative base.`
        : undefined;

      nextActions = [
        { label: "Add to trip",     kind: "addTrip" },
        { label: "Build itinerary", kind: "buildItinerary" },
        { label: "Ask community",   kind: "askCommunity" },
      ];
    }

    res.json({
      id:               `ask_${Date.now()}`,
      bestPick,
      why,
      whyLabel,
      socialProof,
      socialProofLabel,
      tradeoff,
      tradeoffLabel,
      usedPostIds:      [],
      nextActions,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "compass/ask failed");
    const fallbackCity = city ?? "your destination";
    res.json(_buildFallbackRec(fallbackCity, isItinerary));
  }
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
    sendError(res, "db_error", "Could not process feedback");
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
    sendError(res, "db_error", "Could not load preferences");
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
    sendError(res, "db_error", "Could not save preferences");
    return;
  }

  const { data: updated } = await sc
    .from("compass_user_preferences")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  res.json({ preferences: updated ?? { user_id: user.id, ...parsed.data } });
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

  const { data, error } = await sc
    .from("compass_active_user_scores")
    .select("tier, badge_eligibility, boost_visibility_enabled")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    req.log.warn({ err: error, userId: user.id }, "compass/me/active-reward: read failed");
    sendError(res, "db_error", "Could not load active reward");
    return;
  }

  const tier   = (data as any)?.tier ?? "active_traveler";
  const badges = (data as any)?.badge_eligibility ?? [];
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
    sendError(res, "db_error", "Could not load context");
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
    sendError(res, "db_error", "Could not save context");
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
    sendError(res, "db_error", "Could not delete context");
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
    sendError(res, "db_error", "Could not load settings");
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
    sendError(res, "db_error", "Could not save settings");
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
    sendError(res, "db_error", "Could not save report");
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

  const { surface = "for_you", q, city, limit, startDate, endDate, tripId } = parsed.data;
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

      const { data: buddyRows } = await sc
        .from("rent_buddy_profiles")
        .select(
          "id, user_id, display_name, city, country, categories, languages, " +
          "hourly_rate_usd, status, verified, average_rating, review_count, " +
          "cover_photo_url, admin_status, risk_hold",
        )
        .eq("status", "active");

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
        reason:   buildBuddyReasonText(s.reasonCode, effectiveCity, {
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

      res.json({ recommendations: buddyRecommendations, surface });
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
          "id, username, display_name, name, avatar_url, home_city, home_country, " +
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
      const requestedSet  = new Set<string>();
      if (topTravIds.length > 0) {
        const { data: followRows } = await sc
          .from("user_follows")
          .select("following_id")
          .eq("follower_id", user.id)
          .in("following_id", topTravIds);
        for (const r of (followRows ?? []) as any[]) followingSet.add(r.following_id);

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
            avatarUrl:       (s.row.avatar_url ?? null) as string | null,
            homeCity:        isPrivate ? null : ((s.row.home_city ?? null) as string | null),
            isPrivate,
            verified:        s.row.verified ?? false,
            sharedInterests: isPrivate ? [] : s.sharedInterests,
            reasonCode:      s.reasonCode,
            followStatus,
          },
        };
      });

      res.json({ recommendations: travelerRecommendations, surface });
      return;
    }

    // Allow caller to override the context city.
    const effectiveProfile = city ? { ...profile, currentCity: city } : profile;

    const signals = defaultSignals(effectiveProfile as typeof profile);
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

    res.json({ recommendations, surface });
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
    sendError(res, "db_error", "Could not load recommendations");
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
        .select("destination")
        .eq("id", tripId)
        .maybeSingle();
      cityContext = (tripRow as any)?.destination ?? null;
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
    const signals = defaultSignals(effectiveProfile);
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
