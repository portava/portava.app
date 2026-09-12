/**
 * Trips spec §19.2 — the internal API's read surface, as projections.
 *
 *   GET /trips/:id/timeline   TripTimelineProjection   (§19.1)
 *   GET /trips/:id/map        TripMapProjection        (§14.1; alias of /map-projection)
 *   GET /trips/:id/crew       TripCrewProjection       (§10 cards + envelope)
 *   GET /trips/:id/context    TripCompassProjection    (§19.1; Compass consumes the same object)
 *   GET /trips/:id/safety     TripSafetyProjection     (§17.4)
 *
 * `/today` is §11.1's and is not here: its inputs (the Temporal Freedom
 * Engine, §7.3) do not exist yet, and a `/today` that returned the plan under
 * another name would be the "different path, same list" finding that
 * census-trips TR371/TR373 already made about `/plan/map` and `/plan`.
 *
 * WHAT MAKES THESE PROJECTIONS AND NOT ENDPOINTS
 * ==============================================
 * Every response spreads one `TripProjectionEnvelope` (services/trips/
 * TripProjectionEnvelope.ts): `projectionSchemaVersion`, `generatedAt`,
 * `sourceTripVersion`, `freshness`. The version is read BEFORE the rows —
 * routes/tripMapProjection.ts established the order — so it names the state
 * the rows were read against. When it cannot be read, `freshness` says
 * "unattributable" and the projection is served anyway; when the rows a
 * projection IS cannot be read, the request is refused with a
 * `TRIP_PROJECTION_UNAVAILABLE` reason, because a projection assembled from a
 * failed read is a claim about the trip that nobody made.
 *
 * THE OLD ENDPOINTS STAY
 * ======================
 * `/plan`, `/plan/map`, `/crew/map` and `/map-projection` keep their shapes.
 * The client that groups `/plan` into days on its own is not broken by a
 * server that also can; it is given something better to read.
 *
 * AUTHORIZATION
 * =============
 * The same gate the surface each projection is built from already applies:
 * accepted crew for the timeline, context and safety (as `/plan`); any
 * membership including invited for the crew projection (as `/crew/map`, whose
 * header explains why an invitee may see who else is coming). Refusals carry
 * Appendix B reasons (lib/tripReasonCodes.ts).
 */
import { Router } from "express";

import { requireUser, requireTripMember, sendError, canEditPlan } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendTripRefusal } from "../lib/tripReasonCodes.js";
import { toCamel } from "./plan.js";
import { computeWarnings } from "./trips.js";
import { serveMapProjection } from "./tripMapProjection.js";
import { liveEnvelope, readTripVersion } from "../services/trips/TripProjectionEnvelope.js";
import { buildTripTimeline } from "../services/trips/TripTimelineProjection.js";
import { projectTripSafety, type SafetySessionRow } from "../services/trips/TripSafetyProjection.js";
import { buildTripCompassProjection } from "../services/trips/TripCompassProjection.js";
import { getCrewMap, CrewMapUnavailableError } from "../services/tripCrew/TripCrewLocationService.js";

const router = Router();
const log = logger.child({ mod: "tripProjections" });
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** The columns `GET /trips/:tripId/plan` reads — the same list, so the two cannot disagree about an item. */
const PLAN_ITEM_COLUMNS =
  "id, trip_id, creator_id, title, category, status, source_type, source_id, " +
  "day_date, starts_at, ends_at, location_name, notes, sort_order, visibility, " +
  "lock_type, location_is_private, lat, lng, created_at, updated_at";

/** Safe Return statuses that have a §17.4 operational state. `pending`/`cancelled` do not. */
const OPERATIONAL_SAFE_RETURN_STATUSES = ["active", "missed", "safe"];

// ── GET /trips/:tripId/timeline ───────────────────────────────────────────────

router.get("/trips/:tripId/timeline", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to view the timeline"); return; }

  // Version and dates from ONE row, first. An unreadable trips row is refused
  // outright (as /plan does): the dates decide the warnings and the days, so
  // there is no honest timeline without them.
  const { data: trip, error: tripErr } = await sc
    .from("trips")
    .select("start_date, end_date, version")
    .eq("id", tripId)
    .maybeSingle();
  if (tripErr) {
    log.warn({ err: tripErr.message, tripId }, "timeline: trip unreadable — refusing");
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "We could not read this trip's dates right now, so the timeline cannot be built. Please try again shortly.");
    return;
  }
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const t = trip as any;
  const tripStartDate: string | null = t.start_date ?? null;
  const tripEndDate: string | null = t.end_date ?? null;
  const sourceTripVersion: number | null = typeof t.version === "number" ? t.version : null;

  const editAllowed = await canEditPlan(sc, tripId, user.id);

  const { data, error } = await sc
    .from("trip_plan_items")
    .select(PLAN_ITEM_COLUMNS)
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .order("day_date", { ascending: true, nullsFirst: false })
    .order("starts_at", { ascending: true, nullsFirst: false })
    .order("sort_order", { ascending: true });
  if (error) {
    log.warn({ err: error.message, tripId }, "timeline: plan items unreadable — refusing");
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "The plan could not be read right now. Please try again shortly.");
    return;
  }
  const rows = ((data ?? []) as any[]);

  // Cancelled source meetups, exactly as /plan: an unreadable `meetups` read
  // would leave this set empty, which is what "nothing was cancelled" looks
  // like, so it refuses rather than assumes.
  const meetupSourceIds = rows.filter((i) => i.source_type === "meetup" && i.source_id).map((i) => i.source_id as string);
  const cancelledMeetupIds = new Set<string>();
  if (meetupSourceIds.length > 0) {
    const { data: meetups, error: meetupsErr } = await sc.from("meetups").select("id, status").in("id", meetupSourceIds);
    if (meetupsErr) {
      log.warn({ err: meetupsErr.message, tripId }, "timeline: source meetups unreadable — refusing");
      sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "We could not check whether the events behind this plan are still on. Please try again shortly.");
      return;
    }
    for (const m of ((meetups ?? []) as any[])) if (m.status === "cancelled") cancelledMeetupIds.add(m.id);
  }

  const warnMap = computeWarnings(rows, tripStartDate, tripEndDate, cancelledMeetupIds);
  const items = rows.map((row) => toCamel(row, { warnings: warnMap.get(row.id) ?? [] }));
  const timeline = buildTripTimeline(items, { tripStartDate, tripEndDate });

  res.json({
    ...liveEnvelope(sourceTripVersion),
    tripId,
    tripStartDate,
    tripEndDate,
    canEdit: editAllowed === true,
    itemCount: rows.length,
    ...timeline,
  });
}));

// ── GET /trips/:tripId/map — §19.2's path for the §14.1 projection ───────────

router.get("/trips/:tripId/map", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  await serveMapProjection(req, res, auth);
}));

// ── GET /trips/:tripId/crew ───────────────────────────────────────────────────

router.get("/trips/:tripId/crew", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Same flag, same order, same degraded shape as /crew/map — plus the
  // envelope, with `freshness: "unattributable"` because nothing was read.
  if (!await isFlagEnabled(sc, "trip_crew_map_enabled")) {
    res.status(200).json({
      ...liveEnvelope(null), tripId, featureEnabled: false, members: [], totalCount: 0,
      reading: "trip_crew_map_enabled is off; no crew was read",
    });
    return;
  }

  // Invited members may see who else is coming (routes/tripCrewLocation.ts header).
  const membership = await requireTripMember(sc, tripId, user.id, { status: "any" });
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "Only trip members (including invited) can view the crew projection"); return; }

  const sourceTripVersion = await readTripVersion(sc, tripId);
  try {
    const result = await getCrewMap(sc, tripId, user.id);
    res.status(200).json({ ...liveEnvelope(sourceTripVersion), tripId, featureEnabled: true, ...result });
  } catch (err) {
    // getCrewMap refuses (503, retryable) when an input it cannot answer
    // without could not be read; the global handler reads the status/code it
    // carries. Everything else stays a 500. Same as /crew/map.
    if (err instanceof CrewMapUnavailableError) {
      log.warn({ err, tripId }, "crew projection: input unavailable — refusing");
      throw err;
    }
    throw err;
  }
}));

// ── GET /trips/:tripId/context ────────────────────────────────────────────────

router.get("/trips/:tripId/context", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to view the trip context"); return; }

  const built = await buildTripCompassProjection(sc, tripId);
  if (!built.ok) {
    if (built.reason === "TRIP_NOT_FOUND") { sendError(res, "not_found", built.message); return; }
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", built.message);
    return;
  }
  res.json(built.projection);
}));

// ── GET /trips/:tripId/safety ─────────────────────────────────────────────────

router.get("/trips/:tripId/safety", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to view the safety projection"); return; }

  // Owner and version from one row, first.
  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id, version").eq("id", tripId).maybeSingle();
  if (tripErr) {
    log.warn({ err: tripErr.message, tripId }, "safety: trip unreadable — refusing");
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "The trip could not be read right now. Please try again shortly.");
    return;
  }
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const ownerId: string | null = (trip as any).owner_id ?? null;
  const sourceTripVersion: number | null = typeof (trip as any).version === "number" ? (trip as any).version : null;

  // The roster decides whose session is this trip's. REFUSE when it cannot be
  // read — a roster of "the owner and nobody else" is a claim, not a fallback.
  const { data: members, error: membersErr } = await sc
    .from("trip_members")
    .select("user_id, status")
    .eq("trip_id", tripId)
    .in("role", ["owner", "co_host", "member", "viewer"]);
  if (membersErr) {
    log.warn({ err: membersErr.message, tripId }, "safety: trip_members unreadable — refusing");
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "The crew could not be read right now. Please try again shortly.");
    return;
  }
  const crewIds = new Set<string>(ownerId ? [ownerId] : []);
  for (const m of ((members ?? []) as any[])) {
    if (m.status == null || m.status === "accepted") crewIds.add(String(m.user_id));
  }

  // The safety-critical read. An unreadable table would say NOBODY is walking
  // home when the truth is "we could not look" (the crew map's reasoning,
  // services/tripCrew/TripCrewLocationService.ts) — refused, not emptied.
  const { data: sessions, error: sessionsErr } = await sc
    .from("safe_return_sessions")
    .select("id, user_id, trip_id, status, escalation_level, timer_start_at, timer_end_at, notify_trip_crew_enabled, closed_at, updated_at")
    .eq("trip_id", tripId)
    .in("status", OPERATIONAL_SAFE_RETURN_STATUSES);
  if (sessionsErr) {
    log.warn({ err: sessionsErr.message, tripId }, "safety: safe_return_sessions unreadable — refusing");
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "Safe Return status could not be read right now. Please try again shortly.");
    return;
  }

  // Each member's own answer to "may the crew see my Safe Return status".
  // Unreadable means the disclosure rule is unknown for everyone — refused.
  const { data: prefs, error: prefsErr } = await sc
    .from("trip_crew_location_preferences")
    .select("user_id, share_safe_return_status")
    .eq("trip_id", tripId);
  if (prefsErr) {
    log.warn({ err: prefsErr.message, tripId }, "safety: trip_crew_location_preferences unreadable — refusing");
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "Sharing preferences could not be read right now. Please try again shortly.");
    return;
  }
  const sharePrefs = new Map<string, boolean>();
  for (const p of ((prefs ?? []) as any[])) sharePrefs.set(String(p.user_id), p.share_safe_return_status === true);

  res.json(projectTripSafety(
    { tripId, viewerId: user.id, crewIds, sessions: ((sessions ?? []) as SafetySessionRow[]), sharePrefs },
    liveEnvelope(sourceTripVersion),
  ));
}));

export default router;
