/**
 * Save-profile routes
 *
 * POST   /api/users/:userId/save        — save a user profile
 * DELETE /api/users/:userId/save        — unsave
 * GET    /api/me/saves                  — list my saved profiles
 * GET    /api/users/:userId/save-status — have I saved this user?
 *
 * Privacy guarantee:
 *   - Saves are PRIVATE: the saved user is never notified.
 *   - A save grants NO access to private content, trips, live location,
 *     or circle memberships. The save list is only visible to the saver.
 *   - Block hides: if either party blocks the other, canSaveProfile=false.
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { isUuid } from "../lib/followDecisions";
import { getServiceClient } from "../lib/supabase";
import { nameVisibilitySet } from "../lib/publicIdentity";
import { resolveInteractionPermissions } from "../services/interactionPermissions";

const router = Router();

/* ===========================================================================
 * POST /users/:userId/save  — save a profile
 * ===========================================================================
 * Idempotent: saving an already-saved profile is a no-op (200).
 */
router.post("/users/:userId/save", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const targetId = req.params.userId;
  if (!isUuid(targetId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }
  if (targetId === user.id) { sendError(res, "invalid_payload", "Cannot save yourself"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Permission engine — fail-closed block check; save grants no access
  try {
    const perms = await resolveInteractionPermissions(sc, user.id, targetId);
    if (!perms.canSaveProfile) {
      sendError(res, "forbidden", perms.reasonCodes.includes("blocked")
        ? "Cannot save a user you have blocked or who has blocked you"
        : "Cannot save this profile");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for save");
    sendError(res, "db_error", "Permission check failed");
    return;
  }

  const { error } = await sc
    .from("user_saves")
    .upsert(
      { saver_id: user.id, saved_id: targetId },
      { onConflict: "saver_id,saved_id", ignoreDuplicates: true },
    );

  if (error) {
    req.log.error({ err: error }, "user_saves upsert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ saved: true, userId: targetId });
});

/* ===========================================================================
 * DELETE /users/:userId/save  — unsave
 * ===========================================================================
 */
router.delete("/users/:userId/save", async (req, res) => {
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
      sendError(res, "forbidden", "Cannot remove save for this user");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for save delete");
    sendError(res, "db_error", "Permission check failed");
    return;
  }

  const { error } = await sc
    .from("user_saves")
    .delete()
    .eq("saver_id", user.id)
    .eq("saved_id", targetId);

  if (error) {
    req.log.error({ err: error }, "user_saves delete failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ saved: false, userId: targetId });
});

/* ===========================================================================
 * GET /me/saves  — list profiles I have saved
 * ===========================================================================
 */
router.get("/me/saves", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rows, error } = await sc
    .from("user_saves")
    .select("saved_id, created_at")
    .eq("saver_id", user.id)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    req.log.error({ err: error }, "user_saves list failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const ids = (rows ?? []).map((r: any) => r.saved_id as string);
  let profileMap: Record<string, any> = {};
  if (ids.length > 0) {
    const { data: profiles } = await sc
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", ids);
    for (const p of profiles ?? []) profileMap[(p as any).id] = p;
  }

  // Universal display-name rule: saved users show @handle unless opted in.
  const allowedSavedNames = await nameVisibilitySet(sc, ids);

  res.status(200).json({
    saves: (rows ?? []).map((r: any) => {
      const p = profileMap[r.saved_id] ?? {};
      return {
        id:        r.saved_id as string,
        handle:    (p.handle    as string | null) ?? null,
        name:      (r.saved_id === user.id || allowedSavedNames.has(r.saved_id as string)) ? ((p.name as string | null) ?? null) : null,
        avatarUrl: (p.avatar_url as string | null) ?? null,
        savedAt:   r.created_at as string,
      };
    }),
  });
});

/* ===========================================================================
 * GET /users/:userId/save-status  — have I saved this profile?
 * ===========================================================================
 */
router.get("/users/:userId/save-status", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const targetId = req.params.userId;
  if (!isUuid(targetId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("user_saves")
    .select("saver_id")
    .eq("saver_id", user.id)
    .eq("saved_id", targetId)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, "save-status check failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ userId: targetId, saved: data !== null });
});

export default router;
