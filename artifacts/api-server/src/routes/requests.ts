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
import { getServiceClient } from "../lib/supabase";
import { getAgeEligibilityReason } from "../lib/ageEligibility";
import { resolveInteractionPermissions } from "../services/interactionPermissions.js";
import { nameVisibilitySet, sanitizeIdentity } from "../lib/publicIdentity";
import {
  isTripKernelEnabled,
  readCommandEnvelope,
  executeTripCommand,
  sendKernelRejection,
  setTripVersionHeader,
} from "../lib/tripKernel.js";
import { randomUUID } from "node:crypto";

const router = Router();

/**
 * Trip Kernel gate (Trips spec §4; lib/tripKernel.ts; migrations 2420/2450).
 * `sc` is auth.client — the service-role client — which is what the kernel
 * function requires. Returns it when `trip_kernel_enabled` is TRUE, else null;
 * null means the pre-kernel direct write runs exactly as before. The flag read
 * is fail-closed. Same shape as routes/trips.ts.
 */
async function tripKernel(sc: any): Promise<any | null> {
  return (await isTripKernelEnabled(sc)) ? sc : null;
}

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

async function batchProfiles(sc: any, ids: string[], viewerId: string): Promise<Record<string, any>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return {};
  const { data } = await sc.from("profiles").select(PROFILE_PUBLIC).in("id", uniq);
  const allowedNames = await nameVisibilitySet(sc, uniq);
  const map: Record<string, any> = {};
  for (const p of (data ?? [])) map[p.id] = sanitizeIdentity(p as any, allowedNames, viewerId);
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
  const profileMap = await batchProfiles(sc, actorIds, user.id);

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

  // Permission engine — suspended recipient cannot accept; requester may have blocked recipient
  const permSc = getServiceClient();
  if (!permSc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  try {
    const perms = await resolveInteractionPermissions(permSc, user.id, fr.requester_id);
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
  const { error: acceptErr } = await sc.from("friend_requests").update({ status: "accepted", responded_at: now, updated_at: now }).eq("id", id);
  if (acceptErr) {
    req.log.error({ err: acceptErr }, "friend request accept update failed");
    sendError(res, "db_error", acceptErr.message);
    return;
  }
  const [ua, ub] = normalizedFriendshipPair(fr.requester_id, fr.recipient_id);
  // If this upsert fails, the request row is already flipped to accepted but no
  // friendship row exists. Recovery: report db_error so the client retries; the
  // retry hits the "already accepted" guard, so the client should re-invoke the
  // accept — the upsert is idempotent (same normalized pair), so a repaired
  // retry or the auto-accept path can safely re-create the row.
  const { error: friendshipErr } = await sc.from("user_friendships").upsert({ user_a: ua, user_b: ub, accepted_request_id: id, created_at: now });
  if (friendshipErr) {
    req.log.error({ err: friendshipErr }, "user_friendships upsert failed after accept");
    sendError(res, "db_error", friendshipErr.message);
    return;
  }

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
    .select("id, requester_id, recipient_id, status").eq("id", id).maybeSingle();
  if (!fr) { sendError(res, "not_found", "Friend request not found"); return; }
  if (fr.status !== "pending") { sendError(res, "invalid_payload", `Request is already ${fr.status}`); return; }
  if (fr.recipient_id !== user.id) { sendError(res, "forbidden", "Only the recipient may decline this request"); return; }

  // Permission engine — suspended recipient cannot decline
  const permScD = getServiceClient();
  if (!permScD) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  try {
    const perms = await resolveInteractionPermissions(permScD, user.id, fr.requester_id);
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
  const { error: declineErr } = await sc.from("friend_requests").update({ status: "declined", responded_at: now, updated_at: now }).eq("id", id);
  if (declineErr) {
    req.log.error({ err: declineErr }, "friend request decline update failed");
    sendError(res, "db_error", declineErr.message);
    return;
  }

  // Anti-retaliation cooldown: requester cannot re-send for 24 hours after a decline
  const cooldownExpiry = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
  await permScD.from("user_interaction_cooldowns").upsert({
    user_id:        fr.requester_id,
    target_user_id: user.id,
    cooldown_type:  "friend_request",
    expires_at:     cooldownExpiry,
  }, { onConflict: "user_id,target_user_id,cooldown_type" }).then(undefined, () => {});

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
    .select("id, requester_id, recipient_id, status").eq("id", id).maybeSingle();
  if (!fr) { sendError(res, "not_found", "Friend request not found"); return; }
  if (fr.status !== "pending") { sendError(res, "invalid_payload", `Request is already ${fr.status}`); return; }
  if (fr.requester_id !== user.id) { sendError(res, "forbidden", "Only the requester may cancel this request"); return; }

  // Permission engine — verify requester still owns an outgoing request (canCancelFriendRequest)
  const permScC = getServiceClient();
  if (!permScC) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  try {
    const perms = await resolveInteractionPermissions(permScC, user.id, fr.recipient_id);
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
  const { error: cancelErr } = await sc.from("friend_requests").update({ status: "cancelled", responded_at: now, updated_at: now }).eq("id", id);
  if (cancelErr) {
    req.log.error({ err: cancelErr }, "friend request cancel update failed");
    sendError(res, "db_error", cancelErr.message);
    return;
  }
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

  // ── Age eligibility check — the circle owner's age settings ──────────────
  //
  // "This circle has no age limit" is the PERMISSIVE answer, and this route
  // used to reach it by two paths that had not read anything:
  //
  //   `if (serviceClient)` with no else — a boot-order or configuration problem
  //     meant no client, the whole gate was SKIPPED, and the invite was accepted
  //     as though the owner had set no limit. Silently.
  //   an unbound `.error` — supabase-js RESOLVES on a database error, so an
  //     unreadable `circle_age_settings` bound `data: null`, fell through
  //     `ageSettings?.age_limit_enabled` and accepted the invite the same way.
  //
  // A row that is genuinely ABSENT and a row that could not be READ are
  // opposite facts here: the first means the owner set no limit, the second
  // means we do not know whether they did. This is the same defect, and the
  // same fix, as GET /circle-age-settings/:ownerId in routes/circleAgeSettings.ts
  // (commit 04dcbde5) — which is the read this path is the write side of. Both
  // now refuse with a retryable 503 rather than joining someone to another
  // user's trusted circle on a guess.
  //
  // NOTE ON COVERAGE, so it is not implied where it does not exist: the
  // `!serviceClient` branch is verified BY INSPECTION ONLY. `getServiceClient()`
  // answers from the environment, so `_setTestServiceClient(null)` does not
  // produce a null client — a test built that way gets a real client pointed at
  // an unreachable host and passes off the read-error branch instead. See the
  // same note in commit 04dcbde5.
  const serviceClient = getServiceClient();
  if (!serviceClient) {
    req.log.error(
      { inviteId: id, ownerId: inv.owner_id },
      "circle invite accept: no service client — refusing rather than skipping the age gate",
    );
    sendError(res, "degraded_unavailable", "Age settings are temporarily unavailable");
    return;
  }
  {
    const [ageSettingsRes, profileRes] = await Promise.all([
      serviceClient
        .from("circle_age_settings")
        .select("age_limit_enabled, min_age, max_age")
        .eq("owner_id", inv.owner_id)
        .maybeSingle(),
      serviceClient
        .from("profiles")
        .select("date_of_birth")
        .eq("id", user.id)
        .maybeSingle(),
    ]);

    if (ageSettingsRes.error) {
      req.log.error(
        { err: ageSettingsRes.error, inviteId: id, ownerId: inv.owner_id },
        "circle invite accept: circle_age_settings read failed — refusing rather than accepting as 'no age limit'",
      );
      sendError(res, "degraded_unavailable", "Age settings are temporarily unavailable");
      return;
    }
    if (profileRes.error) {
      // Direction was ALREADY fail-closed here (a null DOB makes
      // getAgeEligibilityReason return eligible:false), but the 403 it produced
      // told the acceptor "your profile needs a date of birth" — a statement
      // about their profile, made from a read of it that failed. A retryable
      // 503 refuses just as firmly and does not say something untrue.
      req.log.error(
        { err: profileRes.error, inviteId: id, userId: user.id },
        "circle invite accept: profile read failed — refusing without claiming the acceptor has no date of birth",
      );
      sendError(res, "degraded_unavailable", "Age settings are temporarily unavailable");
      return;
    }

    // A SUCCESSFUL read that found no row: the owner has set no age limit.
    const ageSettings = ageSettingsRes.data as any;
    if (ageSettings?.age_limit_enabled) {
      const dob = (profileRes.data as any)?.date_of_birth ?? null;
      const eligibility = getAgeEligibilityReason(dob, true, ageSettings.min_age, ageSettings.max_age);
      if (!eligibility.eligible) {
        // Write audit log (best-effort)
        void (async () => {
          const { error: auditError } = await serviceClient.from("age_limit_audit_log").insert({
            actor_user_id: user.id,
            target_type:   "circle",
            target_id:     inv.owner_id,
            action:        "circle_invite_accept_blocked",
            reason:        eligibility.reason,
          });
          if (auditError) req.log.warn({ err: auditError }, "age limit audit insert failed (best-effort)");
        })();
        res.status(403).json({
          error: "age_not_eligible",
          reason: eligibility.reason,
          message: eligibility.publicMessage,
        });
        return;
      }
    }
  }

  const now = new Date().toISOString();
  const { error: ciAcceptErr } = await sc.from("circle_invites").update({ status: "accepted", responded_at: now }).eq("id", id);
  if (ciAcceptErr) {
    req.log.error({ err: ciAcceptErr }, "circle invite accept update failed");
    sendError(res, "db_error", ciAcceptErr.message);
    return;
  }
  const { error: cmUpsertErr } = await sc.from("circle_memberships").upsert({ user_id: inv.owner_id, other_id: user.id, created_at: now });
  if (cmUpsertErr) {
    req.log.error({ err: cmUpsertErr }, "circle membership upsert failed after invite accept");
    sendError(res, "db_error", cmUpsertErr.message);
    return;
  }

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
  const { error: ciCancelErr } = await sc.from("circle_invites").update({ status: "cancelled", updated_at: now }).eq("id", id);
  if (ciCancelErr) {
    req.log.error({ err: ciCancelErr }, "circle invite cancel update failed");
    sendError(res, "db_error", ciCancelErr.message);
    return;
  }
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
  const nowMs = Date.now();

  const now = new Date(nowMs).toISOString();
  const { error: ciDeclineErr } = await sc.from("circle_invites").update({ status: "declined", responded_at: now }).eq("id", id);
  if (ciDeclineErr) {
    req.log.error({ err: ciDeclineErr }, "circle invite decline update failed");
    sendError(res, "db_error", ciDeclineErr.message);
    return;
  }

  // Anti-retaliation cooldown: invite owner cannot re-invite for 48 hours after a decline
  const ciCooldownExpiry = new Date(nowMs + 48 * 60 * 60 * 1000).toISOString();
  const ciPermSc = getServiceClient();
  if (ciPermSc) {
    const { data: ciInvFull } = await ciPermSc.from("circle_invites")
      .select("owner_id").eq("id", id).maybeSingle();
    if (ciInvFull?.owner_id) {
      await ciPermSc.from("user_interaction_cooldowns").upsert({
        user_id:        ciInvFull.owner_id,
        target_user_id: user.id,
        cooldown_type:  "circle_invite",
        expires_at:     ciCooldownExpiry,
      }, { onConflict: "user_id,target_user_id,cooldown_type" }).then(undefined, () => {});
    }
  }

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

  // Trip Kernel path (ACCEPT_INVITE, contract v2). The invitee is the actor;
  // the kernel requires exactly an 'invited' row for them. Off => the direct
  // update below, exactly as before.
  const kernelAccept = await tripKernel(sc);
  let kernelAccepted = false;
  if (kernelAccept) {
    const env = readCommandEnvelope(req);
    if (!env.ok) { sendError(res, "invalid_payload", env.message); return; }
    const r = await executeTripCommand(kernelAccept, {
      commandId: randomUUID(),
      tripId,
      actorUserId: user.id,
      expectedTripVersion: env.expectedTripVersion,
      idempotencyKey: env.idempotencyKey,
      type: "ACCEPT_INVITE",
      payload: {},
    });
    if (!r.ok) { sendKernelRejection(res, r, req.log); return; }
    setTripVersionHeader(res, r.version);
    kernelAccepted = true;
  }

  // trip-kernel:legacy-path — the flag-off twin of ACCEPT_INVITE above.
  const { error: tmAcceptErr } = kernelAccepted ? { error: null } : await sc.from("trip_members").update({ role: "member" }).eq("trip_id", tripId).eq("user_id", user.id);
  if (tmAcceptErr) {
    req.log.error({ err: tmAcceptErr }, "trip invite accept update failed");
    sendError(res, "db_error", tmAcceptErr.message);
    return;
  }
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

  // Trip Kernel path (DECLINE_INVITE, contract v2). Deletes the row exactly as
  // legacy does; the event is the durable record. Off => the direct delete below.
  const kernelDecline = await tripKernel(sc);
  let kernelDeclined = false;
  if (kernelDecline) {
    const env = readCommandEnvelope(req);
    if (!env.ok) { sendError(res, "invalid_payload", env.message); return; }
    const r = await executeTripCommand(kernelDecline, {
      commandId: randomUUID(),
      tripId,
      actorUserId: user.id,
      expectedTripVersion: env.expectedTripVersion,
      idempotencyKey: env.idempotencyKey,
      type: "DECLINE_INVITE",
      payload: {},
    });
    if (!r.ok) { sendKernelRejection(res, r, req.log); return; }
    setTripVersionHeader(res, r.version);
    kernelDeclined = true;
  }

  // trip-kernel:legacy-path — the flag-off twin of DECLINE_INVITE above.
  const { error: tiDeclineErr } = kernelDeclined ? { error: null } : await sc.from("trip_members")
    .delete().eq("trip_id", tripId).eq("user_id", user.id);
  if (tiDeclineErr) { sendError(res, "db_error", "Failed to decline trip invite", { exposeDetail: true }); return; }

  // Anti-retaliation cooldown: trip owner cannot re-invite for 48 hours after a decline
  const tiPermSc = getServiceClient();
  if (tiPermSc) {
    const { data: ownerRow } = await tiPermSc.from("trip_members")
      .select("user_id").eq("trip_id", tripId).eq("role", "owner").maybeSingle();
    if (ownerRow?.user_id) {
      const tiCooldownExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      await tiPermSc.from("user_interaction_cooldowns").upsert({
        user_id:        ownerRow.user_id,
        target_user_id: user.id,
        cooldown_type:  "trip_invite",
        expires_at:     tiCooldownExpiry,
      }, { onConflict: "user_id,target_user_id,cooldown_type" }).then(undefined, () => {});
    }
  }

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

  // Trip Kernel path (REMOVE_PARTICIPANT, contract v2). The owner check above
  // is the authorization; the kernel re-checks owner and refuses the owner's
  // own row. The event records role_at_removal = 'invited', which is how a
  // consumer tells "invite cancelled" from "member removed". Off => the direct
  // delete below, exactly as before (its error was never read; the kernel's is).
  const kernelCancel = await tripKernel(sc);
  let kernelCancelled = false;
  if (kernelCancel) {
    const env = readCommandEnvelope(req);
    if (!env.ok) { sendError(res, "invalid_payload", env.message); return; }
    const r = await executeTripCommand(kernelCancel, {
      commandId: randomUUID(),
      tripId,
      actorUserId: user.id,
      expectedTripVersion: env.expectedTripVersion,
      idempotencyKey: env.idempotencyKey,
      type: "REMOVE_PARTICIPANT",
      payload: { user_id: inviteeId },
    });
    if (!r.ok) { sendKernelRejection(res, r, req.log); return; }
    setTripVersionHeader(res, r.version);
    kernelCancelled = true;
  }

  // trip-kernel:legacy-path — the flag-off twin of REMOVE_PARTICIPANT above.
  if (!kernelCancelled) await sc.from("trip_members").delete().eq("trip_id", tripId).eq("user_id", inviteeId);
  res.status(200).json({ status: "cancelled", tripId, inviteeId });
});

export default router;
