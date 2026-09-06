/**
 * Hidden Gems routes
 *
 * POST   /api/hidden-gems              — submit a new gem
 * GET    /api/hidden-gems              — list/filter/rank
 * GET    /api/hidden-gems/saved        — caller's saved gems
 * GET    /api/hidden-gems/layover-safe — layover-safe gems filtered by time window
 * GET    /api/hidden-gems/trip-city/:tripId — gems for a trip's destination city
 * GET    /api/hidden-gems/:id          — single gem detail
 * PATCH  /api/hidden-gems/:id          — owner/guide edit
 * POST   /api/hidden-gems/:id/save     — save a gem
 * DELETE /api/hidden-gems/:id/save     — unsave a gem
 * POST   /api/hidden-gems/:id/verify-visit  — GPS check-in
 * POST   /api/hidden-gems/:id/report   — report a gem
 * GET    /api/hidden-gems/nearby        — proximity-ranked gems
 * POST   /api/hidden-gems/:id/share-telegraph — share to Telegraph
 * POST   /api/hidden-gems/:id/plan     — add to trip plan
 *
 * Admin (requires profiles.role = 'admin'):
 * GET    /api/admin/hidden-gems/pending          — pending queue
 * GET    /api/admin/hidden-gems/reported         — reported gems
 * GET    /api/admin/hidden-gems/guide-applications — guide applications
 * POST   /api/admin/hidden-gems/:id/verify       — admin verify/hide gem
 * POST   /api/admin/hidden-gems/:id/sensitive    — mark sensitive
 * POST   /api/admin/hidden-gems/:id/merge        — merge duplicate
 * POST   /api/admin/local-guides/:userId/status  — approve/demote guide
 *
 * Privacy: HiddenGemPrivacyGuard is called on every response before serialising.
 *          Protected gems: exact coords NEVER returned.
 *          LLM calls (Compass): protected gems excluded entirely.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError, canEditPlan } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import {
  submitGem,
  getGem,
  listGems,
  updateGem,
  updateGemAsGuide,
  saveGem,
  unsaveGem,
  listSavedGems,
} from "../services/hiddenGems/HiddenGemService.js";
import { findNearbyGems } from "../services/hiddenGems/HiddenGemDiscoveryService.js";
import {
  applyGemPrivacy,
  applyGemPrivacyBatch,
} from "../services/hiddenGems/HiddenGemPrivacyGuard.js";
import {
  recordGpsCheckin,
  recordGuideVerification,
  recordAdminVerification,
} from "../services/hiddenGems/HiddenGemVerificationService.js";
import {
  reportGem,
  markSensitive,
  hideGem,
  mergeDuplicate,
  resolveGemReport,
  getPendingQueue,
  getReportedGems,
  getGuideApplications,
  getSensitiveGems,
  getDuplicateCandidates,
} from "../services/hiddenGems/HiddenGemModerationService.js";
import {
  applyForGuide,
  getGuideProfile,
  recordContribution,
  setGuideStatus,
} from "../services/hiddenGems/LocalGuideService.js";
import {
  recordGemContribution,
  batchDeriveGemProjections,
  deriveGemProjection,
} from "../services/hiddenGems/HiddenGemContributionService.js";
import { GEM_CONTRIBUTION_TYPES } from "../lib/hiddenGemState.js";
import { logDiscoveryServe, DiscoveryServePoint } from "../lib/discoveryServeLog.js";

import { isAdmin } from "../lib/requireAdmin.js";

const router = Router();

// ── Feature flag helper ───────────────────────────────────────────────────────

async function isFlagEnabled(db: any, flag: string): Promise<boolean> {
  try {
    const { data } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flag)
      .maybeSingle();
    return !!(data as any)?.enabled;
  } catch {
    return false;
  }
}

// ── Validation schemas ─────────────────────────────────────────────────────────

const VALID_CATEGORIES = [
  "food", "drink", "nature", "culture", "adventure", "nightlife",
  "wellness", "local_secret", "market", "viewpoint", "transport", "other",
] as const;

const VALID_SENSITIVITY = [
  "public", "approximate", "reveal_after_save",
  "reveal_after_acceptance", "protected",
] as const;

const VALID_REPORT_REASONS = [
  "inaccurate", "unsafe", "outdated", "duplicate", "spam", "offensive", "other",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_CROWD_LEVELS = ["quiet", "moderate", "busy", "very_busy"] as const;
const VALID_VISIBILITIES = ["public", "circle_only", "private"] as const;

const submitSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.enum(VALID_CATEGORIES),
  city: z.string().min(1).max(100),
  country: z.string().max(100).optional().nullable(),
  neighborhood: z.string().max(100).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  approxLatitude: z.number().min(-90).max(90).optional().nullable(),
  approxLongitude: z.number().min(-180).max(180).optional().nullable(),
  vibeTags: z.array(z.string().max(50)).max(10).optional(),
  priceRange: z.enum(["free", "$", "$$", "$$$", "$$$$"]).optional().nullable(),
  safetyNotes: z.string().max(1000).optional().nullable(),
  bestTimeToGo: z.string().max(300).optional().nullable(),
  layoverSafe: z.boolean().optional(),
  minimumLayoverMinutes: z.number().int().min(0).max(1440).optional().nullable(),
  sensitivityLevel: z.enum(VALID_SENSITIVITY).optional(),
  imageUrl: z.string().url().max(2048).optional().nullable(),
  // ── Fields required by the dedicated "Add a Gem" creation flow ──────────────
  /**
   * canonicalPlaceId — UUID of the verified place from the places table.
   * Required when sourceConfirmation is provided (dedicated gem creation flow).
   * Must be a valid UUID; raw coordinates or free-text names are rejected.
   */
  canonicalPlaceId: z.string().uuid().optional().nullable(),
  /**
   * sourceConfirmation — the submitter's explicit attestation that the
   * submitted media actually depicts the selected place. Must be true when
   * present; submitting false or omitting it while providing canonicalPlaceId
   * is rejected with 422.
   */
  sourceConfirmation: z.boolean().optional(),
  /** Visibility for the gem (defaults to 'public' when omitted). */
  visibility: z.enum(VALID_VISIBILITIES).optional().nullable(),
  /** Accessibility information (optional). */
  accessibility: z.string().max(500).optional().nullable(),
  /** Crowd level estimate (optional). */
  crowdLevel: z.enum(VALID_CROWD_LEVELS).optional().nullable(),
  /** UUID of the trip to attach this gem to at submission time (optional). */
  tripId: z.string().uuid().optional().nullable(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  safetyNotes: z.string().max(1000).optional().nullable(),
  bestTimeToGo: z.string().max(300).optional().nullable(),
  localEtiquette: z.string().max(500).optional().nullable(),
  vibeTags: z.array(z.string().max(50)).max(10).optional(),
  priceRange: z.enum(["free", "$", "$$", "$$$", "$$$$"]).optional().nullable(),
  sensitivityLevel: z.enum(VALID_SENSITIVITY).optional(),
  layoverSafe: z.boolean().optional(),
  minimumLayoverMinutes: z.number().int().min(0).max(1440).optional().nullable(),
});

const reportSchema = z.object({
  reason: z.enum(VALID_REPORT_REASONS),
  notes: z.string().max(500).optional(),
});

const checkinSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  tripId: z.string().uuid().optional().nullable(),
});

// §16.3 structured gem contribution — an observation, never a canonical flip.
const contributionSchema = z.object({
  contributionType: z.enum(GEM_CONTRIBUTION_TYPES),
  notes: z.string().max(500).optional().nullable(),
});

// ── Helper: resolve caller ID from bearer token (optional auth) ───────────────

// ── Vote + review aggregate batch enrichment (gems) ──────────────────────────

type GemAgg = { worthItCount: number; avgRating: number | null; reviewCount: number };

async function batchFetchGemAggregates(
  sc: ReturnType<typeof getServiceClient>,
  gemIds: string[],
): Promise<Map<string, GemAgg>> {
  const result = new Map<string, GemAgg>();
  if (!sc || gemIds.length === 0) return result;
  try {
    const [votesRes, reviewsRes] = await Promise.all([
      sc
        .from("place_votes")
        .select("entity_id, vote")
        .eq("entity_type", "gem")
        .in("entity_id", gemIds),
      sc
        .from("reviews")
        .select("entity_id, rating")
        .eq("entity_type", "place")
        .in("entity_id", gemIds)
        .eq("state", "published"),
    ]);
    for (const row of (votesRes.data ?? []) as any[]) {
      const id = row.entity_id as string;
      if (!result.has(id)) result.set(id, { worthItCount: 0, avgRating: null, reviewCount: 0 });
      if (row.vote === "worth_it") result.get(id)!.worthItCount++;
    }
    const reviewsByGem = new Map<string, number[]>();
    for (const row of (reviewsRes.data ?? []) as any[]) {
      const id = row.entity_id as string;
      if (!reviewsByGem.has(id)) reviewsByGem.set(id, []);
      if (row.rating != null) reviewsByGem.get(id)!.push(parseFloat(String(row.rating)));
    }
    for (const [id, ratings] of reviewsByGem) {
      if (!result.has(id)) result.set(id, { worthItCount: 0, avgRating: null, reviewCount: 0 });
      const entry = result.get(id)!;
      entry.reviewCount = ratings.length;
      if (ratings.length > 0) {
        entry.avgRating =
          Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10;
      }
    }
  } catch { /* non-fatal */ }
  return result;
}

async function resolveCallerId(req: any, sc: any): Promise<string | null> {
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    const { data } = await sc.auth.getUser(token);
    return (data?.user?.id as string) ?? null;
  } catch {
    return null;
  }
}

// ── POST /api/hidden-gems — submit a new gem ───────────────────────────────────

router.post("/hidden-gems", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  // ── Dedicated "Add a Gem" flow validation ─────────────────────────────────
  // When canonicalPlaceId OR sourceConfirmation is present in the payload (i.e.
  // the request came from the dedicated gem-creation UI, not a legacy path),
  // enforce the full set of required gem-creation fields:
  //   1. sourceConfirmation must be exactly true (not false, not omitted).
  //   2. canonicalPlaceId must be a non-empty, well-formed UUID that resolves
  //      to a live, non-duplicate place row.
  //
  // Callers cannot bypass the attestation requirement by omitting sourceConfirmation
  // while providing canonicalPlaceId — the presence of either field triggers
  // the full validation gate.
  // Free-text names, raw coordinates, hashtags, or unconfirmed media are blocked.
  const isGemCreationFlow =
    parsed.data.canonicalPlaceId !== undefined ||
    parsed.data.sourceConfirmation !== undefined;

  if (isGemCreationFlow) {
    if (parsed.data.sourceConfirmation !== true) {
      res.status(422).json({
        error: "invalid_payload",
        message:
          "You must confirm that the submitted media actually depicts the selected place. " +
          "Illustrative images and unrelated media are not accepted.",
      });
      return;
    }

    // canonicalPlaceId is optional — a freehand gem (no linked place) may omit
    // it and still submit. Only validate when the caller actually supplies one.
    const cpid = parsed.data.canonicalPlaceId;
    if (cpid !== null && cpid !== undefined) {
      if (!UUID_RE.test(cpid)) {
        res.status(422).json({
          error: "invalid_payload",
          message:
            "The linked place ID is not a valid UUID. " +
            "Please select a place from the autocomplete list.",
        });
        return;
      }

      // Verify the canonicalPlaceId actually exists in the places table.
      const { data: placeRow } = await sc
        .from("places")
        .select("id, status")
        .eq("id", cpid)
        .maybeSingle();

      if (!placeRow) {
        res.status(422).json({
          error: "invalid_payload",
          message: "The selected place could not be verified. Please search and select the location again.",
        });
        return;
      }

      if ((placeRow as any).status === "duplicate") {
        res.status(422).json({
          error: "invalid_payload",
          message: "The selected place has been merged into another record. Please search and select the location again.",
        });
        return;
      }
    }
  }

  // ── tripId validation ────────────────────────────────────────────────────────
  // When the caller provides a tripId, verify:
  //   1. The trip exists and is active or upcoming.
  //   2. The caller is the trip owner or an accepted member.
  // Client-side filtering is not sufficient; enforce ownership server-side.
  if (parsed.data.tripId) {
    const [tripRes, memberRes] = await Promise.all([
      sc
        .from("trips")
        .select("id, owner_id, status")
        .eq("id", parsed.data.tripId)
        .maybeSingle(),
      sc
        .from("trip_members")
        .select("role")
        .eq("trip_id", parsed.data.tripId)
        .eq("user_id", user.id)
        .in("role", ["owner", "member"])
        .maybeSingle(),
    ]);

    const tripRow = tripRes.data as any;
    if (!tripRow) {
      res.status(422).json({ error: "invalid_payload", message: "Trip not found." });
      return;
    }

    const allowedStatuses = ["active", "upcoming"];
    if (!allowedStatuses.includes(tripRow.status)) {
      res.status(422).json({
        error: "invalid_payload",
        message: "Gems can only be attached to active or upcoming trips.",
      });
      return;
    }

    const isOwner = tripRow.owner_id === user.id;
    const isMember = !!(memberRes.data);
    if (!isOwner && !isMember) {
      res.status(403).json({
        error: "forbidden",
        message: "You are not a member of this trip.",
      });
      return;
    }
  }

  try {
    const gem = await submitGem(sc, { ...parsed.data, submittedBy: user.id });
    const safe = await applyGemPrivacy(gem, sc, user.id);
    res.status(201).json({ ok: true, gem: safe });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── GET /api/hidden-gems — list/filter ────────────────────────────────────────

router.get("/hidden-gems", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const callerId = await resolveCallerId(req, sc);
  const callerTripId = (req.query.tripId as string) || null;

  const opts: any = {
    limit: Math.min(parseInt(req.query.limit as string) || 40, 100),
  };
  if (req.query.city) opts.city = req.query.city as string;
  if (req.query.neighborhood) opts.neighborhood = req.query.neighborhood as string;
  if (req.query.category) opts.category = req.query.category as string;
  if (req.query.layoverSafe === "1") {
    opts.layoverSafe = true;
    if (req.query.availableMinutes) opts.minLayoverMinutes = parseInt(req.query.availableMinutes as string);
  }
  if (req.query.verificationLevel) opts.verificationLevel = req.query.verificationLevel as string;
  if (req.query.submittedBy)       opts.submittedBy = req.query.submittedBy as string;

  // tripId filter: return gems explicitly attached to this trip at submission time.
  // Requires auth + caller must be the trip owner or an accepted member.
  if (callerTripId && UUID_RE.test(callerTripId) && !opts.submittedBy) {
    // Auth is required for this filtered view.
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    // Verify trip exists and caller is a member or owner.
    const [tripRes, memberRes] = await Promise.all([
      sc
        .from("trips")
        .select("id, owner_id, status")
        .eq("id", callerTripId)
        .maybeSingle(),
      sc
        .from("trip_members")
        .select("role")
        .eq("trip_id", callerTripId)
        .eq("user_id", user.id)
        .in("role", ["owner", "member"])
        .maybeSingle(),
    ]);

    const tripRow = tripRes.data as any;
    if (!tripRow) { sendError(res, "not_found", "Trip not found"); return; }

    const isOwner = tripRow.owner_id === user.id;
    const isMember = !!(memberRes.data);
    if (!isOwner && !isMember) {
      res.status(403).json({ error: "forbidden", message: "You are not a member of this trip." });
      return;
    }

    try {
      // hidden_gems has no trip_id column — a gem's attachment to a trip is
      // recorded in trip_plan_items (source_type="hidden_gem", source_id =
      // gem id), the same table /:id/plan writes to. Resolve the gem ids via
      // that join table first, then fetch the gems themselves.
      const { data: planItems } = await sc
        .from("trip_plan_items")
        .select("source_id")
        .eq("trip_id", callerTripId)
        .eq("source_type", "hidden_gem");
      const gemIdsForTrip = [...new Set(((planItems as any[]) ?? []).map((p: any) => p.source_id as string))];
      const { data: tripGems } = gemIdsForTrip.length
        ? await sc
            .from("hidden_gems")
            .select("*")
            .in("id", gemIdsForTrip)
            .eq("status", "active")
            .order("created_at", { ascending: false })
            .limit(opts.limit)
        : { data: [] as any[] };
      const safe = await applyGemPrivacyBatch(tripGems ?? [], sc, user.id, callerTripId);
      const gemIds = (safe as any[]).map((g: any) => g.id as string);
      const agg = await batchFetchGemAggregates(sc, gemIds);
      const enriched = (safe as any[]).map((g: any) => {
        const a = agg.get(g.id);
        return a ? { ...g, worthItCount: a.worthItCount, avgRating: a.avgRating, reviewCount: a.reviewCount } : g;
      });
      return res.json({ gems: enriched, total: enriched.length });
    } catch (err: any) {
      return sendError(res, "db_error", err.message);
    }
  }

  // submittedBy: return gems submitted by a specific user (public guide profile queries)
  if (opts.submittedBy) {
    try {
      const { data: userGems } = await sc
        .from("hidden_gems")
        .select("*")
        .eq("submitted_by", opts.submittedBy)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(opts.limit);
      const safe = await applyGemPrivacyBatch(userGems ?? [], sc, callerId, callerTripId);
      const gemIds2 = (safe as any[]).map((g: any) => g.id as string);
      const agg2 = await batchFetchGemAggregates(sc, gemIds2);
      const enriched2 = (safe as any[]).map((g: any) => {
        const a = agg2.get(g.id);
        return a ? { ...g, worthItCount: a.worthItCount, avgRating: a.avgRating, reviewCount: a.reviewCount } : g;
      });
      return res.json({ gems: enriched2, total: enriched2.length });
    } catch (err: any) {
      return sendError(res, "db_error", err.message);
    }
  }

  try {
    // Use weighted discovery ranking (verif weight + saves + visits + vibe-tag match)
    const { discoverGems } = await import("../services/hiddenGems/HiddenGemDiscoveryService.js");
    const ranked = await discoverGems(sc, {
      city: opts.city,
      neighborhood: opts.neighborhood,
      category: opts.category,
      layoverSafe: opts.layoverSafe,
      availableMinutes: opts.minLayoverMinutes,
      limit: opts.limit,
    });
    const rawGems = ranked.map((r) => r.gem);
    const safe = await applyGemPrivacyBatch(rawGems, sc, callerId, callerTripId);
    const gemIds3 = (safe as any[]).map((g: any) => g.id as string);
    const [agg3, projections3] = await Promise.all([
      batchFetchGemAggregates(sc, gemIds3),
      batchDeriveGemProjections(sc, rawGems),
    ]);
    const enriched3 = (safe as any[]).map((g: any) => {
      const a = agg3.get(g.id);
      const p = projections3.get(g.id);
      const base = a ? { ...g, worthItCount: a.worthItCount, avgRating: a.avgRating, reviewCount: a.reviewCount } : { ...g };
      if (p) { base.gemState = p.gemState; base.gemConfidence = p.gemConfidence; }
      return base;
    });
    res.json({ gems: enriched3, total: enriched3.length });

    // Serve point 11 — this route ranks (discoverGems: verification weight +
    // saves + visits + vibe-tag match) and served its results to users while
    // writing no rank_events row of any kind, so Discovery analytics could not
    // see hidden gems at all — not the impressions, and therefore not the
    // outcomes either, because POST /rank-events/outcome resolves an outcome by
    // finding the impression row it upgrades.
    //
    // AFTER res.json and un-awaited: logDiscoveryServe never throws and is
    // itself gated on discovery_serve_log_enabled, so this adds no latency and
    // cannot fail the request. It no-ops for anonymous callers, because
    // rank_events.user_id is NOT NULL.
    void logDiscoveryServe(sc, {
      userId:     callerId ?? "",
      servePoint: DiscoveryServePoint.HIDDEN_GEMS,
      route:      "GET /hidden-gems",
      items:      enriched3.map((g: any) => ({ id: String(g.id), kind: "gem" as const })),
      context:    {
        city:         opts.city ?? null,
        neighborhood: opts.neighborhood ?? null,
        category:     opts.category ?? null,
        layoverSafe:  opts.layoverSafe === true,
      },
    });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── GET /api/hidden-gems/saved — caller's saved gems ─────────────────────────

router.get("/hidden-gems/saved", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  try {
    const gems = await listSavedGems(sc, user.id);
    const safe = await applyGemPrivacyBatch(gems, sc, user.id);
    const gemIds = (safe as any[]).map((g: any) => g.id as string);
    const agg = await batchFetchGemAggregates(sc, gemIds);
    const enriched = (safe as any[]).map((g: any) => {
      const a = agg.get(g.id);
      return a ? { ...g, worthItCount: a.worthItCount, avgRating: a.avgRating, reviewCount: a.reviewCount } : g;
    });
    res.json({ gems: enriched, total: enriched.length });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── GET /api/hidden-gems/layover-safe — time-window filtered ─────────────────

router.get("/hidden-gems/layover-safe", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }
  if (!await isFlagEnabled(sc, "hidden_gems_layover_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const availableMinutes = parseInt(req.query.availableMinutes as string);
  if (!Number.isFinite(availableMinutes) || availableMinutes < 1) {
    sendError(res, "invalid_payload", "availableMinutes must be a positive integer");
    return;
  }

  const callerId = await resolveCallerId(req, sc);
  const city = req.query.city as string | undefined;

  try {
    const gems = await listGems(sc, {
      city,
      layoverSafe: true,
      minLayoverMinutes: availableMinutes,
    });
    const safe = await applyGemPrivacyBatch(gems, sc, callerId);
    res.json({ gems: safe, total: safe.length, availableMinutes });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── GET /api/hidden-gems/trip-city/:tripId — gems for a trip's city ───────────

router.get("/hidden-gems/trip-city/:tripId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const tripId = req.params.tripId;

  // Load trip destination
  const { data: trip } = await client
    .from("trips")
    .select("id, destination_city")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip) {
    sendError(res, "not_found", "Trip not found");
    return;
  }

  const city = (trip as any).destination_city?.split(",")[0]?.trim();
  if (!city) {
    res.json({ gems: [], total: 0 });
    return;
  }

  try {
    const gems = await listGems(sc, { city, limit: 30 });
    const safe = await applyGemPrivacyBatch(gems, sc, user.id, tripId);
    const gemIds = (safe as any[]).map((g: any) => g.id as string);
    const agg = await batchFetchGemAggregates(sc, gemIds);
    const enriched = (safe as any[]).map((g: any) => {
      const a = agg.get(g.id);
      return a ? { ...g, worthItCount: a.worthItCount, avgRating: a.avgRating, reviewCount: a.reviewCount } : g;
    });
    res.json({ gems: enriched, total: enriched.length, city });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── GET /api/hidden-gems/nearby — proximity-ranked gems ──────────────────────
// NOTE: registered here (before /:id) so Express doesn't swallow "nearby" as an id.

const nearbySchema = z.object({
  lat:      z.coerce.number().min(-90).max(90),
  lng:      z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().min(0.1).max(100).optional().default(5),
  category: z.string().optional(),
  limit:    z.coerce.number().int().min(1).max(50).optional().default(30),
});

router.get("/hidden-gems/nearby", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const parsed = nearbySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }

  try {
    const ranked = await findNearbyGems(sc, parsed.data.lat, parsed.data.lng, parsed.data.radiusKm, {
      category: parsed.data.category,
      limit: parsed.data.limit,
    });

    const projections = await batchDeriveGemProjections(sc, ranked.map((r) => r.gem));
    const gems = await Promise.all(
      ranked.map(async ({ gem, distanceKm }) => {
        const safe = await applyGemPrivacy(gem, sc, user.id);
        const p = projections.get((gem as any).id);
        return {
          ...safe,
          distanceKm,
          ...(p ? { gemState: p.gemState, gemConfidence: p.gemConfidence } : {}),
        };
      }),
    );

    res.json({ ok: true, gems });

    // Serve point 11 — same reasoning as GET /hidden-gems above; the `route`
    // field is what separates the two in the corpus. findNearbyGems ranks by
    // proximity, so this is also a ranked-in-request serve.
    void logDiscoveryServe(sc, {
      userId:     user.id,
      servePoint: DiscoveryServePoint.HIDDEN_GEMS,
      route:      "GET /hidden-gems/nearby",
      items:      gems.map((g: any) => ({ id: String(g.id), kind: "gem" as const })),
      // Never the caller's coordinates — spec §8: precise GPS is not logged.
      context:    { radiusKm: parsed.data.radiusKm, category: parsed.data.category ?? null },
    });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── GET /api/hidden-gems/:id — detail ─────────────────────────────────────────

router.get("/hidden-gems/:id", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const callerId = await resolveCallerId(req, sc);
  const callerTripId = (req.query.tripId as string) || null;

  try {
    const gem = await getGem(sc, req.params.id);
    if (!gem) { sendError(res, "not_found", "Gem not found"); return; }
    // Non-active gems (pending / hidden / merged) are only visible to owner or admin
    if ((gem as any).status !== "active" && (gem as any).submitted_by !== callerId) {
      // Renamed from `isAdmin` when the shared predicate arrived: a local
      // `const isAdmin` would shadow the import inside this block and make
      // its own initialiser a TDZ ReferenceError.
      const callerIsAdmin = callerId ? await isAdmin(sc, callerId) : false;
      // 404, not 403 — this branch is reached while composing a response for
      // a caller who may not know the gem exists, and saying "forbidden"
      // would confirm that it does.
      if (!callerIsAdmin) { sendError(res, "not_found", "Gem not found"); return; }
    }

    const safe = await applyGemPrivacy(gem, sc, callerId, callerTripId);

    // Derive the §16 semantic state + numeric confidence at read time from the
    // gem's existing signals + structured contributions (never stored). Reads no
    // coordinate values beyond presence, so it is privacy-neutral.
    const projection = await deriveGemProjection(sc, gem);
    (safe as any).gemState = projection.gemState;
    (safe as any).gemConfidence = projection.gemConfidence;

    // Attach guide profile if gem has guide_verified_by
    let guideProfile: any = null;
    if ((gem as any).guide_verified_by) {
      guideProfile = await getGuideProfile(sc, (gem as any).guide_verified_by);
    }

    // Attach saved state for authenticated callers
    let savedByMe = false;
    if (callerId) {
      const { data: saveRow } = await sc
        .from("hidden_gem_saves")
        .select("gem_id")
        .eq("gem_id", req.params.id)
        .eq("user_id", callerId)
        .maybeSingle();
      savedByMe = !!saveRow;
    }

    res.json({ gem: safe, guideProfile, savedByMe });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── PATCH /api/hidden-gems/:id — owner/guide edit ─────────────────────────────

router.patch("/hidden-gems/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  try {
    const rawPatch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== null),
    ) as Parameters<typeof updateGem>[3];

    // Determine if caller is an active guide (but not the owner)
    const guide = await getGuideProfile(sc, user.id);
    const isActiveGuide = guide && (guide as any).status === "active";

    // Fetch gem to check ownership
    const existing = await getGem(sc, req.params.id);
    if (!existing) { sendError(res, "not_found", "Gem not found"); return; }
    const isOwner = (existing as any).submitted_by === user.id;

    let updated: any;
    if (isOwner) {
      // Owners may change all fields
      updated = await updateGem(sc, req.params.id, user.id, rawPatch);
    } else if (isActiveGuide) {
      // Guides may only touch community-knowledge fields
      const guidePatch: Parameters<typeof updateGemAsGuide>[3] = {};
      if (rawPatch.safetyNotes    !== undefined) guidePatch.safetyNotes    = rawPatch.safetyNotes;
      if (rawPatch.bestTimeToGo   !== undefined) guidePatch.bestTimeToGo   = rawPatch.bestTimeToGo;
      if (rawPatch.localEtiquette !== undefined) guidePatch.localEtiquette = rawPatch.localEtiquette;
      if (rawPatch.vibeTags       !== undefined) guidePatch.vibeTags       = rawPatch.vibeTags;
      updated = await updateGemAsGuide(sc, req.params.id, user.id, guidePatch);
    } else {
      sendError(res, "forbidden", "Only the gem owner or an active local guide can edit this gem");
      return;
    }

    const safe = await applyGemPrivacy(updated, sc, user.id);

    // Record guide contribution for any active guide (including owner-guides)
    if (isActiveGuide) {
      const ct = parsed.data.safetyNotes ? "safety_notes"
        : parsed.data.bestTimeToGo ? "best_time"
        : parsed.data.localEtiquette ? "etiquette"
        : "gem_submitted";
      await recordContribution(sc, user.id, req.params.id, ct).catch(() => {});
    }

    res.json({ ok: true, gem: safe });
  } catch (err: any) {
    if ((err as any).code === "not_a_guide") {
      sendError(res, "forbidden", err.message); return;
    }
    sendError(res, "db_error", err.message);
  }
});

// ── POST /api/hidden-gems/:id/save ────────────────────────────────────────────

router.post("/hidden-gems/:id/save", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  try {
    const result = await saveGem(sc, req.params.id, user.id);
    res.json({ ok: true, alreadySaved: result.alreadySaved });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── DELETE /api/hidden-gems/:id/save ─────────────────────────────────────────

router.delete("/hidden-gems/:id/save", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  try {
    const result = await unsaveGem(sc, req.params.id, user.id);
    res.json({ ok: true, removed: result.removed });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── POST /api/hidden-gems/:id/verify-visit — GPS check-in ─────────────────────

router.post("/hidden-gems/:id/verify-visit", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }
  if (!await isFlagEnabled(sc, "hidden_gem_verification_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const parsed = checkinSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { latitude, longitude, tripId } = parsed.data;

  try {
    const result = await recordGpsCheckin(sc, req.params.id, user.id, latitude, longitude);

    if (result.error === "gem_not_found") { sendError(res, "not_found", "Gem not found"); return; }
    if (result.error === "gem_not_active") { sendError(res, "invalid_payload", "Gem is not active"); return; }

    // Fire-and-forget: Passport stamp + suggested memory after verified visit
    if (result.ok && !result.isSuspicious) {
      void (async () => {
        try {
          const { data: passportFlag } = await sc
            .from("feature_flags").select("enabled").eq("flag", "hidden_gems_passport_enabled").maybeSingle();
          if (!(passportFlag as any)?.enabled) return;

          const { createStamp } = await import("../services/passport/PassportStampService.js");
          const { createSuggestedMemory } = await import("../services/passport/PassportMemoryService.js");

          // Load gem for city/country context (we need it for the stamp)
          const gem = await getGem(sc, req.params.id);
          if (!gem) return;

          const stampResult = await createStamp(sc, {
            userId: user.id,
            stampType: "city",
            country: (gem as any).country ?? null,
            city: (gem as any).city ?? null,
            tripId: tripId ?? null,
            verificationLevel: "checkin",
            sourceType: "hidden_gem_visit",
          });

          // §20 ledger (TABLE 21): this is the ONLY producer of
          // `hidden_gem_verified`, the sole type behind the projection's
          // `hiddenGems` headline count — which was structurally zero for every
          // traveller until now. Only reached when the check-in is
          // GPS-verified and not flagged suspicious (see the guard above).
          const { recordContributionIfEnabled } = await import(
            "../services/passport/PassportContributionService.js"
          );
          void recordContributionIfEnabled(sc, {
            userId: user.id,
            eventType: "hidden_gem_verified",
            sourceType: "hidden_gem_visit",
            sourceId: req.params.id,
            verificationLevel: "checkin",
            metadata: {
              city: (gem as any).city ?? null,
              country: (gem as any).country ?? null,
              category: "hidden_gem",
            },
          });

          if (stampResult?.isNew) {
            const { data: memFlag } = await sc
              .from("feature_flags").select("enabled").eq("flag", "passport_memories_enabled").maybeSingle();
            if ((memFlag as any)?.enabled) {
              await createSuggestedMemory(sc, {
                userId: user.id,
                title: `Hidden Gem: ${(gem as any).name}`,
                country: (gem as any).country ?? null,
                city: (gem as any).city ?? null,
                neighborhood: (gem as any).neighborhood ?? null,
                category: "hidden_gem",
                tripId: tripId ?? null,
                sourceType: "hidden_gem_visit",
                verificationLevel: "checkin",
                suggestionReason: "You visited a hidden gem",
              } as any);
            }
          }
        } catch { /* non-fatal */ }
      })();
    }

    // Fire-and-forget: Pulse post after verified non-suspicious GPS check-in
    if (result.ok && !result.isSuspicious) {
      void (async () => {
        try {
          const { data: pulseFlag } = await sc
            .from("feature_flags").select("enabled").eq("flag", "hidden_gems_pulse_enabled").maybeSingle();
          if (!(pulseFlag as any)?.enabled) return;

          const gem = await getGem(sc, req.params.id);
          if (!gem) return;

          // Insert a Pulse post tagged to the gem's city — no exact coords
          await sc.from("posts").insert({
            author_id: user.id,
            content: `Just verified a hidden gem: "${(gem as any).name}" in ${(gem as any).city} 📍`,
            visibility: "public",
            category: "hidden_gem_checkin",
          });
        } catch { /* non-fatal */ }
      })();
    }

    res.json({
      ok: result.ok,
      visitId: result.visitId,
      distanceM: result.distanceM,
      withinRange: result.withinRange,
      trustLevel: result.trustLevel,
      isSuspicious: result.isSuspicious,
      verificationUpgraded: result.verificationUpgraded,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── POST /api/hidden-gems/:id/report ──────────────────────────────────────────

router.post("/hidden-gems/:id/report", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  try {
    const result = await reportGem(sc, req.params.id, user.id, parsed.data.reason, parsed.data.notes);
    res.json({ ok: true, alreadyReported: result.alreadyReported });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── POST /api/hidden-gems/:id/contribute — §16.3 structured contribution ──────
// Records one of the nine structured contribution types as an OBSERVATION. It
// feeds gem confidence and the derived state; it NEVER flips canonical status on
// its own (§16.3). Returns the freshly-derived projection so the client can show
// the updated (still community-derived, not canonically-flipped) state.

router.post("/hidden-gems/:id/contribute", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const parsed = contributionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  try {
    const result = await recordGemContribution(
      sc, req.params.id, user.id, parsed.data.contributionType, parsed.data.notes ?? null,
    );

    if (result.error === "gem_not_found") { sendError(res, "not_found", "Gem not found"); return; }
    if (result.error === "gem_not_active") { sendError(res, "invalid_payload", "Gem is not active"); return; }
    if (result.error === "invalid_contribution_type") { sendError(res, "invalid_payload", "Invalid contribution type"); return; }
    if (!result.ok) { sendError(res, "db_error", "Failed to record contribution"); return; }

    // Re-derive the projection so the caller sees the state as it now reads.
    const gem = await getGem(sc, req.params.id);
    const projection = gem ? await deriveGemProjection(sc, gem) : null;

    res.json({
      ok: true,
      contributionId: result.contributionId,
      alreadyObserved: result.alreadyObserved,
      gemState: projection?.gemState ?? null,
      gemConfidence: projection?.gemConfidence ?? null,
    });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── POST /api/hidden-gems/:id/share-telegraph — share to Telegraph ────────────

router.post("/hidden-gems/:id/share-telegraph", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const threadId = req.body?.threadId;
  if (!threadId) { sendError(res, "invalid_payload", "threadId is required"); return; }

  // Thread access is gated ONLY by message_thread_members — the same check the
  // canonical send path makes before its insert (routes/messaging.ts, and
  // verifyThreadMember in routes/telegraphChat.ts). Without it, threadId came
  // straight from the body and any authenticated user could post a message into
  // ANY thread id they could guess. The insert below runs on the service-role
  // client, so RLS is not a backstop, and messages_thread_id_fkey only proves
  // the thread exists — not that the sender belongs to it.
  const { data: threadMember } = await sc
    .from("message_thread_members")
    .select("user_id, left_at")
    .eq("thread_id", threadId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!threadMember || (threadMember as any).left_at !== null) {
    sendError(res, "forbidden", "Not a member of this thread");
    return;
  }

  try {
    const gem = await getGem(sc, req.params.id);
    if (!gem) { sendError(res, "not_found", "Gem not found"); return; }
    // Enforce active-only for non-owners sharing gems
    if ((gem as any).status !== "active" && (gem as any).submitted_by !== user.id) {
      sendError(res, "not_found", "Gem not found"); return;
    }

    // Run through the privacy guard — single choke-point for all coord/neighborhood disclosure
    const safe = await applyGemPrivacy(gem, sc, user.id);

    const sensitivityLevel = (safe as any).sensitivity_level ?? (safe as any).sensitivityLabel;
    const isProtected = sensitivityLevel === "protected";

    const card: Record<string, unknown> = {
      type: "hidden_gem",
      gemId: (safe as any).id,
      name: (safe as any).name,
      category: (safe as any).category,
      city: (safe as any).city,
      country: (safe as any).country ?? null,
      // Protected gems: strip neighborhood — exact location must never leak via Telegraph
      neighborhood: isProtected ? null : ((safe as any).neighborhood ?? null),
      sensitivityLabel: sensitivityLevel,
      verificationLevel: (safe as any).verificationLevel ?? (safe as any).verification_level,
      priceRange: (safe as any).priceRange ?? (safe as any).price_range ?? null,
      vibeTags: (safe as any).vibeTags ?? (safe as any).vibe_tags ?? [],
    };

    // Insert Telegraph message with the gem card embedded as JSON in body
    // (messages has body — not content — and no metadata column).
    await client
      .from("messages")
      .insert({
        thread_id: threadId,
        sender_id: user.id,
        body: JSON.stringify({
          ...card,
          text: `📍 Shared a hidden gem: ${(gem as any).name} in ${(gem as any).city}`,
        }),
        msg_type: "card",
        subtype: "hidden_gem",
      });

    res.json({ ok: true, card });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── POST /api/hidden-gems/:id/plan — add to trip plan ────────────────────────

router.post("/hidden-gems/:id/plan", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "hidden_gems_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const tripId = req.body?.tripId;
  if (!tripId) { sendError(res, "invalid_payload", "tripId is required"); return; }

  // tripId is caller-supplied and was previously written straight through with
  // no membership or plan-edit check at all, so any authenticated user could
  // add an item to any trip id they could guess. Same shape as
  // routes/compassAutopilot.ts: null means the trip does not exist, false means
  // it does but this user may not edit its plan.
  const permitted = await canEditPlan(sc, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You don't have permission to edit this trip's plan"); return; }

  try {
    const gem = await getGem(sc, req.params.id);
    if (!gem) { sendError(res, "not_found", "Gem not found"); return; }

    // Duplicate guard, mirroring routes/plan.ts. trip_plan_items_source_uniq
    // (trip_id, source_type, source_id) means a second tap raises 23505, which
    // becomes a db_error and is then SANITIZED to "A database error occurred" —
    // so the client cannot tell a duplicate from a real failure. Return the
    // established 409 shape instead.
    const { data: existing } = await client
      .from("trip_plan_items")
      .select("id")
      .eq("trip_id", tripId)
      .eq("source_type", "hidden_gem")
      .eq("source_id", (gem as any).id)
      .is("removed_at", null)
      .maybeSingle();
    if (existing) {
      res.status(409).json({ error: "duplicate", message: "This gem is already in your trip plan" });
      return;
    }

    // Location reveal follows sensitivity rules
    const coords = await (async () => {
      const { resolveGemCoords } = await import("../services/hiddenGems/HiddenGemPrivacyGuard.js");
      return resolveGemCoords(gem as any, sc, user.id, (gem as any).submitted_by ?? null, tripId);
    })();

    const planItem = {
      trip_id: tripId,
      // creator_id is NOT NULL and required by the generated Insert type
      // (database.types.ts: `creator_id: string`), while added_by is optional
      // (`added_by?: string | null`). This insert set only added_by, so every
      // call violated NOT NULL and this endpoint has never once added a gem to
      // a plan — which is also why the missing authorization check above was
      // latent rather than exploited. routes/plan.ts sets creator_id likewise.
      creator_id: user.id,
      added_by: user.id,
      source_type: "hidden_gem",
      source_id: (gem as any).id,
      title: (gem as any).name,
      description: (gem as any).description ?? null,
      location_name: (gem as any).name,
      city: (gem as any).city,
      country: (gem as any).country ?? null,
      // Coords hidden until plan accepted for reveal_after_acceptance gems
      lat: coords.coordsPrecision === "exact" ? coords.lat : null,
      lng: coords.coordsPrecision === "exact" ? coords.lng : null,
      category: (gem as any).category,
    };

    const { data, error } = await client
      .from("trip_plan_items")
      .insert(planItem)
      .select("id")
      .single();

    if (error) { sendError(res, "db_error", error.message); return; }

    res.status(201).json({ ok: true, planItemId: (data as any).id });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── Local Guide profile ───────────────────────────────────────────────────────

router.get("/hidden-gems/guides/:userId", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "local_guides_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  try {
    const guide = await getGuideProfile(sc, req.params.userId);
    if (!guide || (guide as any).status !== "active") {
      sendError(res, "not_found", "Guide not found");
      return;
    }
    res.json({ guide });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

router.post("/hidden-gems/guides/apply", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isFlagEnabled(sc, "local_guides_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const bio = typeof req.body?.bio === "string" ? req.body.bio.slice(0, 500) : undefined;
  const cityExpertise = Array.isArray(req.body?.cityExpertise) ? req.body.cityExpertise.slice(0, 10) : [];

  try {
    const profile = await applyForGuide(sc, user.id, bio, cityExpertise);
    res.status(201).json({ ok: true, guide: profile });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// ── Admin routes ──────────────────────────────────────────────────────────────

router.get("/admin/hidden-gems/pending", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  if (!await isAdmin(sc, user.id)) {
    sendError(res, "forbidden", "Admin access required"); return;
  }

  try {
    const queue = await getPendingQueue(sc);
    res.json({ queue });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

router.get("/admin/hidden-gems/reported", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  if (!await isAdmin(sc, user.id)) {
    sendError(res, "forbidden", "Admin access required"); return;
  }

  try {
    const gems = await getReportedGems(sc);
    res.json({ gems });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

router.get("/admin/hidden-gems/guide-applications", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  if (!await isAdmin(sc, user.id)) {
    sendError(res, "forbidden", "Admin access required"); return;
  }

  try {
    const applications = await getGuideApplications(sc);
    res.json({ applications });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

const adminVerifySchema = z.object({
  result: z.enum(["approved", "rejected", "hidden"]),
  notes: z.string().max(500).optional(),
});

router.get("/admin/hidden-gems/sensitive-gems", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isAdmin(sc, user.id)) { sendError(res, "forbidden", "Admin access required"); return; }
  try {
    const gems = await getSensitiveGems(sc);
    res.json({ gems });
  } catch (err: any) { sendError(res, "db_error", err.message); }
});

router.get("/admin/hidden-gems/duplicate-candidates", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!await isAdmin(sc, user.id)) { sendError(res, "forbidden", "Admin access required"); return; }
  try {
    const gems = await getDuplicateCandidates(sc);
    res.json({ gems });
  } catch (err: any) { sendError(res, "db_error", err.message); }
});

router.post("/admin/hidden-gems/:id/verify", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  if (!await isAdmin(sc, user.id)) {
    sendError(res, "forbidden", "Admin access required"); return;
  }

  const parsed = adminVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  // Fetch gem's submitter before recording the verification (needed for stamp award).
  const { data: gemRow } = await sc
    .from("hidden_gems")
    .select("submitted_by, city, country")
    .eq("id", req.params.id)
    .maybeSingle();

  try {
    await recordAdminVerification(sc, req.params.id, user.id, parsed.data.result, parsed.data.notes);
    res.json({ ok: true });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
    return;
  }

  // Fire-and-forget: award hidden_gem_explorer stamp to the submitter on approval.
  if (parsed.data.result === "approved" && gemRow && (gemRow as any).submitted_by) {
    const submitterId: string = (gemRow as any).submitted_by;
    void (async () => {
      try {
        const { awardStamp } = await import("../services/passport/StampAwardEngine.js");
        const result = await awardStamp(sc, {
          userId:        submitterId,
          definitionSlug: "hidden_gem_explorer",
          sourceType:    "hidden_gems",
          sourceId:      req.params.id,
          city:          (gemRow as any).city    ?? undefined,
          country:       (gemRow as any).country ?? undefined,
        });
        if (result.awarded) {
          const { NotificationService } = await import("../services/notifications/NotificationService.js");
          const { NotificationRouter }  = await import("../services/notifications/NotificationRouter.js");
          const notifSvc    = new NotificationService(sc);
          const notifRouter = new NotificationRouter(sc);
          const row = await notifSvc.create({
            userId:     submitterId,
            eventType:  "passport.stamp_earned",
            sourceType: "hidden_gems",
            sourceId:   req.params.id,
            params:     { location: (gemRow as any).city ?? (gemRow as any).country ?? "hidden gem" },
          });
          if (row) await notifRouter.route(row);
        }
      } catch {}
    })();
  }
});

router.post("/admin/hidden-gems/:id/sensitive", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  if (!await isAdmin(sc, user.id)) {
    sendError(res, "forbidden", "Admin access required"); return;
  }

  const sensitivityLevel = req.body?.sensitivityLevel;
  if (!VALID_SENSITIVITY.includes(sensitivityLevel)) {
    sendError(res, "invalid_payload", "Invalid sensitivityLevel");
    return;
  }

  try {
    await markSensitive(sc, req.params.id, sensitivityLevel);
    res.json({ ok: true });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

router.post("/admin/hidden-gems/:id/merge", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  if (!await isAdmin(sc, user.id)) {
    sendError(res, "forbidden", "Admin access required"); return;
  }

  const canonicalGemId = req.body?.canonicalGemId;
  if (!canonicalGemId) { sendError(res, "invalid_payload", "canonicalGemId is required"); return; }

  try {
    await mergeDuplicate(sc, req.params.id, canonicalGemId);
    res.json({ ok: true });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

// Resolve the reports against a gem. This is the exit from the reported-gems
// queue, which previously had none: reports accumulated and `hideGem` was
// imported but never called from any route, so nothing could ever act on them.
//
// The outcome is explicit rather than inferred from report_count, because this
// is also the only place a contribution costs its author trust. Upholding a
// report charges the author GEM_DISPUTED against guide_accuracy; dismissing one
// costs them nothing and restores the gem. Being reported is not a finding.
router.post("/admin/hidden-gems/:id/resolve-report", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  if (!await isAdmin(sc, user.id)) {
    sendError(res, "forbidden", "Admin access required"); return;
  }

  const outcome = req.body?.outcome;
  if (outcome !== "upheld" && outcome !== "dismissed") {
    sendError(res, "invalid_payload", "outcome must be 'upheld' or 'dismissed'"); return;
  }
  const note = typeof req.body?.note === "string" ? req.body.note : undefined;

  try {
    const result = await resolveGemReport(sc, req.params.id, user.id, outcome, note);
    if (!result.ok) { sendError(res, "not_found", "Gem not found"); return; }
    res.json(result);
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

router.post("/admin/local-guides/:userId/status", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  if (!await isAdmin(sc, user.id)) {
    sendError(res, "forbidden", "Admin access required"); return;
  }

  const status = req.body?.status;
  if (!["active", "suspended", "demoted"].includes(status)) {
    sendError(res, "invalid_payload", "status must be active | suspended | demoted");
    return;
  }

  try {
    await setGuideStatus(sc, req.params.userId, status);
    res.json({ ok: true });
  } catch (err: any) {
    sendError(res, "db_error", err.message);
  }
});

export default router;
