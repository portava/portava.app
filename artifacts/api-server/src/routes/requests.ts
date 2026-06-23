/**
 * Unified Request Inbox
 *
 * GET  /me/requests       — all-status list (friend, circle, trip) split incoming/outgoing
 * GET  /me/requests/count — incoming-only pending count for the nav badge
 *
 * POST /me/requests/friend_request/:id/accept|decline|cancel
 * POST /me/requests/circle_invite/:id/accept|decline
 * POST /me/requests/trip_invite/:tripId/accept|decline
 * POST /me/requests/trip_invite/:tripId/cancel   (body: { inviteeId })
 *
 * All writes use auth.client (service-role, JWT-verified) so they work in tests
 * via the _setTestClient slot in http.ts.
 */
import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { normalizedFriendshipPair, isUuid } from "../lib/friendDecisions";

const router = Router();

const PROFILE_PUBLIC = "id, handle, name, avatar_url";

interface Actor {
  id: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
}

interface InboxItem {
  id: string;
  type: "friend_request" | "circle_invite" | "trip_invite";
  direction: "incoming" | "outgoing";
  status: string;
  actor: Actor | null;
  targetName: string | null;
  createdAt: string;
}

function profileToActor(p: any): Actor | null {
  if (!p) return null;
  return { id: p.id, handle: p.handle ?? null, name: p.name ?? null, avatarUrl: p.avatar_url ?? null };
}

async function batchProfiles(sc: any, ids: string[]): Promise<Record<string, any>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return {};
  const { data } = await sc.from("profiles").select(PROFILE_PUBLIC).in("id", uniq);
  const map: Record<string, any> = {};
  for (const p of (data ?? [])) map[p.id] = p;
  return map;
}

/* =============================================================================
 * GET /me/requests
 * =============================================================================
 * Returns all social request items regardless of status (pending, accepted,
 * declined, cancelled, invited) so the UI can display history and status chips.
 * Items are sorted globally newest-first.
 * =============================================================================
 */
router.get("/me/requests", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  // ── 1. Fan out all reads ────────────────────────────────────────────────────
  const [
    { data: frIn },
    { data: frOut },
    { data: ciIn },
    { data: ciOut },
    { data: tripInvited },
    { data: ownedTrips },
  ] = await Promise.all([
    sc.from("friend_requests").select("id, status, created_at, requester_id")
      .eq("recipient_id", user.id).order("created_at", { ascending: false }),
    sc.from("friend_requests").select("id, status, created_at, recipient_id")
      .eq("requester_id", user.id).order("created_at", { ascending: false }),
    sc.from("circle_invites").select("id, status, created_at, owner_id")
      .eq("recipient_id", user.id).order("created_at", { ascending: false }),
    sc.from("circle_invites").select("id, status, created_at, recipient_id")
      .eq("owner_id", user.id).order("created_at", { ascending: false }),
    // Incoming trip invites (user is invitee)
    sc.from("trip_members").select("trip_id, created_at")
      .eq("user_id", user.id).eq("role", "invited").order("created_at", { ascending: false }),
    // Trips user owns (for outgoing trip invites)
    sc.from("trip_members").select("trip_id")
      .eq("user_id", user.id).eq("role", "owner"),
  ]);

  // ── 2. Outgoing trip invites (people I invited to my trips) ────────────────
  const ownedTripIds = (ownedTrips ?? []).map((r: any) => r.trip_id as string);
  let tripInviteesOut: Array<{ trip_id: string; user_id: string; created_at: string }> = [];
  if (ownedTripIds.length > 0) {
    const { data: invitees } = await sc.from("trip_members")
      .select("trip_id, user_id, created_at")
      .in("trip_id", ownedTripIds)
      .eq("role", "invited")
      .order("created_at", { ascending: false });
    tripInviteesOut = invitees ?? [];
  }

  // ── 3. Enrich trip invites with trip titles ────────────────────────────────
  const allTripIds = [
    ...new Set([
      ...(tripInvited ?? []).map((r: any) => r.trip_id as string),
      ...tripInviteesOut.map((r) => r.trip_id),
    ]),
  ];
  let tripTitleMap: Record<string, string | null> = {};
  let tripOwnerMap: Record<string, string> = {};
  if (allTripIds.length > 0) {
    const [{ data: tripsData }, { data: ownerRows }] = await Promise.all([
      sc.from("trips").select("id, title").in("id", allTripIds),
      sc.from("trip_members").select("trip_id, user_id")
        .in("trip_id", allTripIds).eq("role", "owner"),
    ]);
    for (const t of (tripsData ?? [])) tripTitleMap[t.id] = t.title ?? null;
    for (const r of (ownerRows ?? [])) tripOwnerMap[r.trip_id] = r.user_id;
  }

  // ── 4. Batch-fetch all actor profiles ─────────────────────────────────────
  const actorIds = [
    ...(frIn ?? []).map((r: any) => r.requester_id),
    ...(frOut ?? []).map((r: any) => r.recipient_id),
    ...(ciIn ?? []).map((r: any) => r.owner_id),
    ...(ciOut ?? []).map((r: any) => r.recipient_id),
    ...Object.values(tripOwnerMap),           // trip owners (for incoming)
    ...tripInviteesOut.map((r) => r.user_id), // invitees (for outgoing)
  ];
  const profileMap = await batchProfiles(sc, actorIds);

  // ── 5. Assemble items ──────────────────────────────────────────────────────
  const items: InboxItem[] = [];

  for (const r of (frIn ?? [])) {
    items.push({
      id: r.id, type: "friend_request", direction: "incoming", status: r.status,
      actor: profileToActor(profileMap[r.requester_id]), targetName: null, createdAt: r.created_at,
    });
  }
  for (const r of (ciIn ?? [])) {
    items.push({
      id: r.id, type: "circle_invite", direction: "incoming", status: r.status,
      actor: profileToActor(profileMap[r.owner_id]), targetName: null, createdAt: r.created_at,
    });
  }
  for (const r of (tripInvited ?? [])) {
    items.push({
      id: r.trip_id, type: "trip_invite", direction: "incoming", status: "invited",
      actor: profileToActor(profileMap[tripOwnerMap[r.trip_id]]),
      targetName: tripTitleMap[r.trip_id] ?? null, createdAt: r.created_at,
    });
  }
  for (const r of (frOut ?? [])) {
    items.push({
      id: r.id, type: "friend_request", direction: "outgoing", status: r.status,
      actor: profileToActor(profileMap[r.recipient_id]), targetName: null, createdAt: r.created_at,
    });
  }
  for (const r of (ciOut ?? [])) {
    items.push({
      id: r.id, type: "circle_invite", direction: "outgoing", status: r.status,
      actor: profileToActor(profileMap[r.recipient_id]), targetName: null, createdAt: r.created_at,
    });
  }
  for (const r of tripInviteesOut) {
    // Compound ID: tripId|inviteeId — the owner needs this for cancel
    items.push({
      id: `${r.trip_id}|${r.user_id}`, type: "trip_invite", direction: "outgoing", status: "invited",
      actor: profileToActor(profileMap[r.user_id]),
      targetName: tripTitleMap[r.trip_id] ?? null, createdAt: r.created_at,
    });
  }

  // ── 6. Sort globally newest-first ─────────────────────────────────────────
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  res.status(200).json({ items });
});

/* =============================================================================
 * GET /me/requests/count  — incoming pending count for nav badge
 * =============================================================================
 */
router.get("/me/requests/count", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const [{ data: frRows }, { data: ciRows }, { data: tiRows }, { data: miRows }] = await Promise.all([
    sc.from("friend_requests").select("id").eq("recipient_id", user.id).eq("status", "pending"),
    sc.from("circle_invites").select("id").eq("recipient_id", user.id).eq("status", "pending"),
    sc.from("trip_members").select("trip_id").eq("user_id", user.id).eq("role", "invited"),
    sc.from("meetup_invites").select("id").eq("user_id", user.id).eq("status", "pending"),
  ]);

  const count = (frRows ?? []).length + (ciRows ?? []).length + (tiRows ?? []).length + (miRows ?? []).length;
  res.status(200).json({ count });
});

/* =============================================================================
 * POST /me/requests/friend_request/:id/accept
 * Only the recipient may accept.  Creates user_friendships row.
 * =============================================================================
 */
router.post("/me/requests/friend_request/:id/accept", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid request id"); return; }

  const { data: fr } = await sc.from("friend_requests")
    .select("id, requester_id, recipient_id, status").eq("id", id).maybeSingle();
  if (!fr) { sendError(res, "not_found", "Friend request not found"); return; }
  if (fr.status !== "pending") { sendError(res, "invalid_payload", `Request is already ${fr.status}`); return; }
  if (fr.recipient_id !== user.id) { sendError(res, "forbidden", "Only the recipient may accept this request"); return; }

  const now = new Date().toISOString();
  await sc.from("friend_requests").update({ status: "accepted", responded_at: now, updated_at: now }).eq("id", id);
  const [ua, ub] = normalizedFriendshipPair(fr.requester_id, fr.recipient_id);
  await sc.from("user_friendships").upsert({ user_a: ua, user_b: ub, accepted_request_id: id, created_at: now });

  res.status(200).json({ status: "friends", requestId: id });
});

/* =============================================================================
 * POST /me/requests/friend_request/:id/decline
 * Only the recipient may decline.
 * =============================================================================
 */
router.post("/me/requests/friend_request/:id/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid request id"); return; }

  const { data: fr } = await sc.from("friend_requests")
    .select("id, recipient_id, status").eq("id", id).maybeSingle();
  if (!fr) { sendError(res, "not_found", "Friend request not found"); return; }
  if (fr.status !== "pending") { sendError(res, "invalid_payload", `Request is already ${fr.status}`); return; }
  if (fr.recipient_id !== user.id) { sendError(res, "forbidden", "Only the recipient may decline this request"); return; }

  const now = new Date().toISOString();
  await sc.from("friend_requests").update({ status: "declined", responded_at: now, updated_at: now }).eq("id", id);
  res.status(200).json({ status: "declined", requestId: id });
});

/* =============================================================================
 * POST /me/requests/friend_request/:id/cancel
 * Only the requester may cancel.
 * =============================================================================
 */
router.post("/me/requests/friend_request/:id/cancel", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid request id"); return; }

  const { data: fr } = await sc.from("friend_requests")
    .select("id, requester_id, status").eq("id", id).maybeSingle();
  if (!fr) { sendError(res, "not_found", "Friend request not found"); return; }
  if (fr.status !== "pending") { sendError(res, "invalid_payload", `Request is already ${fr.status}`); return; }
  if (fr.requester_id !== user.id) { sendError(res, "forbidden", "Only the requester may cancel this request"); return; }

  const now = new Date().toISOString();
  await sc.from("friend_requests").update({ status: "cancelled", updated_at: now }).eq("id", id);
  res.status(200).json({ status: "cancelled", requestId: id });
});

/* =============================================================================
 * POST /me/requests/circle_invite/:id/accept
 * Only the recipient may accept.  Creates circle_memberships row.
 * =============================================================================
 */
router.post("/me/requests/circle_invite/:id/accept", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid invite id"); return; }

  const { data: inv } = await sc.from("circle_invites")
    .select("id, owner_id, recipient_id, status").eq("id", id).maybeSingle();
  if (!inv) { sendError(res, "not_found", "Circle invite not found"); return; }
  if (inv.status !== "pending") { sendError(res, "invalid_payload", `Invite is already ${inv.status}`); return; }
  if (inv.recipient_id !== user.id) { sendError(res, "forbidden", "Only the recipient may accept this invite"); return; }

  const now = new Date().toISOString();
  await sc.from("circle_invites").update({ status: "accepted", responded_at: now }).eq("id", id);
  await sc.from("circle_memberships").upsert({ owner_id: inv.owner_id, member_id: user.id, created_at: now });

  res.status(200).json({ status: "accepted", ownerId: inv.owner_id });
});

/* =============================================================================
 * POST /me/requests/circle_invite/:id/cancel
 * Only the owner (sender) may cancel a pending invite.
 * =============================================================================
 */
router.post("/me/requests/circle_invite/:id/cancel", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid invite id"); return; }

  const { data: inv } = await sc.from("circle_invites")
    .select("id, owner_id, status").eq("id", id).maybeSingle();
  if (!inv) { sendError(res, "not_found", "Circle invite not found"); return; }
  if (inv.status !== "pending") { sendError(res, "invalid_payload", `Invite is already ${inv.status}`); return; }
  if (inv.owner_id !== user.id) { sendError(res, "forbidden", "Only the invite owner may cancel this invite"); return; }

  const now = new Date().toISOString();
  await sc.from("circle_invites").update({ status: "cancelled", updated_at: now }).eq("id", id);
  res.status(200).json({ status: "cancelled" });
});

/* =============================================================================
 * POST /me/requests/circle_invite/:id/decline
 * Only the recipient may decline.
 * =============================================================================
 */
router.post("/me/requests/circle_invite/:id/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid invite id"); return; }

  const { data: inv } = await sc.from("circle_invites")
    .select("id, recipient_id, status").eq("id", id).maybeSingle();
  if (!inv) { sendError(res, "not_found", "Circle invite not found"); return; }
  if (inv.status !== "pending") { sendError(res, "invalid_payload", `Invite is already ${inv.status}`); return; }
  if (inv.recipient_id !== user.id) { sendError(res, "forbidden", "Only the recipient may decline this invite"); return; }

  const now = new Date().toISOString();
  await sc.from("circle_invites").update({ status: "declined", responded_at: now }).eq("id", id);
  res.status(200).json({ status: "declined" });
});

/* =============================================================================
 * POST /me/requests/trip_invite/:tripId/accept
 * Only the invitee may accept (role 'invited' → 'member').
 * =============================================================================
 */
router.post("/me/requests/trip_invite/:tripId/accept", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;
  const { tripId } = req.params;
  if (!isUuid(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const { data: tm } = await sc.from("trip_members")
    .select("trip_id, user_id, role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle();
  if (!tm) { sendError(res, "not_found", "Trip invite not found"); return; }
  if (tm.role !== "invited") { sendError(res, "invalid_payload", `Trip membership is already '${tm.role}'`); return; }

  await sc.from("trip_members").update({ role: "member" }).eq("trip_id", tripId).eq("user_id", user.id);
  res.status(200).json({ status: "member", tripId });
});

/* =============================================================================
 * POST /me/requests/trip_invite/:tripId/decline
 * Only the invitee may decline (removes the trip_members row).
 * =============================================================================
 */
router.post("/me/requests/trip_invite/:tripId/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;
  const { tripId } = req.params;
  if (!isUuid(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const { data: tm } = await sc.from("trip_members")
    .select("trip_id, user_id, role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle();
  if (!tm) { sendError(res, "not_found", "Trip invite not found"); return; }
  if (tm.role !== "invited") { sendError(res, "invalid_payload", `Trip membership is already '${tm.role}'`); return; }

  await sc.from("trip_members").delete().eq("trip_id", tripId).eq("user_id", user.id);
  res.status(200).json({ status: "declined", tripId });
});

/* =============================================================================
 * POST /me/requests/trip_invite/:tripId/cancel
 * Body: { inviteeId: string }
 * Only the trip owner may cancel a pending invite.
 * =============================================================================
 */
router.post("/me/requests/trip_invite/:tripId/cancel", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;
  const { tripId } = req.params;
  const { inviteeId } = req.body ?? {};

  if (!isUuid(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  if (!inviteeId || !isUuid(inviteeId)) { sendError(res, "invalid_payload", "inviteeId must be a valid UUID"); return; }

  // Verify current user is the trip owner
  const { data: ownerRow } = await sc.from("trip_members")
    .select("role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle();
  if (!ownerRow || ownerRow.role !== "owner") {
    sendError(res, "forbidden", "Only the trip owner may cancel invites"); return;
  }

  const { data: inviteRow } = await sc.from("trip_members")
    .select("role").eq("trip_id", tripId).eq("user_id", inviteeId).maybeSingle();
  if (!inviteRow) { sendError(res, "not_found", "Invite not found"); return; }
  if (inviteRow.role !== "invited") { sendError(res, "invalid_payload", `Membership is already '${inviteRow.role}'`); return; }

  await sc.from("trip_members").delete().eq("trip_id", tripId).eq("user_id", inviteeId);
  res.status(200).json({ status: "cancelled", tripId, inviteeId });
});

/* =============================================================================
 * POST /trips/:tripId/remove-member
 * Body: { memberId: string }
 * Only the trip owner may remove an accepted member.
 * Immediately sets left_at on the member's chat thread row via sync.
 * =============================================================================
 */
router.post("/trips/:tripId/remove-member", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;
  const { tripId } = req.params;
  const { memberId } = req.body ?? {};

  if (!isUuid(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  if (!memberId || !isUuid(memberId)) { sendError(res, "invalid_payload", "memberId must be a valid UUID"); return; }

  if (memberId === user.id) { sendError(res, "invalid_payload", "Cannot remove yourself"); return; }

  const { data: ownerRow } = await sc
    .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle();
  if (!ownerRow || ownerRow.role !== "owner") {
    sendError(res, "forbidden", "Only the trip owner may remove members"); return;
  }

  const { data: memberRow } = await sc
    .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", memberId).maybeSingle();
  if (!memberRow) { sendError(res, "not_found", "Member not found on this trip"); return; }
  if (memberRow.role === "owner") { sendError(res, "invalid_payload", "Cannot remove the trip owner"); return; }

  await sc.from("trip_members").delete().eq("trip_id", tripId).eq("user_id", memberId);
  res.status(200).json({ status: "removed", tripId, memberId });

  // Immediately revoke chat access by syncing — sets left_at for the removed member.
  const { syncTripChatMembers } = await import("../lib/chatSync.js");
  syncTripChatMembers(tripId, sc).catch(() => {});

  // Immediately revoke any active crew live-share sessions for the removed member.
  const { revokeAccessForMember } = await import("../services/tripCrew/TripCrewLiveShareService.js");
  revokeAccessForMember(sc, tripId, memberId).catch(() => {});
});

export default router;
