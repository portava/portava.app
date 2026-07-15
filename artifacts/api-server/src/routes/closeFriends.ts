/**
 * Close Friends / Trusted Crew routes
 *
 * GET    /users/me/close-friends          — list my close friends (private)
 * POST   /users/me/close-friends          — add a user to my close friends list
 * DELETE /users/me/close-friends/:userId  — remove a user from my close friends list
 *
 * The close friends list is PRIVATE — other users cannot read it.
 * No indicator is shown to the people on the list.
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { nameVisibilitySet, presentedName } from "../lib/publicIdentity.js";

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

// ── GET /users/me/close-friends ───────────────────────────────────────────────

router.get("/users/me/close-friends", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rows, error } = await client
    .from("close_friends")
    .select("friend_user_id, created_at")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    req.log.error({ err: error }, "Failed to load close friends");
    sendError(res, "db_error", error.message);
    return;
  }

  if (!rows || rows.length === 0) {
    res.status(200).json({ closeFriends: [] });
    return;
  }

  const friendIds = rows.map((r: any) => r.friend_user_id as string);

  const { data: profiles } = await sc
    .from("profiles")
    .select("id, handle, name, avatar_url")
    .in("id", friendIds);

  const allowedNames = await nameVisibilitySet(sc, friendIds);
  const profileMap: Record<string, any> = {};
  for (const p of profiles ?? []) {
    profileMap[(p as any).id] = { id: (p as any).id, handle: (p as any).handle, name: presentedName(p as any, (p as any).id === user.id || allowedNames.has((p as any).id)), avatarUrl: (p as any).avatar_url ?? null };
  }

  const closeFriends = rows.map((r: any) => ({
    userId: r.friend_user_id,
    ...profileMap[r.friend_user_id],
    addedAt: r.created_at,
  }));

  res.status(200).json({ closeFriends });
});

// ── POST /users/me/close-friends ──────────────────────────────────────────────

const addCloseFriendSchema = z.object({
  userId: z.string().uuid("userId must be a valid UUID"),
});

router.post("/users/me/close-friends", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = addCloseFriendSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const friendId = parsed.data.userId;
  if (friendId === user.id) {
    sendError(res, "invalid_payload", "You cannot add yourself to your close friends list");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Verify the target user exists
  const { data: profile } = await sc
    .from("profiles")
    .select("id")
    .eq("id", friendId)
    .maybeSingle();

  if (!profile) {
    sendError(res, "not_found", "User not found");
    return;
  }

  // Require that the caller follows the target user (or is mutually followed).
  // This prevents adding arbitrary strangers to the close friends list.
  const { data: followRow } = await sc
    .from("user_follows")
    .select("following_id")
    .eq("follower_id", user.id)
    .eq("following_id", friendId)
    .maybeSingle();

  if (!followRow) {
    sendError(res, "forbidden", "You must follow this user before adding them to Close Friends");
    return;
  }

  // Upsert (idempotent)
  const { error } = await client
    .from("close_friends")
    .upsert({ owner_id: user.id, friend_user_id: friendId }, { onConflict: "owner_id,friend_user_id" });

  if (error) {
    req.log.error({ err: error }, "Failed to add close friend");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ ok: true, userId: friendId });
});

// ── DELETE /users/me/close-friends/:userId ────────────────────────────────────

router.delete("/users/me/close-friends/:userId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { userId: friendId } = req.params;
  if (!isUuid(friendId)) {
    sendError(res, "invalid_payload", "Invalid user id");
    return;
  }

  const { error } = await client
    .from("close_friends")
    .delete()
    .eq("owner_id", user.id)
    .eq("friend_user_id", friendId);

  if (error) {
    req.log.error({ err: error }, "Failed to remove close friend");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(204).send();
});

export default router;
