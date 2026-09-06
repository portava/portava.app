import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { publishToUsers, terminateUserConnections } from "../lib/telegraphEvents";
import { getServiceClient } from "../lib/supabase.js";
import { invalidateCompassProfile } from "../compass/CompassProfileService.js";
import { invalidate as invalidateCompassCache } from "../compass/CompassCacheEngine.js";
import { invalidateCompassHomeCache } from "./compassHome.js";
import { resolveInteractionPermissions } from "../services/interactionPermissions.js";
import { nameVisibilitySet, presentedName } from "../lib/publicIdentity.js";
import { _clearMediaAccessCache } from "../lib/mediaAccess.js";

const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

/* ===========================================================================
 * POST /users/:userId/block  — block a user
 * ===========================================================================
 * Inserts a block row, then removes all follow edges between the two users.
 * Idempotent: blocking someone already blocked returns 200.
 */
router.post("/users/:userId/block", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const target = req.params.userId;
  if (!UUID.test(target)) { sendError(res, "invalid_payload", "Invalid user id"); return; }
  if (target === user.id) { sendError(res, "invalid_payload", "You cannot block yourself"); return; }

  // Permission engine — enforces suspension gate (suspended users cannot block)
  try {
    const perms = await resolveInteractionPermissions(client, user.id, target);
    if (!perms.canBlock) {
      sendError(res, "forbidden", "Cannot block this user");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for block");
    sendError(res, "db_error", "Permission check failed", { exposeDetail: true });
    return;
  }

  // Idempotent: upsert the block row
  const { error: blockErr } = await client
    .from("blocks")
    .upsert({ blocker_id: user.id, blocked_id: target }, { onConflict: "blocker_id,blocked_id", ignoreDuplicates: true });

  if (blockErr) {
    req.log.error({ err: blockErr }, "Failed to insert block");
    sendError(res, "db_error", blockErr.message);
    return;
  }

  // Remove all social edges between the two users — fire-and-forget errors
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  await Promise.all([
    // Follow edges (both directions)
    client.from("user_follows").delete().eq("follower_id", user.id).eq("following_id", target),
    client.from("user_follows").delete().eq("follower_id", target).eq("following_id", user.id),
    // Pending friend requests (both directions) — uses correct column names
    client.from("friend_requests").delete()
      .or(`and(requester_id.eq.${user.id},recipient_id.eq.${target}),and(requester_id.eq.${target},recipient_id.eq.${user.id})`),
    // Active friendship row
    client.from("user_friendships").delete()
      .or(`and(user_a.eq.${user.id},user_b.eq.${target}),and(user_a.eq.${target},user_b.eq.${user.id})`),
    // Cancel pending message requests (both directions) — prevents post-block inbox spam
    client.from("message_requests").update({ status: "cancelled", updated_at: now })
      .eq("sender_id", target).eq("recipient_id", user.id).eq("status", "pending"),
    client.from("message_requests").update({ status: "cancelled", updated_at: now })
      .eq("sender_id", user.id).eq("recipient_id", target).eq("status", "pending"),
  ]).catch((e) => req.log.warn({ err: e }, "cleanup after block partially failed"));

  // Anti-retaliation cooldowns: prevent blocked user from re-requesting for 90 days
  // (uses client which is already the service-role client, available before sc is declared below)
  const expiresAt = new Date(nowMs + 90 * 24 * 60 * 60 * 1000).toISOString();
  await client.from("user_interaction_cooldowns").upsert([
    { user_id: target, target_user_id: user.id, cooldown_type: "message_request", expires_at: expiresAt },
    { user_id: target, target_user_id: user.id, cooldown_type: "friend_request",  expires_at: expiresAt },
    { user_id: target, target_user_id: user.id, cooldown_type: "follow",          expires_at: expiresAt },
  ], { onConflict: "user_id,target_user_id,cooldown_type" }).then(undefined, () => {});

  // Evict Compass profile + feed cache for both parties — must complete before response
  // so clients immediately see consistent state on next request.
  invalidateCompassProfile(user.id);
  invalidateCompassProfile(target);
  invalidateCompassHomeCache(user.id);
  invalidateCompassHomeCache(target);
  const sc = getServiceClient ? getServiceClient() : null;
  await Promise.allSettled([
    invalidateCompassCache(sc, user.id, "block"),
    invalidateCompassCache(sc, target, "blocked_by"),
  ]);

  // Evict the per-(viewer,object) media-access allow-cache for both parties so
  // neither side retains a stale "allowed" entry for the other's media.
  _clearMediaAccessCache();

  res.status(200).json({ blocked: true, userId: target });

  // Realtime: let the blocker's other sessions refresh (threads/follow state
  // may have changed). Not sent to the blocked user.
  void publishToUsers([user.id], {
    type: "user.blocked",
    payload: { blockedId: target },
  });

  // Force-close any live SSE connections for the blocked user so they cannot
  // continue to receive events from the blocker's session.  Runs after the
  // response is sent — best-effort, non-blocking.
  terminateUserConnections(target);

  // Blocking mid-call force-ends any open direct call between the two users
  // (server-side room termination + call.ended to both). Fire-and-forget.
  if (sc) {
    void (async () => {
      try {
        const { livekitEnvStatus, makeRoomAdmin, readLivekitEnv } = await import("../lib/calls/livekitService.js");
        if (!livekitEnvStatus().ok) return;
        const { forceEndDirectCallsBetween } = await import("../lib/calls/callSignaling.js");
        await forceEndDirectCallsBetween(sc, makeRoomAdmin(readLivekitEnv()), user.id, target);
      } catch (err) {
        req.log.warn({ err }, "force-end calls after block failed (non-critical)");
      }
    })();
  }
});

/* ===========================================================================
 * DELETE /users/:userId/block  — unblock a user
 * ===========================================================================
 */
router.delete("/users/:userId/block", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const target = req.params.userId;
  if (!UUID.test(target)) { sendError(res, "invalid_payload", "Invalid user id"); return; }
  if (target === user.id) { sendError(res, "invalid_payload", "Invalid request"); return; }

  // Permission engine — canUnblock is true when viewer is the blocker (iBlocked=true);
  // false when viewer never blocked (no-op anyway) or when viewer account is in a terminal state.
  // Uses client (JWT) client since blocks table RLS is viewer-scoped.
  try {
    const perms = await resolveInteractionPermissions(client, user.id, target);
    if (!perms.canUnblock) {
      sendError(res, "forbidden", "Cannot remove this block");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for block delete");
    sendError(res, "db_error", "Permission check failed", { exposeDetail: true });
    return;
  }

  const { error } = await client
    .from("blocks")
    .delete()
    .eq("blocker_id", user.id)
    .eq("blocked_id", target);

  if (error) {
    req.log.error({ err: error }, "Failed to delete block");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ blocked: false, userId: target });

  // Evict Compass profile cache for both parties — unblock changes block signals immediately.
  invalidateCompassProfile(user.id);
  invalidateCompassProfile(target);
  invalidateCompassHomeCache(user.id);
  invalidateCompassHomeCache(target);
});

/* ===========================================================================
 * GET /me/blocks  — list users I have blocked
 * ===========================================================================
 * Returns id, handle, name, avatarUrl for each blocked user.
 */
router.get("/me/blocks", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { data: rows, error } = await client
    .from("blocks")
    .select("blocked_id, created_at")
    .eq("blocker_id", user.id)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    req.log.error({ err: error }, "Failed to fetch block list");
    sendError(res, "db_error", error.message);
    return;
  }

  const ids = (rows ?? []).map((r: any) => r.blocked_id as string);
  if (ids.length === 0) { res.status(200).json({ blocked: [] }); return; }

  const { data: profiles, error: profErr } = await client
    .from("profiles")
    .select("id, handle, name, avatar_url")
    .in("id", ids);

  if (profErr) {
    req.log.error({ err: profErr }, "Failed to fetch blocked profiles");
    sendError(res, "db_error", profErr.message);
    return;
  }

  const profileMap: Record<string, any> = {};
  for (const p of profiles ?? []) profileMap[(p as any).id] = p;

  const allowedNames = await nameVisibilitySet(client, ids);

  res.status(200).json({
    blocked: (rows ?? []).map((r: any) => {
      const p = profileMap[r.blocked_id] ?? {};
      return {
        id: r.blocked_id as string,
        handle: (p.handle as string) ?? null,
        name: presentedName(p, r.blocked_id === user.id || allowedNames.has(r.blocked_id as string)),
        avatarUrl: (p.avatar_url as string | null) ?? null,
        blockedAt: r.created_at as string,
      };
    }),
  });
});

/* ===========================================================================
 * GET /me/blocker-ids  — IDs of users who have blocked me (privacy-safe, IDs only)
 * ===========================================================================
 * Used by the client BlockedIdsContext to suppress navigation to profiles that
 * have blocked the viewer — guards the "they blocked me" direction in addition
 * to the "I blocked them" direction already tracked by /me/blocks.
 */
router.get("/me/blocker-ids", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { data: rows, error } = await client
    .from("blocks")
    .select("blocker_id")
    .eq("blocked_id", user.id)
    .limit(500);

  if (error) {
    req.log.error({ err: error }, "Failed to fetch blocker-ids");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ ids: (rows ?? []).map((r: any) => r.blocker_id as string) });
});

/* ===========================================================================
 * GET /users/:userId/block-status  — am I blocking or blocked by this user?
 * ===========================================================================
 */
router.get("/users/:userId/block-status", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const target = req.params.userId;
  if (!UUID.test(target)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const [iBlocked, theyBlocked] = await Promise.all([
    client.from("blocks").select("blocked_id").eq("blocker_id", user.id).eq("blocked_id", target).maybeSingle(),
    client.from("blocks").select("blocked_id").eq("blocker_id", target).eq("blocked_id", user.id).maybeSingle(),
  ]);

  // Reading only `.data` reported a confident "not blocked, not blocked by" for
  // BOTH fields during an outage — supabase-js RESOLVES with `{ data: null,
  // error }` — and clients gate "can I message / see this person" on exactly
  // this answer. Say we don't know rather than say no.
  if (iBlocked.error || theyBlocked.error) {
    req.log.error(
      { err: iBlocked.error ?? theyBlocked.error, targetId: target },
      "block-status read failed",
    );
    sendError(res, "db_error", "Block status could not be determined");
    return;
  }

  res.status(200).json({
    userId: target,
    iBlocked: Boolean(iBlocked.data),
    theyBlockedMe: Boolean(theyBlocked.data),
  });
});

export default router;
