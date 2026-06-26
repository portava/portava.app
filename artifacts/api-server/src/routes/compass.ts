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
import { isCompassEnabled } from "../compass/flags.js";
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

    const profile  = await getCompassProfile(sc, user.id);
    const signals  = defaultSignals(profile);
    const context  = buildCompassContext(profile, signals);
    const items    = await hydrateCompassItems(sc, profile);
    const feed = await buildFeed(items, profile, context, sc, cursor ?? null);

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
    res.json({ section: null, nextCursor: null, fallback: true });
    return;
  }

  const sectionParam = req.params.section as string;
  if (!SECTION_NAMES.includes(sectionParam as SectionName)) {
    sendError(res, "invalid_payload", `Unknown section '${sectionParam}'`);
    return;
  }

  // Proactive fallback-mode check — same gate as the feed endpoint.
  // Returns section-schema-compatible response so clients don't need
  // separate handling for section vs full-feed fallback mode.
  const fallbackModeOn = await isFallbackModeEnabled(sc);
  if (fallbackModeOn) {
    req.log.info({ userId: user.id }, "compass/feed/section: COMPASS_FALLBACK_MODE_ENABLED, returning section fallback");
    res.json({ section: null, nextCursor: null, fallback: true });
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

    const profile  = await getCompassProfile(sc, user.id);
    const signals  = defaultSignals(profile);
    const context  = buildCompassContext(profile, signals);
    const items    = await hydrateCompassItems(sc, profile);

    const result = await buildSection(
      sectionParam as SectionName,
      items,
      profile,
      context,
      sc,
      cursor ?? null,
    );

    // Write-through: cache the result (fire-and-forget)
    void setCachedFeed(sc, user.id, cacheKey, "section", result);
    res.json(result);
  } catch (err) {
    // On unhandled error, return a section-schema-compatible fallback
    // response so the client never receives a mismatched payload shape.
    // `section: null` is identical to the COMPASS_ENABLED=false path and
    // the fallback-mode-enabled path above, making handling uniform.
    req.log.error({ err }, "compass/feed/section: build failed, using fallback");
    res.json({ section: null, nextCursor: null, fallback: true });
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

    // ── On-demand abuse scan ───────────────────────────────────────────────
    // When a user reports or blocks another user, immediately trigger a
    // scoped abuse scan for the target so the AbuseDefenseEngine can act
    // on the signal before the next scheduled batch window.
    const { action, targetUserId } = parsed.data;
    if (targetUserId && (action === "report" || action === "block")) {
      triggerOnDemandScan(targetUserId);
    }
  } catch (err) {
    req.log.error({ err }, "compass/feedback: processing failed");
    sendError(res, "db_error", "Could not process feedback");
  }
});

export default router;
