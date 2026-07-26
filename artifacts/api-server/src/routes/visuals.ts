/**
 * Visual generation API — /api/visuals/*
 *
 * The server owns everything sensitive: it loads the canonical entity from the DB
 * and ignores any client-supplied owner/prompt/provider/model/storage fields.
 * Authorization: event → host, trip → owner, place → admin.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { requireUser } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { coerceStyle } from "../lib/visuals/styles.js";
import {
  requestGeneration,
  processJob,
  type GenerationRequest,
} from "../lib/visuals/service.js";
import type { VisualEntityType, VisualPurpose } from "../lib/visuals/types.js";

const router = Router();

const ENTITY_TYPES = ["event", "place", "trip", "city_guide", "group", "content"] as const;
const PURPOSES = [
  "event_header",
  "place_header",
  "trip_cover",
  "city_guide_cover",
  "group_cover",
  "generic_content_header",
] as const;

const GenerateBody = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string().min(1).max(200),
  purpose: z.enum(PURPOSES),
  style: z.string().max(60).optional(),
  preferences: z
    .object({
      people: z.enum(["auto", "people", "no_people"]).optional(),
      timeOfDay: z
        .enum(["auto", "morning", "afternoon", "sunset", "evening", "night"])
        .optional(),
      renderMode: z.enum(["realistic", "illustrated"]).optional(),
      mood: z.string().max(60).optional(),
    })
    .optional(),
});

/** Is this user allowed to generate/replace visuals for this entity? */
async function canEditEntity(
  sc: any,
  entityType: VisualEntityType,
  entityId: string,
  userId: string,
): Promise<boolean> {
  // Admins can always manage visuals.
  const { data: prof } = await sc.from("profiles").select("role").eq("id", userId).maybeSingle();
  if (prof?.role === "admin") return true;

  if (entityType === "event") {
    const { data } = await sc.from("events").select("host_id").eq("id", entityId).maybeSingle();
    return !!data && data.host_id === userId;
  }
  if (entityType === "trip") {
    const { data } = await sc.from("trips").select("owner_id").eq("id", entityId).maybeSingle();
    return !!data && data.owner_id === userId;
  }
  // Places and other reference entities are admin-managed only.
  return false;
}

// ── POST /api/visuals/generate ────────────────────────────────────────────────
router.post(
  "/visuals/generate",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const parsed = GenerateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid body");
    }
    const sc = getServiceClient();
    if (!sc) return sendError(res, "server_not_configured");

    const { entityType, entityId, purpose, style, preferences } = parsed.data;
    if (!(await canEditEntity(sc, entityType, entityId, auth.user.id))) {
      return sendError(res, "forbidden", "You cannot generate a visual for this entity");
    }

    const request: GenerationRequest = {
      entityType,
      entityId,
      purpose: purpose as VisualPurpose,
      ownerUserId: auth.user.id,
      style: coerceStyle(style),
      preferences,
    };
    const outcome = await requestGeneration(request);
    if (!outcome.ok) {
      if (outcome.status === "rate_limited") return sendError(res, "rate_limited", outcome.error);
      if (outcome.status === "disabled") return sendError(res, "feature_disabled", outcome.error);
      return sendError(res, "db_error", outcome.error);
    }

    // Fire the async job without blocking the response.
    if (outcome.visualId && outcome.status === "queued") {
      void processJob(outcome.visualId);
    }
    return res.status(202).json({
      id: outcome.visualId,
      status: outcome.status,
      entityType,
      entityId,
      purpose,
      style: request.style,
      imageUrl: null,
    });
  }),
);

// ── GET /api/visuals/:id ──────────────────────────────────────────────────────
router.get(
  "/visuals/:id",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) return sendError(res, "server_not_configured");
    const { data, error } = await sc
      .from("generated_visuals")
      .select(
        "id, entity_type, entity_id, purpose, status, style, source_image_url, hero_path, card_path, thumbnail_path, share_path, moderation_status, failure_code, created_at, updated_at",
      )
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) return sendError(res, "db_error");
    if (!data) return sendError(res, "not_found");
    return res.json({ visual: data });
  }),
);

// ── GET /api/visuals/entity/:entityType/:entityId ─────────────────────────────
router.get(
  "/visuals/entity/:entityType/:entityId",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const et = req.params.entityType;
    if (!ENTITY_TYPES.includes(et as any)) return sendError(res, "invalid_payload", "bad entityType");
    const sc = getServiceClient();
    if (!sc) return sendError(res, "server_not_configured");
    const { data, error } = await sc
      .from("generated_visuals")
      .select("id, purpose, status, style, source_image_url, hero_path, created_at")
      .eq("entity_type", et)
      .eq("entity_id", req.params.entityId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return sendError(res, "db_error");
    return res.json({ visuals: data ?? [] });
  }),
);

// ── POST /api/visuals/:id/regenerate ──────────────────────────────────────────
router.post(
  "/visuals/:id/regenerate",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) return sendError(res, "server_not_configured");
    const { data: prior } = await sc
      .from("generated_visuals")
      .select("entity_type, entity_id, purpose, style")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!prior) return sendError(res, "not_found");
    if (!(await canEditEntity(sc, prior.entity_type, prior.entity_id, auth.user.id))) {
      return sendError(res, "forbidden");
    }
    const outcome = await requestGeneration({
      entityType: prior.entity_type,
      entityId: prior.entity_id,
      purpose: prior.purpose,
      ownerUserId: auth.user.id,
      style: prior.style,
      force: true,
    });
    if (!outcome.ok) {
      if (outcome.status === "rate_limited") return sendError(res, "rate_limited", outcome.error);
      return sendError(res, "db_error", outcome.error);
    }
    if (outcome.visualId) void processJob(outcome.visualId);
    return res.status(202).json({ id: outcome.visualId, status: outcome.status });
  }),
);

// ── POST /api/visuals/:id/accept ──────────────────────────────────────────────
router.post(
  "/visuals/:id/accept",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) return sendError(res, "server_not_configured");
    const { data: v } = await sc
      .from("generated_visuals")
      .select("entity_type, entity_id, status")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!v) return sendError(res, "not_found");
    if (!(await canEditEntity(sc, v.entity_type, v.entity_id, auth.user.id))) {
      return sendError(res, "forbidden");
    }
    if (v.status !== "ready") return sendError(res, "invalid_state_transition", "visual not ready");
    await sc
      .from("generated_visuals")
      .update({ accepted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", req.params.id);
    return res.json({ ok: true });
  }),
);

// ── DELETE /api/visuals/:id ───────────────────────────────────────────────────
router.delete(
  "/visuals/:id",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) return sendError(res, "server_not_configured");
    const { data: v } = await sc
      .from("generated_visuals")
      .select("entity_type, entity_id")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!v) return sendError(res, "not_found");
    if (!(await canEditEntity(sc, v.entity_type, v.entity_id, auth.user.id))) {
      return sendError(res, "forbidden");
    }
    // Soft-remove: mark replaced rather than hard delete, preserving audit history.
    await sc
      .from("generated_visuals")
      .update({ status: "replaced", replaced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", req.params.id);
    return res.json({ ok: true });
  }),
);

export default router;
