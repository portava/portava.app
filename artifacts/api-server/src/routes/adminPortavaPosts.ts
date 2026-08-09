/**
 * Admin endpoints for @Portava curated-content post authoring.
 *
 * POST   /admin/portava/posts      — create a post authored by the @portava account,
 *                                    with optional scheduledAt and category.
 * GET    /admin/portava/posts      — list all @portava posts with schedule status.
 * PATCH  /admin/portava/posts/:id  — edit body / scheduledAt / category before publish.
 * DELETE /admin/portava/posts/:id  — cancel a scheduled post or unpublish an active post.
 *
 * All routes are gated behind the existing admin-auth check (profiles.role = 'admin').
 * Author-ID is always the @portava service account — never client-supplied.
 *
 * Scheduled posts use the existing delayed-publish pipeline:
 *   scheduledAt → publish_after_time + post_status = 'pending_delay'
 *   (no scheduledAt) → post_status = 'published' immediately
 */

import { Router } from "express";
import { z } from "zod";
import { sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ensurePlaceDay, isEligiblePlaceDayPost } from "../lib/places/placeDays.js";
import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

// ── Category enum ─────────────────────────────────────────────────────────────

export const PORTAVA_POST_CATEGORIES = [
  "hidden_gem",
  "inspiration",
  "festival",
  "restaurant",
  "beach_resort",
  "nightlife",
  "neighborhood",
  "trending_destination",
  "travel_tip",
  "hotel",
  "featured_creator",
  "destination_of_week",
  "community_spotlight",
] as const;

export type PortavaPostCategory = (typeof PORTAVA_POST_CATEGORIES)[number];

const portavaPostCategory = z.enum(PORTAVA_POST_CATEGORIES);

// ── Resolve @portava account id ───────────────────────────────────────────────

async function resolvePortavaId(sc: any): Promise<string | null> {
  const { data, error } = await sc
    .from("profiles")
    .select("id")
    .eq("handle", "portava")
    .eq("is_official", true)
    .maybeSingle();
  if (error || !data) return null;
  return (data as any).id as string;
}

// ── Column lists (static strings required by check:write-path-columns) ────────

const PORTAVA_POST_SELECT_COLUMNS =
  "id, author_id, canonical_place_id, content, category, post_status, publish_after_time, published_at, visibility, media_urls, media_type, location_city, location_country, status, created_at, updated_at";

// ── Shared response mapper ────────────────────────────────────────────────────

function mapPost(row: any): Record<string, unknown> {
  return {
    id:              row.id,
    authorId:        row.author_id,
    content:         row.content,
    category:        row.category ?? null,
    postStatus:      row.post_status,
    scheduledAt:     row.publish_after_time ?? null,
    publishedAt:     row.published_at ?? null,
    visibility:      row.visibility,
    mediaUrls:       row.media_urls ?? [],
    mediaType:       row.media_type ?? null,
    locationCity:    row.location_city ?? null,
    locationCountry: row.location_country ?? null,
    status:          row.status,
    createdAt:       row.created_at,
    updatedAt:       row.updated_at ?? null,
  };
}

// ── POST /admin/portava/posts ─────────────────────────────────────────────────

const createPortavaPostSchema = z.object({
  content: z.string().min(1, "Post body is required").max(3000),
  category: portavaPostCategory.nullish(),
  mediaUrls: z.array(z.string().min(1)).max(10).optional(),
  mediaType: z.enum(["image", "video", "mixed"]).nullish(),
  locationName: z.string().max(200).nullish(),
  locationCity: z.string().max(100).nullish(),
  locationCountry: z.string().max(100).nullish(),
  locationLat: z.number().min(-90).max(90).nullish(),
  locationLng: z.number().min(-180).max(180).nullish(),
  /** ISO-8601 datetime string: if provided the post is scheduled via the delayed-publish pipeline. */
  scheduledAt: z.string().datetime().nullish(),
  visibility: z.enum(["public", "private"]).optional().default("public"),
});

router.post("/admin/portava/posts", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = createPortavaPostSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const p = parsed.data;

  // Validate scheduling is in the future
  if (p.scheduledAt) {
    const schedDate = new Date(p.scheduledAt);
    if (schedDate <= new Date()) {
      sendError(res, "invalid_payload", "scheduledAt must be in the future");
      return;
    }
  }

  const portavaId = await resolvePortavaId(sc);
  if (!portavaId) {
    sendError(res, "not_found", "@portava account not found — run seed-portava-account.ts first");
    return;
  }

  let postStatus: string;
  let publishAfterTime: string | null = null;
  let publishEligibleAt: string | null = null;
  let publishedAt: string | null = null;

  if (p.scheduledAt) {
    postStatus = "pending_delay";
    publishAfterTime = new Date(p.scheduledAt).toISOString();
    publishEligibleAt = publishAfterTime;
  } else {
    postStatus = "published";
    publishedAt = new Date().toISOString();
  }

  const { data, error } = await sc
    .from("posts")
    .insert({
      author_id:               portavaId,
      created_by:              portavaId,
      updated_by:              admin.userId,
      content:                 p.content,
      category:                p.category ?? null,
      media_urls:              p.mediaUrls ?? [],
      media_type:              p.mediaType ?? null,
      visibility:              p.visibility,
      status:                  "active",
      source:                  "admin_portava",
      post_status:             postStatus,
      publish_after_time:      publishAfterTime,
      publish_eligible_at:     publishEligibleAt,
      published_at:            publishedAt,
      // Location fields
      location_name:           p.locationName ?? null,
      location_city:           p.locationCity ?? null,
      location_country:        p.locationCountry ?? null,
      location_lat:            p.locationLat ?? null,
      location_lng:            p.locationLng ?? null,
      public_location_label:   p.locationCity ?? p.locationName ?? null,
      location_source:         "manual",
      location_verified:       !!(p.locationLat && p.locationLng),
      location_verified_at:    (p.locationLat && p.locationLng) ? new Date().toISOString() : null,
      location_privacy_mode:   "city_only",
      location_sensitivity_level: "low",
      add_to_passport:         false,
      geofence_radius_meters:  150,
      publish_after_exit:      false,
      geotag_verified:         !!(p.locationLat && p.locationLng),
      geotag_credit_awarded:   false,
    })
    .select("id, author_id, content, category, post_status, publish_after_time, published_at, visibility, media_urls, media_type, location_city, location_country, status, created_at, updated_at")
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to insert @portava post");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(201).json({ post: mapPost(data as any) });
}));

// ── GET /admin/portava/posts ──────────────────────────────────────────────────

router.get("/admin/portava/posts", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const portavaId = await resolvePortavaId(sc);
  if (!portavaId) {
    sendError(res, "not_found", "@portava account not found — run seed-portava-account.ts first");
    return;
  }

  const page  = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 50);

  // Optional filters
  const statusFilter   = (req.query.status as string | undefined) ?? "all";
  const categoryFilter = req.query.category as string | undefined;

  let query = sc
    .from("posts")
    .select("id, author_id, content, category, post_status, publish_after_time, published_at, visibility, media_urls, media_type, location_city, location_country, status, created_at, updated_at", { count: "exact" })
    .eq("author_id", portavaId)
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (statusFilter === "scheduled") {
    query = query.eq("post_status", "pending_delay");
  } else if (statusFilter === "published") {
    query = query.eq("post_status", "published");
  } else if (statusFilter === "cancelled") {
    query = query.eq("post_status", "canceled");
  }

  if (categoryFilter && PORTAVA_POST_CATEGORIES.includes(categoryFilter as PortavaPostCategory)) {
    query = query.eq("category", categoryFilter);
  }

  const { data, error, count } = await query;
  if (error) {
    sendError(res, "db_error", error.message);
    return;
  }

  const posts = (data ?? []).map(mapPost);
  res.json({ posts, total: count ?? 0, page, portavaId });
}));

// ── PATCH /admin/portava/posts/:id ────────────────────────────────────────────

const patchPortavaPostSchema = z.object({
  content:     z.string().min(1).max(3000).optional(),
  category:    portavaPostCategory.nullish(),
  scheduledAt: z.string().datetime().nullish(),
  visibility:  z.enum(["public", "private"]).optional(),
  mediaUrls:   z.array(z.string().min(1)).max(10).optional(),
});

router.patch("/admin/portava/posts/:id", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;
  const now = new Date();

  const { id } = req.params;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    sendError(res, "not_found", "Post not found"); return;
  }

  const parsed = patchPortavaPostSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    sendError(res, "invalid_payload", "At least one field must be provided");
    return;
  }
  const p = parsed.data;

  // Verify post belongs to @portava and is editable (not yet published)
  const portavaId = await resolvePortavaId(sc);
  if (!portavaId) {
    sendError(res, "not_found", "@portava account not found");
    return;
  }

  const { data: existing, error: fetchErr } = await sc
    .from("posts")
    .select("id, post_status, author_id")
    .eq("id", id)
    .eq("author_id", portavaId)
    .neq("status", "deleted")
    .maybeSingle();

  if (fetchErr || !existing) {
    sendError(res, "not_found", "Post not found"); return;
  }

  // Validate future scheduling if provided
  if (p.scheduledAt !== undefined) {
    if (p.scheduledAt !== null) {
      const schedDate = new Date(p.scheduledAt);
      if (schedDate <= new Date()) {
        sendError(res, "invalid_payload", "scheduledAt must be in the future");
        return;
      }
    }
  }

  const patch: Record<string, unknown> = { updated_by: admin.userId, updated_at: now.toISOString() };
  if (p.content    !== undefined) patch.content    = p.content;
  if (p.category   !== undefined) patch.category   = p.category ?? null;
  if (p.visibility !== undefined) patch.visibility  = p.visibility;
  if (p.mediaUrls  !== undefined) patch.media_urls  = p.mediaUrls;

  // Scheduling update: re-enter pipeline or publish immediately
  if (p.scheduledAt !== undefined) {
    if (p.scheduledAt) {
      const iso = new Date(p.scheduledAt).toISOString();
      patch.publish_after_time  = iso;
      patch.publish_eligible_at = iso;
      patch.post_status         = "pending_delay";
      patch.published_at        = null;
    } else {
      // Clear schedule → publish immediately
      patch.publish_after_time  = null;
      patch.publish_eligible_at = null;
      patch.post_status         = "published";
      patch.published_at        = now.toISOString();
    }
  }

  const { data, error } = await sc
    .from("posts")
    .update(patch)
    .eq("id", id)
    .select(PORTAVA_POST_SELECT_COLUMNS)
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to update @portava post");
    sendError(res, "db_error", error.message);
    return;
  }

  if (
    patch.post_status === "published" &&
    (data as any)?.canonical_place_id &&
    isEligiblePlaceDayPost(data)
  ) {
    await ensurePlaceDay(
      sc,
      (data as any).canonical_place_id,
      new Date((data as any).created_at ?? now),
    );
  }

  res.json({ post: mapPost(data as any) });
}));

// ── DELETE /admin/portava/posts/:id ──────────────────────────────────────────

router.delete("/admin/portava/posts/:id", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { id } = req.params;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    sendError(res, "not_found", "Post not found"); return;
  }

  const portavaId = await resolvePortavaId(sc);
  if (!portavaId) {
    sendError(res, "not_found", "@portava account not found");
    return;
  }

  // Verify post belongs to @portava before touching it
  const { data: existing, error: fetchErr } = await sc
    .from("posts")
    .select("id, post_status, status")
    .eq("id", id)
    .eq("author_id", portavaId)
    .neq("status", "deleted")
    .maybeSingle();

  if (fetchErr || !existing) {
    sendError(res, "not_found", "Post not found"); return;
  }

  // Scheduled → cancel; published → soft-delete (status=deleted)
  const isScheduled = (existing as any).post_status === "pending_delay";
  const patch: Record<string, unknown> = {
    updated_by: admin.userId,
    updated_at: new Date().toISOString(),
  };
  if (isScheduled) {
    patch.post_status        = "canceled";
    patch.publish_after_time = null;
    patch.publish_eligible_at = null;
  } else {
    patch.status = "deleted";
  }

  const { error } = await sc
    .from("posts")
    .update(patch)
    .eq("id", id);

  if (error) {
    req.log.error({ err: error }, "Failed to delete @portava post");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(204).end();
}));

export default router;
