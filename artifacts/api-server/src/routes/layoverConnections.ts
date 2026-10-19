/**
 * Layover connections from a trip's flights (census-layover L11, L21, L239,
 * L267; Layover spec §18 detectFromTrip, §25 "Trips: detect connection; show
 * Layover card/status; pass flight segments into session creation", App B.1
 * step 1). Layover 165 program, lane B1-F.
 *
 *   GET  /trips/:tripId/layover-connections            the trip's connections, each with its
 *                                                       missed-connection risk and the caller's
 *                                                       session for it (status + §4.1 state)
 *   POST /trips/:tripId/layover-connections            start the DETECTED session for one
 *                                                       connection, linked to both flights
 *   POST /trips/:tripId/flight-segments/:segmentId/status
 *                                                       the traveller's own flight update (gate,
 *                                                       terminal, delay, cancellation), through
 *                                                       the flight-status adapter: recorded on
 *                                                       the Trips segment and their linked
 *                                                       sessions recalculated
 *
 * A separate router rather than routes/airport.ts: that file is line-anchored
 * by census citations (routes/layoverConstraints.ts gives the same reason).
 *
 * GATES. `airport_mode_enabled` (the Layover feature) and
 * `layover_flight_connections_enabled` (3827, seeded FALSE) — both, read on
 * every request. OFF / absent: feature_disabled, nothing read. The status route
 * also needs `trip_flight_segments_enabled` (3826): it writes a Trips segment.
 * Every route requires trip membership; the kernel re-checks crew capability.
 */
import { Router } from "express";
import { z } from "zod";

import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { refuseIfRetainedRecordOnly } from "../lib/tripTrustGate.js";
import { readFlightSegmentsByIds, type FlightObservation, FLIGHT_STATUSES } from "../domain/trips/services/TripFlightSegments.js";
import { flightSegmentView } from "../server/trips/flightSegmentRoute.js";
import { detectFromTrip, startConnectionSession, type TripConnectionView } from "../services/airport/LayoverConnectionDetection.js";
import { applyFlightStatusUpdate } from "../services/airport/LayoverFlightStatus.js";
import { lookupByIata } from "../services/airport/AirportProfileService.js";
import { wallTimeToUtc } from "../services/airport/AirportTime.js";

const router = Router();
const log = logger.child({ mod: "layoverConnections" });
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Both gates, in the order the feature nests: Layover itself, then flight connections. */
async function connectionsOpen(sc: any): Promise<boolean> {
  return (await isFlagEnabled(sc, "airport_mode_enabled")) && (await isFlagEnabled(sc, "layover_flight_connections_enabled"));
}

/** A connection as the Trips card reads it. */
export function connectionView(c: TripConnectionView) {
  return {
    key: c.key,
    status: c.status,
    unknowns: c.unknowns,
    airport: c.airport,
    arrivalSegment: flightSegmentView(c.arrivalSegment),
    departureSegment: flightSegmentView(c.departureSegment),
    scheduledGapMinutes: c.scheduledGapMinutes,
    arrival: c.arrival,
    departure: c.departure,
    gapMinutes: c.gapMinutes,
    connectionType: c.connectionType,
    terminalChange: c.terminalChange,
    missedConnection: c.missedConnection,
    facts: c.facts,
    session: c.session,
  };
}

router.get("/trips/:tripId/layover-connections", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await connectionsOpen(sc)) { sendError(res, "feature_disabled", "Layover connections are not enabled yet"); return; }
  const membership = await requireTripMember(sc, tripId, auth.user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }
  const detected = await detectFromTrip(sc, auth.user.id, tripId);
  if (!detected.ok) {
    log.warn({ tripId, reason: detected.reason }, "layover connection detection unreadable");
    sendError(res, "degraded_unavailable", "This trip's connections could not be read. Please try again.");
    return;
  }
  res.json({
    ok: true,
    connections: detected.connections.map(connectionView),
    degraded: detected.degradedReasons.length > 0,
    degradedReasons: detected.degradedReasons,
  });
}));

const startSchema = z.object({
  arrivalSegmentId: z.string().regex(UUID_RE),
  departureSegmentId: z.string().regex(UUID_RE),
}).strict();

const STATUS_FOR: Record<string, number> = {
  segments_unreadable: 503, airport_unreadable: 503, write_failed: 503,
  not_a_connection: 400, undetermined: 400, airport_unknown: 400, already_departed: 400, connection_missed: 400, window_too_long: 400,
};

router.post("/trips/:tripId/layover-connections", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await connectionsOpen(sc)) { sendError(res, "feature_disabled", "Layover connections are not enabled yet"); return; }
  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }
  if (await refuseIfRetainedRecordOnly(res, sc, tripId, user.id)) return;
  const started = await startConnectionSession(sc, { userId: user.id, tripId, ...parsed.data, nowMs: Date.now() });
  if (!started.ok) {
    const status = STATUS_FOR[started.reason] ?? 400;
    res.status(status).json({ ok: false, error: status === 503 ? "degraded_unavailable" : "invalid_payload", reason: started.reason, message: started.message, ...(started.unknowns ? { unknowns: started.unknowns } : {}) });
    return;
  }
  res.status(started.existed ? 200 : 201).json({
    ok: true,
    existed: started.existed,
    session: started.session,
    connection: { arrivalSegmentId: parsed.data.arrivalSegmentId, departureSegmentId: parsed.data.departureSegmentId, connectionType: started.connection.connectionType, detectedSource: "trip_itinerary", state: "DETECTED" },
    facts: started.facts,
  });
}));

const WALL_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/;
const nullableShort = z.union([z.string().trim().min(1).max(32), z.null()]);
const statusSchema = z.object({
  status: z.enum(FLIGHT_STATUSES).optional(),
  estimatedDepartureLocal: z.union([z.string().trim().regex(WALL_RE), z.null()]).optional(),
  estimatedArrivalLocal: z.union([z.string().trim().regex(WALL_RE), z.null()]).optional(),
  departureTerminal: nullableShort.optional(),
  arrivalTerminal: nullableShort.optional(),
  departureGate: nullableShort.optional(),
  arrivalGate: nullableShort.optional(),
}).strict();

router.post("/trips/:tripId/flight-segments/:segmentId/status", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { tripId, segmentId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(segmentId)) { sendError(res, "invalid_payload", "Invalid id"); return; }
  const parsed = statusSchema.safeParse(req.body ?? {});
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload"); return; }
  const b = parsed.data;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await connectionsOpen(sc) || !await isFlagEnabled(sc, "trip_flight_segments_enabled")) { sendError(res, "feature_disabled", "Flight updates are not enabled yet"); return; }
  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }
  if (await refuseIfRetainedRecordOnly(res, sc, tripId, user.id)) return;
  const seg = await readFlightSegmentsByIds(sc, [segmentId]);
  if (!seg.ok) { sendError(res, "degraded_unavailable", "This flight could not be loaded. Please try again."); return; }
  const flight = seg.segments.find((s) => s.tripId === tripId);
  if (!flight) { sendError(res, "not_found", "No such flight on this trip"); return; }

  // A local wall time is converted in ITS airport's zone, or refused. Never as UTC.
  const observation: FlightObservation = {};
  for (const [key, wall, iata] of [
    ["estimatedDepartureAt", b.estimatedDepartureLocal, flight.departureAirport],
    ["estimatedArrivalAt", b.estimatedArrivalLocal, flight.arrivalAirport],
  ] as const) {
    if (wall === undefined) continue;
    if (wall === null) { observation[key] = null; continue; }
    const looked = iata ? await lookupByIata(sc, iata) : null;
    if (looked?.kind === "degraded") { sendError(res, "degraded_unavailable", "Airport details could not be loaded. Please try again."); return; }
    const tz = looked?.kind === "read" ? looked.value.airport?.timezone : null;
    if (!tz) { sendError(res, "invalid_payload", "This flight's airport has no known time zone, so a local time there cannot be read."); return; }
    const at = wallTimeToUtc(tz, wall);
    if (!at) { sendError(res, "invalid_payload", `${key} is not a valid local time`); return; }
    observation[key] = at.toISOString();
  }
  for (const k of ["departureTerminal", "arrivalTerminal", "departureGate", "arrivalGate"] as const) if (b[k] !== undefined) observation[k] = b[k];
  if (b.status !== undefined) observation.status = b.status;

  const nowMs = Date.now();
  const applied = await applyFlightStatusUpdate(sc, {
    source: "traveller", segmentId, actorUserId: user.id, observedAt: new Date(nowMs).toISOString(), observation,
  }, { nowMs });
  if (!applied.ok) {
    const status = applied.reason === "invalid_update" ? 400 : applied.reason === "feature_disabled" ? 403 : 503;
    res.status(status).json({ ok: false, error: status === 400 ? "invalid_payload" : status === 403 ? "feature_disabled" : "degraded_unavailable", reason: applied.reason, message: applied.message });
    return;
  }
  const outcome = applied.segments[0];
  if (!outcome || !outcome.recorded) {
    const refusal = outcome?.refusal ?? "segment_not_found";
    const status = refusal === "TRIP_AUTH_NOT_CREW" ? 403 : refusal === "TRIP_FLIGHT_STATUS_STALE" ? 409 : refusal === "TRIP_KERNEL_UNAVAILABLE" ? 503 : 400;
    res.status(status).json({ ok: false, error: status === 403 ? "forbidden" : status === 409 ? "conflict" : status === 503 ? "degraded_unavailable" : "invalid_payload", reason: refusal });
    return;
  }
  res.json({ ok: true, outcome });
}));

export default router;
