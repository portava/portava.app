/**
 * Reviews router — cross-domain post-attendance reviews
 *
 * POST   /api/reviews                      — create review (eligibility enforced)
 * GET    /api/trips/:id/reviews            — list reviews for a trip
 * GET    /api/users/:id/reviews            — aggregate + recent reviews where user hosted
 * DELETE /api/reviews/:id                  — admin remove or author retract
 * POST   /api/reviews/:id/report           — report a review (routes to reports system)
 *
 * NOTE: Event reviews use a dedicated flow in events.ts (event_reviews table):
 *   POST /api/events/:id/reviews  — write
 *   GET  /api/events/:id/reviews  — read
 *   DELETE /api/events/:id/reviews — delete (own)
 * This router covers trips and rent_buddy_bookings only.
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { z } from "zod";
import { requireUser, optionalUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isUuid } from "../lib/followDecisions.js";
import { recordTrustEvent } from "../services/trust/TrustEventService.js";
import { nameVisibilitySet } from "../lib/publicIdentity.js";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireAdminGuard(
  req: any,
  res: any,
): Promise<{ userId: string; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;
  const { data } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }
  const sc = getServiceClient() ?? client;
  return { userId: user.id, sc };
}

/**
 * Checks whether the caller is eligible to review the given entity:
 *  - entity_type=trip:              active completed trip member (trip_members)
 *  - entity_type=rent_buddy_booking: party to a completed booking
 *  - entity_type=place:             any authenticated user (open rating)
 *
 * Note: event eligibility is handled by POST /api/events/:id/reviews in events.ts.
 */
async function checkEligibility(
  sc: any,
  userId: string,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  switch (entityType) {
    case "place": {
      // Any authenticated user may rate a seeded/community place.
      // Check discovery_places first; fall back to canonical places table
      // (used by /place/[id] screens) then hidden_gems (gem detail pages
      // pass entityType="place" to reuse the same reviews table).
      const { data: discoveryRow } = await sc
        .from("discovery_places")
        .select("id")
        .eq("id", entityId)
        .eq("status", "active")
        .maybeSingle();
      if (discoveryRow) return true;

      const { data: canonicalRow } = await sc
        .from("places")
        .select("id")
        .eq("id", entityId)
        .maybeSingle();
      if (canonicalRow) return true;

      const { data: gemRow } = await sc
        .from("hidden_gems")
        .select("id")
        .eq("id", entityId)
        .maybeSingle();
      return !!gemRow;
    }
    case "trip": {
      const { data: membership } = await sc
        .from("trip_members")
        .select("user_id")
        .eq("trip_id", entityId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!membership) return false;
      // Only allow reviews once the trip is marked completed
      const { data: tripRow } = await sc
        .from("trips")
        .select("status")
        .eq("id", entityId)
        .maybeSingle();
      return (tripRow as any)?.status === "completed";
    }
    case "rent_buddy_booking": {
      const { data } = await sc
        .from("rent_buddy_bookings")
        .select("id, status")
        .eq("id", entityId)
        .or(`traveler_id.eq.${userId},buddy_user_id.eq.${userId}`)
        .in("status", ["completed"])
        .maybeSingle();
      return !!data;
    }
    default:
      return false;
  }
}

// ── GET /api/reviews/my-review ────────────────────────────────────────────────
// Returns whether the current user has already reviewed a given entity,
// plus the full review payload so the composer can pre-fill for editing.
// Query params: entityType (trip|rent_buddy_booking), entityId (uuid)

router.get("/reviews/my-review", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const { entityType, entityId } = req.query as Record<string, string>;
  if (!entityType || !entityId || !isUuid(entityId)) {
    sendError(res, "invalid_payload", "entityType and entityId (uuid) are required");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("reviews")
    .select("id, rating, body, tags, visibility")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .eq("reviewer_id", auth.user.id)
    .not("state", "in", '("removed","hidden")')
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, "get my-review");
    sendError(res, "db_error", error.message);
    return;
  }

  if (!data) {
    res.json({ exists: false, reviewId: null });
    return;
  }

  res.json({
    exists:    true,
    reviewId:  (data as any).id,
    rating:    (data as any).rating,
    body:      (data as any).body ?? null,
    tags:      (data as any).tags ?? [],
    anonymous: (data as any).visibility === "anonymous",
  });
}));

// ── POST /api/reviews ─────────────────────────────────────────────────────────

const CreateReviewSchema = z.object({
  entityType:  z.enum(["trip", "rent_buddy_booking", "place"]),
  entityId:    z.string().uuid(),
  rating:      z.number().int().min(1).max(5),
  body:        z.string().max(2000).optional(),
  tags:        z.array(z.string().max(64)).max(10).optional().default([]),
  anonymous:   z.boolean().optional().default(false),
  photos:      z.array(z.string().url()).max(3).optional().default([]),
});

router.post("/reviews", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const parsed = CreateReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }

  const { entityType, entityId, rating, body, tags, anonymous, photos } = parsed.data;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const eligible = await checkEligibility(sc, auth.user.id, entityType, entityId);
  if (!eligible) {
    sendError(res, "review_not_eligible", "You must have confirmed attendance to leave a review");
    return;
  }

  const { data: review, error } = await sc
    .from("reviews")
    .insert({
      reviewer_id:  auth.user.id,
      entity_type:  entityType,
      entity_id:    entityId,
      rating,
      body:         body ?? null,
      tags:         tags ?? [],
      photos:       photos ?? [],
      visibility:   anonymous ? "anonymous" : "public",
      state:        "published",
      updated_at:   new Date().toISOString(),
    })
    .select("id, rating, body, tags, photos, visibility, state, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      sendError(res, "duplicate_review", "You have already reviewed this");
    } else {
      req.log.error({ err: error }, "create review");
      sendError(res, "db_error", error.message);
    }
    return;
  }

  // Controlled trust signal: small positive delta for verified-attendance review submission
  await recordTrustEvent(sc, {
    userId:     auth.user.id,
    eventType:  "review_submitted",
    category:   "community_value",
    delta:      2,
    severity:   "minor",
    sourceType: "review",
    sourceId:   (review as any).id,
  }).catch(() => {});

  res.status(201).json({
    id:         (review as any).id,
    rating:     (review as any).rating,
    body:       (review as any).body ?? null,
    tags:       (review as any).tags,
    photos:     (review as any).photos ?? [],
    anonymous,
    createdAt:  (review as any).created_at,
  });
}));

// ── GET /api/trips/:id/reviews ────────────────────────────────────────────────

router.get("/trips/:id/reviews", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const page  = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data: reviews, error } = await sc
    .from("reviews")
    .select("id, rating, body, tags, visibility, created_at, reviewer_id, profiles!reviewer_id(handle, display_name, avatar_url, verification_level)")
    .eq("entity_type", "trip")
    .eq("entity_id", id)
    .eq("state", "published")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "get trip reviews"); sendError(res, "db_error", error.message); return; }

  const rows = (reviews as any[]) ?? [];

  // Aggregate across all reviews for this trip (not just the current page)
  const { data: allForCount } = await sc
    .from("reviews")
    .select("rating")
    .eq("entity_type", "trip")
    .eq("entity_id", id)
    .eq("state", "published");

  const allRows = (allForCount as any[]) ?? [];
  const totalCount = allRows.length;
  const avgRating = totalCount > 0
    ? Math.round((allRows.reduce((s: number, r: any) => s + r.rating, 0) / totalCount) * 10) / 10
    : null;

  // Universal display-name rule: reviewer real names default to hidden (@handle)
  // unless the reviewer opted in. Anonymous reviews carry no reviewer at all.
  const reviewerIds = rows
    .filter((r: any) => r.visibility !== "anonymous")
    .map((r: any) => r.reviewer_id as string);
  const allowedNames = await nameVisibilitySet(sc, reviewerIds);

  res.json({
    reviews: rows.map((r: any) => ({
      id:         r.id,
      rating:     r.rating,
      body:       r.body ?? null,
      tags:       r.tags ?? [],
      anonymous:  r.visibility === "anonymous",
      createdAt:  r.created_at,
      reviewer:   r.visibility === "anonymous" ? null : {
        id:              r.reviewer_id,
        handle:          r.profiles?.handle ?? null,
        displayName:     (r.reviewer_id === auth.user.id || allowedNames.has(r.reviewer_id))
          ? (r.profiles?.display_name ?? null)
          : null,
        avatarUrl:       r.profiles?.avatar_url ?? null,
        verificationLevel: r.profiles?.verification_level ?? null,
      },
    })),
    avgRating,
    total: totalCount,
    page,
    limit,
  });
}));

// ── GET /api/places/:id/reviews ────────────────────────────────────────────────
// Public read — auth is optional; unauthenticated callers still see published reviews.

router.get("/places/:id/reviews", asyncHandler(async (req, res) => {
  // optionalUser: if a Bearer token is present it is verified; missing token is fine.
  const viewer = await optionalUser(req);
  const viewerId = viewer?.user.id ?? null;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid place id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const page  = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data: reviews, error } = await sc
    .from("reviews")
    .select("id, rating, body, tags, visibility, created_at, reviewer_id, profiles!reviewer_id(handle, display_name, avatar_url, verification_level)")
    .eq("entity_type", "place")
    .eq("entity_id", id)
    .eq("state", "published")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "get place reviews"); sendError(res, "db_error", error.message); return; }

  const rows = (reviews as any[]) ?? [];

  const { data: allForCount } = await sc
    .from("reviews")
    .select("rating")
    .eq("entity_type", "place")
    .eq("entity_id", id)
    .eq("state", "published");

  const allRows = (allForCount as any[]) ?? [];
  const totalCount = allRows.length;
  const avgRating = totalCount > 0
    ? Math.round((allRows.reduce((s: number, r: any) => s + r.rating, 0) / totalCount) * 10) / 10
    : null;

  // Universal display-name rule: reviewer real names default to hidden (@handle)
  // unless the reviewer opted in. Viewer may be unauthenticated (viewerId null).
  const reviewerIds = rows
    .filter((r: any) => r.visibility !== "anonymous")
    .map((r: any) => r.reviewer_id as string);
  const allowedNames = await nameVisibilitySet(sc, reviewerIds);

  res.json({
    reviews: rows.map((r: any) => ({
      id:         r.id,
      rating:     r.rating,
      body:       r.body ?? null,
      tags:       r.tags ?? [],
      anonymous:  r.visibility === "anonymous",
      createdAt:  r.created_at,
      reviewer:   r.visibility === "anonymous" ? null : {
        id:              r.reviewer_id,
        handle:          r.profiles?.handle ?? null,
        displayName:     ((viewerId && r.reviewer_id === viewerId) || allowedNames.has(r.reviewer_id))
          ? (r.profiles?.display_name ?? null)
          : null,
        avatarUrl:       r.profiles?.avatar_url ?? null,
        verificationLevel: r.profiles?.verification_level ?? null,
      },
    })),
    avgRating,
    total: totalCount,
    page,
    limit,
  });
}));

// ── GET /api/users/:id/reviews ────────────────────────────────────────────────
// Aggregate hosting rating + recent public reviews where this user is the host

router.get("/users/:id/reviews", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "10")));

  // Trips hosted by this user
  const { data: hostedTrips } = await sc
    .from("trips")
    .select("id")
    .eq("owner_id", id);

  const tripIds = ((hostedTrips as any[]) ?? []).map((t: any) => t.id as string);

  // Events hosted by this user
  const { data: hostedEvents } = await sc
    .from("events")
    .select("id")
    .eq("host_id", id);

  const eventIds = ((hostedEvents as any[]) ?? []).map((e: any) => e.id as string);

  if (tripIds.length === 0 && eventIds.length === 0) {
    res.json({ avgRating: null, reviewCount: 0, reviews: [] });
    return;
  }

  // ── Trip reviews (from unified `reviews` table) ───────────────────────────
  const tripOrParts: string[] = [];
  if (tripIds.length > 0) tripOrParts.push(`and(entity_type.eq.trip,entity_id.in.(${tripIds.join(",")}))`);

  const [tripReviewsRes, eventReviewsRes] = await Promise.all([
    // All trip reviews for aggregate
    tripIds.length > 0
      ? sc.from("reviews").select("id, rating, body, tags, visibility, entity_type, entity_id, created_at, reviewer_id, profiles!reviewer_id(handle, display_name, avatar_url, verification_level)")
          .or(tripOrParts.join(","))
          .eq("state", "published")
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),

    // All event reviews from legacy event_reviews table
    eventIds.length > 0
      ? sc.from("event_reviews").select("id, rating, body, anonymous, event_id, reviewer_id, created_at, profiles!reviewer_id(handle, display_name, avatar_url, verification_level)")
          .in("event_id", eventIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (tripReviewsRes.error) {
    req.log.error({ err: tripReviewsRes.error }, "get user trip reviews");
    sendError(res, "db_error", tripReviewsRes.error.message); return;
  }

  const tripRows = (tripReviewsRes.data as any[]) ?? [];
  const eventRows = (eventReviewsRes.data as any[]) ?? [];

  // Combined aggregate across all hosted reviews (trips + events)
  const allRatings = [
    ...tripRows.map((r: any) => r.rating),
    ...eventRows.map((r: any) => r.rating),
  ];
  const reviewCount = allRatings.length;
  const avgRating = reviewCount > 0
    ? Math.round((allRatings.reduce((s, v) => s + v, 0) / reviewCount) * 10) / 10
    : null;

  // Universal display-name rule: reviewer real names default to hidden (@handle)
  // unless the reviewer opted in. Anonymous reviews carry no reviewer at all.
  const reviewerIds = [
    ...tripRows.filter((r: any) => r.visibility !== "anonymous").map((r: any) => r.reviewer_id as string),
    ...eventRows.filter((r: any) => !(r.anonymous ?? false)).map((r: any) => r.reviewer_id as string),
  ];
  const allowedNames = await nameVisibilitySet(sc, reviewerIds);
  const displayNameFor = (r: any) =>
    (r.reviewer_id === auth.user.id || allowedNames.has(r.reviewer_id))
      ? (r.profiles?.display_name ?? null)
      : null;

  // Merge + sort by date, return most recent `limit` items
  const merged = [
    ...tripRows.map((r: any) => ({
      id:         r.id,
      rating:     r.rating,
      body:       r.body ?? null,
      tags:       r.tags ?? [],
      entityType: r.entity_type as string,
      entityId:   r.entity_id as string,
      anonymous:  r.visibility === "anonymous",
      createdAt:  r.created_at as string,
      reviewer:   r.visibility === "anonymous" ? null : {
        id:              r.reviewer_id,
        handle:          r.profiles?.handle ?? null,
        displayName:     displayNameFor(r),
        avatarUrl:       r.profiles?.avatar_url ?? null,
        verificationLevel: r.profiles?.verification_level ?? null,
      },
    })),
    ...eventRows.map((r: any) => ({
      id:         r.id,
      rating:     r.rating,
      body:       r.body ?? null,
      tags:       [] as string[],
      entityType: "event",
      entityId:   r.event_id as string,
      anonymous:  r.anonymous ?? false,
      createdAt:  r.created_at as string,
      reviewer:   r.anonymous ? null : {
        id:              r.reviewer_id,
        handle:          r.profiles?.handle ?? null,
        displayName:     displayNameFor(r),
        avatarUrl:       r.profiles?.avatar_url ?? null,
        verificationLevel: r.profiles?.verification_level ?? null,
      },
    })),
  ]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);

  res.json({
    avgRating,
    reviewCount,
    reviews: merged,
  });
}));

// ── PATCH /api/reviews/:id ────────────────────────────────────────────────────
// Author updates their own review (rating, body, tags, anonymous)

const UpdateReviewSchema = z.object({
  rating:    z.number().int().min(1).max(5).optional(),
  body:      z.string().max(2000).optional().nullable(),
  tags:      z.array(z.string().max(64)).max(10).optional(),
  anonymous: z.boolean().optional(),
  photos:    z.array(z.string().url()).max(3).optional(),
});

router.patch("/reviews/:id", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid review id"); return; }

  const parsed = UpdateReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Verify the review exists and belongs to the caller
  const { data: existing, error: fetchError } = await sc
    .from("reviews")
    .select("id, reviewer_id, state")
    .eq("id", id)
    .maybeSingle();

  if (fetchError || !existing) { sendError(res, "not_found", "Review not found"); return; }
  if ((existing as any).reviewer_id !== auth.user.id) {
    res.status(403).json({ error: "forbidden", message: "Not your review" });
    return;
  }
  if ((existing as any).state === "removed" || (existing as any).state === "hidden") {
    sendError(res, "not_found", "Review not found");
    return;
  }

  const { rating, body, tags, anonymous, photos } = parsed.data;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (rating    !== undefined) patch.rating     = rating;
  if (body      !== undefined) patch.body        = body ?? null;
  if (tags      !== undefined) patch.tags        = tags;
  if (anonymous !== undefined) patch.visibility  = anonymous ? "anonymous" : "public";
  if (photos    !== undefined) patch.photos      = photos;

  const { data: updated, error } = await sc
    .from("reviews")
    .update(patch)
    .eq("id", id)
    .select("id, rating, body, tags, photos, visibility, updated_at")
    .single();

  if (error) { req.log.error({ err: error }, "patch review"); sendError(res, "db_error", error.message); return; }

  res.json({
    id:        (updated as any).id,
    rating:    (updated as any).rating,
    body:      (updated as any).body ?? null,
    tags:      (updated as any).tags ?? [],
    photos:    (updated as any).photos ?? [],
    anonymous: (updated as any).visibility === "anonymous",
    updatedAt: (updated as any).updated_at,
  });
}));

// ── DELETE /api/reviews/:id ───────────────────────────────────────────────────
// Admin removes or author retracts their own review

router.delete("/reviews/:id", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid review id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Fetch review to check ownership
  const { data: review, error: fetchError } = await sc
    .from("reviews")
    .select("id, reviewer_id, state")
    .eq("id", id)
    .maybeSingle();

  if (fetchError || !review) { sendError(res, "not_found", "Review not found"); return; }

  // Check admin role
  const { data: profile } = await auth.client
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .maybeSingle();

  const isAdmin = (profile as any)?.role === "admin";
  const isAuthor = (review as any).reviewer_id === auth.user.id;

  if (!isAdmin && !isAuthor) {
    res.status(403).json({ error: "forbidden", message: "Not your review" });
    return;
  }

  const newState = isAdmin ? "removed" : "hidden";

  const { error } = await sc
    .from("reviews")
    .update({ state: newState, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) { req.log.error({ err: error }, "delete review"); sendError(res, "db_error", error.message); return; }

  res.json({ ok: true, state: newState });
}));

// ── GET /api/places/:id/votes ─────────────────────────────────────────────────
// Returns Worth-It / Skip-It tally for a place or gem.
// Auth is optional — unauthed callers see counts but no myVote.
// Query param: entityType = 'place' (default) | 'gem'

router.get("/places/:id/votes", asyncHandler(async (req, res) => {
  const viewer = await optionalUser(req);
  const viewerId = viewer?.user.id ?? null;

  const { id } = req.params;
  if (!id || id.length > 200) {
    sendError(res, "invalid_payload", "Invalid entity id");
    return;
  }

  const entityType = req.query.entityType === "gem" ? "gem" : "place";

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rows, error } = await sc
    .from("place_votes")
    .select("vote, user_id")
    .eq("entity_type", entityType)
    .eq("entity_id", id);

  if (error) {
    // Table may not exist yet in some envs — degrade gracefully
    if ((error as any).code === "42P01") {
      res.json({ worthItCount: 0, skipItCount: 0, myVote: null });
      return;
    }
    req.log.error({ err: error }, "get place votes");
    sendError(res, "db_error", error.message);
    return;
  }

  const voteRows = (rows as any[]) ?? [];
  const worthItCount = voteRows.filter((r: any) => r.vote === "worth_it").length;
  const skipItCount  = voteRows.filter((r: any) => r.vote === "skip_it").length;
  const myVote = viewerId
    ? (voteRows.find((r: any) => r.user_id === viewerId)?.vote ?? null)
    : null;

  res.json({ worthItCount, skipItCount, myVote: myVote as string | null });
}));

// ── POST /api/places/:id/votes ────────────────────────────────────────────────
// Cast or retract a Worth-It / Skip-It vote.
// Body: { vote: 'worth_it' | 'skip_it' | null, entityType?: 'place' | 'gem' }
// Passing vote=null retracts the current vote.
// Returns updated tallies.

router.post("/places/:id/votes", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const { id } = req.params;
  if (!id || id.length > 200) {
    sendError(res, "invalid_payload", "Invalid entity id");
    return;
  }

  const voteRaw = req.body?.vote as string | null | undefined;
  const entityTypeRaw = req.body?.entityType;
  const entityType = entityTypeRaw === "gem" ? "gem" : "place";

  if (voteRaw !== null && voteRaw !== undefined && !["worth_it", "skip_it"].includes(voteRaw)) {
    sendError(res, "invalid_payload", "vote must be 'worth_it', 'skip_it', or null");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Validate entity exists before writing — prevents orphaned votes for arbitrary IDs.
  // Retract (vote=null) is allowed without the existence check since
  // deleting a non-existent row is a no-op.
  if (voteRaw !== null && voteRaw !== undefined) {
    if (entityType === "gem") {
      const { data: gemRow } = await sc
        .from("hidden_gems")
        .select("id")
        .eq("id", id)
        .maybeSingle();
      if (!gemRow) {
        sendError(res, "not_found", "Gem not found");
        return;
      }
    } else {
      // Accept IDs from discovery_places (active) OR canonical places table.
      const { data: discoveryRow } = await sc
        .from("discovery_places")
        .select("id")
        .eq("id", id)
        .eq("status", "active")
        .maybeSingle();
      if (!discoveryRow) {
        const { data: canonicalRow } = await sc
          .from("places")
          .select("id")
          .eq("id", id)
          .maybeSingle();
        if (!canonicalRow) {
          sendError(res, "not_found", "Place not found");
          return;
        }
      }
    }
  }

  if (voteRaw === null || voteRaw === undefined) {
    // Retract vote
    const { error } = await sc
      .from("place_votes")
      .delete()
      .eq("user_id", auth.user.id)
      .eq("entity_type", entityType)
      .eq("entity_id", id);
    if (error && (error as any).code !== "42P01") {
      req.log.error({ err: error }, "retract place vote");
      sendError(res, "db_error", error.message);
      return;
    }
  } else {
    // Upsert vote
    const { error } = await sc
      .from("place_votes")
      .upsert(
        {
          user_id:     auth.user.id,
          entity_type: entityType,
          entity_id:   id,
          vote:        voteRaw,
          created_at:  new Date().toISOString(),
        },
        { onConflict: "user_id,entity_type,entity_id" },
      );
    if (error && (error as any).code !== "42P01") {
      req.log.error({ err: error }, "upsert place vote");
      sendError(res, "db_error", error.message);
      return;
    }
  }

  // Re-fetch tallies
  const { data: rows } = await sc
    .from("place_votes")
    .select("vote, user_id")
    .eq("entity_type", entityType)
    .eq("entity_id", id);

  const voteRows = (rows as any[]) ?? [];
  const worthItCount = voteRows.filter((r: any) => r.vote === "worth_it").length;
  const skipItCount  = voteRows.filter((r: any) => r.vote === "skip_it").length;
  const myVote = voteRows.find((r: any) => r.user_id === auth.user.id)?.vote ?? null;

  res.json({ worthItCount, skipItCount, myVote: myVote as string | null });
}));

// ── POST /api/reviews/:id/report ──────────────────────────────────────────────
// Routes to the unified reports system with target_type=review

router.post("/reviews/:id/report", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid review id"); return; }

  const { reason, notes } = req.body ?? {};
  if (!reason) { sendError(res, "invalid_payload", "reason is required"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Verify review exists and has not been actioned (removed or hidden)
  const { data: review } = await sc
    .from("reviews")
    .select("id, reviewer_id, state")
    .eq("id", id)
    .maybeSingle();

  if (!review) { sendError(res, "not_found", "Review not found"); return; }
  if ((review as any).state === "removed" || (review as any).state === "hidden") {
    sendError(res, "not_found", "Review not found");
    return;
  }
  if ((review as any).reviewer_id === auth.user.id) {
    sendError(res, "invalid_payload", "Cannot report your own review");
    return;
  }

  const { error } = await sc
    .from("reports")
    .insert({
      reporter_id:  auth.user.id,
      target_type:  "review",
      target_id:    id,
      reason_code:  reason,
      notes:        notes ?? null,
      severity:     "low",
      status:       "pending",
    });

  if (error) {
    if (error.code === "23505") {
      sendError(res, "duplicate_report", "You have already reported this review");
    } else {
      req.log.error({ err: error }, "report review");
      sendError(res, "db_error", error.message);
    }
    return;
  }

  res.status(201).json({ ok: true });
}));

export default router;
