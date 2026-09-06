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
import { resolveInteractionPermissions } from "../services/interactionPermissions";
import { nameVisibilitySet, sanitizeIdentity } from "../lib/publicIdentity";
import { linkOutcomeSignal } from "../compass/CompassOutcomeEngine";

// NOTE (Section A table-name audit, 2026-07-20): the product spec is
// follow-only (no friends system) and the original plan called for removing
// these routes. However, the live database DOES contain the
// `user_friendships` and `friend_requests` tables (verified against the
// production schema), so these routes are functional — only the
// `friend_connections` table referenced elsewhere was an orphan (repointed in
// passportStamps.ts). Decision recorded: KEEP the friends system for now.
// TODO: friends system not in spec — if it is dropped, unregister this router
// in routes/index.ts and remove user_friendships/friend_requests references
// across the codebase.
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

  // Permission engine — fail-closed block + restriction gate before any DB write
  try {
    const perms = await resolveInteractionPermissions(sc, user.id, recipientId);
    // Mutual-pending case: the target already sent us a pending request.
    // canAddFriend is false then (hasIncomingFriendReq), but sending a request
    // back should auto-accept — canAcceptFriendRequest covers exactly that case
    // (incoming pending + viewer not suspended; blocked users hit the ALL_FALSE
    // early return so both flags are false).
    if (!perms.canAddFriend && !perms.canAcceptFriendRequest) {
      const isBlocked = perms.reasonCodes.includes("blocked");
      sendError(res, isBlocked ? "forbidden" : "invalid_payload",
        isBlocked ? "Cannot send a friend request to this user" : "Friend request not allowed");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for friend request");
    sendError(res, "db_error", "Permission check failed", { exposeDetail: true });
    return;
  }

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
    const { error: reactivateErr } = await sc.from("friend_requests")
      .update({ status: "pending", responded_at: null, updated_at: now })
      .eq("id", existing.id);
    if (reactivateErr) {
      req.log.error({ err: reactivateErr }, "friend request reactivation update failed");
      sendError(res, "db_error", reactivateErr.message);
      return;
    }
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
    const { error: autoAcceptErr } = await sc.from("friend_requests")
      .update({ status: "accepted", responded_at: now, updated_at: now })
      .eq("id", incoming.id);
    if (autoAcceptErr) {
      req.log.error({ err: autoAcceptErr }, "friend request auto-accept update failed");
      sendError(res, "db_error", autoAcceptErr.message);
      return;
    }
    const [ua, ub] = normalizedFriendshipPair(user.id, recipientId);
    // Half-committed recovery: request is already accepted; the upsert is
    // idempotent on the normalized pair, so surfacing db_error lets a retry
    // (or a later accept path) safely re-create the friendship row.
    const { error: autoFriendshipErr } = await sc.from("user_friendships")
      .upsert({ user_a: ua, user_b: ub, accepted_request_id: incoming.id, created_at: now });
    if (autoFriendshipErr) {
      req.log.error({ err: autoFriendshipErr }, "user_friendships upsert failed after auto-accept");
      sendError(res, "db_error", autoFriendshipErr.message);
      return;
    }
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

  // Permission engine — suspended recipient cannot accept requests
  try {
    const perms = await resolveInteractionPermissions(sc, user.id, fr.requester_id);
    if (!perms.canAcceptFriendRequest) {
      sendError(res, "forbidden", "Cannot accept this friend request");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for friend request accept");
    sendError(res, "db_error", "Permission check failed", { exposeDetail: true });
    return;
  }

  const now = new Date().toISOString();
  const { error: acceptErr } = await sc.from("friend_requests")
    .update({ status: "accepted", responded_at: now, updated_at: now })
    .eq("id", requestId);
  if (acceptErr) {
    req.log.error({ err: acceptErr }, "friend request accept update failed");
    sendError(res, "db_error", acceptErr.message);
    return;
  }

  const [ua, ub] = normalizedFriendshipPair(fr.requester_id, fr.recipient_id);
  // Half-committed recovery: request is already accepted; the upsert is
  // idempotent on the normalized pair, so surfacing db_error lets a retry
  // safely re-create the friendship row.
  const { error: friendshipErr } = await sc.from("user_friendships")
    .upsert({ user_a: ua, user_b: ub, accepted_request_id: requestId, created_at: now });
  if (friendshipErr) {
    req.log.error({ err: friendshipErr }, "user_friendships upsert failed after accept");
    sendError(res, "db_error", friendshipErr.message);
    return;
  }

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

  // Permission engine — suspended recipient cannot decline requests
  try {
    const perms = await resolveInteractionPermissions(sc, user.id, fr.requester_id);
    if (!perms.canDeclineFriendRequest) {
      sendError(res, "forbidden", "Cannot decline this friend request");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for friend request decline");
    sendError(res, "db_error", "Permission check failed", { exposeDetail: true });
    return;
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const { error: declineErr } = await sc.from("friend_requests")
    .update({ status: "declined", responded_at: now, updated_at: now })
    .eq("id", requestId);
  if (declineErr) {
    req.log.error({ err: declineErr }, "friend request decline update failed");
    sendError(res, "db_error", declineErr.message);
    return;
  }

  // Anti-retaliation cooldown: requester cannot re-send for 24 hours after a decline
  const cooldownExpiry = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
  await sc.from("user_interaction_cooldowns").upsert({
    user_id:        fr.requester_id,
    target_user_id: user.id,
    cooldown_type:  "friend_request",
    expires_at:     cooldownExpiry,
  }, { onConflict: "user_id,target_user_id,cooldown_type" }).then(undefined, () => {});

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

  // Permission engine — suspended requester cannot cancel (edge case safety)
  try {
    const perms = await resolveInteractionPermissions(sc, user.id, fr.recipient_id);
    if (!perms.canCancelFriendRequest) {
      sendError(res, "forbidden", "Cannot cancel this friend request");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for friend request cancel");
    sendError(res, "db_error", "Permission check failed", { exposeDetail: true });
    return;
  }

  const now = new Date().toISOString();
  const { error: cancelErr } = await sc.from("friend_requests")
    .update({ status: "cancelled", updated_at: now })
    .eq("id", requestId);
  if (cancelErr) {
    req.log.error({ err: cancelErr }, "friend request cancel update failed");
    sendError(res, "db_error", cancelErr.message);
    return;
  }

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
    const allowedNames = await nameVisibilitySet(sc, requesterIds);
    for (const p of profiles ?? []) profileMap[p.id] = sanitizeIdentity(p as any, allowedNames, user.id);
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
    const allowedNames = await nameVisibilitySet(sc, recipientIds);
    for (const p of profiles ?? []) profileMap[p.id] = sanitizeIdentity(p as any, allowedNames, user.id);
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
    const allowedNames = await nameVisibilitySet(sc, friendIds);
    for (const p of profiles ?? []) profileMap[p.id] = sanitizeIdentity(p as any, allowedNames, user.id);
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
      .select("other_id")
      .eq("user_id", circleOwnerId)
      .eq("other_id", user.id)
      .maybeSingle();
    if (!mem) { sendError(res, "forbidden", "Not a circle member"); return; }
  }

  const { data: memberships, error: memErr } = await sc
    .from("circle_memberships")
    .select("other_id")
    .eq("user_id", circleOwnerId);

  if (memErr) { sendError(res, "db_error", memErr.message); return; }

  const memberIds = (memberships ?? [])
    .map((m: any) => m.other_id as string)
    .concat(!isOwner ? [circleOwnerId] : [])
    .filter((id) => id !== user.id);

  if (memberIds.length === 0) { res.status(200).json({ members: [] }); return; }

  const { data: profiles, error: profErr } = await sc
    .from("profiles")
    .select("id, handle, name, avatar_url")
    .in("id", memberIds);

  if (profErr) { sendError(res, "db_error", profErr.message); return; }

  const allowedNames = await nameVisibilitySet(sc, memberIds);

  res.status(200).json({
    members: (profiles ?? []).map((p: any) => {
      const s = sanitizeIdentity(p as any, allowedNames, user.id);
      return {
        id: s.id as string,
        handle: s.handle as string,
        name: s.name as string,
        avatarUrl: (s.avatar_url as string | null) ?? null,
      };
    }),
  });
});

/* ===========================================================================
 * GET /circles/:circleOwnerId/invitable-users  — grouped invite picker data
 * ===========================================================================
 * Returns circle members (groupMembers) + caller's friends not in the circle
 * (otherFollowers). Caller must be the circle owner or a circle member.
 */
router.get("/circles/:circleOwnerId/invitable-users", async (req, res) => {
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
      .from("circle_memberships").select("other_id")
      .eq("user_id", circleOwnerId).eq("other_id", user.id).maybeSingle();
    if (!mem) { sendError(res, "forbidden", "Not a circle member"); return; }
  }

  const [{ data: memberships }, { data: friendsAsA }, { data: friendsAsB }, blockResult] = await Promise.all([
    sc.from("circle_memberships").select("other_id").eq("user_id", circleOwnerId),
    sc.from("user_friendships").select("user_b").eq("user_a", user.id),
    sc.from("user_friendships").select("user_a").eq("user_b", user.id),
    sc.from("blocks").select("blocker_id, blocked_id").or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`),
  ]);

  // FAIL CLOSED: `blockResult.data ?? []` read a PostgREST error as "nobody is
  // blocked", and the whole list below is filtered on this set — so an
  // unreadable blocks table surfaced blocked people in the circle mention candidates.
  // There is no honest partial answer here, so the route refuses.
  if ((blockResult as any).error) {
    req.log?.warn(
      { userId: user.id, err: (blockResult as any).error },
      "circle mention candidates: block-state read failed — refusing rather than listing unfiltered people",
    );
    sendError(res, "db_error", "Block state could not be verified");
    return;
  }

  const blockedSet = new Set<string>();
  for (const b of (blockResult.data ?? [])) {
    if ((b as any).blocker_id === user.id) blockedSet.add((b as any).blocked_id);
    else blockedSet.add((b as any).blocker_id);
  }

  const groupMemberIds = (memberships ?? [])
    .map((m: any) => m.other_id as string)
    .concat(!isOwner ? [circleOwnerId] : [])
    .filter((id) => id !== user.id && !blockedSet.has(id));

  const groupMemberSet = new Set(groupMemberIds);
  const otherFollowerIds = [
    ...(friendsAsA ?? []).map((r: any) => r.user_b as string),
    ...(friendsAsB ?? []).map((r: any) => r.user_a as string),
  ].filter((id) => id !== user.id && !groupMemberSet.has(id) && !blockedSet.has(id));

  const allIds = [...groupMemberIds, ...otherFollowerIds];
  const profileMap: Record<string, any> = {};
  if (allIds.length > 0) {
    const { data: profiles } = await sc.from("profiles").select(PROFILE_PUBLIC).in("id", allIds);
    const allowedNames = await nameVisibilitySet(sc, allIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = sanitizeIdentity(p as any, allowedNames, user.id);
  }

  const toUser = (id: string) => {
    const p = profileMap[id];
    if (!p) return null;
    return { id: p.id as string, handle: p.handle as string, name: p.name as string, avatarUrl: (p.avatar_url as string | null) ?? null };
  };

  res.status(200).json({
    groupMembers:   groupMemberIds.map(toUser).filter(Boolean),
    otherFollowers: [...new Set(otherFollowerIds)].map(toUser).filter(Boolean),
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
  // Phase 14 — inviting a recommended traveler to your circle is a realized
  // outcome; link it back to the originating Compass recommendation.
  void linkOutcomeSignal(sc, user.id, recipientId, "invited", "route:circle_invite");

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
    .upsert({ user_id: (inv as any).owner_id, other_id: user.id, created_at: now });

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
    .select("other_id")
    .eq("user_id", circleOwnerId)
    .eq("other_id", memberId)
    .maybeSingle();

  if (!membership) { sendError(res, "not_found", "Membership not found"); return; }

  await sc.from("circle_memberships").delete().eq("user_id", circleOwnerId).eq("other_id", memberId);

  res.status(200).json({ status: "removed", memberId });

  // Immediately revoke chat access by syncing — sets left_at for the removed member.
  syncCircleChatMembers(circleOwnerId, sc).catch(() => {});
});

/* ===========================================================================
 * DELETE /me/friends/:friendId  — remove a friendship (unfriend)
 * ===========================================================================
 * Either party may remove the friendship.  Deletes the normalized row from
 * user_friendships.  Returns 404 if no friendship exists.
 */
router.delete("/me/friends/:friendId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { friendId } = req.params;
  if (!isUuid(friendId)) { sendError(res, "invalid_payload", "Invalid friendId"); return; }
  if (friendId === user.id) { sendError(res, "invalid_payload", "Cannot unfriend yourself"); return; }

  const [a, b] = normalizedFriendshipPair(user.id, friendId);

  const { data: existing } = await sc
    .from("user_friendships")
    .select("user_a")
    .eq("user_a", a)
    .eq("user_b", b)
    .maybeSingle();

  if (!existing) { sendError(res, "not_found", "Friendship not found"); return; }

  const { error } = await sc
    .from("user_friendships")
    .delete()
    .eq("user_a", a)
    .eq("user_b", b);

  if (error) { sendError(res, "db_error", "Failed to remove friendship", { exposeDetail: true }); return; }

  res.status(200).json({ status: "removed", friendId });
});

export default router;
