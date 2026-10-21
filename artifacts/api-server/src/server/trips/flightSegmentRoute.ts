/**
 * Trips flight segments — the traveller's own itinerary entry for a flight
 * (Layover spec §3 "Trips owns flight segments"; census-layover L11, L267).
 *
 *   GET  /trips/:tripId/flight-segments   the trip's flights, every unknown explicit
 *   POST /trips/:tripId/flight-segments   add one flight (ADD_TRANSPORT_SEGMENT, mode 'flight')
 *
 * WHY A TYPED ROUTE AND NOT ONLY POST /trips/:id/commands. A flight is entered
 * in each AIRPORT'S local time ("BA286 leaves SFO 16:40, lands LHR 10:55"), and
 * the kernel stores instants. Converting a wall time needs the airport's zone,
 * which the server knows (airport_profiles, else the static dataset) and the
 * phone does not. A wall time for an airport whose zone is unknown is REFUSED by
 * name, never converted as UTC — the same rule POST /airport/sessions applies.
 * The write itself is the kernel's, exactly as through the commands endpoint:
 * the verified token is the actor, the route checks membership, the kernel
 * re-checks crew capability, the Idempotency-Key header makes a retry the same
 * command.
 *
 * FLAG `trip_flight_segments_enabled` (3826, seeded FALSE). OFF / absent: both
 * routes answer feature_disabled and touch nothing — the flag row's existence
 * is also what says 3826's columns are there.
 *
 * This file computes no deadline and no risk (§3: Trips "must not own layover
 * safety calculations"); a connection between two of these flights is the
 * Layover domain's (routes/layoverConnections.ts).
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requireUser, requireTripMember, sendError } from "../../lib/http.js";
import { getServiceClient } from "../../lib/supabase.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { logger } from "../../lib/logger.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { executeTripCommand, readCommandEnvelope } from "../../domain/trips/commands/tripKernel.js";
import { refuseIfRetainedRecordOnly } from "../../lib/tripTrustGate.js";
import {
  addFlightSegmentPayload, bestKnownArrival, bestKnownDeparture, parseDesignator, readTripFlightSegments,
  rowToFlightSegment, type FlightSegment,
} from "../../domain/trips/services/TripFlightSegments.js";
import { lookupByIata } from "../../services/airport/AirportProfileService.js";
import { wallTimeToUtc } from "../../services/airport/AirportTime.js";

const router = Router();
const log = logger.child({ mod: "tripFlightSegments" });

export const TRIP_FLIGHT_SEGMENTS_FLAG = "trip_flight_segments_enabled";
const UUID_RE = /^[0-9a-f-]{36}$/i;
const IATA_RE = /^[A-Za-z]{3}$/;
const WALL_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/;
/** The longest scheduled flights are under 19 hours; a "flight" longer than a day is a typo. */
export const MAX_FLIGHT_MINUTES = 24 * 60;

const short = z.string().trim().min(1).max(32);
export const addFlightSchema = z.object({
  flight: z.string().trim().min(3).max(10),
  departureAirport: z.string().trim().regex(IATA_RE, "departureAirport must be a 3-letter IATA code"),
  arrivalAirport: z.string().trim().regex(IATA_RE, "arrivalAirport must be a 3-letter IATA code"),
  departureLocal: z.string().trim().regex(WALL_RE, "departureLocal must be YYYY-MM-DDTHH:mm in the departure airport's time"),
  arrivalLocal: z.string().trim().regex(WALL_RE, "arrivalLocal must be YYYY-MM-DDTHH:mm in the arrival airport's time"),
  departureTerminal: short.optional(),
  arrivalTerminal: short.optional(),
  departureGate: short.optional(),
  arrivalGate: short.optional(),
  bookingRef: z.string().trim().min(1).max(64).optional(),
  legId: z.string().regex(UUID_RE).optional(),
}).strict();

/** A flight as the client reads it: the segment plus its best-known times WITH their basis. */
export function flightSegmentView(s: FlightSegment) {
  return { ...s, bestKnownDeparture: bestKnownDeparture(s), bestKnownArrival: bestKnownArrival(s) };
}

type ZoneRead = { ok: true; timezone: string } | { ok: false; status: number; error: "degraded_unavailable" | "invalid_payload"; message: string };

/** An airport's IANA zone, or a refusal that says why. A degraded read refuses: a fallback zone is a guess. */
async function airportZone(sc: any, iata: string): Promise<ZoneRead> {
  const looked = await lookupByIata(sc, iata);
  if (looked.kind === "degraded") return { ok: false, status: 503, error: "degraded_unavailable", message: "Airport details could not be loaded. Please try again." };
  const tz = looked.value.airport?.timezone;
  if (!looked.value.airport || typeof tz !== "string" || tz.length === 0 || looked.value.airport.iataCode === "UNK") {
    return { ok: false, status: 400, error: "invalid_payload", message: `We do not know ${iata.toUpperCase()}'s time zone, so a local time there cannot be read. Check the airport code.` };
  }
  return { ok: true, timezone: tz };
}

router.get("/trips/:tripId/flight-segments", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, TRIP_FLIGHT_SEGMENTS_FLAG)) { sendError(res, "feature_disabled", "Trip flights are not enabled yet"); return; }
  const membership = await requireTripMember(sc, tripId, auth.user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }
  const read = await readTripFlightSegments(sc, tripId);
  if (!read.ok) {
    log.warn({ tripId, err: read.message }, "trip flight segments unreadable");
    sendError(res, "degraded_unavailable", "This trip's flights could not be loaded. Please try again.");
    return;
  }
  res.json({ ok: true, segments: read.segments.map(flightSegmentView) });
}));

router.post("/trips/:tripId/flight-segments", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const parsed = addFlightSchema.safeParse(req.body ?? {});
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload"); return; }
  const b = parsed.data;
  const designator = parseDesignator(b.flight);
  if (!designator) { sendError(res, "invalid_payload", "flight must be an airline designator and number, e.g. BA286"); return; }
  const dep = b.departureAirport.toUpperCase();
  const arr = b.arrivalAirport.toUpperCase();
  if (dep === arr) { sendError(res, "invalid_payload", "A flight leaves from one airport and lands at another"); return; }
  const envelope = readCommandEnvelope(req);
  if (!envelope.ok) { sendError(res, "invalid_payload", envelope.message); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, TRIP_FLIGHT_SEGMENTS_FLAG)) { sendError(res, "feature_disabled", "Trip flights are not enabled yet"); return; }
  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }
  if (await refuseIfRetainedRecordOnly(res, sc, tripId, user.id)) return;

  const depZone = await airportZone(sc, dep);
  if (!depZone.ok) { res.status(depZone.status).json({ ok: false, error: depZone.error, message: depZone.message }); return; }
  const arrZone = await airportZone(sc, arr);
  if (!arrZone.ok) { res.status(arrZone.status).json({ ok: false, error: arrZone.error, message: arrZone.message }); return; }
  const depAt = wallTimeToUtc(depZone.timezone, b.departureLocal);
  const arrAt = wallTimeToUtc(arrZone.timezone, b.arrivalLocal);
  if (!depAt) { sendError(res, "invalid_payload", "departureLocal is not a valid local time"); return; }
  if (!arrAt) { sendError(res, "invalid_payload", "arrivalLocal is not a valid local time"); return; }
  const minutes = Math.round((arrAt.getTime() - depAt.getTime()) / 60_000);
  if (minutes <= 0) { sendError(res, "invalid_payload", "The flight must land after it leaves (each time is in its own airport's local time)"); return; }
  if (minutes > MAX_FLIGHT_MINUTES) { sendError(res, "invalid_payload", "A single flight cannot last more than 24 hours — check the dates"); return; }

  const result = await executeTripCommand(sc, {
    commandId: randomUUID(),
    tripId,
    actorUserId: user.id,
    actorRole: "user",
    expectedTripVersion: envelope.expectedTripVersion,
    idempotencyKey: envelope.idempotencyKey,
    type: "ADD_TRANSPORT_SEGMENT",
    payload: addFlightSegmentPayload({
      carrierCode: designator.carrierCode, flightNumber: designator.flightNumber,
      departureAirport: dep, arrivalAirport: arr,
      scheduledDepartureAt: depAt.toISOString(), scheduledArrivalAt: arrAt.toISOString(),
      departureTerminal: b.departureTerminal ?? null, arrivalTerminal: b.arrivalTerminal ?? null,
      departureGate: b.departureGate ?? null, arrivalGate: b.arrivalGate ?? null,
      bookingRef: b.bookingRef ?? null, legId: b.legId ?? null,
    }),
  });
  if (result.ok) {
    const row = (result.result ?? {}) as Record<string, unknown>;
    if (!("carrier_code" in row)) {
      // The kernel wrote a segment without the flight columns: 3826's transform is not installed
      // behind a flag that says it is. Said, never reported as a saved flight.
      log.error({ tripId }, "flight segment written without 3826's columns");
      res.status(503).json({ ok: false, error: "degraded_unavailable", message: "Your flight could not be saved with its details. Please try again later." });
      return;
    }
    res.status(result.duplicate ? 200 : 201).json({ ok: true, duplicate: result.duplicate, version: result.version, segment: flightSegmentView(rowToFlightSegment(row)) });
    return;
  }
  if (result.reason === "TRIP_KERNEL_UNAVAILABLE") {
    log.warn({ tripId, detail: result.detail }, "trip kernel unavailable (flight segment)");
    res.status(503).json({ ok: false, error: "degraded_unavailable", reason: result.reason, message: "Your flight could not be saved. Please try again." });
    return;
  }
  const status = result.reason === "TRIP_AUTH_NOT_CREW" ? 403
    : result.reason === "TRIP_NOT_FOUND" || result.reason === "TRIP_LEG_NOT_FOUND" ? 404
    : result.reason === "TRIP_VERSION_CONFLICT" ? 409 : 400;
  res.status(status).json({
    ok: false,
    error: status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 409 ? "conflict" : "invalid_payload",
    reason: result.reason, detail: result.detail, currentVersion: result.currentVersion,
  });
}));

export default router;
