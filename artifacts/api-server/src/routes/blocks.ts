import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { publishToUsers } from "../lib/telegraphEvents";
import { invalidateCompassProfile } from "../compass/CompassProfileService.js";

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

  // Idempotent: upsert the block row
  const { error: blockErr } = await client
    .from("blocks")
    .upsert({ blocker_id: user.id, blocked_id: target }, { onConflict: "blocker_id,blocked_id", ignoreDuplicates: true });

  if (blockErr) {
    req.log.error({ err: blockErr }, "Failed to insert block");
    sendError(res, "db_error", blockErr.message);
    return;
  }

  // Remove all follow edges between the two users (both directions) — fire-and-forget errors
  await Promise.all([
    client.from("user_follows").delete().eq("follower_id", user.id).eq("following_id", target),
    client.from("user_follows").delete().eq("follower_id", target).eq("following_id", user.id),
    // Also remove any pending friend requests between them
    client.from("friend_requests").delete()
      .or(`and(from_user.eq.${user.id},to_user.eq.${target}),and(from_user.eq.${target},to_user.eq.${user.id})`),
    // Remove friendship if it exists
    client.from("user_friendships").delete()
      .or(`and(user_a.eq.${user.id},user_b.eq.${target}),and(user_a.eq.${target},user_b.eq.${user.id})`),
  ]).catch((e) => req.log.warn({ err: e }, "cleanup after block partially failed"));

  res.status(200).json({ blocked: true, userId: target });

  // Evict Compass profile cache for both parties — block changes affect signals immediately.
  invalidateCompassProfile(user.id);
  invalidateCompassProfile(target);

  // Realtime: let the blocker's other sessions refresh (threads/follow state
  // may have changed). Not sent to the blocked user.
  void publishToUsers([user.id], {
    type: "user.blocked",
    payload: { blockedId: target },
  });
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

  res.status(200).json({
    blocked: (rows ?? []).map((r: any) => {
      const p = profileMap[r.blocked_id] ?? {};
      return {
        id: r.blocked_id as string,
        handle: (p.handle as string) ?? null,
        name: (p.name as string) ?? null,
        avatarUrl: (p.avatar_url as string | null) ?? null,
        blockedAt: r.created_at as string,
      };
    }),
  });
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

  res.status(200).json({
    userId: target,
    iBlocked: Boolean(iBlocked.data),
    theyBlockedMe: Boolean(theyBlocked.data),
  });
});

export default router;
