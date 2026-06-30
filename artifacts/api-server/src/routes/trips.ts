import { Router } from "express";
import { z } from "zod";
import { getServiceClient, isServiceClientReady } from "../lib/supabase";
import { requireUser, isAcceptedTripMember, requireTripMember, sendError, canEditPlanItem, canEditPlan, type PlanEditPermission } from "../lib/http.js";
import { toCamel } from "./plan.js";
import { syncTripChatMembers } from "../lib/chatSync.js";
import { getRestrictionState } from "../services/trust/TrustRestrictionService.js";
import { sendPushNotification } from "../lib/push.js";

const router = Router();

router.post("/trips", async (req, res) => {
  if (!isServiceClientReady) {
    res.status(503).json({ error: "Server not configured: SUPABASE_SERVICE_ROLE_KEY is missing" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }
  const token = authHeader.slice(7);

  const client = getServiceClient()!;

  // Verify user JWT via Supabase Auth directly — this works regardless of
  // whether PostgREST supports ECC P-256 JWT verification.
  const { data: { user }, error: authError } = await client.auth.getUser(token);
  if (authError || !user) {
    res.status(401).json({ error: authError?.message ?? "Invalid or expired token" });
    return;
  }

  // Trust Engine: check if user is restricted from hosting
  const trustState = await getRestrictionState(client, user.id);
  if (!trustState.canHost) {
    res.status(403).json({ error: "trust_restriction", message: "Your account is currently restricted from creating trips." });
    return;
  }

  const { title, destinationCity, destinationCountry, startDate, endDate, status, visibility, coverUrl } = req.body;

  if (!title || !destinationCity) {
    res.status(400).json({ error: "title and destinationCity are required" });
    return;
  }

  const { data, error } = await client
    .from("trips")
    .insert({
      owner_id: user.id,
      title,
      destination_city: destinationCity,
      destination_country: destinationCountry ?? null,
      start_date: startDate ?? null,
      end_date: endDate ?? null,
      status: status ?? "planning",
      visibility: visibility ?? "private",
      cover_url: coverUrl ?? null,
    })
    .select("*")
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to insert trip");
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json(data);

  // Wire chat sync: ensure trip chat thread exists with the owner as first member.
  const newTripId = (data as any)?.id;
  if (newTripId) {
    syncTripChatMembers(newTripId, client).catch(() => {});
  }
});

/* ===========================================================================
 * GET /trips/:tripId/members  — list accepted trip members (for invite picker)
 * ===========================================================================
 * Returns profiles of all accepted members (role = owner|member), excluding
 * the caller. Caller must be an accepted trip member themselves.
 */
router.get("/trips/:tripId/members", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const ok = await isAcceptedTripMember(client, tripId, user.id);
  if (!ok) { sendError(res, "forbidden", "Not a trip member"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rows, error: rowsErr } = await sc
    .from("trip_members")
    .select("user_id, role")
    .eq("trip_id", tripId)
    .in("role", ["owner", "member", "invited"]);

  if (rowsErr) { sendError(res, "db_error", rowsErr.message); return; }

  const memberIds = (rows ?? [])
    .filter((r: any) => r.role === "owner" || r.role === "member")
    .map((r: any) => r.user_id as string)
    .filter((id) => id !== user.id);

  const invitedIds = (rows ?? [])
    .filter((r: any) => r.role === "invited")
    .map((r: any) => r.user_id as string)
    .filter((id) => id !== user.id);

  const allIds = [...memberIds, ...invitedIds];
  if (allIds.length === 0) { res.status(200).json({ members: [], invited: [] }); return; }

  const [{ data: profiles, error: profErr }, { data: theyFollowMe }, { data: iFollowThem }] = await Promise.all([
    sc.from("profiles").select("id, handle, name, avatar_url").in("id", allIds),
    sc.from("user_follows").select("follower_id").eq("following_id", user.id).in("follower_id", allIds),
    sc.from("user_follows").select("following_id").eq("follower_id", user.id).in("following_id", allIds),
  ]);

  if (profErr) { sendError(res, "db_error", profErr.message); return; }

  const profileMap: Record<string, any> = {};
  for (const p of profiles ?? []) profileMap[(p as any).id] = p;

  const followsYouSet = new Set<string>((theyFollowMe ?? []).map((r: any) => r.follower_id as string));
  const youFollowSet = new Set<string>((iFollowThem ?? []).map((r: any) => r.following_id as string));

  const toUser = (id: string) => {
    const p = profileMap[id];
    return {
      id,
      handle: (p?.handle as string) ?? "",
      name: (p?.name as string) ?? "",
      avatarUrl: (p?.avatar_url as string | null) ?? null,
      followsYou: followsYouSet.has(id),
      youFollow: youFollowSet.has(id),
    };
  };

  res.status(200).json({
    members: memberIds.map(toUser),
    invited: invitedIds.map(toUser),
  });
});

/* ===========================================================================
 * GET /trips/:tripId/invitable-users  — grouped invite picker data
 * ===========================================================================
 * Returns trip members (groupMembers) + caller's friends not in the trip
 * (otherFollowers), so the invite picker can render two labelled sections.
 * Caller must be an accepted trip member.
 */
router.get("/trips/:tripId/invitable-users", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }

  const [{ data: memberRows }, { data: friendsAsA }, { data: friendsAsB }, blockResult] = await Promise.all([
    sc.from("trip_members").select("user_id").eq("trip_id", tripId).in("role", ["owner", "member"]),
    sc.from("user_friendships").select("user_b").eq("user_a", user.id),
    sc.from("user_friendships").select("user_a").eq("user_b", user.id),
    sc.from("blocks").select("blocker_id, blocked_id").or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`),
  ]);

  const blockedSet = new Set<string>();
  for (const b of (blockResult.data ?? [])) {
    if ((b as any).blocker_id === user.id) blockedSet.add((b as any).blocked_id);
    else blockedSet.add((b as any).blocker_id);
  }

  const groupMemberIds = (memberRows ?? [])
    .map((r: any) => r.user_id as string)
    .filter((id) => id !== user.id);

  const groupMemberSet = new Set(groupMemberIds);
  const otherFollowerIds = [
    ...(friendsAsA ?? []).map((r: any) => r.user_b as string),
    ...(friendsAsB ?? []).map((r: any) => r.user_a as string),
  ].filter((id) => id !== user.id && !groupMemberSet.has(id) && !blockedSet.has(id));

  const allIds = [...groupMemberIds, ...otherFollowerIds];
  const profileMap: Record<string, any> = {};
  if (allIds.length > 0) {
    const { data: profiles } = await sc.from("profiles").select("id, handle, name, avatar_url").in("id", allIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = p;
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
 * GET /me/trip-invites/pending  — list pending trip invitations for the caller
 * ===========================================================================
 * Returns every trip_members row where role = 'invited' for the current user,
 * enriched with trip details (name, destination, dates) and inviter profile.
 */
router.get("/me/trip-invites/pending", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Get all invited memberships for this user
  const { data: inviteRows, error: invErr } = await sc
    .from("trip_members")
    .select("trip_id, created_at")
    .eq("user_id", user.id)
    .eq("role", "invited");

  if (invErr) { sendError(res, "db_error", invErr.message); return; }
  if (!inviteRows || inviteRows.length === 0) {
    res.status(200).json({ invites: [] });
    return;
  }

  const tripIds = inviteRows.map((r: any) => r.trip_id as string);

  // Fetch trip details
  const { data: trips, error: tripsErr } = await sc
    .from("trips")
    .select("id, title, destination_city, destination_country, start_date, end_date, cover_url, owner_id")
    .in("id", tripIds);

  if (tripsErr) { sendError(res, "db_error", tripsErr.message); return; }

  const tripMap: Record<string, any> = {};
  for (const t of trips ?? []) tripMap[(t as any).id] = t;

  // Collect unique owner IDs to resolve inviter profiles
  const ownerIds = [...new Set((trips ?? []).map((t: any) => t.owner_id as string))];
  const profileMap: Record<string, any> = {};
  if (ownerIds.length > 0) {
    const { data: profiles } = await sc
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", ownerIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = p;
  }

  const invites = inviteRows
    .map((row: any) => {
      const trip = tripMap[row.trip_id];
      if (!trip) return null;
      const inviter = profileMap[trip.owner_id] ?? null;
      return {
        tripId:             trip.id,
        tripTitle:          trip.title,
        destinationCity:    trip.destination_city,
        destinationCountry: trip.destination_country ?? null,
        startDate:          trip.start_date ?? null,
        endDate:            trip.end_date ?? null,
        coverUrl:           trip.cover_url ?? null,
        invitedAt:          row.created_at,
        inviter: inviter ? {
          id:        inviter.id,
          name:      inviter.name,
          handle:    inviter.handle,
          avatarUrl: inviter.avatar_url ?? null,
        } : null,
      };
    })
    .filter(Boolean);

  res.status(200).json({ invites });
});

/* ===========================================================================
 * PATCH /trips/:tripId  — update trip plan-edit permission (owner only)
 * ===========================================================================
 * Accepts: { planEditPermission, planEditors? }
 * planEditors is the full replacement list of user IDs for specific_members mode.
 */
const PlanEditPermissionEnum = ["owner_only", "all_members", "specific_members"] as const;
const UUID_RE = /^[0-9a-f-]{36}$/i;

const PatchTripSchema = z.object({
  planEditPermission: z.enum(PlanEditPermissionEnum).optional(),
  planEditors: z.array(z.string().regex(UUID_RE)).optional(),
});

router.patch("/trips/:tripId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const parsed = PatchTripSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const { planEditPermission, planEditors } = parsed.data;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Only the trip owner may change plan permissions
  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the trip owner can change plan permissions"); return; }

  if (planEditPermission !== undefined) {
    const { error } = await sc.from("trips").update({ plan_edit_permission: planEditPermission }).eq("id", tripId);
    if (error) { sendError(res, "db_error", error.message); return; }
  }

  // Replace plan_editors list when provided (always a full replacement)
  if (planEditors !== undefined) {
    // Delete existing editors then insert new list
    const { error: delErr } = await sc.from("plan_editors").delete().eq("trip_id", tripId);
    if (delErr) { sendError(res, "db_error", delErr.message); return; }

    if (planEditors.length > 0) {
      const rows = planEditors.map((uid) => ({ trip_id: tripId, user_id: uid }));
      const { error: insErr } = await sc.from("plan_editors").insert(rows);
      if (insErr) { sendError(res, "db_error", insErr.message); return; }
    }
  }

  // Return current state
  const { data: updated } = await sc
    .from("trips")
    .select("id, plan_edit_permission")
    .eq("id", tripId)
    .maybeSingle();

  const { data: editorRows } = await sc
    .from("plan_editors")
    .select("user_id")
    .eq("trip_id", tripId);

  res.json({
    tripId,
    planEditPermission: (updated as any)?.plan_edit_permission ?? "all_members",
    planEditors: (editorRows ?? []).map((r: any) => r.user_id as string),
  });
});

/* ===========================================================================
 * GET /trips/:tripId/plan-permission  — get current plan permission for caller
 * ===========================================================================
 * Returns { planEditPermission, planEditors, canEdit } for the calling user.
 */
router.get("/trips/:tripId/plan-permission", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "Not a trip member"); return; }

  const { data: trip } = await sc
    .from("trips")
    .select("owner_id, plan_edit_permission")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const perm    = ((trip as any).plan_edit_permission as PlanEditPermission) ?? "all_members";
  const ownerId = (trip as any).owner_id as string;

  const { data: editorRows } = await sc
    .from("plan_editors")
    .select("user_id")
    .eq("trip_id", tripId);

  const editorIds = (editorRows ?? []).map((r: any) => r.user_id as string);

  let canEdit = false;
  if (user.id === ownerId)           canEdit = true;
  else if (perm === "all_members")   canEdit = true;
  else if (perm === "owner_only")    canEdit = false;
  else canEdit = editorIds.includes(user.id);

  res.json({ planEditPermission: perm, planEditors: editorIds, canEdit, isOwner: user.id === ownerId });
});

/* ===========================================================================
 * POST /trips/:tripId/invite  — trip owner invites a user
 * ===========================================================================
 * Reuses the existing trip_members table with role='invited'.
 * Friendship alone NEVER creates this row — only explicit owner invitation.
 */
router.post("/trips/:tripId/invite", async (req, res) => {
  if (!isServiceClientReady) {
    res.status(503).json({ error: "server_not_configured" });
    return;
  }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) { res.status(401).json({ error: "Missing Authorization header" }); return; }

  const client = getServiceClient()!;
  const { data: { user }, error: authErr } = await client.auth.getUser(authHeader.slice(7));
  if (authErr || !user) { res.status(401).json({ error: "Invalid or expired token" }); return; }

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" }); return; }

  const userId = req.body?.userId;
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) { res.status(400).json({ error: "invalid_payload", message: "userId must be a valid UUID" }); return; }
  if (userId === user.id) { res.status(400).json({ error: "invalid_payload", message: "You cannot invite yourself" }); return; }

  // Only the trip owner may invite
  const { data: trip } = await client.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { res.status(404).json({ error: "not_found", message: "Trip not found" }); return; }
  if ((trip as any).owner_id !== user.id) { res.status(403).json({ error: "forbidden", message: "Only the trip owner can invite members" }); return; }

  // Idempotent: check existing membership
  const { data: existing } = await client.from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", userId).maybeSingle();
  if (existing) { res.status(200).json({ status: "already_member", role: (existing as any).role, idempotent: true }); return; }

  const { error } = await client.from("trip_members").insert({ trip_id: tripId, user_id: userId, role: "invited" });
  if (error) { res.status(500).json({ error: "db_error", message: error.message }); return; }

  res.status(201).json({ status: "invited", tripId, userId });
});

/* ===========================================================================
 * POST /trips/:tripId/accept-invite  — invitee accepts their trip invitation
 * ===========================================================================
 */
router.post("/trips/:tripId/accept-invite", async (req, res) => {
  if (!isServiceClientReady) { res.status(503).json({ error: "server_not_configured" }); return; }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) { res.status(401).json({ error: "Missing Authorization header" }); return; }

  const client = getServiceClient()!;
  const { data: { user }, error: authErr } = await client.auth.getUser(authHeader.slice(7));
  if (authErr || !user) { res.status(401).json({ error: "Invalid or expired token" }); return; }

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" }); return; }

  const { data: membership } = await client
    .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle();

  if (!membership) { res.status(404).json({ error: "not_found", message: "No invitation found for this trip" }); return; }
  if ((membership as any).role !== "invited") { res.status(400).json({ error: "invalid_payload", message: `Already a ${(membership as any).role}` }); return; }

  const { error } = await client.from("trip_members").update({ role: "member" }).eq("trip_id", tripId).eq("user_id", user.id);
  if (error) { res.status(500).json({ error: "db_error", message: error.message }); return; }

  // Fire-and-forget: sync group chat membership for this trip.
  syncTripChatMembers(tripId, client).catch((e) => req.log?.error({ err: e }, "syncTripChatMembers failed"));

  // Fire-and-forget: notify trip owner their invite was accepted (#129).
  (async () => {
    try {
      const sc2 = getServiceClient();
      if (!sc2) return;
      const { data: tripRow } = await sc2.from("trips").select("title, owner_id").eq("id", tripId).maybeSingle();
      if (!tripRow || (tripRow as any).owner_id === user.id) return; // skip if caller IS owner
      const [{ data: ownerRow }, { data: acceptorRow }] = await Promise.all([
        sc2.from("profiles").select("expo_push_token").eq("id", (tripRow as any).owner_id).maybeSingle(),
        sc2.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
      ]);
      const acceptorName = (acceptorRow as any)?.display_name ?? "Someone";
      await sendPushNotification([(ownerRow as any)?.expo_push_token], {
        title: (tripRow as any).title ?? "Your trip",
        body: `${acceptorName} joined your trip!`,
        data: { type: "trip_invite_accepted", tripId },
      });
    } catch { /* best-effort */ }
  })();

  res.status(200).json({ status: "accepted", tripId, role: "member" });
});

/* ===========================================================================
 * POST /trips/:tripId/decline-invite  — invitee declines their trip invitation
 * ===========================================================================
 */
router.post("/trips/:tripId/decline-invite", async (req, res) => {
  if (!isServiceClientReady) { res.status(503).json({ error: "server_not_configured" }); return; }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) { res.status(401).json({ error: "Missing Authorization header" }); return; }

  const client = getServiceClient()!;
  const { data: { user }, error: authErr } = await client.auth.getUser(authHeader.slice(7));
  if (authErr || !user) { res.status(401).json({ error: "Invalid or expired token" }); return; }

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" }); return; }

  const { data: membership } = await client
    .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle();

  if (!membership) { res.status(404).json({ error: "not_found", message: "No invitation found for this trip" }); return; }
  if ((membership as any).role !== "invited") { res.status(400).json({ error: "invalid_payload", message: "Cannot decline — you are already a member" }); return; }

  const { error } = await client.from("trip_members").delete().eq("trip_id", tripId).eq("user_id", user.id);
  if (error) { res.status(500).json({ error: "db_error", message: error.message }); return; }

  res.status(200).json({ status: "declined", tripId });
});

/* ===========================================================================
 * GET /me/plan-editable-trips  — trips where caller has plan-edit permission
 * ===========================================================================
 * Returns only trips where the calling user can add/edit plan items.
 * Respects plan_edit_permission: owner_only | all_members | specific_members.
 */
router.get("/me/plan-editable-trips", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Get all trip memberships for this user (owner or member)
  const { data: memberRows, error: memErr } = await sc
    .from("trip_members")
    .select("trip_id, role")
    .eq("user_id", user.id)
    .in("role", ["owner", "member"]);

  if (memErr) { sendError(res, "db_error", memErr.message); return; }
  if (!memberRows || memberRows.length === 0) { res.json({ trips: [] }); return; }

  const tripIds = memberRows.map((r: any) => r.trip_id as string);

  // Fetch trip details including plan_edit_permission
  const { data: trips, error: tripsErr } = await sc
    .from("trips")
    .select("id, title, destination_city, destination_country, start_date, end_date, cover_url, owner_id, plan_edit_permission")
    .in("id", tripIds);

  if (tripsErr) { sendError(res, "db_error", tripsErr.message); return; }
  if (!trips || trips.length === 0) { res.json({ trips: [] }); return; }

  // Collect plan_editors for trips with specific_members permission
  const specificIds = trips
    .filter((t: any) => t.plan_edit_permission === "specific_members")
    .map((t: any) => t.id as string);

  const editorMap: Record<string, string[]> = {};
  if (specificIds.length > 0) {
    const { data: editorRows } = await sc
      .from("plan_editors")
      .select("trip_id, user_id")
      .in("trip_id", specificIds);
    for (const e of editorRows ?? []) {
      const eid = (e as any).trip_id as string;
      if (!editorMap[eid]) editorMap[eid] = [];
      editorMap[eid].push((e as any).user_id as string);
    }
  }

  const editable = (trips as any[]).filter((trip) => {
    if (trip.owner_id === user.id) return true;
    const perm: string = trip.plan_edit_permission ?? "all_members";
    if (perm === "all_members") return true;
    if (perm === "owner_only")  return false;
    return (editorMap[trip.id] ?? []).includes(user.id);
  });

  res.json({
    trips: editable.map((t: any) => ({
      id:                 t.id,
      title:              t.title,
      destinationCity:    t.destination_city,
      destinationCountry: t.destination_country ?? null,
      startDate:          t.start_date ?? null,
      endDate:            t.end_date ?? null,
      coverUrl:           t.cover_url ?? null,
    })),
  });
});

// ── Zod schemas for plan items ────────────────────────────────────────────────

const UUID = /^[0-9a-f-]{36}$/i;

const CATEGORIES = ["accommodation","activity","dining","transport","free_time","meeting_point","other"] as const;
const STATUSES   = ["confirmed","tentative","done","cancelled"] as const;
const SOURCE_TYPES = ["manual","place","meetup"] as const;

const CreatePlanItemSchema = z.object({
  title:             z.string().min(1).max(200),
  category:          z.enum(CATEGORIES).default("activity"),
  status:            z.enum(STATUSES).default("tentative"),
  sourceType:        z.enum(SOURCE_TYPES).default("manual"),
  sourceId:          z.string().optional(),
  dayDate:           z.string().optional(),
  startsAt:          z.string().optional(),
  endsAt:            z.string().optional(),
  locationName:      z.string().max(300).optional(),
  lat:               z.number().nullable().optional(),
  lng:               z.number().nullable().optional(),
  locationIsPrivate: z.boolean().default(false),
  notes:             z.string().max(1000).optional(),
  sortOrder:         z.number().int().default(0),
});

const UpdatePlanItemSchema = z.object({
  title:             z.string().min(1).max(200).optional(),
  category:          z.enum(CATEGORIES).optional(),
  status:            z.enum(STATUSES).optional(),
  dayDate:           z.string().nullable().optional(),
  startsAt:          z.string().nullable().optional(),
  endsAt:            z.string().nullable().optional(),
  locationName:      z.string().max(300).nullable().optional(),
  lat:               z.number().nullable().optional(),
  lng:               z.number().nullable().optional(),
  locationIsPrivate: z.boolean().optional(),
  notes:             z.string().max(1000).nullable().optional(),
  sortOrder:         z.number().int().optional(),
});

const ReorderSchema = z.object({
  sortOrder: z.number().int(),
});

// ── Conflict detection helper ─────────────────────────────────────────────────

function computeWarnings(
  items: any[],
  tripStartDate: string | null | undefined,
  tripEndDate: string | null | undefined,
  cancelledMeetupIds: Set<string> = new Set(),
): Map<string, string[]> {
  const warnMap = new Map<string, string[]>();
  for (const item of items) warnMap.set(item.id, []);

  // 1. Duplicate source_id across active items
  const sourceCount = new Map<string, number>();
  for (const item of items) {
    if (item.source_id) sourceCount.set(item.source_id, (sourceCount.get(item.source_id) ?? 0) + 1);
  }
  for (const item of items) {
    if (item.source_id && (sourceCount.get(item.source_id) ?? 0) > 1) {
      warnMap.get(item.id)!.push("duplicate");
    }
  }

  // 2. Time overlap: items on same day with truly overlapping time windows (not just start proximity)
  const byDay = new Map<string, any[]>();
  for (const item of items) {
    if (item.day_date && item.starts_at) {
      if (!byDay.has(item.day_date)) byDay.set(item.day_date, []);
      byDay.get(item.day_date)!.push(item);
    }
  }
  for (const dayItems of byDay.values()) {
    for (let i = 0; i < dayItems.length; i++) {
      for (let j = i + 1; j < dayItems.length; j++) {
        const a = dayItems[i], b = dayItems[j];
        const aStart = new Date(a.starts_at).getTime();
        const bStart = new Date(b.starts_at).getTime();
        // Default 1-hour duration when ends_at is absent
        const aEnd = a.ends_at ? new Date(a.ends_at).getTime() : aStart + 3_600_000;
        const bEnd = b.ends_at ? new Date(b.ends_at).getTime() : bStart + 3_600_000;
        if (aStart < bEnd && bStart < aEnd) {
          if (!warnMap.get(a.id)!.includes("time_overlap")) warnMap.get(a.id)!.push("time_overlap");
          if (!warnMap.get(b.id)!.includes("time_overlap")) warnMap.get(b.id)!.push("time_overlap");
        }
      }
    }
  }

  // 3. Outside trip dates
  if (tripStartDate && tripEndDate) {
    const start = new Date(tripStartDate + "T00:00:00Z").getTime();
    const end   = new Date(tripEndDate   + "T23:59:59Z").getTime();
    for (const item of items) {
      if (item.day_date) {
        const ms = new Date(item.day_date + "T00:00:00Z").getTime();
        if (ms < start || ms > end) warnMap.get(item.id)!.push("outside_trip_dates");
      }
    }
  }

  // 4. Missing location: has a location name but no coordinates (can't appear on map)
  for (const item of items) {
    if (item.location_name && (item.lat == null || item.lng == null)) {
      warnMap.get(item.id)!.push("missing_location");
    }
  }

  // 5. Cancelled source: meetup-sourced item from a cancelled meetup
  for (const item of items) {
    if (item.source_type === "meetup" && item.source_id && cancelledMeetupIds.has(item.source_id)) {
      warnMap.get(item.id)!.push("cancelled_source");
    }
  }

  return warnMap;
}

// ── GET /trips/:tripId/plan ───────────────────────────────────────────────────

router.get("/trips/:tripId/plan", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to view the plan"); return; }

  // Fetch trip metadata (dates + plan permission)
  const { data: trip } = await client
    .from("trips")
    .select("start_date,end_date,owner_id,plan_edit_permission")
    .eq("id", tripId)
    .maybeSingle();
  const tripStartDate = (trip as any)?.start_date ?? null;
  const tripEndDate   = (trip as any)?.end_date   ?? null;

  // Resolve caller's edit permission for this trip
  const editAllowed = await canEditPlan(client, tripId, user.id);
  const canEdit = editAllowed === true;

  const { data, error } = await client
    .from("trip_plan_items")
    .select("*")
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .order("day_date", { ascending: true, nullsFirst: false })
    .order("starts_at", { ascending: true, nullsFirst: false })
    .order("sort_order", { ascending: true });

  if (error) { req.log.error({ err: error }, "get trip plan"); sendError(res, "db_error", error.message); return; }

  const rows = data ?? [];

  // Fetch cancelled meetup IDs for cancelled_source advisory warning
  const meetupSourceIds = rows
    .filter((i) => i.source_type === "meetup" && i.source_id)
    .map((i) => i.source_id as string);
  const cancelledMeetupIds = new Set<string>();
  if (meetupSourceIds.length > 0) {
    const { data: meetups } = await client
      .from("meetups")
      .select("id, status")
      .in("id", meetupSourceIds);
    for (const m of (meetups ?? [])) {
      if ((m as any).status === "cancelled") cancelledMeetupIds.add(m.id);
    }
  }

  const warnMap = computeWarnings(rows, tripStartDate, tripEndDate, cancelledMeetupIds);

  res.json({
    items: rows.map((row) => toCamel(row, { warnings: warnMap.get(row.id) ?? [] })),
    canEdit,
  });
});

// ── GET /trips/:tripId/plan/map — only items with safe public coordinates ──────

router.get("/trips/:tripId/plan/map", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to view the map"); return; }

  const { data, error } = await client
    .from("trip_plan_items")
    .select("*")
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .order("sort_order", { ascending: true });

  if (error) { req.log.error({ err: error }, "get trip plan map"); sendError(res, "db_error", error.message); return; }

  // Only items with safe public coordinates
  const mapItems = (data ?? [])
    .filter((row) => !row.location_is_private && row.lat != null && row.lng != null)
    .map((row) => toCamel(row, {}));

  res.json({ items: mapItems });
});

// ── POST /trips/:tripId/plan/items ────────────────────────────────────────────

router.post("/trips/:tripId/plan/items", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You do not have permission to add plan items on this trip"); return; }

  const parsed = CreatePlanItemSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  // Duplicate guard for sourced items
  if (b.sourceId) {
    const { data: dup } = await client
      .from("trip_plan_items")
      .select("id")
      .eq("trip_id", tripId)
      .eq("source_type", b.sourceType)
      .eq("source_id", b.sourceId)
      .is("removed_at", null)
      .maybeSingle();
    if (dup) { res.status(409).json({ error: "duplicate", message: "This item is already in the plan" }); return; }
  }

  const { data: item, error } = await client
    .from("trip_plan_items")
    .insert({
      trip_id:             tripId,
      creator_id:          user.id,   // always from token
      title:               b.title,
      category:            b.category,
      status:              b.status,
      source_type:         b.sourceType,
      source_id:           b.sourceId ?? null,
      day_date:            b.dayDate ?? null,
      starts_at:           b.startsAt ?? null,
      ends_at:             b.endsAt ?? null,
      location_name:       b.locationName ?? null,
      lat:                 b.lat ?? null,
      lng:                 b.lng ?? null,
      location_is_private: b.locationIsPrivate ?? false,
      notes:               b.notes ?? null,
      sort_order:          b.sortOrder,
      visibility:          "members",
    })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "create plan item"); sendError(res, "db_error", error.message); return; }

  res.status(201).json(toCamel(item));
});

// ── PATCH /trips/:tripId/plan/items/:itemId ───────────────────────────────────

router.patch("/trips/:tripId/plan/items/:itemId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId, itemId } = req.params;
  if (!UUID.test(tripId) || !UUID.test(itemId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const parsed = UpdatePlanItemSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const patch = parsed.data;

  // Check trip-level plan edit permission first
  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You do not have permission to edit plan items on this trip"); return; }

  const auth = await canEditPlanItem(client, tripId, itemId, user.id);
  if (!auth.permitted) { sendError(res, auth.code, auth.message); return; }

  const dbPatch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.title             !== undefined) dbPatch.title               = patch.title;
  if (patch.category          !== undefined) dbPatch.category            = patch.category;
  if (patch.status            !== undefined) dbPatch.status              = patch.status;
  if (patch.dayDate           !== undefined) dbPatch.day_date            = patch.dayDate;
  if (patch.startsAt          !== undefined) dbPatch.starts_at           = patch.startsAt;
  if (patch.endsAt            !== undefined) dbPatch.ends_at             = patch.endsAt;
  if (patch.locationName      !== undefined) dbPatch.location_name       = patch.locationName;
  if (patch.lat               !== undefined) dbPatch.lat                 = patch.lat;
  if (patch.lng               !== undefined) dbPatch.lng                 = patch.lng;
  if (patch.locationIsPrivate !== undefined) dbPatch.location_is_private = patch.locationIsPrivate;
  if (patch.notes             !== undefined) dbPatch.notes               = patch.notes;
  if (patch.sortOrder         !== undefined) dbPatch.sort_order          = patch.sortOrder;

  const { data: updated, error } = await client
    .from("trip_plan_items")
    .update(dbPatch)
    .eq("id", itemId)
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "update plan item"); sendError(res, "db_error", error.message); return; }

  res.json(toCamel(updated));
});

// ── PATCH /trips/:tripId/plan/items/:itemId/remove — soft-delete ──────────────

router.patch("/trips/:tripId/plan/items/:itemId/remove", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId, itemId } = req.params;
  if (!UUID.test(tripId) || !UUID.test(itemId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You do not have permission to edit plan items on this trip"); return; }

  const auth = await canEditPlanItem(client, tripId, itemId, user.id);
  if (!auth.permitted) { sendError(res, auth.code, auth.message); return; }

  // Soft-delete only — source record is NOT deleted
  const { error } = await client
    .from("trip_plan_items")
    .update({ removed_at: new Date().toISOString() })
    .eq("id", itemId);

  if (error) { req.log.error({ err: error }, "remove plan item"); sendError(res, "db_error", error.message); return; }

  res.json({ status: "removed", itemId });
});

// ── DELETE /trips/:tripId/plan/items/:itemId — REST soft-delete ───────────────

router.delete("/trips/:tripId/plan/items/:itemId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId, itemId } = req.params;
  if (!UUID.test(tripId) || !UUID.test(itemId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You do not have permission to edit plan items on this trip"); return; }

  const auth = await canEditPlanItem(client, tripId, itemId, user.id);
  if (!auth.permitted) { sendError(res, auth.code, auth.message); return; }

  const { error } = await client
    .from("trip_plan_items")
    .update({ removed_at: new Date().toISOString() })
    .eq("id", itemId);

  if (error) { req.log.error({ err: error }, "delete plan item"); sendError(res, "db_error", error.message); return; }

  res.status(204).send();
});

// ── POST /trips/:tripId/plan/items/:itemId/reorder — plan-edit permission ─────

router.post("/trips/:tripId/plan/items/:itemId/reorder", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId, itemId } = req.params;
  if (!UUID.test(tripId) || !UUID.test(itemId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const parsed = ReorderSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "sortOrder must be an integer"); return; }

  // Reorder requires trip-level plan edit permission (same as add/edit/delete)
  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You don't have permission to reorder plan items"); return; }

  const { data: updated, error } = await client
    .from("trip_plan_items")
    .update({ sort_order: parsed.data.sortOrder, updated_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("trip_id", tripId)
    .select("id")
    .maybeSingle();

  if (error) { req.log.error({ err: error }, "reorder plan item"); sendError(res, "db_error", error.message); return; }
  if (!updated) { sendError(res, "not_found", "Plan item not found in this trip"); return; }

  res.json({ status: "reordered", itemId, sortOrder: parsed.data.sortOrder });
});

export default router;
