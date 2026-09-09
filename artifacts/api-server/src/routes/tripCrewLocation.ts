/**
 * Trip Crew Location routes
 *
 * Most endpoints require the caller to be an ACCEPTED trip member (owner or
 * accepted member). Pending invites and removed members receive 403 for
 * mutation endpoints (ghost-mode, live-share, preferences).
 *
 * Exception — GET /trips/:tripId/crew/map:
 *   Invited (pending) members are also permitted so they can see who else is
 *   on the trip before deciding to accept the invitation.
 *
 * Exact coordinates are never returned — all responses use blurred area labels.
 *
 * GET  /api/trips/:tripId/crew/map
 * GET  /api/trips/:tripId/crew/location-preferences
 * PUT  /api/trips/:tripId/crew/location-preferences
 * POST /api/trips/:tripId/crew/ghost-mode/enable
 * POST /api/trips/:tripId/crew/ghost-mode/disable
 * POST /api/trips/:tripId/crew/live-share/start
 * POST /api/trips/:tripId/crew/live-share/stop
 * GET  /api/trips/:tripId/crew/live-shares
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { getRestrictionState } from "../services/trust/TrustRestrictionService.js";
import {
  getCrewMap,
  getCrewPreferences,
  upsertCrewPreferences,
  setGhostMode,
  CrewMapUnavailableError,
} from "../services/tripCrew/TripCrewLocationService.js";
import {
  startLiveShare,
  stopLiveShare,
  getActiveLiveShares,
} from "../services/tripCrew/TripCrewLiveShareService.js";

const router = Router();

// ── requireTripMember middleware ──────────────────────────────────────────────

/**
 * Returns 'owner' | 'member' | null.
 * Only 'owner' and 'member' (accepted) are granted access.
 * Pending invites, removed members, and non-members get null → 403.
 *
 * "PENDING" IS ENCODED TWICE, AND THIS USED TO CHECK ONLY ONE OF THEM.
 * trip_members carries pending state in BOTH columns:
 *   role   — the legacy encoding; role='invited' is a pending invite, which
 *            routes/invites flips to 'member' on accept. The role filter below
 *            already excluded it.
 *   status — text NOT NULL DEFAULT 'accepted'; status='invited' is a pending
 *            invite under the newer encoding. This function never read it, so
 *            a row of {role:'member', status:'invited'} passed every check and
 *            the doc comment above was false. Production holds exactly one such
 *            row, and this function gates seven crew-location endpoints.
 *
 * The rule now matches requireTripMember (lib/http.ts:430-478), which is the
 * definition of record: coalesce(status,'accepted') = 'accepted'. Status is
 * selected and compared in JS rather than filtered in PostgREST because
 * coalesce-on-a-nullable-column is awkward to express as a filter and easy to
 * get subtly wrong; the row count here is at most one.
 *
 * DELIBERATELY NOT WIDENED: requireTripMember also accepts 'viewer', and
 * migration 2337 widened the RLS policies to match it. This function keeps its
 * narrower owner/co_host/member set, because widening it would GRANT crew
 * location access to a role that does not have it today. Route stricter than
 * RLS is the safe direction; the reverse is not.
 */
async function getMemberRole(
  db: ReturnType<typeof getServiceClient>,
  tripId: string,
  userId: string,
): Promise<"owner" | "member" | null> {
  if (!db) return null;
  try {
    const { data: trip } = await db
      .from("trips")
      .select("owner_id")
      .eq("id", tripId)
      .maybeSingle();
    if ((trip as any)?.owner_id === userId) return "owner";

    const { data: member } = await db
      .from("trip_members")
      .select("role, status")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .in("role", ["owner", "co_host", "member"])
      .maybeSingle();
    if (!member) return null;
    // A read error leaves `member` undefined and returns null above, so this
    // path stays fail-closed (403) rather than fail-open — unlike the
    // resolves-on-error pattern that opened guards elsewhere in this tree.
    const status = (member as any).status ?? "accepted";
    if (status !== "accepted") return null;
    return "member";
  } catch {
    return null;
  }
}

/**
 * The statuses a trip_members row may carry, from migration 0078:
 *   status TEXT NOT NULL DEFAULT 'accepted'
 *          CHECK (status IN ('invited','accepted','declined','removed','left'))
 * A row that is not one of the two "still on the trip" states below describes a
 * person who is GONE — they declined, they were removed, or they left — and the
 * role column does not change when that happens (REMOVE_PARTICIPANT records the
 * role at removal; see migration 2450). So a rule that reads role and not status
 * cannot tell a member from an ex-member. `null`/absent is treated as 'accepted'
 * for pre-0078 rows, exactly as requireTripMember (lib/http.ts) does.
 */
const STILL_ON_TRIP_STATUSES = ["accepted", "invited"];

/** True when a trip_members row's status means the person is still on the trip. */
function statusStillOnTrip(row: any): boolean {
  const status = (row as any)?.status;
  return status == null || STILL_ON_TRIP_STATUSES.includes(String(status));
}

/**
 * Like getMemberRole but also accepts 'invited' role.
 * Used for read-only crew visibility endpoints where pending invitees should be
 * able to see who else is on their trip before deciding to accept.
 *
 * THE STATUS GATE, AND WHY IT IS WIDER HERE THAN IN getMemberRole.
 * This function read ROLE ONLY, so {role:'member', status:'removed'} — the
 * shape a removed member's row keeps — passed it, and the crew map served the
 * trip's roster and area labels to someone taken off the trip. That contradicts
 * this file's own header ("Pending invites and removed members receive 403").
 * getMemberRole demands status === 'accepted'; this one also admits 'invited',
 * because admitting PENDING invitees is this endpoint's documented purpose. The
 * three statuses it now rejects — declined, removed, left — are the ones that
 * mean the person is off the trip, and none of them was ever meant in.
 */
async function getMemberRoleAny(
  db: ReturnType<typeof getServiceClient>,
  tripId: string,
  userId: string,
): Promise<string | null> {
  if (!db) return null;
  try {
    const { data: trip } = await db
      .from("trips")
      .select("owner_id")
      .eq("id", tripId)
      .maybeSingle();
    if ((trip as any)?.owner_id === userId) return "owner";

    const { data: member } = await db
      .from("trip_members")
      .select("role, status")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .in("role", ["owner", "co_host", "member", "invited"])
      .maybeSingle();
    // A read error leaves `member` null and returns null below, so this path
    // stays fail-closed (403) — the same disposition getMemberRole records.
    if (!member) return null;
    if (!statusStillOnTrip(member)) return null;
    return (member as any).role as string;
  } catch {
    return null;
  }
}

/**
 * Returns all accepted member IDs for a trip (owner + accepted member rows).
 * Used to validate allowedMemberIds in live-share start.
 *
 * THIS IS AN ALLOW-LIST FOR EXACT COORDINATES, and it filtered by role alone.
 * A live-share recipient is precisely who getCrewMap will hand exact lat/lng to
 * (TripCrewLocationService step 7 → buildCrewCard), so a removed member named
 * here kept receiving the sharer's position for the life of the share — while
 * the route rejected everyone ELSE with the words "not accepted trip members".
 * `status` is compared in JS rather than filtered in PostgREST for the same
 * reason getMemberRole does it: coalesce-on-a-nullable-column is awkward to
 * express as a filter and easy to get subtly wrong.
 *
 * Note this set is deliberately NARROWER than getMemberRoleAny's: a pending
 * invitee may LOOK at the crew map, but may not be given a live-share grant.
 */
async function getAcceptedMemberIds(
  db: ReturnType<typeof getServiceClient>,
  tripId: string,
): Promise<string[]> {
  if (!db) return [];
  try {
    const [ownerRes, membersRes] = await Promise.all([
      db.from("trips").select("owner_id").eq("id", tripId).maybeSingle(),
      db.from("trip_members").select("user_id, status").eq("trip_id", tripId).in("role", ["owner", "co_host", "member"]),
    ]);
    const ids: string[] = [];
    const ownerId = (ownerRes.data as any)?.owner_id;
    if (ownerId) ids.push(ownerId);
    for (const row of ((membersRes.data as any[]) ?? [])) {
      if (String((row as any).status ?? "accepted") !== "accepted") continue;
      if (row.user_id && !ids.includes(row.user_id)) ids.push(row.user_id);
    }
    return ids;
  } catch {
    return [];
  }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const VISIBILITY_VALUES = ["hidden", "city_only", "neighborhood", "nearby", "arrived_only"] as const;
const SHARE_DURATIONS = ["15m", "30m", "1h", "plan_end"] as const;
const LIVE_SHARE_VISIBILITY = ["city_only", "neighborhood", "nearby"] as const;

const prefsSchema = z.object({
  defaultVisibility:      z.enum(VISIBILITY_VALUES).optional(),
  ghostModeEnabled:       z.boolean().optional(),
  shareArrivalStatus:     z.boolean().optional(),
  shareSafeReturnStatus:  z.boolean().optional(),
});

const liveShareSchema = z.object({
  duration:         z.enum(SHARE_DURATIONS),
  visibilityLevel:  z.enum(LIVE_SHARE_VISIBILITY).optional(),
  allowedMemberIds: z.array(z.string()).min(1, "At least one recipient required"),
  planEndAt:        z.string().datetime().optional().nullable(),
});

// ── GET /api/trips/:tripId/crew/map ───────────────────────────────────────────

router.get("/trips/:tripId/crew/map", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: db, user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  if (!await isFlagEnabled(sc, "trip_crew_map_enabled")) {
    res.status(200).json({ featureEnabled: false, members: [], totalCount: 0 });
    return;
  }

  const { tripId } = req.params;
  const role = await getMemberRoleAny(sc, tripId, user.id);
  if (!role) {
    sendError(res, "not_member", "Only trip members (including invited) can view crew location data");
    return;
  }

  try {
    const result = await getCrewMap(sc, tripId, user.id);
    res.status(200).json({ featureEnabled: true, ...result });
  } catch (err) {
    // getCrewMap refuses with CrewMapUnavailableError (503
    // degraded_unavailable, retryable) when an input it cannot answer without
    // could not be READ. Flattening that into db_error (500, not retryable)
    // would tell the client its request failed when the truth is "ask again" —
    // so the refusal is re-thrown for the global handler, which reads the
    // `status`/`code` it carries. Everything else stays a 500.
    if (err instanceof CrewMapUnavailableError) {
      req.log.warn({ err, tripId }, "crew/map: input unavailable — refusing");
      throw err;
    }
    req.log.error({ err }, "crew/map: failed");
    sendError(res, "db_error", "Failed to load crew map", { exposeDetail: true });
  }
});

// ── GET /api/trips/:tripId/crew/location-preferences ─────────────────────────

router.get("/trips/:tripId/crew/location-preferences", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { tripId } = req.params;
  const role = await getMemberRole(sc, tripId, user.id);
  if (!role) {
    sendError(res, "not_member", "Only accepted trip members can view crew preferences");
    return;
  }

  try {
    const prefs = await getCrewPreferences(sc, tripId, user.id);
    res.status(200).json(prefs);
  } catch (err) {
    req.log.error({ err }, "crew/location-preferences GET: failed");
    sendError(res, "db_error", "Failed to load preferences", { exposeDetail: true });
  }
});

// ── PUT /api/trips/:tripId/crew/location-preferences ─────────────────────────

router.put("/trips/:tripId/crew/location-preferences", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const parsed = prefsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { tripId } = req.params;
  const role = await getMemberRole(sc, tripId, user.id);
  if (!role) {
    sendError(res, "not_member", "Only accepted trip members can update crew preferences");
    return;
  }

  const result = await upsertCrewPreferences(sc, tripId, user.id, parsed.data);
  if (!result.ok) { sendError(res, "db_error", result.error); return; }
  res.status(200).json({ ok: true });
});

// ── POST /api/trips/:tripId/crew/ghost-mode/enable ───────────────────────────

router.post("/trips/:tripId/crew/ghost-mode/enable", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  if (!await isFlagEnabled(sc, "trip_crew_ghost_mode_enabled")) {
    sendError(res, "feature_disabled", "Ghost Mode is not enabled");
    return;
  }

  const { tripId } = req.params;
  const role = await getMemberRole(sc, tripId, user.id);
  if (!role) { sendError(res, "not_member"); return; }

  const result = await setGhostMode(sc, tripId, user.id, true);
  if (!result.ok) { sendError(res, "db_error", result.error); return; }

  // Write audit event (best-effort)
  {
    const { error: evtError } = await sc.from("trip_crew_location_events").insert({
      trip_id: tripId,
      user_id: user.id,
      event_type: "ghost_mode_on",
      metadata: {},
    });
    if (evtError) req.log.warn({ err: evtError, tripId }, "ghost_mode_on event insert failed (best-effort)");
  }

  res.status(200).json({ ok: true });
});

// ── POST /api/trips/:tripId/crew/ghost-mode/disable ──────────────────────────

router.post("/trips/:tripId/crew/ghost-mode/disable", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  if (!await isFlagEnabled(sc, "trip_crew_ghost_mode_enabled")) {
    sendError(res, "feature_disabled", "Ghost Mode is not enabled");
    return;
  }

  const { tripId } = req.params;
  const role = await getMemberRole(sc, tripId, user.id);
  if (!role) { sendError(res, "not_member"); return; }

  const result = await setGhostMode(sc, tripId, user.id, false);
  if (!result.ok) { sendError(res, "db_error", result.error); return; }

  // best-effort
  {
    const { error: evtError } = await sc.from("trip_crew_location_events").insert({
      trip_id: tripId,
      user_id: user.id,
      event_type: "ghost_mode_off",
      metadata: {},
    });
    if (evtError) req.log.warn({ err: evtError, tripId }, "ghost_mode_off event insert failed (best-effort)");
  }

  res.status(200).json({ ok: true });
});

// ── POST /api/trips/:tripId/crew/live-share/start ─────────────────────────────

router.post("/trips/:tripId/crew/live-share/start", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  if (!await isFlagEnabled(sc, "trip_crew_live_share_enabled")) {
    sendError(res, "feature_disabled", "Live sharing is not enabled");
    return;
  }

  const parsed = liveShareSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { tripId } = req.params;
  const role = await getMemberRole(sc, tripId, user.id);
  if (!role) { sendError(res, "not_member"); return; }

  // ── Trust: location_plan_join, the other restriction nothing enforced ──────
  //
  // "cannot join location-based plans" (TrustRestrictionService:8). Like
  // private_plan_access it reached the user as a Passport capability chip and
  // was enforced NOWHERE (census-trust A13). Starting a live location share with
  // a trip's crew is the location-based join this type names: it is the moment a
  // restricted user begins broadcasting their position to a group, which is the
  // harm the restriction exists to prevent.
  //
  // Gated on START only, never on STOP — a restricted user must always be able
  // to stop sharing.
  //
  // No degraded branch, for the reason stated on the private-plan gate in
  // routes/trips.ts: this type fails OPEN inside getRestrictionState by design,
  // so canJoinLocationPlans is `true` on an unreadable read and the gate cannot
  // fire on one.
  const locTrust = await getRestrictionState(sc, user.id);
  if (!locTrust.canJoinLocationPlans) {
    res.status(403).json({
      error: "trust_restriction",
      message: "Your account is currently restricted from joining location-based plans.",
    });
    return;
  }

  const { duration, visibilityLevel, allowedMemberIds, planEndAt } = parsed.data;

  // Validate allowedMemberIds are accepted members of this trip (not pending/non-members)
  const acceptedMemberIds = await getAcceptedMemberIds(sc, tripId);
  const invalid = allowedMemberIds.filter((id) => !acceptedMemberIds.includes(id));
  if (invalid.length > 0) {
    sendError(res, "invalid_payload", `These user IDs are not accepted trip members: ${invalid.join(", ")}`);
    return;
  }

  const result = await startLiveShare(sc, {
    tripId,
    userId: user.id,
    duration,
    visibilityLevel,
    allowedMemberIds,
    planEndAt,
  });

  if (!result.ok) { sendError(res, "db_error", result.error); return; }
  res.status(201).json({ ok: true, sessionId: result.sessionId, expiresAt: result.expiresAt });
});

// ── POST /api/trips/:tripId/crew/live-share/stop ──────────────────────────────

router.post("/trips/:tripId/crew/live-share/stop", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { tripId } = req.params;
  const role = await getMemberRole(sc, tripId, user.id);
  if (!role) { sendError(res, "not_member"); return; }

  const result = await stopLiveShare(sc, tripId, user.id);
  if (!result.ok) { sendError(res, "db_error", result.error); return; }
  res.status(200).json({ ok: true });
});

// ── GET /api/trips/:tripId/crew/live-shares ───────────────────────────────────

router.get("/trips/:tripId/crew/live-shares", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { tripId } = req.params;
  const role = await getMemberRole(sc, tripId, user.id);
  if (!role) { sendError(res, "not_member"); return; }

  try {
    const liveShares = await getActiveLiveShares(sc, tripId, user.id);
    res.status(200).json({ liveShares });
  } catch (err) {
    req.log.error({ err }, "crew/live-shares GET: failed");
    sendError(res, "db_error", "Failed to load live shares", { exposeDetail: true });
  }
});

export default router;
