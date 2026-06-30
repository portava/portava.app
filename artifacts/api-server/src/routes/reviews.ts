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
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isUuid } from "../lib/followDecisions.js";
import { recordTrustEvent } from "../services/trust/TrustEventService.js";

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
 *  - entity_type=trip:   active trip member (trip_members)
 *  - entity_type=rent_buddy_booking: party to the completed booking
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
    case "trip": {
      const { data: membership } = await sc
        .from("trip_members")
        .select("id")
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

// ── POST /api/reviews ─────────────────────────────────────────────────────────

const CreateReviewSchema = z.object({
  entityType:  z.enum(["trip", "rent_buddy_booking"]),
  entityId:    z.string().uuid(),
  rating:      z.number().int().min(1).max(5),
  body:        z.string().max(2000).optional(),
  tags:        z.array(z.string().max(64)).max(10).optional().default([]),
  anonymous:   z.boolean().optional().default(false),
});

router.post("/reviews", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const parsed = CreateReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }

  const { entityType, entityId, rating, body, tags, anonymous } = parsed.data;
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
      visibility:   anonymous ? "anonymous" : "public",
      state:        "published",
      updated_at:   new Date().toISOString(),
    })
    .select("id, rating, body, tags, visibility, state, created_at")
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
    anonymous,
    createdAt:  (review as any).created_at,
  });
});

// ── GET /api/trips/:id/reviews ────────────────────────────────────────────────

router.get("/trips/:id/reviews", async (req, res) => {
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
    .select("id, rating, body, tags, visibility, created_at, reviewer_id, profiles!reviewer_id(handle, display_name, avatar_url)")
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

  res.json({
    reviews: rows.map((r: any) => ({
      id:         r.id,
      rating:     r.rating,
      body:       r.body ?? null,
      tags:       r.tags ?? [],
      anonymous:  r.visibility === "anonymous",
      createdAt:  r.created_at,
      reviewer:   r.visibility === "anonymous" ? null : {
        id:          r.reviewer_id,
        handle:      r.profiles?.handle ?? null,
        displayName: r.profiles?.display_name ?? null,
        avatarUrl:   r.profiles?.avatar_url ?? null,
      },
    })),
    avgRating,
    total: totalCount,
    page,
    limit,
  });
});

// ── GET /api/users/:id/reviews ────────────────────────────────────────────────
// Aggregate hosting rating + recent public reviews where this user is the host

router.get("/users/:id/reviews", async (req, res) => {
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

  // Build OR filter for all hosted entity IDs
  const orParts: string[] = [];
  if (tripIds.length > 0)  orParts.push(`and(entity_type.eq.trip,entity_id.in.(${tripIds.join(",")}))`);
  if (eventIds.length > 0) orParts.push(`and(entity_type.eq.event,entity_id.in.(${eventIds.join(",")}))`);

  // Aggregate over ALL reviews for this host (not page-limited)
  const { data: allForAggregate } = await sc
    .from("reviews")
    .select("rating")
    .or(orParts.join(","))
    .eq("state", "published");

  const allRows = (allForAggregate as any[]) ?? [];
  const reviewCount = allRows.length;
  const avgRating = reviewCount > 0
    ? Math.round((allRows.reduce((s: number, r: any) => s + r.rating, 0) / reviewCount) * 10) / 10
    : null;

  // Paginated list for display — includes entity_type, entity_id
  const { data: reviews, error } = await sc
    .from("reviews")
    .select("id, rating, body, tags, visibility, entity_type, entity_id, created_at, reviewer_id, profiles!reviewer_id(handle, display_name, avatar_url)")
    .or(orParts.join(","))
    .eq("state", "published")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) { req.log.error({ err: error }, "get user reviews"); sendError(res, "db_error", error.message); return; }

  const rows = (reviews as any[]) ?? [];

  res.json({
    avgRating,
    reviewCount,
    reviews: rows.map((r: any) => ({
      id:          r.id,
      rating:      r.rating,
      body:        r.body ?? null,
      tags:        r.tags ?? [],
      entityType:  r.entity_type,
      entityId:    r.entity_id,
      anonymous:   r.visibility === "anonymous",
      createdAt:   r.created_at,
      reviewer:    r.visibility === "anonymous" ? null : {
        id:          r.reviewer_id,
        handle:      r.profiles?.handle ?? null,
        displayName: r.profiles?.display_name ?? null,
        avatarUrl:   r.profiles?.avatar_url ?? null,
      },
    })),
  });
});

// ── DELETE /api/reviews/:id ───────────────────────────────────────────────────
// Admin removes or author retracts their own review

router.delete("/reviews/:id", async (req, res) => {
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
});

// ── POST /api/reviews/:id/report ──────────────────────────────────────────────
// Routes to the unified reports system with target_type=review

router.post("/reviews/:id/report", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid review id"); return; }

  const { reason, notes } = req.body ?? {};
  if (!reason) { sendError(res, "invalid_payload", "reason is required"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Verify review exists
  const { data: review } = await sc
    .from("reviews")
    .select("id, reviewer_id")
    .eq("id", id)
    .maybeSingle();

  if (!review) { sendError(res, "not_found", "Review not found"); return; }
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
});

export default router;
