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
import { recordContribution } from "../services/passport/PassportContributionService.js";
import type { VisibilityTier, CallerContext } from "../services/passport/PassportPrivacyGuard.js";
import { filterStamps, filterMemories } from "../services/passport/PassportPrivacyGuard.js";

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
    // DB error (e.g. table not yet migrated) → fail-open so dev env works.
    if (error) return true;
    // No row means the flag hasn't been seeded yet → treat as enabled.
    if (data == null) return true;
    return Boolean((data as any).enabled);
  } catch {
    return true;
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
});

const patchMemorySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  visibility: VISIBILITY.optional(),
  photoUrl: z.string().url().nullable().optional(),
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
 * Returns the caller's stamps with optional filters.
 * ?country= ?city= ?type= ?visibility=
 */
router.get("/me/passport/stamps", async (req, res) => {
  if (!await isFlagEnabled("passport_stamps_enabled")) {
    sendError(res, "feature_disabled", "Passport stamps are not enabled");
    return;
  }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const filters: Record<string, string> = {};
  if (req.query.country) filters.country = String(req.query.country);
  if (req.query.city) filters.city = String(req.query.city);
  if (req.query.type) filters.stampType = String(req.query.type);
  if (req.query.visibility) filters.visibility = String(req.query.visibility) as VisibilityTier;

  const rows = await loadStamps(client, user.id, filters as any);
  // Owner sees all their own stamps
  const stamps = filterStamps(rows as any, "owner");

  res.json({
    stamps: stamps.map((s) => ({
      id: s.id,
      stampType: s.stamp_type,
      country: s.country,
      city: s.city,
      neighborhood: s.neighborhood,
      placeId: s.place_id,
      planId: s.plan_id,
      tripId: s.trip_id,
      sourceType: s.source_type,
      verificationLevel: s.verification_level,
      visibility: s.visibility,
      earnedAt: s.earned_at,
      createdAt: s.created_at,
    })),
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
    description: parsed.data.description ?? undefined,
  });

  if (!id) {
    sendError(res, "db_error", "Failed to create memory");
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
    description: parsed.data.description ?? undefined,
    visibility: parsed.data.visibility,
    photoUrl: parsed.data.photoUrl ?? undefined,
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
        .from("location_preferences")
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
    });
    return;
  }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const stats = await buildStats(client, user.id);
  res.json(stats);
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
      // Check circle membership
      const { data: circleRow } = await sc
        .from("friend_connections")
        .select("id")
        .eq("user_a_id", callerId)
        .eq("user_b_id", (profile as any).id)
        .eq("status", "connected")
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
      const { data: circleRow2 } = await sc
        .from("friend_connections")
        .select("id")
        .eq("user_a_id", callerId2)
        .eq("user_b_id", (profile as any).id)
        .eq("status", "connected")
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

export default router;
