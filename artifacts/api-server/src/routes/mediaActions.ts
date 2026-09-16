/**
 * Media v2 — action rail + intent + experience-plan endpoints (§15/§43).
 *
 *   GET  /api/media/:id/actions                       §15/§43  eligible action set
 *   POST /api/media/:id/intent                        §15.1    "I Want This" signal
 *   DELETE /api/media/:id/intent                       §15.1    undo the signal
 *   GET  /api/media/experiences/:experienceId/plan    §15.2    "Do This Experience"
 *
 * ADDITIVE. New routes only; existing media/compass behavior is untouched.
 *
 * INVARIANTS:
 *   • requireUser on every route (auth + ban gate — never client.auth.getUser).
 *   • The action rail is eligibility-gated: a media item the viewer may not see
 *     returns not_found, and every offered action is gated by the SAME
 *     authorization as its target endpoint (§47) inside the resolver.
 *   • "I Want This" records an intent SIGNAL to its own store — not a like/save.
 *   • "Do This Experience" produces a plan PROPOSAL bound to the existing
 *     trip-plan endpoint; it writes nothing (Compass stays propose-only).
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { resolveViewer } from "../services/media/MediaProjectionService.js";
import {
  resolveMediaActions,
  buildDoThisExperiencePlan,
  recordMediaIntent,
  loadEligibleMediaRow,
  resolveMediaEntities,
  MEDIA_INTENT_KINDS,
  type MediaIntentKind,
} from "../services/media/MediaActionResolver.js";
import { authorizeMediaContext } from "../lib/mediaVisibility.js";
import {
  softDeleteMediaAsset,
  retryMediaProcessing,
} from "../services/media/MediaLifecycleService.js";
import {
  recordMediaAttachment,
} from "../lib/mediaAssets.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHMENT_VISIBILITIES = ["inherit", "public", "private", "followers", "following", "trip_crew", "shared_moment"] as const;
/** Entity types whose table and ownership semantics are defined below. */
export const SUPPORTED_ATTACHMENT_ENTITY_TYPES = [
  "post",
  "postcard",
  "memory",
  "trip",
  "event",
  "hidden_gem",
  "shared_moment",
] as const;
export const attachmentBodySchema = z.object({
  entity_type: z.enum(SUPPORTED_ATTACHMENT_ENTITY_TYPES),
  entity_id: z.string().regex(UUID_RE),
  position: z.number().int().min(0).max(10000).optional(),
  is_cover: z.boolean().optional(),
  visibility_override: z.enum(ATTACHMENT_VISIBILITIES).nullable().optional(),
}).strict();
export function validateMediaAttachmentBody(body: unknown) {
  return attachmentBodySchema.safeParse(body);
}

export async function ownsAttachmentEntity(sc: any, userId: string, entityType: string, entityId: string): Promise<boolean> {
  const entities: Record<string, { table: string; ownerColumn: string }> = {
    post: { table: "posts", ownerColumn: "author_id" },
    postcard: { table: "passport_postcards", ownerColumn: "user_id" },
    memory: { table: "passport_memories", ownerColumn: "user_id" },
    event: { table: "events", ownerColumn: "host_id" },
    hidden_gem: { table: "hidden_gems", ownerColumn: "submitted_by" },
    shared_moment: { table: "shared_moments", ownerColumn: "owner_id" },
    trip: { table: "trips", ownerColumn: "owner_id" },
  };
  const entity = entities[entityType];
  if (!entity) return false;
  try {
    const { data, error } = await sc
      .from(entity.table)
      .select(`id,${entity.ownerColumn}`)
      .eq("id", entityId)
      .maybeSingle();
    if (error || !data) return false;
    if (String(data[entity.ownerColumn]) === userId) return true;
    if (entityType !== "trip") return false;
    // A trip attachment is collaborative: only an accepted member may attach.
    const member = await sc
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", entityId)
      .eq("user_id", userId)
      .eq("status", "accepted")
      .maybeSingle();
    return !member.error && Boolean(member.data);
  } catch {
    return false;
  }
}

// ── Owner lifecycle actions ───────────────────────────────────────────────────
// These routes intentionally return probe-safe not_found for missing and
// unauthorized assets; ownership-sensitive details never cross the boundary.
router.delete(
  "/media/:id",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      sendError(res, "invalid_payload", "Invalid media id");
      return;
    }
    const result = await softDeleteMediaAsset(sc, id, auth.user.id, { logger: req.log });
    if (!result.ok) {
      sendError(res, "not_found", "Media item not found");
      return;
    }
    res.status(202).json({
      deleted: true,
      alreadyDeleted: result.alreadyDeleted,
      purge: result.purgeScheduled ? "pending" : "completed",
    });
  }),
);

router.post(
  "/media/:id/retry",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      sendError(res, "invalid_payload", "Invalid media id");
      return;
    }
    const result = await retryMediaProcessing(sc, id, auth.user.id);
    if (!result.ok) {
      sendError(res, "not_found", "Media item not found");
      return;
    }
    res.status(202).json({ retryQueued: true, alreadyQueued: result.alreadyQueued });
  }),
);

// ── POST /media/:id/attachments ──────────────────────────────────────────────
router.post(
  "/media/:id/attachments",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured"); return; }
    const mediaId = String(req.params.id ?? "");
    if (!UUID_RE.test(mediaId)) { sendError(res, "invalid_payload", "Invalid media id"); return; }
    const parsed = validateMediaAttachmentBody(req.body);
    if (!parsed.success) { sendError(res, "invalid_payload", "Invalid attachment"); return; }
    const body = parsed.data;
    let asset: any;
    try {
      const result = await sc.from("media_assets").select("id,owner_user_id").eq("id", mediaId).maybeSingle();
      asset = result.error ? null : result.data;
    } catch { asset = null; }
    // Missing and unauthorized assets/entities intentionally share not_found.
    if (!asset || asset.owner_user_id !== auth.user.id ||
      !(await ownsAttachmentEntity(sc, auth.user.id, body.entity_type, body.entity_id))) {
      sendError(res, "not_found", "Media item not found");
      return;
    }
    const attachmentId = await recordMediaAttachment(sc, {
      mediaAssetId: mediaId,
      entityType: body.entity_type,
      entityId: body.entity_id,
      position: body.position,
      isCover: body.is_cover,
      visibilityOverride: body.visibility_override,
    });
    if (!attachmentId) {
      sendError(res, "not_found", "Media item not found");
      return;
    }
    res.status(200).json({ id: attachmentId, mediaAssetId: mediaId, entityType: body.entity_type, entityId: body.entity_id });
  }),
);

// ── GET /media/:id/actions ────────────────────────────────────────────────────
router.get(
  "/media/:id/actions",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      sendError(res, "invalid_payload", "Invalid media id");
      return;
    }
    const rl = checkRateLimit("media_actions", auth.user.id, 120, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, id, nowMs);
    if (!result) {
      // Not visible to this viewer (private / blocked / ineligible) or missing —
      // a probe-safe not_found, identical to GET /media/:id.
      sendError(res, "not_found", "Media item not found");
      return;
    }
    res.json({ ...result, generatedAt: new Date(nowMs).toISOString() });
  }),
);

// ── POST /media/:id/intent  ("I Want This", §15.1) ────────────────────────────
const intentBodySchema = z.object({
  intent: z.enum(MEDIA_INTENT_KINDS).default("want_to_go"),
});

router.post(
  "/media/:id/intent",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      sendError(res, "invalid_payload", "Invalid media id");
      return;
    }
    const parsed = intentBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }
    const rl = checkRateLimit("media_intent", auth.user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }

    // Resolve the media THROUGH the eligibility gate: an intent can only be
    // recorded on an item the viewer may see, and the entity it is keyed to is
    // resolved server-side (never trusted from the client).
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: true });
    const row = await loadEligibleMediaRow(sc, viewer, id);
    if (!row) {
      sendError(res, "not_found", "Media item not found");
      return;
    }
    if ((row as any).trip_id && (row as any).author_id &&
      !(await authorizeMediaContext(sc, auth.user.id, String((row as any).author_id), {
        contextType: "trip",
        contextId: String((row as any).trip_id),
      }))) {
      sendError(res, "not_found", "Media item not found");
      return;
    }
    const entities = await resolveMediaEntities(sc, viewer, row, nowMs);
    const entityType = entities.tripId
      ? "trip"
      : entities.gemId
        ? "gem"
        : entities.placeId
          ? "place"
          : "media";
    const entityId = entities.tripId ?? entities.gemId ?? entities.placeId ?? id;

    const result = await recordMediaIntent(
      sc,
      auth.user.id,
      id,
      { entityType, entityId },
      parsed.data.intent as MediaIntentKind,
    );
    if (!result.recorded) {
      sendError(res, "db_error", "Could not record intent", { exposeDetail: false });
      return;
    }
    res.status(200).json({ recorded: true, intent: parsed.data.intent, entityType, entityId });
  }),
);

// ── DELETE /media/:id/intent  (undo the signal) ───────────────────────────────
router.delete(
  "/media/:id/intent",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      sendError(res, "invalid_payload", "Invalid media id");
      return;
    }
    const { error } = await (sc as any)
      .from("media_intent_signals")
      .delete()
      .eq("user_id", auth.user.id)
      .eq("media_id", id);
    if (error) {
      req.log?.warn({ err: error }, "media/intent: delete failed");
      sendError(res, "db_error", "Could not remove intent", { exposeDetail: false });
      return;
    }
    res.status(200).json({ removed: true });
  }),
);

// ── GET /media/experiences/:experienceId/plan  ("Do This Experience", §15.2) ──
router.get(
  "/media/experiences/:experienceId/plan",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const experienceId = String(req.params.experienceId ?? "");
    if (!UUID_RE.test(experienceId)) {
      sendError(res, "invalid_payload", "Invalid experience id");
      return;
    }
    const rl = checkRateLimit("media_experience_plan", auth.user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: true });
    const proposal = await buildDoThisExperiencePlan(sc, viewer, experienceId, nowMs);
    if (!proposal) {
      // Experience not visible to this viewer (private / blocked / missing).
      sendError(res, "not_found", "Experience not available");
      return;
    }
    res.json({ ...proposal, generatedAt: new Date(nowMs).toISOString() });
  }),
);

export default router;
