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
import {
  getCrewMap,
  getCrewPreferences,
  upsertCrewPreferences,
  setGhostMode,
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
      .select("role")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .in("role", ["owner", "co_host", "member"])
      .maybeSingle();
    return member ? "member" : null;
  } catch {
    return null;
  }
}

/**
 * Like getMemberRole but also accepts 'invited' role.
 * Used for read-only crew visibility endpoints where pending invitees should be
 * able to see who else is on their trip before deciding to accept.
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
      .select("role")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .in("role", ["owner", "co_host", "member", "invited"])
      .maybeSingle();
    return member ? ((member as any).role as string) : null;
  } catch {
    return null;
  }
}

/**
 * Returns all accepted member IDs for a trip (owner + role=member rows).
 * Used to validate allowedMemberIds in live-share start.
 */
async function getAcceptedMemberIds(
  db: ReturnType<typeof getServiceClient>,
  tripId: string,
): Promise<string[]> {
  if (!db) return [];
  try {
    const [ownerRes, membersRes] = await Promise.all([
      db.from("trips").select("owner_id").eq("id", tripId).maybeSingle(),
      db.from("trip_members").select("user_id").eq("trip_id", tripId).in("role", ["owner", "co_host", "member"]),
    ]);
    const ids: string[] = [];
    const ownerId = (ownerRes.data as any)?.owner_id;
    if (ownerId) ids.push(ownerId);
    for (const row of ((membersRes.data as any[]) ?? [])) {
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
