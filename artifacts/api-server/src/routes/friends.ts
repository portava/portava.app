import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import {
  decideSendRequest,
  decideAcceptRequest,
  decideDeclineRequest,
  decideCancelRequest,
  normalizedFriendshipPair,
  isUuid,
} from "../lib/friendDecisions";
import { getServiceClient } from "../lib/supabase";
import { syncCircleChatMembers } from "../lib/chatSync";

const router = Router();

const PROFILE_PUBLIC = "id, handle, name, avatar_url";

async function getRequest(sc: any, requestId: string) {
  return sc
    .from("friend_requests")
    .select("id, requester_id, recipient_id, status")
    .eq("id", requestId)
    .maybeSingle();
}

/* ===========================================================================
 * POST /users/:userId/friend-request  — send (or ensure pending) request
 * ===========================================================================
 * Privacy guarantee: writes ONLY to friend_requests + user_friendships.
 * Never touches circle_memberships, trip_members, live_location, or visibility.
 */
router.post("/users/:userId/friend-request", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const recipientId = req.params.userId;

  if (!isUuid(recipientId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const decision = decideSendRequest(user.id, recipientId);
  if (!decision.ok) { sendError(res, "invalid_payload", decision.reason); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: profile } = await sc.from("profiles").select("id").eq("id", recipientId).maybeSingle();
  if (!profile) { sendError(res, "not_found", "User not found"); return; }

  // Check for an existing request in this direction
  const { data: existing } = await sc
    .from("friend_requests")
    .select("id, status")
    .eq("requester_id", user.id)
    .eq("recipient_id", recipientId)
    .maybeSingle();

  if (existing) {
    if (existing.status === "pending") {
      res.status(200).json({ requestId: existing.id, status: "outgoing_pending", idempotent: true });
      return;
    }
    if (existing.status === "accepted") {
      res.status(200).json({ requestId: existing.id, status: "friends" });
      return;
    }
    // Re-activate declined/cancelled
    const now = new Date().toISOString();
    await sc.from("friend_requests")
      .update({ status: "pending", responded_at: null, updated_at: now })
      .eq("id", existing.id);
    res.status(200).json({ requestId: existing.id, status: "outgoing_pending", reactivated: true });
    return;
  }

  // Check if target already sent us a request → auto-accept both sides
  const { data: incoming } = await sc
    .from("friend_requests")
    .select("id")
    .eq("requester_id", recipientId)
    .eq("recipient_id", user.id)
    .eq("status", "pending")
    .maybeSingle();

  if (incoming) {
    const now = new Date().toISOString();
    await sc.from("friend_requests")
      .update({ status: "accepted", responded_at: now, updated_at: now })
      .eq("id", incoming.id);
    const [ua, ub] = normalizedFriendshipPair(user.id, recipientId);
    await sc.from("user_friendships")
      .upsert({ user_a: ua, user_b: ub, accepted_request_id: incoming.id, created_at: now });
    res.status(200).json({ requestId: incoming.id, status: "friends", autoAccepted: true });
    return;
  }

  const { data: newReq, error } = await sc
    .from("friend_requests")
    .insert({ requester_id: user.id, recipient_id: recipientId })
    .select("id")
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to create friend request");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(201).json({ requestId: (newReq as any).id, status: "outgoing_pending" });
});

/* ===========================================================================
 * POST /friend-requests/:requestId/accept
 * ===========================================================================
 * Only the recipient may call this. Creates the user_friendships row.
 * DOES NOT create circle_memberships or trip_members.
 */
router.post("/friend-requests/:requestId/accept", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { requestId } = req.params;
  if (!isUuid(requestId)) { sendError(res, "invalid_payload", "Invalid request id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: fr } = await getRequest(sc, requestId);
  if (!fr) { sendError(res, "not_found", "Friend request not found"); return; }
  if (fr.status !== "pending") { sendError(res, "invalid_payload", `Request is already ${fr.status}`); return; }

  const decision = decideAcceptRequest(user.id, fr.recipient_id);
  if (!decision.ok) { sendError(res, "forbidden", decision.reason); return; }

  const now = new Date().toISOString();
  await sc.from("friend_requests")
    .update({ status: "accepted", responded_at: now, updated_at: now })
    .eq("id", requestId);

  const [ua, ub] = normalizedFriendshipPair(fr.requester_id, fr.recipient_id);
  await sc.from("user_friendships")
    .upsert({ user_a: ua, user_b: ub, accepted_request_id: requestId, created_at: now });

  res.status(200).json({ status: "friends", requestId });
});

/* ===========================================================================
 * POST /friend-requests/:requestId/decline
 * ===========================================================================
 */
router.post("/friend-requests/:requestId/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { requestId } = req.params;
  if (!isUuid(requestId)) { sendError(res, "invalid_payload", "Invalid request id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: fr } = await getRequest(sc, requestId);
  if (!fr) { sendError(res, "not_found", "Friend request not found"); return; }
  if (fr.status !== "pending") { sendError(res, "invalid_payload", `Request is already ${fr.status}`); return; }

  const decision = decideDeclineRequest(user.id, fr.recipient_id);
  if (!decision.ok) { sendError(res, "forbidden", decision.reason); return; }

  const now = new Date().toISOString();
  await sc.from("friend_requests")
    .update({ status: "declined", responded_at: now, updated_at: now })
    .eq("id", requestId);

  res.status(200).json({ status: "declined", requestId });
});

/* ===========================================================================
 * POST /friend-requests/:requestId/cancel
 * ===========================================================================
 */
router.post("/friend-requests/:requestId/cancel", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { requestId } = req.params;
  if (!isUuid(requestId)) { sendError(res, "invalid_payload", "Invalid request id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: fr } = await getRequest(sc, requestId);
  if (!fr) { sendError(res, "not_found", "Friend request not found"); return; }
  if (fr.status !== "pending") { sendError(res, "invalid_payload", `Request is already ${fr.status}`); return; }

  const decision = decideCancelRequest(user.id, fr.requester_id);
  if (!decision.ok) { sendError(res, "forbidden", decision.reason); return; }

  const now = new Date().toISOString();
  await sc.from("friend_requests")
    .update({ status: "cancelled", updated_at: now })
    .eq("id", requestId);

  res.status(200).json({ status: "cancelled", requestId });
});

/* ===========================================================================
 * GET /me/friend-requests/incoming
 * ===========================================================================
 */
router.get("/me/friend-requests/incoming", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("friend_requests")
    .select("id, status, created_at, requester_id")
    .eq("recipient_id", user.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) { req.log.error({ err: error }, "incoming requests query failed"); sendError(res, "db_error", error.message); return; }

  const requesterIds = [...new Set((data ?? []).map((r: any) => r.requester_id))];
  let profileMap: Record<string, any> = {};
  if (requesterIds.length > 0) {
    const { data: profiles } = await sc.from("profiles").select(PROFILE_PUBLIC).in("id", requesterIds);
    for (const p of profiles ?? []) profileMap[p.id] = p;
  }

  const requests = (data ?? []).map((r: any) => {
    const p = profileMap[r.requester_id];
    return {
      requestId: r.id,
      status: r.status,
      createdAt: r.created_at,
      user: p ? { id: p.id, handle: p.handle, name: p.name, avatarUrl: p.avatar_url ?? null } : null,
    };
  });

  res.status(200).json({ requests });
});

/* ===========================================================================
 * GET /me/friend-requests/outgoing
 * ===========================================================================
 */
router.get("/me/friend-requests/outgoing", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("friend_requests")
    .select("id, status, created_at, recipient_id")
    .eq("requester_id", user.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) { req.log.error({ err: error }, "outgoing requests query failed"); sendError(res, "db_error", error.message); return; }

  const recipientIds = [...new Set((data ?? []).map((r: any) => r.recipient_id))];
  let profileMap: Record<string, any> = {};
  if (recipientIds.length > 0) {
    const { data: profiles } = await sc.from("profiles").select(PROFILE_PUBLIC).in("id", recipientIds);
    for (const p of profiles ?? []) profileMap[p.id] = p;
  }

  const requests = (data ?? []).map((r: any) => {
    const p = profileMap[r.recipient_id];
    return {
      requestId: r.id,
      status: r.status,
      createdAt: r.created_at,
      user: p ? { id: p.id, handle: p.handle, name: p.name, avatarUrl: p.avatar_url ?? null } : null,
    };
  });

  res.status(200).json({ requests });
});

/* ===========================================================================
 * GET /me/friends
 * ===========================================================================
 */
router.get("/me/friends", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const [{ data: asA }, { data: asB }] = await Promise.all([
    sc.from("user_friendships").select("user_b, created_at").eq("user_a", user.id),
    sc.from("user_friendships").select("user_a, created_at").eq("user_b", user.id),
  ]);

  const entries = [
    ...(asA ?? []).map((r: any) => ({ friendId: r.user_b, since: r.created_at })),
    ...(asB ?? []).map((r: any) => ({ friendId: r.user_a, since: r.created_at })),
  ];

  const friendIds = entries.map((e) => e.friendId);
  let profileMap: Record<string, any> = {};
  if (friendIds.length > 0) {
    const { data: profiles } = await sc.from("profiles").select(PROFILE_PUBLIC).in("id", friendIds);
    for (const p of profiles ?? []) profileMap[p.id] = p;
  }

  const friends = entries
    .map((e) => {
      const p = profileMap[e.friendId];
      return p ? { id: p.id, handle: p.handle, name: p.name, avatarUrl: p.avatar_url ?? null, since: e.since } : null;
    })
    .filter(Boolean);

  res.status(200).json({ friends });
});

/* ===========================================================================
 * GET /circles/:circleOwnerId/members  — list circle members (for invite picker)
 * ===========================================================================
 * Returns profiles of all circle members, excluding the caller.
 * Caller must be the owner or a member of this circle.
 */
router.get("/circles/:circleOwnerId/members", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { circleOwnerId } = req.params;
  if (!isUuid(circleOwnerId)) { sendError(res, "invalid_payload", "Invalid circle owner id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const isOwner = user.id === circleOwnerId;
  if (!isOwner) {
    const { data: mem } = await sc
      .from("circle_memberships")
      .select("member_id")
      .eq("owner_id", circleOwnerId)
      .eq("member_id", user.id)
      .maybeSingle();
    if (!mem) { sendError(res, "forbidden", "Not a circle member"); return; }
  }

  const { data: memberships } = await sc
    .from("circle_memberships")
    .select("member_id")
    .eq("owner_id", circleOwnerId);

  const memberIds = (memberships ?? [])
    .map((m: any) => m.member_id as string)
    .concat(!isOwner ? [circleOwnerId] : [])
    .filter((id) => id !== user.id);

  if (memberIds.length === 0) { res.status(200).json({ members: [] }); return; }

  const { data: profiles } = await sc
    .from("profiles")
    .select("id, handle, name, avatar_url")
    .in("id", memberIds);

  res.status(200).json({
    members: (profiles ?? []).map((p: any) => ({
      id: p.id as string,
      handle: p.handle as string,
      name: p.name as string,
      avatarUrl: (p.avatar_url as string | null) ?? null,
    })),
  });
});

/* ===========================================================================
 * GET /users/:userId/friend-status
 * ===========================================================================
 * Returns: none | outgoing_pending | incoming_pending | friends | self
 * requestId is included when status is *_pending (needed for accept/decline/cancel).
 */
router.get("/users/:userId/friend-status", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const targetId = req.params.userId;

  if (!isUuid(targetId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  if (user.id === targetId) {
    res.status(200).json({ userId: targetId, status: "self" });
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Active friendship?
  const [ua, ub] = normalizedFriendshipPair(user.id, targetId);
  const { data: friendship } = await sc
    .from("user_friendships").select("user_a").eq("user_a", ua).eq("user_b", ub).maybeSingle();

  if (friendship) {
    res.status(200).json({ userId: targetId, status: "friends" });
    return;
  }

  // Outgoing pending?
  const { data: outgoing } = await sc
    .from("friend_requests").select("id")
    .eq("requester_id", user.id).eq("recipient_id", targetId).eq("status", "pending").maybeSingle();

  if (outgoing) {
    res.status(200).json({ userId: targetId, status: "outgoing_pending", requestId: (outgoing as any).id });
    return;
  }

  // Incoming pending?
  const { data: incomingReq } = await sc
    .from("friend_requests").select("id")
    .eq("requester_id", targetId).eq("recipient_id", user.id).eq("status", "pending").maybeSingle();

  if (incomingReq) {
    res.status(200).json({ userId: targetId, status: "incoming_pending", requestId: (incomingReq as any).id });
    return;
  }

  res.status(200).json({ userId: targetId, status: "none" });
});

/* ===========================================================================
 * POST /circle-invites  — invite someone to your trusted circle
 * ===========================================================================
 * Friendship makes inviting easier — but acceptance is the ONLY mechanism
 * that writes a circle_memberships row. This endpoint never does that.
 */
router.post("/circle-invites", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const recipientId = req.body?.recipientId;
  if (!recipientId || !isUuid(recipientId)) { sendError(res, "invalid_payload", "recipientId must be a valid UUID"); return; }
  if (recipientId === user.id) { sendError(res, "invalid_payload", "You cannot invite yourself to your circle"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc
    .from("circle_invites").select("id, status")
    .eq("owner_id", user.id).eq("recipient_id", recipientId).maybeSingle();

  if (existing) {
    const s = (existing as any).status;
    if (s === "pending") { res.status(200).json({ inviteId: (existing as any).id, status: "pending", idempotent: true }); return; }
    if (s === "accepted") { res.status(200).json({ inviteId: (existing as any).id, status: "accepted" }); return; }
    const now = new Date().toISOString();
    await sc.from("circle_invites").update({ status: "pending", responded_at: null }).eq("id", (existing as any).id);
    res.status(200).json({ inviteId: (existing as any).id, status: "pending", reactivated: true });
    return;
  }

  const { data: invite, error } = await sc
    .from("circle_invites")
    .insert({ owner_id: user.id, recipient_id: recipientId })
    .select("id").single();

  if (error) { req.log.error({ err: error }, "circle_invites insert failed"); sendError(res, "db_error", error.message); return; }
  res.status(201).json({ inviteId: (invite as any).id, status: "pending" });
});

/* ===========================================================================
 * POST /circle-invites/:inviteId/accept
 * ===========================================================================
 * THIS IS THE ONLY PLACE that creates a circle_memberships row.
 * Friendship alone never does this.
 */
router.post("/circle-invites/:inviteId/accept", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { inviteId } = req.params;
  if (!isUuid(inviteId)) { sendError(res, "invalid_payload", "Invalid invite id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: inv } = await sc
    .from("circle_invites").select("id, owner_id, recipient_id, status")
    .eq("id", inviteId).maybeSingle();

  if (!inv) { sendError(res, "not_found", "Circle invite not found"); return; }
  if ((inv as any).recipient_id !== user.id) { sendError(res, "forbidden", "Only the recipient can accept this invite"); return; }
  if ((inv as any).status !== "pending") { sendError(res, "invalid_payload", `Invite is already ${(inv as any).status}`); return; }

  const now = new Date().toISOString();
  await sc.from("circle_invites").update({ status: "accepted", responded_at: now }).eq("id", inviteId);

  // Explicit membership creation — the ONLY path that writes to circle_memberships.
  const { error: cmErr } = await sc
    .from("circle_memberships")
    .upsert({ owner_id: (inv as any).owner_id, member_id: user.id, created_at: now });

  if (cmErr) req.log.error({ err: cmErr }, "circle_memberships upsert failed after invite accept");

  // Fire-and-forget: sync group chat membership for this circle.
  syncCircleChatMembers((inv as any).owner_id, sc).catch((e) => req.log.error({ err: e }, "syncCircleChatMembers failed"));

  res.status(200).json({ status: "accepted", ownerId: (inv as any).owner_id });
});

/* ===========================================================================
 * POST /circle-invites/:inviteId/decline
 * ===========================================================================
 */
router.post("/circle-invites/:inviteId/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { inviteId } = req.params;
  if (!isUuid(inviteId)) { sendError(res, "invalid_payload", "Invalid invite id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: inv } = await sc
    .from("circle_invites").select("id, recipient_id, status")
    .eq("id", inviteId).maybeSingle();

  if (!inv) { sendError(res, "not_found", "Circle invite not found"); return; }
  if ((inv as any).recipient_id !== user.id) { sendError(res, "forbidden", "Only the recipient can decline this invite"); return; }
  if ((inv as any).status !== "pending") { sendError(res, "invalid_payload", `Invite is already ${(inv as any).status}`); return; }

  const now = new Date().toISOString();
  await sc.from("circle_invites").update({ status: "declined", responded_at: now }).eq("id", inviteId);

  res.status(200).json({ status: "declined" });
});

/* ===========================================================================
 * DELETE /circles/:circleOwnerId/members/:memberId
 * Only the circle owner may remove an accepted member.
 * Immediately sets left_at on the member's chat thread row via sync.
 * ===========================================================================
 */
router.delete("/circles/:circleOwnerId/members/:memberId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { circleOwnerId, memberId } = req.params;
  if (!isUuid(circleOwnerId)) { sendError(res, "invalid_payload", "Invalid circleOwnerId"); return; }
  if (!isUuid(memberId)) { sendError(res, "invalid_payload", "Invalid memberId"); return; }

  if (user.id !== circleOwnerId) {
    sendError(res, "forbidden", "Only the circle owner may remove members"); return;
  }
  if (memberId === circleOwnerId) {
    sendError(res, "invalid_payload", "Cannot remove yourself from your own circle"); return;
  }

  const { data: membership } = await sc
    .from("circle_memberships")
    .select("member_id")
    .eq("owner_id", circleOwnerId)
    .eq("member_id", memberId)
    .maybeSingle();

  if (!membership) { sendError(res, "not_found", "Membership not found"); return; }

  await sc.from("circle_memberships").delete().eq("owner_id", circleOwnerId).eq("member_id", memberId);

  res.status(200).json({ status: "removed", memberId });

  // Immediately revoke chat access by syncing — sets left_at for the removed member.
  syncCircleChatMembers(circleOwnerId, sc).catch(() => {});
});

export default router;
