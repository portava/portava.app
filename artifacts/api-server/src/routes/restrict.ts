/**
 * Restriction routes
 *
 * POST   /api/users/:userId/restrict         — restrict a user (limits contact to message requests; hides read receipts)
 * DELETE /api/users/:userId/restrict         — unrestrict a user
 * GET    /api/me/restrictions                — list users I have restricted
 * GET    /api/users/:userId/restrict-status  — am I restricting this user?
 *
 * Restriction is a soft visibility control: the restricted user can still
 * send a message request but cannot see online status or read receipts.
 * It is not the same as a block — the restricted user is unaware.
 */
import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { isUuid } from "../lib/followDecisions.js";
import { getServiceClient } from "../lib/supabase.js";
import { resolveInteractionPermissions } from "../services/interactionPermissions.js";
import { nameVisibilitySet, presentedName } from "../lib/publicIdentity.js";

const router = Router();

/* ===========================================================================
 * POST /users/:userId/restrict  — restrict a user
 * ===========================================================================
 * Body: { reason?: string }
 * Idempotent: restricting an already-restricted user updates the reason.
 */
router.post("/users/:userId/restrict", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const targetId = req.params.userId;
  if (!isUuid(targetId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }
  if (targetId === user.id) { sendError(res, "invalid_payload", "Cannot restrict yourself"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  try {
    const perms = await resolveInteractionPermissions(sc, user.id, targetId);
    if (!perms.canRestrict) {
      sendError(res, "forbidden", "Cannot restrict this user");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for restrict");
    sendError(res, "db_error", "Permission check failed", { exposeDetail: true });
    return;
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 255) : "manual";

  const { error } = await sc
    .from("user_restrictions")
    .upsert(
      { restrictor_id: user.id, restricted_id: targetId, options: { reason } },
      { onConflict: "restrictor_id,restricted_id" },
    );

  if (error) {
    req.log.error({ err: error }, "user_restrictions upsert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ restricted: true, userId: targetId });
});

/* ===========================================================================
 * DELETE /users/:userId/restrict  — unrestrict a user
 * ===========================================================================
 * Idempotent: no-op if the user was never restricted.
 */
router.delete("/users/:userId/restrict", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const targetId = req.params.userId;
  if (!isUuid(targetId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Permission engine — canUnsaveProfile is true even when blocked (undo-own-action).
  try {
    const perms = await resolveInteractionPermissions(sc, user.id, targetId);
    if (!perms.canUnsaveProfile) {
      sendError(res, "forbidden", "Cannot remove restriction for this user");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for restrict delete");
    sendError(res, "db_error", "Permission check failed", { exposeDetail: true });
    return;
  }

  const { error } = await sc
    .from("user_restrictions")
    .delete()
    .eq("restrictor_id", user.id)
    .eq("restricted_id", targetId);

  if (error) {
    req.log.error({ err: error }, "user_restrictions delete failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ restricted: false, userId: targetId });
});

/* ===========================================================================
 * GET /me/restrictions  — list users I have restricted
 * ===========================================================================
 */
router.get("/me/restrictions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rows, error } = await sc
    .from("user_restrictions")
    .select("restricted_id, options, created_at")
    .eq("restrictor_id", user.id)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    req.log.error({ err: error }, "user_restrictions list failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const ids = (rows ?? []).map((r: any) => r.restricted_id as string);
  let profileMap: Record<string, any> = {};
  if (ids.length > 0) {
    const { data: profiles } = await sc
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", ids);
    for (const p of profiles ?? []) profileMap[(p as any).id] = p;
  }

  const allowedNames = await nameVisibilitySet(sc, ids);

  res.status(200).json({
    restricted: (rows ?? []).map((r: any) => {
      const p = profileMap[r.restricted_id] ?? {};
      return {
        id:                r.restricted_id as string,
        handle:            (p.handle as string | null) ?? null,
        name:              presentedName(p, r.restricted_id === user.id || allowedNames.has(r.restricted_id as string)),
        avatarUrl:         (p.avatar_url as string | null) ?? null,
        restrictionReason: ((r.options as any)?.reason as string | null) ?? null,
        restrictedAt:      r.created_at as string,
      };
    }),
  });
});

/* ===========================================================================
 * GET /users/:userId/restrict-status  — am I restricting this user?
 * ===========================================================================
 */
router.get("/users/:userId/restrict-status", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const targetId = req.params.userId;
  if (!isUuid(targetId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("user_restrictions")
    .select("options")
    .eq("restrictor_id", user.id)
    .eq("restricted_id", targetId)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, "restrict-status check failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({
    userId:            targetId,
    restricted:        data !== null,
    restrictionReason: ((data as any)?.options?.reason as string | null) ?? null,
  });
});

export default router;
