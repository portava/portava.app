/**
 * GET /api/users/:targetUserId/interaction-context
 *
 * Returns the full set of interaction permissions that the authenticated viewer
 * has against the target user. This is the single canonical permission gate:
 * every social action (follow, friend, message, tag, invite, book, report…)
 * must consult this endpoint before proceeding.
 *
 * Query params:
 *   sourceType — optional context type (e.g. "event", "trip", "deep_link")
 *   sourceId   — optional context ID (e.g. event UUID)
 *
 * SAFETY: Block wins over every other signal. Paid boosts NEVER override safety.
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { isUuid } from "../lib/followDecisions";
import { resolveInteractionPermissions } from "../services/interactionPermissions";
import { getServiceClient } from "../lib/supabase";

const router = Router();

router.get("/users/:targetUserId/interaction-context", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { targetUserId } = req.params;
  if (!isUuid(targetUserId)) {
    sendError(res, "invalid_payload", "Invalid target user id");
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  const sourceType = (req.query.sourceType as string | undefined) ?? null;
  const sourceId = (req.query.sourceId as string | undefined) ?? null;

  try {
    const permissions = await resolveInteractionPermissions(sc, user.id, targetUserId, {
      sourceType,
      sourceId,
    });
    res.status(200).json(permissions);
  } catch (err) {
    req.log.error({ err }, "interaction-context resolver failed");
    sendError(res, "db_error", "Failed to resolve interaction permissions");
  }
});

export default router;
