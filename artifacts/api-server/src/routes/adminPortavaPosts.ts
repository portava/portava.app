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
import { randomUUID } from "node:crypto";
import { planPostMediaUploads } from "../lib/media/storageBackedPostMedia.js";
import { z } from "zod";
import { sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ensurePlaceDay, isEligiblePlaceDayPost } from "../lib/places/placeDays.js";
import { requireAdmin } from "../lib/requireAdmin.js"; import { postMediaModerationHold, postMediaHoldRefusal } from "../lib/media/postMediaModerationHold.js"; import { appMediaRef } from "../lib/postSchemas.js"; // census-media MD269 (a), lead ruling D-82; verifier N3 (admin media refs validated like every post's)

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
  "id, author_id, canonical_place_id, content, category, post_status, publish_after_time, published_at, visibility, media_urls, media_type, media_count, location_city, location_country, status, created_at, updated_at";

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
    mediaCount:      row.media_count ?? (row.media_urls ?? []).length,
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
  operationId: z.string().uuid().optional(),
  content: z.string().min(1, "Post body is required").max(3000),
  category: portavaPostCategory.nullish(),
  mediaUrls: z.array(appMediaRef).max(10).optional(),
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
  const p = parsed.data; { const refusal = postMediaHoldRefusal(await postMediaModerationHold(sc, p.mediaUrls ?? [])); if (refusal) { sendError(res, refusal.code, refusal.message); return; } } // census-media MD269 (a), lead ruling D-82: refused, and nothing written, while the moderation stage holds any of its media

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

  const plan = planPostMediaUploads(p.mediaUrls ?? [], admin.userId, p.mediaType ?? null);
  if (!plan.ok) { sendError(res, plan.code, plan.message); return; }
  const { data: receipt, error } = await sc.rpc("create_official_post_with_media", {
    p_actor_id: admin.userId,
    p_operation_id: p.operationId ?? randomUUID(),
    p_fields: {
      content: p.content, category: p.category ?? null, visibility: p.visibility,
      scheduledAt: p.scheduledAt ?? null, locationName: p.locationName ?? null,
      locationCity: p.locationCity ?? null, locationCountry: p.locationCountry ?? null,
      locationLat: p.locationLat ?? null, locationLng: p.locationLng ?? null,
    },
    p_upload_paths: plan.uploads.map(upload => upload.path),
    p_external_refs: plan.external,
  });
  if (error) {
    req.log.error({ err: error }, "Official post command failed");
    const message = String(error.message ?? "");
    if (/official_post_forbidden|official_media_not_owned/.test(message)) sendError(res, "forbidden", "You may only attach your own uploads as an administrator.");
    else if (/official_post_intent_conflict/.test(message)) sendError(res, "conflict", "This submission has changed. Start a new post.");
    else if (/official_post_invalid/.test(message)) sendError(res, "invalid_payload", "Check the post content, schedule and media references.");
    else if (/official_media_unavailable|official_post_unavailable|no rows/.test(message)) sendError(res, "conflict", "An upload or post is no longer available. Choose a ready upload and try again.");
    else sendError(res, "degraded_unavailable", "The post could not be saved. Please try again.");
    return;
  }
  if (!receipt?.post?.id) { sendError(res, "degraded_unavailable", "The post result could not be verified. Retry the same submission."); return; }
  const data = receipt.post;
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
    .select("id, author_id, content, category, post_status, publish_after_time, published_at, visibility, media_urls, media_type, media_count, location_city, location_country, status, created_at, updated_at", { count: "exact" })
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
  mediaUrls:   z.array(appMediaRef).max(10).optional(),
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
  if (p.mediaUrls  !== undefined) { const refusal = postMediaHoldRefusal(await postMediaModerationHold(sc, p.mediaUrls)); if (refusal) { sendError(res, refusal.code, refusal.message); return; } const plan = planPostMediaUploads(p.mediaUrls, admin.userId); if (!plan.ok) { sendError(res, plan.code, plan.message); return; } if (plan.uploads.length) { sendError(res, "invalid_payload", "Photos and videos are attached when the post is created."); return; } patch.media_urls = plan.external; } // census-media MD269 (a), lead ruling D-82: an edit cannot put held media into a post

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
