/**
 * Passport Stamps & Memories routes
 *
 * All endpoints require authentication. Feature flags gate every code path.
 * Exact coordinates are never stored or returned. Safe Return stamps default
 * to private visibility.
 *
 * GET    /me/passport/stamps
 * PATCH  /me/passport/stamps/:id
 * GET    /me/passport/memories
 * POST   /me/passport/memories
 * PATCH  /me/passport/memories/:id
 * GET    /me/passport/suggestions
 * POST   /me/passport/suggestions/:id/accept
 * POST   /me/passport/suggestions/:id/dismiss
 * GET    /me/passport/map
 * GET    /me/passport/stats
 * GET    /me/passport/visibility-preferences
 * PATCH  /me/passport/visibility-preferences
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { normalizedFriendshipPair } from "../lib/friendDecisions.js";
import { getServiceClient } from "../lib/supabase.js";
import {
  createStamp,
  updateStampVisibility,
  loadStamps,
} from "../services/passport/PassportStampService.js";
import {
  createMemory,
  acceptSuggestedMemory,
  dismissSuggestedMemory,
  updateMemory,
  loadMemories,
  loadSuggestions,
} from "../services/passport/PassportMemoryService.js";
import {
  buildMapPayload,
  buildStats,
} from "../services/passport/PassportMapService.js";
import { countContentStampsReceived } from "../services/stamps/ContentStampService.js";
import { countUserTrips } from "../lib/tripCounts.js";
import { recordContribution } from "../services/passport/PassportContributionService.js";
import type { VisibilityTier, CallerContext } from "../services/passport/PassportPrivacyGuard.js";
import { filterStamps, filterMemories } from "../services/passport/PassportPrivacyGuard.js";

import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

// ── Feature flag helpers ──────────────────────────────────────────────────────

async function isFlagEnabled(flag: string): Promise<boolean> {
  const sc = getServiceClient();
  if (!sc) return false;
  try {
    const { data, error } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flag)
      .maybeSingle();
    // FL-05: fail-CLOSED to match the shared lib/featureFlags isFlagEnabled
    // (this local copy previously failed OPEN, an inconsistency). The passport
    // flags are seeded true by migration 0085, so prod behavior is unchanged.
    if (error) return false;
    if (data == null) return false;
    return Boolean((data as any).enabled);
  } catch {
    return false;
  }
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const VISIBILITY = z.enum(["public", "circle_only", "trip_crew", "private"]);

const patchStampSchema = z.object({
  visibility: VISIBILITY,
});

const createMemorySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).nullable().optional(),
  country: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  neighborhood: z.string().max(100).optional(),
  category: z.string().max(80).optional(),
  visibility: VISIBILITY.optional().default("private"),
  photoUrl: z.string().url().nullable().optional(),
  mediaType: z.enum(["image", "video"]).nullable().optional(),
});

const patchMemorySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  visibility: VISIBILITY.optional(),
  photoUrl: z.string().url().nullable().optional(),
  mediaType: z.enum(["image", "video"]).nullable().optional(),
});

const acceptSuggestionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  visibility: VISIBILITY.optional(),
});

const patchVisibilityPrefsSchema = z.object({
  defaultStampVisibility: VISIBILITY.optional(),
  defaultMemoryVisibility: VISIBILITY.optional(),
  showCityMap: z.boolean().optional(),
  showNeighborhoods: z.boolean().optional(),
  showPlanStamps: z.boolean().optional(),
  showSafeReturnStamps: z.boolean().optional(),
});

// ── Stamp routes ──────────────────────────────────────────────────────────────

/**
 * GET /me/passport/stamps
 * Returns the caller's stamps with optional filters and pagination.
 * ?country= ?city= ?type= ?visibility= ?limit= ?offset=
 *
 * Pagination: limit defaults to 100 (max 200), offset defaults to 0.
 * Response: { stamps: Stamp[], total: number }
 */
router.get("/me/passport/stamps", async (req, res) => {
  if (!await isFlagEnabled("passport_stamps_enabled")) {
    sendError(res, "feature_disabled", "Passport stamps are not enabled");
    return;
  }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  // perf-trim: pagination added — limit defaults to 100 (max 200) to cap page size
  const limitVal  = Math.min(200, Math.max(1, parseInt(String(req.query.limit  ?? "100"), 10) || 100));
  const offsetVal = Math.max(0,              parseInt(String(req.query.offset ?? "0"),   10) || 0);

  const filters: Record<string, string> = {};
  if (req.query.country)    filters.country    = String(req.query.country);
  if (req.query.city)       filters.city       = String(req.query.city);
  if (req.query.type)       filters.stampType  = String(req.query.type);
  if (req.query.visibility) filters.visibility = String(req.query.visibility) as VisibilityTier;

  // Total count (before pagination) — uses the same DB-level filters.
  // If the count query errors or returns a null count, we do NOT default to 0
  // (a page full of stamps with total=0 breaks client "load more" logic).
  // Instead we fall back to a lower bound derived from the page we did fetch.
  let countedTotal: number | null = null;
  try {
    let cq = client
      .from("passport_stamps")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);
    if (filters.country)    cq = (cq as any).eq("country",    filters.country);
    if (filters.city)       cq = (cq as any).eq("city",       filters.city);
    if (filters.stampType)  cq = (cq as any).eq("stamp_type", filters.stampType);
    if (filters.visibility) cq = (cq as any).eq("visibility", filters.visibility);
    const { count, error: countError } = await cq;
    if (countError) {
      console.error("[passport/stamps] count query failed:", countError.message ?? countError);
    } else if (typeof count === "number") {
      countedTotal = count;
    }
  } catch (e) {
    console.error("[passport/stamps] count query threw:", e instanceof Error ? e.message : e);
  }

  const rows = await loadStamps(client, user.id, { ...filters, limit: limitVal, offset: offsetVal } as any);
  // Owner sees all their own stamps
  const stamps = filterStamps(rows as any, "owner");

  // Never report a total smaller than what this page proves exists — if the
  // count query failed, fall back to offset + returned rows so the response
  // can't claim `total: 0` while returning stamps.
  const total = Math.max(countedTotal ?? 0, offsetVal + stamps.length);

  res.json({
    stamps: stamps.map((s) => ({
      id:                s.id,
      stampType:         s.stamp_type,
      country:           s.country,
      city:              s.city,
      neighborhood:      s.neighborhood,
      placeId:           s.place_id,
      planId:            s.plan_id,
      tripId:            s.trip_id,
      sourceType:        s.source_type,
      verificationLevel: s.verification_level,
      visibility:        s.visibility,
      earnedAt:          s.earned_at,
      createdAt:         s.created_at,
    })),
    total,
  });
});

/**
 * PATCH /me/passport/stamps/:id
 * Update stamp visibility.
 */
router.patch("/me/passport/stamps/:id", async (req, res) => {
  if (!await isFlagEnabled("passport_stamps_enabled")) {
    sendError(res, "feature_disabled", "Passport stamps are not enabled");
    return;
  }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = patchStampSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const ok = await updateStampVisibility(client, req.params.id, user.id, parsed.data.visibility);
  if (!ok) {
    sendError(res, "not_found", "Stamp not found or not yours");
    return;
  }

  res.json({ id: req.params.id, visibility: parsed.data.visibility });
});

// ── Memory routes ─────────────────────────────────────────────────────────────

/**
 * GET /me/passport/memories
 * Returns caller's active (accepted) memories.
 */
router.get("/me/passport/memories", async (req, res) => {
  if (!await isFlagEnabled("passport_memories_enabled")) {
    sendError(res, "feature_disabled", "Passport memories are not enabled");
    return;
  }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const rows = await loadMemories(client, user.id);
  const memories = filterMemories(rows as any, "owner");

  res.json({
    memories: memories.map((m) => ({
      id: m.id,
      status: m.status,
      title: m.title,
      description: m.description,
      country: m.country,
      city: m.city,
      neighborhood: m.neighborhood,
      category: m.category,
      visibility: m.visibility,
      verificationLevel: m.verification_level,
      sourceType: m.source_type,
      photoUrl: m.photo_url,
      mediaType: m.media_type ?? null,
      planId: m.plan_id,
      tripId: m.trip_id,
      suggestionReason: m.suggestion_reason,
      earnedAt: m.earned_at,
      createdAt: m.created_at,
    })),
  });
});

/**
 * POST /me/passport/memories
 * Create a memory manually (immediately active).
 */
router.post("/me/passport/memories", async (req, res) => {
  if (!await isFlagEnabled("passport_memories_enabled")) {
    sendError(res, "feature_disabled", "Passport memories are not enabled");
    return;
  }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const parsed = createMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const id = await createMemory(sc, {
    userId: user.id,
    ...parsed.data,
    photoUrl: parsed.data.photoUrl ?? undefined,
    mediaType: parsed.data.mediaType ?? undefined,
    description: parsed.data.description ?? undefined,
  });

  if (!id) {
    sendError(res, "db_error", "Failed to create memory", { exposeDetail: true });
    return;
  }

  if (sc && await isFlagEnabled("passport_contribution_events_enabled")) {
    await recordContribution(sc, {
      userId: user.id,
      eventType: "city_visit_verified",
      sourceType: "manual_memory",
      verificationLevel: "unverified",
    }).catch(() => {});
  }

  res.status(201).json({ memory: { id, status: "active" } });
});

/**
 * PATCH /me/passport/memories/:id
 * Edit an active memory.
 */
router.patch("/me/passport/memories/:id", async (req, res) => {
  if (!await isFlagEnabled("passport_memories_enabled")) {
    sendError(res, "feature_disabled", "Passport memories are not enabled");
    return;
  }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = patchMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  if (Object.keys(parsed.data).length === 0) {
    sendError(res, "invalid_payload", "At least one field must be provided");
    return;
  }

  const ok = await updateMemory(client, req.params.id, user.id, {
    title: parsed.data.title,
    description: parsed.data.description,
    city: parsed.data.city,
    country: parsed.data.country,
    visibility: parsed.data.visibility,
    photoUrl: parsed.data.photoUrl ?? undefined,
    mediaType: parsed.data.mediaType ?? undefined,
  });

  if (!ok) {
    sendError(res, "not_found", "Memory not found or not yours");
    return;
  }

  res.json({ id: req.params.id, updated: true });
});

// ── Suggestion routes ─────────────────────────────────────────────────────────

/**
 * GET /me/passport/suggestions
 * Returns pending suggested memories (status = 'suggested').
 */
router.get("/me/passport/suggestions", async (req, res) => {
  if (!await isFlagEnabled("passport_memories_enabled")) {
    sendError(res, "feature_disabled", "Passport memories are not enabled");
    return;
  }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const rows = await loadSuggestions(client, user.id);

  res.json({
    suggestions: rows.map((m: any) => ({
      id: m.id,
      status: m.status,
      title: m.title,
      description: m.description,
      country: m.country,
      city: m.city,
      neighborhood: m.neighborhood,
      category: m.category,
      visibility: m.visibility,
      verificationLevel: m.verification_level,
      sourceType: m.source_type,
      photoUrl: m.photo_url,
      mediaType: m.media_type ?? null,
      planId: m.plan_id,
      tripId: m.trip_id,
      suggestionReason: m.suggestion_reason,
      earnedAt: m.earned_at,
      createdAt: m.created_at,
    })),
  });
});

/**
 * POST /me/passport/suggestions/:id/accept
 * Promote a suggested memory to active.
 */
router.post("/me/passport/suggestions/:id/accept", async (req, res) => {
  if (!await isFlagEnabled("passport_memories_enabled")) {
    sendError(res, "feature_disabled", "Passport memories are not enabled");
    return;
  }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = acceptSuggestionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const ok = await acceptSuggestedMemory(client, req.params.id, user.id, {
    title: parsed.data.title,
    visibility: parsed.data.visibility,
  });

  if (!ok) {
    sendError(res, "not_found", "Suggestion not found or already accepted/dismissed");
    return;
  }

  res.json({ id: req.params.id, accepted: true });
});

/**
 * POST /me/passport/suggestions/:id/dismiss
 * Discard a suggestion.
 */
router.post("/me/passport/suggestions/:id/dismiss", async (req, res) => {
  if (!await isFlagEnabled("passport_memories_enabled")) {
    sendError(res, "feature_disabled", "Passport memories are not enabled");
    return;
  }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const ok = await dismissSuggestedMemory(client, req.params.id, user.id);
  if (!ok) {
    sendError(res, "not_found", "Suggestion not found or already processed");
    return;
  }

  res.status(204).send();
});

// ── Map route ─────────────────────────────────────────────────────────────────

/**
 * GET /me/passport/map
 * Returns privacy-safe city-level map markers.
 * INVARIANT: Never returns exact lat/lng.
 */
router.get("/me/passport/map", async (req, res) => {
  if (!await isFlagEnabled("passport_map_enabled")) {
    res.json({ markers: [], countries: [], cities: [] });
    return;
  }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  // Check hotel blur preference
  let hotelBlurEnabled = false;
  try {
    const sc = getServiceClient();
    if (sc) {
      const { data: prefs } = await sc
        .from("user_location_preferences")
        .select("hotel_blur_enabled")
        .eq("user_id", user.id)
        .maybeSingle();
      hotelBlurEnabled = (prefs as any)?.hotel_blur_enabled ?? false;
    }
  } catch { /* ignore */ }

  const payload = await buildMapPayload(client, user.id, "owner", { hotelBlurEnabled });
  res.json(payload);
});

// ── Stats route ───────────────────────────────────────────────────────────────

/**
 * GET /me/passport/stats
 * Returns aggregate stats from passport_stamps.
 */
router.get("/me/passport/stats", async (req, res) => {
  if (!await isFlagEnabled("passport_stamps_enabled")) {
    res.json({
      countries: 0, cities: 0, neighborhoods: 0,
      planStamps: 0, hostStamps: 0, hiddenGemStamps: 0,
      safeReturnStamps: 0, totalStamps: 0,
      tripCount: 0, followersCount: 0, followingCount: 0,
      stampsEarned: 0, milestones: [],
    });
    return;
  }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient();

  const [stats, tripResult, followersResult, followingResult, stampsEarnedResult, milestonesResult] = await Promise.all([
    buildStats(client, user.id),
    countUserTrips(sc ?? client, user.id),
    client.from("user_follows").select("follower_id", { count: "exact", head: true }).eq("following_id", user.id),
    client.from("user_follows").select("following_id", { count: "exact", head: true }).eq("follower_id", user.id),
    // Lifetime stamps earned: passport milestone stamps + content stamps received on
    // this user's posts. Both fail silently so a table-absence or DB error returns 0.
    sc
      ? Promise.all([
          sc.from("user_stamps").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("is_revoked", false).then(
            (r: any) => r,
            () => ({ count: 0 }),
          ),
          countContentStampsReceived(sc, user.id),
        ]).then(([milestones, content]) => ({ count: ((milestones as any).count ?? 0) + (content as number) }))
      : Promise.resolve({ count: 0 }),
    // Milestone history from stamp_milestones. Fails silently when table is absent.
    sc
      ? sc.from("stamp_milestones").select("milestone_level, celebrated_at").eq("user_id", user.id).then(
          (r: any) => r,
          () => ({ data: [] }),
        )
      : Promise.resolve({ data: [] }),
  ]);

  // stampsEarnedResult already combines the passport milestone-award count with
  // content stamps received (via countContentStampsReceived, paginated so it's
  // exact for high-post-count users) — do not add it again here.
  const stampsEarned = (stampsEarnedResult as any).count ?? 0;
  const milestones: Array<{ level: number; celebratedAt: string }> =
    ((milestonesResult as any).data ?? []).map((m: any) => ({
      level: m.milestone_level as number,
      celebratedAt: m.celebrated_at as string,
    }));

  res.json({
    ...stats,
    tripCount:      tripResult.count      ?? 0,
    followersCount: followersResult.count ?? 0,
    followingCount: followingResult.count ?? 0,
    stampsEarned,
    milestones,
  });
});

// ── Visibility Preferences routes ─────────────────────────────────────────────

/**
 * GET /me/passport/visibility-preferences
 */
router.get("/me/passport/visibility-preferences", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { data, error } = await client
    .from("passport_visibility_preferences")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error && (error as any).code !== "PGRST116") {
    req.log.error({ err: error }, "Failed to load visibility preferences");
    sendError(res, "db_error", error.message);
    return;
  }

  // Return defaults when no row exists
  const row = data as any ?? {};
  res.json({
    defaultStampVisibility: row.default_stamp_visibility ?? "public",
    defaultMemoryVisibility: row.default_memory_visibility ?? "private",
    showCityMap: row.show_city_map ?? true,
    showNeighborhoods: row.show_neighborhoods ?? true,
    showPlanStamps: row.show_plan_stamps ?? true,
    showSafeReturnStamps: row.show_safe_return_stamps ?? false,
  });
});

/**
 * PATCH /me/passport/visibility-preferences
 */
router.patch("/me/passport/visibility-preferences", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = patchVisibilityPrefsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  if (Object.keys(parsed.data).length === 0) {
    sendError(res, "invalid_payload", "At least one field must be provided");
    return;
  }

  const dbPatch: Record<string, unknown> = { user_id: user.id, updated_at: new Date().toISOString() };
  if (parsed.data.defaultStampVisibility !== undefined) dbPatch.default_stamp_visibility = parsed.data.defaultStampVisibility;
  if (parsed.data.defaultMemoryVisibility !== undefined) dbPatch.default_memory_visibility = parsed.data.defaultMemoryVisibility;
  if (parsed.data.showCityMap !== undefined) dbPatch.show_city_map = parsed.data.showCityMap;
  if (parsed.data.showNeighborhoods !== undefined) dbPatch.show_neighborhoods = parsed.data.showNeighborhoods;
  if (parsed.data.showPlanStamps !== undefined) dbPatch.show_plan_stamps = parsed.data.showPlanStamps;
  if (parsed.data.showSafeReturnStamps !== undefined) dbPatch.show_safe_return_stamps = parsed.data.showSafeReturnStamps;

  const { data, error } = await client
    .from("passport_visibility_preferences")
    .upsert(dbPatch, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to update visibility preferences");
    sendError(res, "db_error", error.message);
    return;
  }

  const row = data as any;
  res.json({
    defaultStampVisibility: row.default_stamp_visibility ?? "public",
    defaultMemoryVisibility: row.default_memory_visibility ?? "private",
    showCityMap: row.show_city_map ?? true,
    showNeighborhoods: row.show_neighborhoods ?? true,
    showPlanStamps: row.show_plan_stamps ?? true,
    showSafeReturnStamps: row.show_safe_return_stamps ?? false,
  });
});

// ── Public passport endpoints (for public / other-user passport views) ────────

/**
 * GET /users/:username/passport/memories
 * Returns active, public memories for another user's passport.
 * Circle/trip-crew callers get their respective visibility tiers when authenticated.
 */
router.get("/users/:username/passport/memories", async (req, res) => {
  if (!await isFlagEnabled("passport_memories_enabled")) {
    res.json({ memories: [] });
    return;
  }

  const sc = getServiceClient();
  if (!sc) { res.json({ memories: [] }); return; }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();
  const { data: profile } = await sc
    .from("profiles")
    .select("id, passport_visibility")
    .eq("username", username)
    .maybeSingle();

  if (!profile || (profile as any).passport_visibility === "private") {
    res.json({ memories: [] });
    return;
  }

  // Determine caller context
  let callerCtx: import("../services/passport/PassportPrivacyGuard.js").CallerContext = "public";

  // Attempt to identify caller from Authorization header
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) {
    const { data: authData } = await sc.auth.getUser(token);
    const callerId = authData?.user?.id;
    if (callerId && callerId !== (profile as any).id) {
      // Check friendship (grants "circle" visibility context).
      // TODO: friends system not in spec (follow-only) — repointed from the
      // non-existent friend_connections table to the live user_friendships
      // table; remove if the friends system is dropped.
      const [ua, ub] = normalizedFriendshipPair(callerId, (profile as any).id);
      const { data: circleRow } = await sc
        .from("user_friendships")
        .select("user_a")
        .eq("user_a", ua)
        .eq("user_b", ub)
        .maybeSingle();
      if (circleRow) callerCtx = "circle";
    }
  }

  const rows = await import("../services/passport/PassportMemoryService.js").then(
    (m) => m.loadMemories(sc, (profile as any).id),
  );

  const { filterMemories } = await import("../services/passport/PassportPrivacyGuard.js");
  const visible = filterMemories(rows, callerCtx);

  const memories = visible.map((m: any) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    country: m.country,
    city: m.city,
    neighborhood: m.neighborhood,
    category: m.category,
    visibility: m.visibility,
    photoUrl: m.photo_url,
    mediaType: m.media_type ?? null,
    earnedAt: m.earned_at,
  }));

  res.json({ memories });
});

/**
 * GET /users/:username/passport/stamps
 * Returns public stamps for a user's passport (no auth required, service-role).
 */
router.get("/users/:username/passport/stamps", async (req, res) => {
  if (!await isFlagEnabled("passport_stamps_enabled")) {
    res.json({ stamps: [] });
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    res.json({ stamps: [] });
    return;
  }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();

  const { data: profile } = await sc
    .from("profiles")
    .select("id, passport_visibility")
    .eq("username", username)
    .maybeSingle();

  if (!profile || (profile as any).passport_visibility === "private") {
    res.json({ stamps: [] });
    return;
  }

  // Determine caller context for visibility filtering
  let callerCtx: import("../services/passport/PassportPrivacyGuard.js").CallerContext = "public";
  const authHeader2 = req.headers.authorization ?? "";
  const token2 = authHeader2.startsWith("Bearer ") ? authHeader2.slice(7) : null;
  if (token2) {
    const { data: authData2 } = await sc.auth.getUser(token2);
    const callerId2 = authData2?.user?.id;
    if (callerId2 === (profile as any).id) {
      callerCtx = "owner";
    } else if (callerId2) {
      // TODO: friends system not in spec (follow-only) — repointed from the
      // non-existent friend_connections table to the live user_friendships
      // table; remove if the friends system is dropped.
      const [ua2, ub2] = normalizedFriendshipPair(callerId2, (profile as any).id);
      const { data: circleRow2 } = await sc
        .from("user_friendships")
        .select("user_a")
        .eq("user_a", ua2)
        .eq("user_b", ub2)
        .maybeSingle();
      if (circleRow2) callerCtx = "circle";
    }
  }

  const rows = await loadStamps(sc, (profile as any).id);
  const { filterStamps } = await import("../services/passport/PassportPrivacyGuard.js");
  const visible = filterStamps(rows, callerCtx);

  const stamps = visible.map((s: any) => ({
    id: s.id,
    stampType: s.stamp_type,
    country: s.country,
    city: s.city,
    neighborhood: s.neighborhood,
    verificationLevel: s.verification_level,
    visibility: s.visibility,
    earnedAt: s.earned_at,
  }));

  res.json({ stamps });
});

// ── Admin artwork preview endpoint ────────────────────────────────────────────

/**
 * GET /admin/passport/stamps/preview
 * Returns the resolved artwork definition for a stamp type and rarity.
 * Used by the admin panel to preview stamp visuals before publishing artwork
 * overrides. Requires admin role (profiles.role = 'admin').
 *
 * Query params:
 *   ?type=city           stamp_type (required)
 *   ?rarity=rare         rarity tier (optional, defaults to type's default)
 *   ?label=CEBU          label text to include in accessibilityLabel preview
 *   ?sublabel=PH+%C2%B7+2026  sublabel (optional)
 *   ?locked=false        whether to preview locked state
 *   ?dark=false          whether to preview dark-mode variant
 */
router.get("/admin/passport/stamps/preview", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const stampType = String(req.query.type ?? "city");
  const label = String(req.query.label ?? stampType.toUpperCase());
  const sublabel = req.query.sublabel ? String(req.query.sublabel) : undefined;
  const locked = req.query.locked === "true";
  const dark = req.query.dark === "true";

  // Map stamp_type → StampKind for the mobile resolver
  const typeToKind: Record<string, string> = {
    city: "city", neighborhood: "city", plan: "plan",
    host: "host", hidden_gem: "gem", safe_return: "safe",
    activity: "perk", trip_crew: "plan", compass_ai: "plan",
    qr_checkin: "perk", gem: "gem", safe: "safe", perk: "perk",
  };
  const kind = typeToKind[stampType] ?? "city";

  // Inline artwork defaults (mirrors stampArtworkResolver.ts in the mobile app).
  // Keeping this self-contained avoids a cross-package import boundary.
  type ThemeDef = { accent: string; bg: string; icon: string; label: string; shape: string; rarity: string; borderStyle: string; borderWeight: number; pattern: string; texture: string; shimmer: boolean; darkAccent?: string; darkBg?: string };
  const INLINE_THEMES: Record<string, ThemeDef> = {
    city:  { accent: "#0A3D4A", bg: "#EFF5F5", darkAccent: "#7BCCD8", darkBg: "#0D2B30", icon: "MapPin",      label: "CITY",  shape: "oval",    rarity: "rare",     borderStyle: "sawtooth", borderWeight: 2, pattern: "radial",   texture: "worn",  shimmer: false },
    plan:  { accent: "#FF4D2E", bg: "#FFF0F3", darkAccent: "#FF8A73", darkBg: "#2B0A06", icon: "Users",       label: "PLAN",  shape: "rect",    rarity: "uncommon", borderStyle: "double",   borderWeight: 2, pattern: "diagonal", texture: "paper", shimmer: false },
    host:  { accent: "#11110F", bg: "#F0F0EE", darkAccent: "#E8E8E4", darkBg: "#0F0F0D", icon: "Crown",       label: "HOST",  shape: "rect",    rarity: "epic",     borderStyle: "wave",     borderWeight: 3, pattern: "solid",    texture: "ink",   shimmer: true  },
    gem:   { accent: "#7A4DBF", bg: "#F5F0FF", darkAccent: "#B89EE8", darkBg: "#1A0E2E", icon: "Gem",         label: "GEM",   shape: "hexagon", rarity: "rare",     borderStyle: "sawtooth", borderWeight: 2, pattern: "dots",     texture: "worn",  shimmer: false },
    safe:  { accent: "#2E7D5B", bg: "#F0F8F5", darkAccent: "#6CC4A0", darkBg: "#0A1F15", icon: "ShieldCheck", label: "SAFE",  shape: "round",   rarity: "uncommon", borderStyle: "double",   borderWeight: 2, pattern: "grid",     texture: "paper", shimmer: false },
    perk:  { accent: "#C8851A", bg: "#FFF8F0", darkAccent: "#F0B86A", darkBg: "#281605", icon: "Ticket",      label: "PERK",  shape: "round",   rarity: "common",   borderStyle: "single",   borderWeight: 1, pattern: "diagonal", texture: "paper", shimmer: false },
  };
  const theme = INLINE_THEMES[kind] ?? INLINE_THEMES.city;

  function buildArtwork(isLocked: boolean, isDark: boolean) {
    const accentColor  = isLocked ? "#D1D5DB" : (isDark && theme.darkAccent ? theme.darkAccent : theme.accent);
    const bgColor      = isLocked ? "#F3F4F6" : (isDark && theme.darkBg ? theme.darkBg : theme.bg);
    return {
      shape:             isLocked ? "oval"          : theme.shape,
      borderStyle:       isLocked ? "single"        : theme.borderStyle,
      borderWeight:      isLocked ? 1               : theme.borderWeight,
      accent:            accentColor,
      background:        bgColor,
      pattern:           isLocked ? "solid"         : theme.pattern,
      texture:           isLocked ? "worn"          : theme.texture,
      iconKey:           theme.icon,
      categoryLabel:     theme.label,
      rarity:            theme.rarity,
      hasShimmer:        !isLocked && theme.shimmer,
      hasGlow:           false,
      locked:            isLocked,
      accessibilityLabel: isLocked
        ? `Locked ${theme.label} stamp — not yet earned`
        : `${label}${sublabel ? " — " + sublabel : ""} ${theme.label} stamp`,
    };
  }

  // Check DB for a custom artwork override for this (stamp_type, rarity) pair.
  // The unique constraint is on (stamp_type, rarity) so we filter both.
  const dbRarity = theme.rarity;
  const { data: dbArt } = await sc
    .from("stamp_artwork_definitions")
    .select("*")
    .eq("stamp_type", stampType)
    .eq("rarity", dbRarity)
    .maybeSingle();

  const dbOverride = dbArt
    ? {
        shape:         (dbArt as any).shape,
        borderStyle:   (dbArt as any).border_style,
        borderWeight:  (dbArt as any).border_weight,
        accent:        (dbArt as any).accent,
        background:    (dbArt as any).background,
        pattern:       (dbArt as any).pattern,
        texture:       (dbArt as any).texture,
        iconKey:       (dbArt as any).icon_key,
        categoryLabel: (dbArt as any).category_label,
        captionText:   (dbArt as any).caption_text ?? undefined,
        hasShimmer:    Boolean((dbArt as any).has_shimmer) && !locked,
        hasGlow:       Boolean((dbArt as any).has_glow) && !locked,
      }
    : {};

  // Build previews at the standard display sizes used by the mobile app
  const SIZES = { tiny: 48, small: 64, medium: 88, large: 120, share: 200 };
  const baseArtwork = { ...buildArtwork(locked, dark), ...dbOverride };

  const sizePreviews = Object.fromEntries(
    Object.entries(SIZES).map(([name, px]) => [
      name,
      {
        px,
        iconSizePx:  Math.round(px * 0.26),
        labelSizePx: Math.round(px * 0.12),
      },
    ])
  );

  res.json({
    preview: {
      stampType,
      label,
      sublabel,
      locked,
      dark,
      artwork: baseArtwork,
      sizes: sizePreviews,
      source: dbArt ? "db_override" : "js_defaults",
    },
  });
});

export default router;
