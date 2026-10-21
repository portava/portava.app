/**
 * LayoverDepartureFlight — the traveller's ONWARD flight as Trips last recorded
 * it, for the two surfaces that need it and had nothing to read:
 *
 *   census-layover L153  §16 "Flight/gate — cache last confirmed values with
 *                        stale indicator". The offline bundle answered
 *                        `unavailable("no_flight_feed")` for every session.
 *   census-layover L43   §5 `RETURNING → AIRPORT_REENTERED`: "checkpoint confirms
 *                        re-entry; side effect = stop landside discovery,
 *                        refresh gate/security". Stopping landside discovery is
 *                        built (LayoverCheckpointStore `landsideSuppressionFor`);
 *                        the refresh had "no gate or security data".
 *
 * ── WHERE THE VALUES COME FROM, AND WHY THEY MAY BE CALLED CONFIRMED ─────────
 * Trips owns the flight (3826): carrier, flight number, scheduled times, and an
 * OPERATION written only by RECORD_FLIGHT_STATUS — status, estimated times,
 * terminal and gate — each observation carrying its source ('traveller' or
 * 'feed', bound to the actor that wrote it) and its instant, and refused when
 * older than the one held. Those are the two producers the owner approved on
 * 2026-10-18 ("verified itinerary information plus approved flight-data
 * integrations; unknown flight information stays explicitly unknown").
 *
 * So the bundle caches the LAST RECORDED OBSERVATION and nothing else: a flight
 * nobody has observed (`flight_status_source` NULL — 3826's CHECK ties it to the
 * instant) is `no_flight_observation`, never its typed schedule dressed up as a
 * status. Every value travels with its source and its instant, and goes stale
 * after the bundle's own TTL from the instant it was OBSERVED (not from now, and
 * never renewed), so an hour-old gate is badged as an hour old.
 *
 * ── WHAT IS READ, AND THE BOUNDARY ───────────────────────────────────────────
 * The session's `departure_segment_id` (3827), owner-scoped, then that one Trips
 * segment, kept only when it is on the session's own trip and was created by the
 * session's owner — the same rule `attachFlightTerminalContext` applies. Behind
 * `layover_flight_connections_enabled` (3827, seeded FALSE): OFF, nothing is
 * read and every answer is exactly what it was. A failed read is `unreadable`,
 * never "not linked". One read per request: the answer is memoised on the
 * request's session object, so the bundle and the re-entry context cannot
 * disagree about the gate.
 *
 * Nothing here writes, and nothing here stores or reads a location.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { logger as rootLogger } from "../../lib/logger.js";
import { readFlightSegmentsByIds, type FlightSegment, type FlightStatus, type FlightStatusSource } from "../../domain/trips/services/TripFlightSegments.js";
import { readSessionConnection } from "./LayoverSessionService.js";
import { landsideSuppressionFor } from "../layover/LayoverCheckpointStore.js";
import type { LayoverFeasibilityRecord } from "./LayoverFeasibility.js";
import { OFFLINE_BUNDLE_TTL_MIN } from "./LayoverDegradedService.js";

const logger = rootLogger.child({ service: "LayoverDepartureFlight" });

/** The onward flight's last recorded observation. Every unknown is null, and `status` is "unknown" when none was stated. */
export interface DepartureFlightObservation {
  segmentId: string;
  /** "BA286", or null when either half is unknown. */
  designator: string | null;
  departureAirport: string | null;
  /** The booked (scheduled) departure — itinerary, not an observation. */
  scheduledDepartureAt: string | null;
  /** The departure the latest observation stated; null = none stated, NEVER "on time". */
  estimatedDepartureAt: string | null;
  terminal: string | null;
  gate: string | null;
  status: FlightStatus;
  source: FlightStatusSource;
  observedAt: string;
  /** After this instant a client MUST badge these values stale: observedAt + the bundle TTL, never renewed. */
  staleAfter: string;
}

export type DepartureFlightRead =
  | { state: "off" }
  | { state: "not_linked" }
  | { state: "not_observed"; segmentId: string }
  | { state: "unreadable"; reason: "session_unreadable" | "flight_unreadable" }
  | { state: "observed"; flight: DepartureFlightObservation };

interface SessionRef { id: string; userId: string; tripId: string | null }

function observationOf(seg: FlightSegment): DepartureFlightObservation | null {
  if (seg.statusSource === null || !seg.statusObservedAt || !Number.isFinite(Date.parse(seg.statusObservedAt))) return null;
  return {
    segmentId: seg.id,
    designator: seg.designator,
    departureAirport: seg.departureAirport,
    scheduledDepartureAt: seg.scheduledDepartureAt,
    estimatedDepartureAt: seg.estimatedDepartureAt,
    terminal: seg.departureTerminal,
    gate: seg.departureGate,
    status: seg.status,
    source: seg.statusSource,
    observedAt: new Date(Date.parse(seg.statusObservedAt)).toISOString(),
    staleAfter: new Date(Date.parse(seg.statusObservedAt) + OFFLINE_BUNDLE_TTL_MIN * 60_000).toISOString(),
  };
}

async function readOnce(db: SupabaseClient, session: SessionRef): Promise<DepartureFlightRead> {
  if (!(await isFlagEnabled(db, "layover_flight_connections_enabled"))) return { state: "off" }; // = LAYOVER_FLIGHT_CONNECTIONS_FLAG, literal for check:flag-polarity
  const link = await readSessionConnection(db, session.id, session.userId);
  if (!link.ok) return { state: "unreadable", reason: "session_unreadable" };
  const segmentId = link.connection?.departureSegmentId ?? null;
  if (!segmentId || !session.tripId) return { state: "not_linked" };
  const read = await readFlightSegmentsByIds(db, [segmentId]);
  if (!read.ok) {
    logger.warn({ sessionId: session.id, reason: read.message }, "onward flight unreadable — refusing rather than reporting no flight");
    return { state: "unreadable", reason: "flight_unreadable" };
  }
  // Another traveller's or another trip's segment is reported exactly as no link: it is not this session's flight.
  const seg = read.segments.find((s) => s.id === segmentId && s.tripId === session.tripId && s.createdBy === session.userId);
  if (!seg) return { state: "not_linked" };
  const flight = observationOf(seg);
  return flight ? { state: "observed", flight } : { state: "not_observed", segmentId: seg.id };
}

const memo = new WeakMap<object, Promise<DepartureFlightRead>>();

/** The session's onward flight, read once per request (memoised on the session object the route holds). */
export function readDepartureFlight(db: SupabaseClient, session: SessionRef): Promise<DepartureFlightRead> {
  let p = memo.get(session);
  if (!p) { p = readOnce(db, session); memo.set(session, p); }
  return p;
}

// ── L43 — REFRESH_GATE_AND_SECURITY ──────────────────────────────────────────
//
// When the traveller's newest check-in is AIRPORT_REENTRY (the same reader that
// already withholds landside suggestions), the overview publishes `reentry`:
// the onward flight's gate as Trips last recorded it, read at this request, and
// the return-side security term of the record certified at this request. Gate
// context then replaces exploration on the screen. Like the landside half, this
// can only ADD information: it moves no deadline, verdict or return state.
//
//   security "live"             the certified record's own live security term
//                               (§10 conditions): extra minutes over the
//                               airport's standing allowance, with the instant
//                               it was observed and when it expires.
//   security "no_live_reading"  nothing live was folded into this answer; the
//                               deadline already carries the airport's standing
//                               security allowance and says nothing newer.
//
// Store OFF or the traveller not re-entered: no key, so the overview is
// byte-identical. Check-ins unreadable: `{ state: "unknown" }`, said, never
// read as "not back yet".

export type ReentrySecurity =
  | { state: "live"; extraMinutes: number; observedAt: string | null; expiresAt: string | null }
  | { state: "no_live_reading" };

export type ReentryContext =
  | { state: "reentered"; reportedAt: string; refreshedAt: string; flight: DepartureFlightRead; security: ReentrySecurity }
  | { state: "unknown"; reason: "checkpoints_unreadable" };

export function reentrySecurityOf(record: Pick<LayoverFeasibilityRecord, "inputs">): ReentrySecurity {
  const live = record.inputs?.liveConditions ?? null;
  if (!live || !Number.isFinite(live.securityWaitExtraMin) || live.observedAt === null) return { state: "no_live_reading" };
  return { state: "live", extraMinutes: Math.max(0, live.securityWaitExtraMin), observedAt: live.observedAt, expiresAt: live.expiresAt };
}

export async function reentryContextFor(
  db: SupabaseClient,
  session: SessionRef,
  record: Pick<LayoverFeasibilityRecord, "inputs">,
  nowMs: number,
): Promise<{ reentry?: ReentryContext }> {
  const landside = await landsideSuppressionFor(db, session.id, nowMs);
  if (landside.state === "unknown") return { reentry: { state: "unknown", reason: "checkpoints_unreadable" } };
  if (landside.state !== "suppressed") return {};
  return {
    reentry: {
      state: "reentered",
      reportedAt: landside.reportedAt,
      refreshedAt: new Date(nowMs).toISOString(),
      flight: await readDepartureFlight(db, session),
      security: reentrySecurityOf(record),
    },
  };
}
