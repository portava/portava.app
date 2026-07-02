/**
 * Admin Stamp Routes
 *
 * Mounted at /api (full paths: /api/admin/stamps/...)
 * All routes require admin role.
 *
 * GET  /admin/stamps/definitions           — list all definitions (incl. inactive)
 * POST /admin/stamps/definitions           — create a new definition
 * PATCH /admin/stamps/definitions/:id      — update a definition
 * POST /admin/stamps/award                 — admin-award a stamp to any user
 * POST /admin/stamps/:userStampId/revoke   — revoke a stamp (requires reason)
 * POST /admin/stamps/:userStampId/restore  — restore a revoked stamp (requires reason)
 * GET  /admin/stamps/audit                 — query stamp_award_events with filters
 * GET  /admin/stamps/campaigns             — list campaigns
 * POST /admin/stamps/campaigns             — create campaign
 * PATCH /admin/stamps/campaigns/:campaignId — update campaign
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { awardStamp, revokeStamp, restoreStamp } from "../services/passport/StampAwardEngine.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { NotificationRouter as NotifRouter } from "../services/notifications/NotificationRouter.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

// ── Admin guard ───────────────────────────────────────────────────────────────

async function requireAdmin(
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

// ── GET /admin/stamps/definitions ────────────────────────────────────────────

router.get("/admin/stamps/definitions", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page  = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const category = req.query.category as string | undefined;
  const isActive = req.query.is_active as string | undefined;

  let query = sc
    .from("stamp_definitions")
    .select("*", { count: "exact" })
    .order("category")
    .order("slug")
    .range((page - 1) * limit, page * limit - 1);

  if (category)  query = (query as any).eq("category", category);
  if (isActive !== undefined) query = (query as any).eq("is_active", isActive === "true");

  const { data, error, count } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ definitions: data ?? [], total: count ?? 0, page });
});

// ── POST /admin/stamps/definitions ───────────────────────────────────────────

const createDefinitionSchema = z.object({
  slug:               z.string().min(1).max(100),
  name:               z.string().min(1).max(200),
  description:        z.string().max(1000).optional(),
  stampType:          z.string().min(1),
  category:           z.string().min(1),
  iconUrl:            z.string().url().optional(),
  rarity:             z.enum(["common", "uncommon", "rare", "legendary"]).default("common"),
  isActive:           z.boolean().default(false),
  isRepeatable:       z.boolean().default(false),
  maxAwardsPerUser:   z.number().int().positive().optional(),
  criteriaType:       z.enum(["manual", "automatic", "admin_only"]).default("manual"),
  criteria:           z.record(z.unknown()).optional(),
  visibilityDefault:  z.enum(["public", "friends_only", "private"]).default("public"),
  sourceSystem:       z.string().optional(),
  city:               z.string().optional(),
  country:            z.string().optional(),
  startsAt:           z.string().datetime().optional(),
  endsAt:             z.string().datetime().optional(),
});

router.post("/admin/stamps/definitions", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = createDefinitionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }
  const d = parsed.data;

  const { data, error } = await sc
    .from("stamp_definitions")
    .insert({
      slug:               d.slug,
      name:               d.name,
      description:        d.description ?? null,
      stamp_type:         d.stampType,
      category:           d.category,
      icon_url:           d.iconUrl ?? null,
      rarity:             d.rarity,
      is_active:          d.isActive,
      is_repeatable:      d.isRepeatable,
      max_awards_per_user: d.maxAwardsPerUser ?? null,
      criteria_type:      d.criteriaType,
      criteria:           d.criteria ?? null,
      visibility_default: d.visibilityDefault,
      source_system:      d.sourceSystem ?? null,
      city:               d.city ?? null,
      country:            d.country ?? null,
      starts_at:          d.startsAt ?? null,
      ends_at:            d.endsAt ?? null,
    })
    .select()
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json({ definition: data });
});

// ── PATCH /admin/stamps/definitions/:id ──────────────────────────────────────

router.patch("/admin/stamps/definitions/:id", async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid definition id"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = createDefinitionSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const d = parsed.data;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (d.slug               !== undefined) patch.slug               = d.slug;
  if (d.name               !== undefined) patch.name               = d.name;
  if (d.description        !== undefined) patch.description        = d.description;
  if (d.stampType          !== undefined) patch.stamp_type         = d.stampType;
  if (d.category           !== undefined) patch.category           = d.category;
  if (d.iconUrl            !== undefined) patch.icon_url           = d.iconUrl;
  if (d.rarity             !== undefined) patch.rarity             = d.rarity;
  if (d.isActive           !== undefined) patch.is_active          = d.isActive;
  if (d.isRepeatable       !== undefined) patch.is_repeatable      = d.isRepeatable;
  if (d.maxAwardsPerUser   !== undefined) patch.max_awards_per_user = d.maxAwardsPerUser;
  if (d.criteriaType       !== undefined) patch.criteria_type      = d.criteriaType;
  if (d.criteria           !== undefined) patch.criteria           = d.criteria;
  if (d.visibilityDefault  !== undefined) patch.visibility_default = d.visibilityDefault;
  if (d.sourceSystem       !== undefined) patch.source_system      = d.sourceSystem;
  if (d.city               !== undefined) patch.city               = d.city;
  if (d.country            !== undefined) patch.country            = d.country;
  if (d.startsAt           !== undefined) patch.starts_at          = d.startsAt;
  if (d.endsAt             !== undefined) patch.ends_at            = d.endsAt;

  if (Object.keys(patch).length === 1) {
    sendError(res, "invalid_payload", "No fields to update");
    return;
  }

  const { data, error } = await sc
    .from("stamp_definitions")
    .update(patch)
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Definition not found"); return; }
  res.json({ definition: data });
});

// ── POST /admin/stamps/award ──────────────────────────────────────────────────

const adminAwardSchema = z.object({
  userId:         z.string().uuid(),
  definitionSlug: z.string().min(1),
  reason:         z.string().min(1).max(500),
  sourceType:     z.string().optional(),
  sourceId:       z.string().optional(),
  city:           z.string().optional(),
  country:        z.string().optional(),
  metadata:       z.record(z.unknown()).optional(),
});

router.post("/admin/stamps/award", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const parsed = adminAwardSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const result = await awardStamp(sc, {
    userId:         parsed.data.userId,
    definitionSlug: parsed.data.definitionSlug,
    sourceType:     parsed.data.sourceType ?? "admin",
    sourceId:       parsed.data.sourceId,
    city:           parsed.data.city,
    country:        parsed.data.country,
    metadata:       parsed.data.metadata,
    awardReason:    parsed.data.reason,
    adminId,
  });

  if (result.awarded) {
    (async () => {
      try {
        const notifSvc    = new NotificationService(sc);
        const notifRouter = new NotifRouter(sc);
        const row = await notifSvc.create({
          userId:     parsed.data.userId,
          eventType:  "passport.stamp_earned",
          sourceType: "passport",
          sourceId:   result.userStampId,
          params:     { location: parsed.data.city ?? parsed.data.country ?? parsed.data.definitionSlug },
        });
        if (row) await notifRouter.route(row);
      } catch {}
    })();
  }

  res.status(result.awarded ? 201 : 200).json(result);
});

// ── POST /admin/stamps/:userStampId/revoke ────────────────────────────────────

const revokeSchema = z.object({
  reason: z.string().min(1).max(500),
});

router.post("/admin/stamps/:userStampId/revoke", async (req, res) => {
  const { userStampId } = req.params;
  if (!isUuid(userStampId)) { sendError(res, "invalid_payload", "Invalid userStampId"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const parsed = revokeSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const result = await revokeStamp(sc, userStampId, adminId, parsed.data.reason);
  if (!result.revoked) {
    sendError(res, "not_found", result.reason);
    return;
  }
  res.json(result);
});

// ── POST /admin/stamps/:userStampId/restore ───────────────────────────────────

router.post("/admin/stamps/:userStampId/restore", async (req, res) => {
  const { userStampId } = req.params;
  if (!isUuid(userStampId)) { sendError(res, "invalid_payload", "Invalid userStampId"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const parsed = revokeSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const result = await restoreStamp(sc, userStampId, adminId, parsed.data.reason);
  if (!result.restored) {
    sendError(res, "not_found", result.reason);
    return;
  }
  res.json(result);
});

// ── GET /admin/stamps/audit ───────────────────────────────────────────────────

router.get("/admin/stamps/audit", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page      = Math.max(1, Number(req.query.page) || 1);
  const limit     = Math.min(100, Number(req.query.limit) || 50);
  const userId    = req.query.user_id as string | undefined;
  const defId     = req.query.stamp_definition_id as string | undefined;
  const stampType = req.query.stamp_type as string | undefined;
  const status    = req.query.status as string | undefined;
  const startDate = req.query.start_date as string | undefined;
  const endDate   = req.query.end_date as string | undefined;

  let query = sc
    .from("stamp_award_events")
    .select(
      "id, user_id, stamp_definition_id, source_type, source_id, award_reason, status, admin_id, created_at, stamp_definitions(stamp_type)",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (userId)    query = (query as any).eq("user_id", userId);
  if (defId)     query = (query as any).eq("stamp_definition_id", defId);
  if (stampType) query = (query as any).eq("stamp_definitions.stamp_type", stampType);
  if (status)    query = (query as any).eq("status", status);
  if (startDate) query = (query as any).gte("created_at", startDate);
  if (endDate)   query = (query as any).lte("created_at", endDate);

  const { data, error, count } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ events: data ?? [], total: count ?? 0, page });
});

// ── GET /admin/stamps/campaigns ───────────────────────────────────────────────

router.get("/admin/stamps/campaigns", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { data, error } = await sc
    .from("stamp_campaigns")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ campaigns: data ?? [] });
});

// ── POST /admin/stamps/campaigns ──────────────────────────────────────────────

const createCampaignSchema = z.object({
  slug:               z.string().min(1).max(100),
  name:               z.string().min(1).max(200),
  description:        z.string().max(1000).optional(),
  stampDefinitionId:  z.string().uuid().optional(),
  startsAt:           z.string().datetime().optional(),
  endsAt:             z.string().datetime().optional(),
  isActive:           z.boolean().default(false),
  metadata:           z.record(z.unknown()).optional(),
});

router.post("/admin/stamps/campaigns", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }
  const d = parsed.data;

  const { data, error } = await sc
    .from("stamp_campaigns")
    .insert({
      slug:               d.slug,
      name:               d.name,
      description:        d.description ?? null,
      stamp_definition_id: d.stampDefinitionId ?? null,
      starts_at:          d.startsAt ?? null,
      ends_at:            d.endsAt ?? null,
      is_active:          d.isActive,
      metadata:           d.metadata ?? null,
    })
    .select()
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json({ campaign: data });
});

// ── PATCH /admin/stamps/campaigns/:campaignId ────────────────────────────────

router.patch("/admin/stamps/campaigns/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  if (!isUuid(campaignId)) { sendError(res, "invalid_payload", "Invalid campaignId"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = createCampaignSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const d = parsed.data;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (d.slug               !== undefined) patch.slug               = d.slug;
  if (d.name               !== undefined) patch.name               = d.name;
  if (d.description        !== undefined) patch.description        = d.description;
  if (d.stampDefinitionId  !== undefined) patch.stamp_definition_id = d.stampDefinitionId;
  if (d.startsAt           !== undefined) patch.starts_at          = d.startsAt;
  if (d.endsAt             !== undefined) patch.ends_at            = d.endsAt;
  if (d.isActive           !== undefined) patch.is_active          = d.isActive;
  if (d.metadata           !== undefined) patch.metadata           = d.metadata;

  if (Object.keys(patch).length === 1) {
    sendError(res, "invalid_payload", "No fields to update");
    return;
  }

  const { data, error } = await sc
    .from("stamp_campaigns")
    .update(patch)
    .eq("id", campaignId)
    .select()
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Campaign not found"); return; }
  res.json({ campaign: data });
});

export default router;
