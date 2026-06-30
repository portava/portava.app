/**
 * Mute routes
 *
 * POST   /api/users/:userId/mute          — mute a user (with mute_types[])
 * DELETE /api/users/:userId/mute          — unmute a user
 * GET    /api/me/mutes                    — list users I have muted
 * GET    /api/users/:userId/mute-status   — am I muting this user?
 *
 * Privacy guarantee: muting is private, not notified to the muted user,
 * and friendship/follow is preserved.
 * Block gate: if either party has blocked the other, canMute=false (via
 * permission engine). Muting a blocked user is redundant — block already
 * prevents all contact.
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { isUuid } from "../lib/followDecisions";
import { getServiceClient } from "../lib/supabase";
import { resolveInteractionPermissions } from "../services/interactionPermissions";

const router = Router();

const VALID_MUTE_TYPES = new Set([
  "messages",
  "posts",
  "event_invites",
  "circle_invites",
  "trip_invites",
  "all",
]);

/* ===========================================================================
 * POST /users/:userId/mute  — mute a user
 * ===========================================================================
 * Body: { mute_types?: string[] }  — defaults to ["all"]
 * Idempotent: muting someone already muted updates their mute_types.
 */
router.post("/users/:userId/mute", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const targetId = req.params.userId;
  if (!isUuid(targetId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }
  if (targetId === user.id) { sendError(res, "invalid_payload", "Cannot mute yourself"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Permission engine — always enforced (fail-closed). canMute=true in normal state;
  // blocked/suspended users get ALL_FALSE early return → canMute=false.
  // Engine semantics: canMute=true allows both new mutes and type updates (idempotent).
  try {
    const perms = await resolveInteractionPermissions(sc, user.id, targetId);
    if (!perms.canMute) {
      sendError(res, "forbidden", perms.reasonCodes.includes("blocked")
        ? "Cannot mute a user you have blocked or who has blocked you"
        : "Cannot mute this user");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for mute");
    sendError(res, "db_error", "Permission check failed");
    return;
  }

  const rawTypes = req.body?.mute_types;
  const muteTypes: string[] = Array.isArray(rawTypes)
    ? (rawTypes as string[]).filter((t) => VALID_MUTE_TYPES.has(t))
    : ["all"];
  if (muteTypes.length === 0) muteTypes.push("all");

  const { error } = await sc
    .from("user_mutes")
    .upsert(
      { muter_id: user.id, muted_id: targetId, mute_types: muteTypes },
      { onConflict: "muter_id,muted_id" },
    );

  if (error) {
    req.log.error({ err: error }, "user_mutes upsert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ muted: true, userId: targetId, muteTypes });
});

/* ===========================================================================
 * DELETE /users/:userId/mute  — unmute
 * ===========================================================================
 */
router.delete("/users/:userId/mute", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const targetId = req.params.userId;
  if (!isUuid(targetId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Permission engine — canUnsaveProfile is true even when blocked (undo-own-action);
  // only false if target account is gone or viewer account is in a terminal state.
  try {
    const perms = await resolveInteractionPermissions(sc, user.id, targetId);
    if (!perms.canUnsaveProfile) {
      sendError(res, "forbidden", "Cannot remove mute for this user");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for mute delete");
    sendError(res, "db_error", "Permission check failed");
    return;
  }

  const { error } = await sc
    .from("user_mutes")
    .delete()
    .eq("muter_id", user.id)
    .eq("muted_id", targetId);

  if (error) {
    req.log.error({ err: error }, "user_mutes delete failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ muted: false, userId: targetId });
});

/* ===========================================================================
 * GET /me/mutes  — list users I have muted
 * ===========================================================================
 */
router.get("/me/mutes", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rows, error } = await sc
    .from("user_mutes")
    .select("muted_id, mute_types, created_at")
    .eq("muter_id", user.id)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    req.log.error({ err: error }, "user_mutes list failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const ids = (rows ?? []).map((r: any) => r.muted_id as string);
  let profileMap: Record<string, any> = {};
  if (ids.length > 0) {
    const { data: profiles } = await sc
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", ids);
    for (const p of profiles ?? []) profileMap[(p as any).id] = p;
  }

  res.status(200).json({
    muted: (rows ?? []).map((r: any) => {
      const p = profileMap[r.muted_id] ?? {};
      return {
        id:         r.muted_id as string,
        handle:     (p.handle    as string | null) ?? null,
        name:       (p.name      as string | null) ?? null,
        avatarUrl:  (p.avatar_url as string | null) ?? null,
        muteTypes:  (r.mute_types as string[]) ?? ["all"],
        mutedAt:    r.created_at as string,
      };
    }),
  });
});

/* ===========================================================================
 * GET /users/:userId/mute-status  — am I muting this user?
 * ===========================================================================
 */
router.get("/users/:userId/mute-status", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const targetId = req.params.userId;
  if (!isUuid(targetId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("user_mutes")
    .select("mute_types")
    .eq("muter_id", user.id)
    .eq("muted_id", targetId)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, "mute-status check failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({
    userId:    targetId,
    muted:     data !== null,
    muteTypes: (data as any)?.mute_types ?? [],
  });
});

export default router;
