/**
 * Admin endpoints for @Portava curated-content post authoring.
 *
 * POST /admin/portava/posts  — create a post authored by the @portava account,
 *                              with optional scheduled_at and category.
 * GET  /admin/portava/posts  — list all @portava posts with schedule status.
 *
 * Both routes are gated behind the existing admin-auth check (profiles.role = 'admin').
 * Posts are inserted with author_id = @portava's profile id, sourced from the
 * profiles table by handle = 'portava'.
 *
 * Scheduled posts use the existing delayed-publish pipeline:
 *   scheduled_at → publish_after_time + post_status = 'pending_delay'
 *   (no scheduled_at) → post_status = 'published'
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";

const router = Router();

// ── Admin guard (mirrors admin.ts) ────────────────────────────────────────────

async function requireAdmin(
  req: any,
  res: any,
): Promise<{ userId: string; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;

  const { data, error } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }

  const sc = getServiceClient() ?? client;
  return { userId: user.id, sc };
}

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

const PORTAVA_POST_INSERT_COLUMNS =
  "id, author_id, content, category, post_status, publish_after_time, published_at, visibility, media_urls, media_type, location_city, location_country, created_at";

const PORTAVA_POST_LIST_COLUMNS =
  "id, content, category, post_status, publish_after_time, published_at, visibility, media_urls, media_type, location_city, location_country, status, created_at, updated_at";

// ── POST /admin/portava/posts ─────────────────────────────────────────────────

const createPortavaPostSchema = z.object({
  content: z.string().min(1).max(3000),
  category: z.string().max(100).nullish(),
  mediaUrls: z.array(z.string().url()).max(10).optional(),
  mediaType: z.enum(["image", "video", "mixed"]).nullish(),
  locationName: z.string().max(200).nullish(),
  locationCity: z.string().max(100).nullish(),
  locationCountry: z.string().max(100).nullish(),
  locationLat: z.number().min(-90).max(90).nullish(),
  locationLng: z.number().min(-180).max(180).nullish(),
  /** ISO-8601 datetime string: if provided the post is scheduled via the delayed-publish pipeline. */
  scheduledAt: z.string().datetime().nullish(),
  visibility: z.enum(["public", "followers_only", "private"]).optional().default("public"),
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

  const portavaId = await resolvePortavaId(sc);
  if (!portavaId) {
    sendError(res, "not_found", "@portava account not found — run seed-portava-account.ts first");
    return;
  }

  // Determine delayed-publish status.
  let postStatus: string;
  let publishAfterTime: string | null = null;
  let publishedAt: string | null = null;

  if (p.scheduledAt) {
    const schedDate = new Date(p.scheduledAt);
    if (schedDate <= new Date()) {
      sendError(res, "invalid_payload", "scheduledAt must be in the future");
      return;
    }
    postStatus = "pending_delay";
    publishAfterTime = schedDate.toISOString();
  } else {
    postStatus = "published";
    publishedAt = new Date().toISOString();
  }

  const { data, error } = await sc
    .from("posts")
    .insert({
      author_id: portavaId,
      created_by: portavaId,
      updated_by: admin.userId,
      content: p.content,
      category: p.category ?? null,
      media_urls: p.mediaUrls ?? [],
      media_type: p.mediaType ?? null,
      visibility: p.visibility,
      status: "active",
      source: "admin_portava",
      post_status: postStatus,
      publish_after_time: publishAfterTime,
      published_at: publishedAt,
      // Location fields
      location_name: p.locationName ?? null,
      location_city: p.locationCity ?? null,
      location_country: p.locationCountry ?? null,
      location_lat: p.locationLat ?? null,
      location_lng: p.locationLng ?? null,
      public_location_label: p.locationCity ?? p.locationName ?? null,
      location_source: "manual",
      location_verified: !!(p.locationLat && p.locationLng),
      location_verified_at: (p.locationLat && p.locationLng) ? new Date().toISOString() : null,
      location_privacy_mode: "city_only",
      location_sensitivity_level: "standard",
      add_to_passport: false,
      geofence_radius_meters: 150,
      publish_after_exit: false,
      geotag_verified: !!(p.locationLat && p.locationLng),
      geotag_credit_awarded: false,
    })
    .select("id, author_id, content, category, post_status, publish_after_time, published_at, visibility, media_urls, media_type, location_city, location_country, created_at")
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to insert @portava post");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(201).json({
    post: {
      id: (data as any).id,
      authorId: (data as any).author_id,
      content: (data as any).content,
      category: (data as any).category,
      postStatus: (data as any).post_status,
      scheduledAt: (data as any).publish_after_time ?? null,
      publishedAt: (data as any).published_at ?? null,
      visibility: (data as any).visibility,
      mediaUrls: (data as any).media_urls ?? [],
      mediaType: (data as any).media_type ?? null,
      locationCity: (data as any).location_city ?? null,
      locationCountry: (data as any).location_country ?? null,
      createdAt: (data as any).created_at,
    },
  });
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

  // Optional filter by schedule status: "published" | "scheduled" | "all" (default)
  const statusFilter = (req.query.status as string | undefined) ?? "all";

  let query = sc
    .from("posts")
    .select("id, content, category, post_status, publish_after_time, published_at, visibility, media_urls, media_type, location_city, location_country, status, created_at, updated_at", { count: "exact" })
    .eq("author_id", portavaId)
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (statusFilter === "scheduled") {
    query = query.eq("post_status", "pending_delay");
  } else if (statusFilter === "published") {
    query = query.eq("post_status", "published");
  }

  const { data, error, count } = await query;
  if (error) {
    sendError(res, "db_error", error.message);
    return;
  }

  const posts = (data ?? []).map((row: any) => ({
    id: row.id,
    content: row.content,
    category: row.category ?? null,
    postStatus: row.post_status,
    scheduledAt: row.publish_after_time ?? null,
    publishedAt: row.published_at ?? null,
    visibility: row.visibility,
    mediaUrls: row.media_urls ?? [],
    mediaType: row.media_type ?? null,
    locationCity: row.location_city ?? null,
    locationCountry: row.location_country ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  res.json({ posts, total: count ?? 0, page, portavaId });
}));

export default router;
