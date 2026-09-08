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
import { readBlockExclusions, isExcluded, sendExclusionsUnavailable } from "../lib/exclusionSet.js";

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

  // Check for an existing request in this direction.
  // supabase-js resolves on a DB error, so an unreadable friend_requests hands
  // back the same `null` "never asked before" does. Reading that as "no prior
  // request" walks past BOTH short-circuits and the reactivate branch and
  // INSERTs a brand-new pending row — which means the recipient of a request
  // they already declined receives a fresh one, with the declined state
  // bypassed rather than re-activated. That notification cannot be recalled,
  // so an unreadable table refuses the send.
  const { data: existing, error: existingErr } = await sc
    .from("friend_requests")
    .select("id, status")
    .eq("requester_id", user.id)
    .eq("recipient_id", recipientId)
    .maybeSingle();

  if (existingErr) {
    req.log.error({ err: existingErr, recipientId }, "friend request: outgoing-request check unavailable");
    sendError(res, "degraded_unavailable", "We could not check your existing friend requests right now. Please try again shortly.");
    return;
  }

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

  // Check if target already sent us a request → auto-accept both sides.
  // An unreadable friend_requests resolves as `{ data: null }`, identical to
  // "they never asked us". Treating it that way skips the auto-accept and
  // INSERTs a second, opposite-direction pending request: two people who both
  // want to be friends end up with two crossed pending requests and NO
  // user_friendships row, and neither side's UI offers an accept because each
  // sees only its own outgoing request. Refuse rather than create that state.
  const { data: incoming, error: incomingErr } = await sc
    .from("friend_requests")
    .select("id")
    .eq("requester_id", recipientId)
    .eq("recipient_id", user.id)
    .eq("status", "pending")
    .maybeSingle();

  if (incomingErr) {
    req.log.error({ err: incomingErr, recipientId }, "friend request: incoming-request check unavailable");
    sendError(res, "degraded_unavailable", "We could not check your existing friend requests right now. Please try again shortly.");
    return;
  }

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

  // Anti-retaliation cooldown: requester cannot re-send for 24 hours after a decline.
  //
  // `.then(undefined, () => {})` IS A REJECTION HANDLER, AND THIS CLIENT DOES NOT
  // REJECT. supabase-js resolves a failed write as `{ error }` -- even a network
  // failure resolves, because postgrest-js catches fetch errors itself -- so the
  // second argument to `.then` never ran, and the resolved `{ error }` was
  // discarded by the empty first slot. The one row that stops the declined
  // requester from re-sending immediately could fail to write and leave no trace
  // anywhere: not in the response, not in the log. The person who just declined
  // is then re-asked, and the cooldown they were owed never existed.
  //
  // Direction unchanged -- a failed cooldown must not fail the decline, which
  // HAS been committed above and is the protection that matters. What changes is
  // that the failure is now observed and stated, the same way routes/blocks.ts
  // reports its own anti-retaliation cooldown write (`cleanup.residual`).
  const cooldownExpiry = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
  const { error: cooldownErr } = await sc.from("user_interaction_cooldowns").upsert({
    user_id:        fr.requester_id,
    target_user_id: user.id,
    cooldown_type:  "friend_request",
    expires_at:     cooldownExpiry,
  }, { onConflict: "user_id,target_user_id,cooldown_type" });
  if (cooldownErr) {
    req.log.error(
      { err: cooldownErr, requestId, requesterId: fr.requester_id },
      "friend request declined, but the 24h anti-retaliation cooldown was NOT written -- " +
        "the requester can re-send immediately",
    );
  }

  res.status(200).json({ status: "declined", requestId, cooldownApplied: !cooldownErr });
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

  // A friendship pair is stored once under a sorted (user_a, user_b) key, so the
  // caller's friends live in BOTH halves and both must be read. Neither read
  // bound its `.error`, and supabase-js resolves on a database error — so one
  // failed half silently deleted every friend on that side of the sort order,
  // and two failed halves answered `{ friends: [] }`: "you have no friends", a
  // complete and confident roster produced by two failures. A half-empty roster
  // is the worse of the two, because nothing in the payload marks it partial.
  // Both are refused with a RETRYABLE 503 rather than served as fact.
  const [aRes, bRes] = await Promise.all([
    sc.from("user_friendships").select("user_b, created_at").eq("user_a", user.id),
    sc.from("user_friendships").select("user_a, created_at").eq("user_b", user.id),
  ]);
  const friendsErr = (aRes as any).error ?? (bRes as any).error;
  if (friendsErr) {
    req.log.error({ err: friendsErr }, "me/friends: user_friendships read failed — refusing to serve a partial roster");
    sendError(res, "degraded_unavailable", "Friend list is temporarily unavailable");
    return;
  }
  const asA = (aRes as any).data as any[] | null;
  const asB = (bRes as any).data as any[] | null;

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

  const [{ data: memberships }, { data: friendsAsA }, { data: friendsAsB }, blockedSet] = await Promise.all([
    sc.from("circle_memberships").select("other_id").eq("user_id", circleOwnerId),
    sc.from("user_friendships").select("user_b").eq("user_a", user.id),
    sc.from("user_friendships").select("user_a").eq("user_b", user.id),
    readBlockExclusions(sc, user.id),
  ]);
  //
  // FAIL-CLOSED, shape 3 (lib/exclusionSet.ts): both halves of this response —
  // groupMembers and otherFollowers — are rosters of people, and the block set
  // scopes every id in both. There is no sub-part left to serve honestly, and
  // an empty picker is a false statement ("you have nobody to invite") that the
  // caller would act on. It refuses with `degraded_unavailable` (503,
  // retryable), the code this codebase already uses for "the check could not be
  // PERFORMED", not db_error (500).
  //
  // `blockResult.data ?? []` previously turned a resolved DB error into an
  // empty block set, so the invite picker offered people the caller blocked.
  if (!blockedSet.ok) {
    sendExclusionsUnavailable(req, res, blockedSet, "circles/invitable-users");
    return;
  }

  const groupMemberIds = (memberships ?? [])
    .map((m: any) => m.other_id as string)
    .concat(!isOwner ? [circleOwnerId] : [])
    .filter((id) => id !== user.id && !isExcluded(blockedSet, id));

  const groupMemberSet = new Set(groupMemberIds);
  const otherFollowerIds = [
    ...(friendsAsA ?? []).map((r: any) => r.user_b as string),
    ...(friendsAsB ?? []).map((r: any) => r.user_a as string),
  ].filter((id) => id !== user.id && !groupMemberSet.has(id) && !isExcluded(blockedSet, id));

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

  // THREE CASCADING READS THAT ONLY EVER FALL ONE WAY. supabase-js RESOLVES on
  // a database error, so each `const { data }` below reads an unreadable table
  // as "no such row" and drops through to the next check — and when all three
  // fail, the handler ends at `status: "none"`: a positive, confident statement
  // that these two people have NO relationship, produced entirely by three
  // failures. Two real people who are friends are told they are strangers, and
  // an existing pending request is hidden along with the requestId the client
  // needs to accept, decline or cancel it — so the caller is denied an action
  // they are entitled to, with no way to tell why.
  //
  // `none` is the terminal, most-permissive verdict of this ladder, so an error
  // must never reach it. Each read is observed and refuses with a RETRYABLE 503
  // (the code this codebase uses for "the check could not be PERFORMED") rather
  // than being laundered into a relationship claim.
  const [ua, ub] = normalizedFriendshipPair(user.id, targetId);
  const { data: friendship, error: friendshipErr } = await sc
    .from("user_friendships").select("user_a").eq("user_a", ua).eq("user_b", ub).maybeSingle();

  if (friendshipErr) {
    req.log.error({ err: friendshipErr }, "friend-status: user_friendships read failed — refusing to report 'none'");
    sendError(res, "degraded_unavailable", "Friend status is temporarily unavailable");
    return;
  }

  if (friendship) {
    res.status(200).json({ userId: targetId, status: "friends" });
    return;
  }

  // Outgoing pending?
  const { data: outgoing, error: outgoingErr } = await sc
    .from("friend_requests").select("id")
    .eq("requester_id", user.id).eq("recipient_id", targetId).eq("status", "pending").maybeSingle();

  if (outgoingErr) {
    req.log.error({ err: outgoingErr }, "friend-status: outgoing friend_requests read failed — refusing to report 'none'");
    sendError(res, "degraded_unavailable", "Friend status is temporarily unavailable");
    return;
  }

  if (outgoing) {
    res.status(200).json({ userId: targetId, status: "outgoing_pending", requestId: (outgoing as any).id });
    return;
  }

  // Incoming pending?
  const { data: incomingReq, error: incomingErr } = await sc
    .from("friend_requests").select("id")
    .eq("requester_id", targetId).eq("recipient_id", user.id).eq("status", "pending").maybeSingle();

  if (incomingErr) {
    req.log.error({ err: incomingErr }, "friend-status: incoming friend_requests read failed — refusing to report 'none'");
    sendError(res, "degraded_unavailable", "Friend status is temporarily unavailable");
    return;
  }

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

  // An unreadable circle_invites resolves as `{ data: null }`, which is also
  // "never invited". Reading it that way skips the pending/accepted
  // short-circuits AND the reactivate branch, and INSERTs a fresh invite — so
  // someone who declined an invitation into this user's trusted circle is
  // re-invited, with their decline neither seen nor reactivated. A circle grants
  // standing privileges (circle-visibility events and posts), and the invite
  // notification cannot be recalled, so an unreadable table refuses.
  const { data: existing, error: existingErr } = await sc
    .from("circle_invites").select("id, status")
    .eq("owner_id", user.id).eq("recipient_id", recipientId).maybeSingle();

  if (existingErr) {
    req.log.error({ err: existingErr, recipientId }, "circle invite: existing-invite check unavailable");
    sendError(res, "degraded_unavailable", "We could not check your existing circle invites right now. Please try again shortly.");
    return;
  }

  if (existing) {
    const s = (existing as any).status;
    if (s === "pending") { res.status(200).json({ inviteId: (existing as any).id, status: "pending", idempotent: true }); return; }
    if (s === "accepted") { res.status(200).json({ inviteId: (existing as any).id, status: "accepted" }); return; }
    const now = new Date().toISOString();
    // A WRITE WITH NO `.error` CHECK REPORTS SUCCESS BLIND. supabase-js resolves
    // a failed UPDATE as `{ error }`, and this one was awaited into nothing --
    // so a reactivation that never happened answered 200 `reactivated: true`,
    // leaving the invite in its declined/cancelled state while both the inviter
    // and the client believed a pending invitation existed.
    const { error: reactivateErr } = await sc
      .from("circle_invites").update({ status: "pending", responded_at: null }).eq("id", (existing as any).id);
    if (reactivateErr) {
      req.log.error({ err: reactivateErr, inviteId: (existing as any).id }, "circle invite reactivation update failed");
      sendError(res, "db_error", reactivateErr.message);
      return;
    }
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

  // An unreadable `circle_invites` resolves as `{ data: null }`, which this
  // handler read as "no such invite" and answered 404 -- telling the recipient
  // their invitation does not exist because the database blinked. The direction
  // is safe (nothing is joined), the CLAIM is not.
  const { data: inv, error: invErr } = await sc
    .from("circle_invites").select("id, owner_id, recipient_id, status")
    .eq("id", inviteId).maybeSingle();

  if (invErr) {
    req.log.error({ err: invErr, inviteId }, "circle invite accept: invite read failed — refusing to report 'not found'");
    sendError(res, "degraded_unavailable", "We could not look up that circle invite right now. Please try again shortly.");
    return;
  }
  if (!inv) { sendError(res, "not_found", "Circle invite not found"); return; }
  if ((inv as any).recipient_id !== user.id) { sendError(res, "forbidden", "Only the recipient can accept this invite"); return; }
  if ((inv as any).status !== "pending") { sendError(res, "invalid_payload", `Invite is already ${(inv as any).status}`); return; }

  const now = new Date().toISOString();

  // ── WHAT THIS ROUTE OWES, AND WHY THE TWO WRITES ARE NOW IN THIS ORDER ─────
  // This handler's own banner says it is THE ONLY PLACE that creates a
  // circle_memberships row. It used to do two writes and believe both:
  //
  //   1. flip the invite to 'accepted'  — awaited into nothing, `.error` never
  //      bound, so a failed flip was invisible;
  //   2. upsert circle_memberships      — `.error` bound, LOGGED, and then
  //      fallen straight past into `res.json({ status: "accepted" })`.
  //
  // (2) is the ERROR-INERT half and the damaging one: the error was observed,
  // and the observation changed nothing about what the caller was told. Someone
  // accepting an invitation into another user's trusted circle got "accepted"
  // for a membership row that does not exist -- they are not in the circle, they
  // will not see circle-visibility posts, presence or events, and every retry
  // now answers 400 `Invite is already accepted` because step (1) DID land.
  // That is an unrecoverable dead end reached by reporting success.
  //
  // The membership upsert therefore goes FIRST and is fatal. It is idempotent on
  // (user_id, other_id), so a retry after any failure below re-runs it safely,
  // and if it fails NOTHING has changed -- the invite is still pending and the
  // retry is the ordinary path, not a special case. The status flip follows and
  // is also checked: if it fails the membership exists but the invite still
  // reads pending, which the next accept resolves by re-upserting the same row.
  // The state after a partial failure is now always retry-recoverable, which is
  // what the old order could not say.
  const { error: cmErr } = await sc
    .from("circle_memberships")
    .upsert({ user_id: (inv as any).owner_id, other_id: user.id, created_at: now });

  if (cmErr) {
    req.log.error({ err: cmErr, inviteId }, "circle_memberships upsert failed — invite NOT accepted");
    sendError(res, "db_error", cmErr.message);
    return;
  }

  const { error: acceptErr } = await sc
    .from("circle_invites").update({ status: "accepted", responded_at: now }).eq("id", inviteId);
  if (acceptErr) {
    req.log.error({ err: acceptErr, inviteId }, "circle invite accept: status flip failed after membership was created");
    sendError(res, "db_error", acceptErr.message);
    return;
  }

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

  const { data: inv, error: invErr } = await sc
    .from("circle_invites").select("id, recipient_id, status")
    .eq("id", inviteId).maybeSingle();

  if (invErr) {
    req.log.error({ err: invErr, inviteId }, "circle invite decline: invite read failed — refusing to report 'not found'");
    sendError(res, "degraded_unavailable", "We could not look up that circle invite right now. Please try again shortly.");
    return;
  }
  if (!inv) { sendError(res, "not_found", "Circle invite not found"); return; }
  if ((inv as any).recipient_id !== user.id) { sendError(res, "forbidden", "Only the recipient can decline this invite"); return; }
  if ((inv as any).status !== "pending") { sendError(res, "invalid_payload", `Invite is already ${(inv as any).status}`); return; }

  const now = new Date().toISOString();
  // DECLINING IS A REFUSAL OF ENTRY, AND THIS ONE WAS REPORTED BLIND. The update
  // was awaited into nothing: a failed write left the invite PENDING -- still in
  // the recipient's inbox, still acceptable, still counting as an outstanding
  // invitation to that user's trusted circle -- while the response said
  // `{ status: "declined" }`. Refusing to join is exactly the answer that must
  // not be assumed, so a failed write is now reported instead of asserted.
  const { error: declineErr } = await sc
    .from("circle_invites").update({ status: "declined", responded_at: now }).eq("id", inviteId);
  if (declineErr) {
    req.log.error({ err: declineErr, inviteId }, "circle invite decline update failed — the invite is still PENDING");
    sendError(res, "db_error", declineErr.message);
    return;
  }

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

  const { data: membership, error: membershipErr } = await sc
    .from("circle_memberships")
    .select("other_id")
    .eq("user_id", circleOwnerId)
    .eq("other_id", memberId)
    .maybeSingle();

  // An unreadable circle_memberships resolved as `{ data: null }` and was
  // reported as "Membership not found" -- an owner trying to eject someone from
  // their trusted circle was told that person is not in it. Nothing destructive
  // followed, but the claim is false and the owner stops trying.
  if (membershipErr) {
    req.log.error(
      { err: membershipErr, circleOwnerId, memberId },
      "circle member removal: membership read failed — refusing to report 'not a member'",
    );
    sendError(res, "degraded_unavailable", "We could not check that membership right now. Please try again shortly.");
    return;
  }
  if (!membership) { sendError(res, "not_found", "Membership not found"); return; }

  // ── THE REMOVAL ITSELF WAS ASSERTED, NOT OBSERVED ─────────────────────────
  // This delete was awaited into nothing. supabase-js resolves a failed DELETE
  // as `{ error }`, so the row could survive and the response still said
  // `{ status: "removed" }` with a 200. The person the owner just ejected from
  // their trusted circle keeps a circle_memberships row -- which is what
  // lib/privacyResolver.ts, routes/events.ts, routes/groupChat.ts,
  // routes/meetups.ts and compass all read to grant circle-visibility access to
  // posts, events, meetups and group chat. A revocation that did not happen,
  // reported as done, is the worst lie this route can tell, and the unfriend
  // handler directly below already checks its delete: the file disagreed with
  // itself.
  //
  // `.select("other_id")` is added so `error === null` is not the only evidence:
  // PostgREST answers a zero-row DELETE with the same 204 as a successful one,
  // and the membership was READ as present two statements ago, so zero rows
  // deleted here means something removed it in between (a concurrent removal --
  // benign, same end state) OR the filters did not match. The returned rows make
  // that observable instead of assumed; the end state ("not a member") is true
  // in both zero-row cases, so only a real error refuses.
  const { error: deleteErr } = await sc
    .from("circle_memberships")
    .delete()
    .eq("user_id", circleOwnerId)
    .eq("other_id", memberId)
    .select("other_id");

  if (deleteErr) {
    req.log.error(
      { err: deleteErr, circleOwnerId, memberId },
      "circle member removal FAILED — the member still has circle access and must not be told otherwise",
    );
    sendError(res, "db_error", deleteErr.message);
    return;
  }

  res.status(200).json({ status: "removed", memberId });

  // Immediately revoke chat access by syncing — sets left_at for the removed member.
  // The empty `.catch(() => {})` here swallowed a REAL rejection (this is an
  // ordinary async function, not a PostgrestBuilder, so it genuinely can reject),
  // and it swallowed it on the REVOKE path while the accept path two handlers up
  // logs the same failure. A removed member silently keeping their circle chat
  // seat is precisely the outcome that needed a log.
  syncCircleChatMembers(circleOwnerId, sc).catch((e) =>
    req.log.error(
      { err: e, circleOwnerId, memberId },
      "syncCircleChatMembers failed after circle removal — the removed member may retain chat access",
    ),
  );
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
