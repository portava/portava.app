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

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
