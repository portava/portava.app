/**
 * LayoverFlightStatus — the flight-status ADAPTER (Layover spec §11 "flight.*"
 * events, §15.2 disruption, §21.1 "Arrival delay → freedom shrinks; Departure
 * delay → freedom may expand after recompute; Flight cancellation → disruption";
 * census-layover L11, L21, L33, L259, L267; Layover 165 program, lane B1-F).
 *
 * Owner decision 2026-10-18 (flight data): "a flight-status adapter interface
 * (no live feed is licensed yet). It accepts verified updates from (a) the
 * traveller (the existing disruption route, source "traveller") and (b) an
 * approved feed, behind the interface, with a contract fixture and no real
 * calls. An update recalculates the session through the existing replan path:
 * the certification, the return deadline, missed-connection risk, and terminal
 * changes."
 *
 * ONE DOOR, TWO PRODUCERS, BOUND TO THEIR ROLES
 *   traveller  a crew member, about a flight of their trip. Recorded on the
 *              Trips segment as source 'traveller' (the kernel refuses a user
 *              claiming 'feed'). It recalculates THAT TRAVELLER'S OWN linked
 *              sessions only: a traveller's report is supporting evidence, never
 *              proof (owner decision, live intelligence), so it never moves a
 *              crew-mate's deadline.
 *   feed       an approved flight-status feed, through `FlightStatusFeed` below.
 *              Recorded as source 'feed' by the system actor, and it
 *              recalculates EVERY active session linked to the flight — the
 *              §24 flight-subject fan-out (3827's indexes, the replan port's
 *              flight axis).
 *
 * WHAT ONE UPDATE DOES, IN ORDER
 *   1. RECORD_FLIGHT_STATUS on the Trips segment (3826). Trips owns the flight;
 *      an observation older than the one it holds is refused by the kernel
 *      (TRIP_FLIGHT_STATUS_STALE) and changes nothing downstream.
 *   2. What moved, measured on BEST-KNOWN times before vs after (an estimate
 *      if stated, else the schedule): the arrival, the departure, the gates,
 *      the terminals, the status.
 *   3. §11 events for what moved — flight.arrival_delayed, flight.departure_
 *      delayed, flight.gate_changed, flight.cancelled — through the EXISTING
 *      replan path, `replanExternalEvent` (normalise → impacted sessions →
 *      affected nodes → certify before/after → diff → invalidate → opportunity →
 *      notify decision; persisted snapshots when that flag is on).
 *   4. The linked sessions' schedule follows the segment (what the replan
 *      decided is what the session now IS): arrival/departure written, an
 *      inconsistent boarding time cleared (the cutoff then falls back to the
 *      departure, the EARLIER and safer instant).
 *   5. Each session re-certified (the return deadline), its missed-connection
 *      risk judged (LayoverConnectionDetection.assessMissedConnection), its §5
 *      state advanced on the graph (DEPARTURE_CANCELLED, MATERIAL_DISRUPTION,
 *      BOARDING_STARTED, DEPARTURE_CONFIRMED — LayoverLifecycle decides), and a
 *      terminal change at the connection reported.
 * Terminal observations are projected from the owned linked flights into the
 * canonical inputs. A terminal-only change re-certifies applicable sourced
 * timing; an unknown or mismatched terminal closes scoped timing evidence.
 * No terminal-transfer duration is invented and no new event type is implied.
 *
 * NO FEED IS LICENSED. `NO_FLIGHT_STATUS_FEED` refuses by name; the HTTP adapter
 * is complete, vendor-neutral and contract-tested against a fixture, and reads
 * exactly two variables: FLIGHT_STATUS_FEED_URL (a URL template with
 * {designator} and {date}, and optionally {key}) and FLIGHT_STATUS_FEED_API_KEY.
 * With either unset it refuses CREDENTIAL_ABSENT / PROVIDER_UNBOUND and makes no
 * request. Nothing here dials a network in a test.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { answer, credentialRefusal, refuse, type ProviderResult } from "../../lib/providers/providerRefusal.js";
import { executeTripCommand } from "../../domain/trips/commands/tripKernel.js";
import {
  bestKnownArrival, bestKnownDeparture, findFlightSegmentsByDesignator, isFlightStatus, observationStatesAnything,
  parseDesignator, readFlightSegmentsByIds, recordFlightStatusPayload, rowToFlightSegment,
  type FlightObservation, type FlightSegment, type FlightStatus,
} from "../../domain/trips/services/TripFlightSegments.js";
import { airportRowToProfile, lookupByIata, type AirportProfile } from "./AirportProfileService.js";
import { localDayString } from "./AirportTime.js";
import { certifySessionFeasibility } from "./LayoverFeasibility.js";
import { MATERIALITY, normalizeEvent, type LayoverEventEnvelope, type LayoverEventType, type EventSubjectRef } from "./LayoverEventReplanner.js";
import { replanExternalEvent, type ReplanReport } from "./LayoverExternalReplanPort.js";
import { assessMissedConnection, type MissedConnectionAssessment } from "./LayoverConnectionDetection.js";
import {
  advanceSessionLifecycle, readActiveSessionRowsByFlightSubjects, readSessionConnection, readSessionsByIds,
  syncConnectionSessionTimes, normalizeFlightTerminalId, type LayoverSession, type StateWrite,
} from "./LayoverSessionService.js";
import { consumerLayoverRecord } from "./LayoverSnapshot.js";

const logger = rootLogger.child({ service: "LayoverFlightStatus" });

export type FlightUpdateSource = "traveller" | "feed";

/** An observation is not accepted from further in the future than this (clock skew), the kernel's own bound. */
export const OBSERVATION_FUTURE_SKEW_MS = 5 * 60_000;
/** A feed record is matched to a Trips segment whose SCHEDULED departure is within this of the feed's. */
export const FEED_MATCH_WINDOW_MS = 6 * 3_600_000;

export interface FlightStatusUpdate {
  source: FlightUpdateSource;
  /** When the source observed it (ISO). */
  observedAt: string;
  /** What it states. A key absent says nothing; a key present with null says "unknown". */
  observation: FlightObservation;
  /** traveller: the Trips segment they report on, and who they are. */
  segmentId?: string;
  actorUserId?: string;
  /** feed: the flight as the feed identifies it. */
  flight?: { carrierCode: string; flightNumber: string; scheduledDepartureAt: string };
  /** feed: the provider id and its record id, for provenance and de-duplication. */
  feedId?: string;
  sourceRef?: string;
}

export interface FlightChanges {
  arrivalMovedMinutes: number | null;
  departureMovedMinutes: number | null;
  departureGate: { from: string | null; to: string | null } | null;
  arrivalGate: { from: string | null; to: string | null } | null;
  departureTerminal: { from: string | null; to: string | null } | null;
  arrivalTerminal: { from: string | null; to: string | null } | null;
  status: { from: FlightStatus; to: FlightStatus } | null;
}

export interface SessionRecalc {
  sessionId: string;
  userId: string;
  role: "arrival" | "departure";
  synced: boolean;
  syncRefusal?: string;
  before: { hardReturnTime: string; usableMinutes: number; returnState: string } | null;
  after: { hardReturnTime: string; usableMinutes: number; returnState: string } | null;
  missedConnection: MissedConnectionAssessment | null;
  state: StateWrite | null;
  /** The terminal at the connection changed on THIS session's side of it. */
  terminalChange: { side: "arrival" | "departure"; from: string | null; to: string | null } | null;
}

export interface SegmentOutcome {
  segmentId: string;
  tripId: string;
  recorded: boolean;
  duplicate: boolean;
  refusal?: string;
  changes: FlightChanges | null;
  replan: Array<{ eventType: LayoverEventType; report: ReplanReport }>;
  sessions: SessionRecalc[];
}

export type FlightStatusApplyResult =
  | { ok: true; segments: SegmentOutcome[] }
  | { ok: false; reason: "feature_disabled" | "invalid_update" | "segments_unreadable" | "sessions_unreadable"; message: string };

// ── validation ───────────────────────────────────────────────────────────────

function isoOrNull(v: unknown): v is string | null {
  return v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)));
}

/** §23 "Validate all external event payloads": the update's own shape, before anything is read. */
export function validateFlightStatusUpdate(u: FlightStatusUpdate, nowMs: number): string | null {
  if (u.source !== "traveller" && u.source !== "feed") return "source must be traveller or feed";
  if (typeof u.observedAt !== "string" || !Number.isFinite(Date.parse(u.observedAt))) return "observedAt must be an instant";
  if (Date.parse(u.observedAt) > nowMs + OBSERVATION_FUTURE_SKEW_MS) return "observedAt is in the future";
  const o = u.observation ?? {};
  if (!observationStatesAnything(o)) return "the update states nothing about the flight";
  for (const k of ["estimatedDepartureAt", "estimatedArrivalAt"] as const) {
    if (o[k] !== undefined && !isoOrNull(o[k])) return `${k} must be an instant or null`;
  }
  for (const k of ["departureTerminal", "arrivalTerminal", "departureGate", "arrivalGate"] as const) {
    const v = o[k];
    if (v !== undefined && v !== null && (typeof v !== "string" || v.trim().length < 1 || v.trim().length > 32)) return `${k} must be 1-32 characters or null`;
  }
  if (o.status !== undefined && o.status !== null && !isFlightStatus(o.status)) return "status is not a flight status";
  if (u.source === "traveller" && (!u.segmentId || !u.actorUserId)) return "a traveller update names its segment and its traveller";
  if (u.source === "feed" && (!u.flight || !parseDesignator(`${u.flight.carrierCode}${u.flight.flightNumber}`) || !Number.isFinite(Date.parse(u.flight.scheduledDepartureAt)))) {
    return "a feed update names the flight: carrier, number and scheduled departure";
  }
  return null;
}

// ── what moved ───────────────────────────────────────────────────────────────

const moved = (a: string | null, b: string | null): number | null =>
  a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 60_000) : null;
const changed = (a: string | null, b: string | null) => (a === b ? null : { from: a, to: b });

export function flightChanges(before: FlightSegment, after: FlightSegment): FlightChanges {
  const arr = moved(bestKnownArrival(before).at, bestKnownArrival(after).at);
  const dep = moved(bestKnownDeparture(before).at, bestKnownDeparture(after).at);
  return {
    arrivalMovedMinutes: arr === 0 ? null : arr,
    departureMovedMinutes: dep === 0 ? null : dep,
    departureGate: changed(before.departureGate, after.departureGate),
    arrivalGate: changed(before.arrivalGate, after.arrivalGate),
    departureTerminal: changed(before.departureTerminal, after.departureTerminal),
    arrivalTerminal: changed(before.arrivalTerminal, after.arrivalTerminal),
    status: before.status === after.status ? null : { from: before.status, to: after.status },
  };
}

/**
 * The §11 events a set of changes is, in the vocabulary's own words. A flight
 * that became `cancelled` is flight.cancelled and nothing else. A terminal has
 * no §11 event and is not invented one.
 */
export function eventsForChanges(after: FlightSegment, c: FlightChanges): Array<{ eventType: LayoverEventType; payload: Record<string, unknown> }> {
  if (c.status && c.status.to === "cancelled") return [{ eventType: "flight.cancelled", payload: {} }];
  const out: Array<{ eventType: LayoverEventType; payload: Record<string, unknown> }> = [];
  if (c.arrivalMovedMinutes !== null) out.push({ eventType: "flight.arrival_delayed", payload: { delayMinutes: c.arrivalMovedMinutes } });
  if (c.departureMovedMinutes !== null) {
    out.push({ eventType: "flight.departure_delayed", payload: { delayMinutes: c.departureMovedMinutes, newDepartureTime: bestKnownDeparture(after).at } });
  }
  if (c.departureGate && c.departureGate.to) out.push({ eventType: "flight.gate_changed", payload: { gate: c.departureGate.to } });
  return out;
}

// ── the door ─────────────────────────────────────────────────────────────────

export interface ApplyOptions {
  nowMs: number;
  /**
   * false: record on the segment and advance the reporter's own §5 state only.
   * The disruption route passes false — it has ALREADY recomputed and persisted
   * that session's schedule itself, and recomputing it twice would apply the
   * delay twice.
   */
  recalculate?: boolean;
  /** Cap on sessions per segment (the port's own default bound). */
  sessionLimit?: number;
}

async function resolveSegments(db: SupabaseClient, u: FlightStatusUpdate): Promise<{ ok: true; segments: FlightSegment[] } | { ok: false; message: string }> {
  if (u.source === "traveller") return readFlightSegmentsByIds(db, [u.segmentId!]);
  const d = parseDesignator(`${u.flight!.carrierCode}${u.flight!.flightNumber}`)!;
  const at = Date.parse(u.flight!.scheduledDepartureAt);
  return findFlightSegmentsByDesignator(db, {
    carrierCode: d.carrierCode, flightNumber: d.flightNumber,
    fromIso: new Date(at - FEED_MATCH_WINDOW_MS).toISOString(), toIso: new Date(at + FEED_MATCH_WINDOW_MS).toISOString(),
  });
}

/**
 * Accept one verified flight-status update. `layover_flight_connections_enabled`
 * OFF / absent: refused `feature_disabled`, nothing read or written.
 */
export async function applyFlightStatusUpdate(db: SupabaseClient, u: FlightStatusUpdate, opts: ApplyOptions): Promise<FlightStatusApplyResult> {
  if (!await isFlagEnabled(db, "layover_flight_connections_enabled")) {
    return { ok: false, reason: "feature_disabled", message: "Flight-status updates are not enabled" };
  }
  const bad = validateFlightStatusUpdate(u, opts.nowMs);
  if (bad) return { ok: false, reason: "invalid_update", message: bad };
  const resolved = await resolveSegments(db, u);
  if (!resolved.ok) return { ok: false, reason: "segments_unreadable", message: resolved.message };
  const observedAt = new Date(Date.parse(u.observedAt)).toISOString();
  const outcomes: SegmentOutcome[] = [];
  for (const before of resolved.segments) {
    outcomes.push(await applyToSegment(db, u, before, observedAt, opts));
  }
  return { ok: true, segments: outcomes };
}

async function applyToSegment(db: SupabaseClient, u: FlightStatusUpdate, before: FlightSegment, observedAt: string, opts: ApplyOptions): Promise<SegmentOutcome> {
  const base: SegmentOutcome = { segmentId: before.id, tripId: before.tripId, recorded: false, duplicate: false, changes: null, replan: [], sessions: [] };
  const kernel = await executeTripCommand(db, {
    commandId: randomUUID(),
    tripId: before.tripId,
    actorUserId: u.source === "traveller" ? u.actorUserId! : null,
    actorRole: u.source === "traveller" ? "user" : "system",
    idempotencyKey: `flight-status:${u.source}:${before.id}:${observedAt}`.slice(0, 200),
    type: "RECORD_FLIGHT_STATUS",
    payload: recordFlightStatusPayload(before.id, u.source, observedAt, u.observation),
    clientObservedAt: observedAt,
  });
  if (!kernel.ok) return { ...base, refusal: kernel.reason };
  const after = rowToFlightSegment((kernel.result ?? {}) as Record<string, unknown>);
  const changes = flightChanges(before, after);
  const outcome: SegmentOutcome = { ...base, recorded: true, duplicate: kernel.duplicate, changes };
  if (kernel.duplicate) return outcome; // already applied, and recalculated, the first time

  // The sessions this observation may move: the flight's linked ACTIVE sessions (§24's
  // flight axis) — for a traveller's report, only their own.
  const linked = await readActiveSessionRowsByFlightSubjects(db, [before.id], opts.sessionLimit ?? 200);
  if (!linked.ok) { outcome.refusal = "sessions_unreadable"; return outcome; }
  const rows = linked.rows.filter((r) => u.source === "feed" || String(r.user_id) === u.actorUserId);

  if (opts.recalculate !== false && rows.length > 0) {
    const subjects: EventSubjectRef[] = u.source === "feed"
      ? [{ kind: "flight", ref: before.id }]
      : rows.map((r) => ({ kind: "session" as const, ref: String(r.id) }));
    for (const e of eventsForChanges(after, changes)) {
      const n = normalizeEvent({
        eventId: randomUUID(), eventType: e.eventType,
        occurredAt: new Date(Math.min(Date.parse(observedAt), opts.nowMs)).toISOString(),
        source: u.source === "feed" ? `flight-status-feed:${u.feedId ?? "feed"}` : "traveller",
        sourceEventId: `${before.id}:${observedAt}:${e.eventType}`,
        subjectRefs: subjects, payload: e.payload,
        confidence: u.source === "feed" ? "HIGH" : "MEDIUM",
      }, { receivedAtMs: opts.nowMs });
      if (!n.ok) { outcome.replan.push({ eventType: e.eventType, report: { ok: false, reason: `${n.reason}: ${n.detail}` } }); continue; }
      outcome.replan.push({ eventType: e.eventType, report: await replanExternalEvent(db, n.event, { nowMs: opts.nowMs, sessionLimit: opts.sessionLimit }) });
    }
  }

  for (const r of rows) outcome.sessions.push(await recalcSession(db, r, before, after, changes, opts, u.source));
  return outcome;
}

function windowOf(record: ReturnType<typeof certifySessionFeasibility>) {
  return { hardReturnTime: record.deadline.hardReturnTime.toISOString(), usableMinutes: record.envelope.usableMinutes, returnState: record.envelope.returnState };
}

async function recalcSession(
  db: SupabaseClient,
  row: Record<string, any>,
  before: FlightSegment,
  after: FlightSegment,
  changes: FlightChanges,
  opts: ApplyOptions,
  source: FlightUpdateSource,
): Promise<SessionRecalc> {
  const sessionId = String(row.id);
  const role: "arrival" | "departure" = row.departure_segment_id === before.id ? "departure" : "arrival";
  const out: SessionRecalc = { sessionId, userId: String(row.user_id ?? ""), role, synced: false, before: null, after: null, missedConnection: null, state: null, terminalChange: null };
  const tc = role === "arrival" ? changes.arrivalTerminal : changes.departureTerminal;
  if (tc) out.terminalChange = { side: role, from: tc.from, to: tc.to };

  // The airport this session is certified against (the replan port's rule: a degraded read is no answer).
  const airport = await sessionAirport(db, row);
  // The other flight of the connection, for its status and best-known time.
  const otherId = role === "arrival" ? row.departure_segment_id : row.arrival_segment_id;
  const other = typeof otherId === "string" ? await readFlightSegmentsByIds(db, [otherId]) : { ok: true as const, segments: [] };
  const otherSeg = other.ok ? other.segments[0] ?? null : null;
  const arrivalSeg = role === "arrival" ? after : otherSeg;
  const departureSeg = role === "departure" ? after : otherSeg;

  // The session as every loader reads it (its declared constraint set attached), certified through
  // the ONE snapshot door when that is on, and the engine directly otherwise (the legacy arm).
  const loaded = await readSessionsByIds(db, [sessionId], 1);
  if (!loaded.ok || !loaded.sessions[0]) { out.syncRefusal = loaded.ok ? "session_not_found" : "session_unreadable"; return out; }
  let session: LayoverSession = loaded.sessions[0];
  if (airport) out.before = windowOf(tc && before.tripId === session.tripId && before.createdBy === session.userId ? certifySessionFeasibility(airport, { ...session, [role === "arrival" ? "arrivalTerminalId" : "departureTerminalId"]: normalizeFlightTerminalId(tc.from) }, { nowMs: opts.nowMs, entry: null }) : await certifiedRecordFor(db, airport, session, opts.nowMs)); // Compare prior terminal context without publishing an obsolete canonical row after the flight observation was committed.

  // 4. the schedule follows the segment
  if (opts.recalculate !== false) {
    const patch: { arrivalTime?: string; departureTime?: string; boardingTime?: string | null } = {};
    if (role === "arrival" && changes.arrivalMovedMinutes !== null && bestKnownArrival(after).at) patch.arrivalTime = bestKnownArrival(after).at!;
    if (role === "departure" && changes.departureMovedMinutes !== null && bestKnownDeparture(after).at) patch.departureTime = bestKnownDeparture(after).at!;
    if (patch.arrivalTime || patch.departureTime) {
      const arr = Date.parse(patch.arrivalTime ?? session.arrivalTime);
      const dep = Date.parse(patch.departureTime ?? session.departureTime);
      const boarding = session.boardingTime ? Date.parse(session.boardingTime) : null;
      if (dep <= arr) out.syncRefusal = "inbound_lands_after_onward_departs";
      else if (dep <= opts.nowMs) out.syncRefusal = "onward_already_departed";
      else if (dep - arr > 48 * 3_600_000) out.syncRefusal = "window_exceeds_48h";
      else {
        if (boarding !== null && (boarding > dep || boarding <= arr)) patch.boardingTime = null; // the cutoff falls back to the departure: earlier, never later
        const w = await syncConnectionSessionTimes(db, sessionId, patch, { flightStatus: { source, segmentId: before.id, role, ...patch } });
        if (!w.ok) out.syncRefusal = "write_failed";
        else if (!w.session) out.syncRefusal = "session_not_active";
        else { out.synced = true; session = { ...w.session, constraints: session.constraints }; }
      }
    }
  }
  if (airport) out.after = windowOf(await certifiedRecordFor(db, airport, session, opts.nowMs));

  // 5. missed-connection risk, on the TWO FLIGHTS' best-known times (not the session's, which a
  // refused sync leaves where it was) and their statuses. A flight not linked: the session's own time.
  if (airport) {
    const arr = arrivalSeg ? bestKnownArrival(arrivalSeg) : { at: session.arrivalTime, basis: "scheduled" as const };
    const dep = departureSeg ? bestKnownDeparture(departureSeg) : { at: session.departureTime, basis: "scheduled" as const };
    const boardingOk = session.boardingTime !== null && dep.at !== null && arr.at !== null
      && Date.parse(session.boardingTime) <= Date.parse(dep.at) && Date.parse(session.boardingTime) > Date.parse(arr.at);
    out.missedConnection = assessMissedConnection({
      airport, arrivalTime: arr.at, departureTime: dep.at, boardingTime: boardingOk ? session.boardingTime : null,
      flightType: session.flightType, immigrationRequired: session.immigrationRequired, checkedBags: session.checkedBags,
      basis: { arrival: arr.basis, departure: dep.basis },
      arrivalStatus: arrivalSeg?.status ?? null, departureStatus: departureSeg?.status ?? null,
    });
  }

  // §5: the graph decides the state; this only asks it.
  const event = lifecycleEventFor(role, changes, out);
  if (event) out.state = await advanceSessionLifecycle(db, sessionId, event, { materialChange: true });
  return out;
}

/** The §5 event an observation is, for a session on one side of the connection. */
export function lifecycleEventFor(role: "arrival" | "departure", c: FlightChanges, r: Pick<SessionRecalc, "missedConnection" | "before" | "after">): "DEPARTURE_CANCELLED" | "MATERIAL_DISRUPTION" | "BOARDING_STARTED" | "DEPARTURE_CONFIRMED" | null {
  if (role === "departure" && c.status?.to === "cancelled") return "DEPARTURE_CANCELLED";
  if (role === "departure" && c.status?.to === "boarding") return "BOARDING_STARTED";
  if (role === "departure" && c.status?.to === "departed") return "DEPARTURE_CONFIRMED";
  const risk = r.missedConnection?.risk;
  if (risk === "missed" || risk === "at_risk") return "MATERIAL_DISRUPTION";
  if (r.before && r.after) {
    const deadline = Math.abs(Date.parse(r.after.hardReturnTime) - Date.parse(r.before.hardReturnTime)) / 60_000;
    const usable = Math.abs(r.after.usableMinutes - r.before.usableMinutes);
    if (deadline >= MATERIALITY.deadlineMinutes || usable >= MATERIALITY.usableMinutes) return "MATERIAL_DISRUPTION";
  }
  return null;
}

/**
 * A session's certified record: the snapshot's (census-discovery §81 — "all
 * surfaces consume the same certified snapshot"), else the engine's own
 * certification with the entry unresolved (the deadline and the window this
 * adapter reports do not turn on the entry corridor; the verdict, which does, is
 * not published here).
 */
async function certifiedRecordFor(db: SupabaseClient, airport: AirportProfile, session: LayoverSession, nowMs: number) {
  return (await consumerLayoverRecord(db, airport, session, nowMs)) ?? certifySessionFeasibility(airport, session, { nowMs, entry: null });
}

async function sessionAirport(db: SupabaseClient, row: Record<string, any>): Promise<AirportProfile | null> {
  if (typeof row.airport_id === "string" && row.airport_id) {
    const { data, error } = await db.from("airport_profiles").select("*").eq("id", row.airport_id).maybeSingle();
    if (error) { logger.warn({ err: error.message }, "airport profile unreadable for a flight-status recalculation"); return null; }
    if (data) return airportRowToProfile(data);
  }
  const iata = typeof row.manual_iata === "string" ? row.manual_iata.trim().toUpperCase() : "";
  if (!iata || iata === "UNK") return null;
  const looked = await lookupByIata(db, iata);
  return looked.kind === "read" ? looked.value.airport : null;
}

// ── (a) the traveller, through the existing disruption route ─────────────────

export type TravellerReport =
  | { recorded: true; segmentId: string; state: StateWrite | null; duplicate: boolean }
  | { recorded: false; reason: string; segmentId?: string };

/**
 * POST /airport/sessions/:id/disruption, `source: "traveller"`: what the
 * traveller reported about their departure, recorded on the Trips flight it is
 * linked to, and the session's §5 state advanced. The route has already
 * recomputed and saved this session's own schedule, so nothing is recalculated
 * twice (`recalculate: false`). Never fails the route: every outcome is reported.
 */
export async function recordTravellerDisruption(
  db: SupabaseClient,
  args: {
    sessionId: string; userId: string; kind: string; newDepartureIso: string | null; nowMs: number;
    /** The route's own recompute (recomputeForDisruption), when it moved the schedule. */
    recompute: { returnStateChanged: boolean; usableMinutesDelta: number } | null;
  },
): Promise<TravellerReport | undefined> {
  if (!await isFlagEnabled(db, "layover_flight_connections_enabled")) return undefined; // OFF: the response is byte-identical
  const link = await readSessionConnection(db, args.sessionId, args.userId);
  if (!link.ok) return { recorded: false, reason: "session_unreadable" };
  const segmentId = link.connection?.departureSegmentId ?? null;
  if (!segmentId) return { recorded: false, reason: "not_linked_to_a_trip_flight" };
  let observation: FlightObservation;
  if (args.kind === "cancellation") observation = { status: "cancelled" };
  else if (args.kind === "delay") observation = { status: "delayed", ...(args.newDepartureIso ? { estimatedDepartureAt: args.newDepartureIso } : {}) };
  else if (args.kind === "on_time") observation = { status: "scheduled", ...(args.newDepartureIso ? { estimatedDepartureAt: args.newDepartureIso } : {}) };
  else return { recorded: false, reason: "a_rebooking_is_a_new_flight", segmentId };
  const r = await applyFlightStatusUpdate(db, {
    source: "traveller", segmentId, actorUserId: args.userId, observedAt: new Date(args.nowMs).toISOString(), observation,
  }, { nowMs: args.nowMs, recalculate: false });
  if (!r.ok) return { recorded: false, reason: r.reason, segmentId };
  const seg = r.segments[0];
  if (!seg || !seg.recorded) return { recorded: false, reason: seg?.refusal ?? "segment_not_found", segmentId };
  // Materiality is the replanner's own threshold, on the route's own recompute; the cancellation is §5's own edge.
  const material = args.recompute !== null && (args.recompute.returnStateChanged || Math.abs(args.recompute.usableMinutesDelta) >= MATERIALITY.usableMinutes);
  const event = args.kind === "cancellation" ? "DEPARTURE_CANCELLED" as const : material ? "MATERIAL_DISRUPTION" as const : null;
  const state = event ? await advanceSessionLifecycle(db, args.sessionId, event, { materialChange: true }) : null;
  return { recorded: true, segmentId, state, duplicate: seg.duplicate };
}

// ── (b) an approved feed, behind this interface ──────────────────────────────

/** One flight as a status feed states it. Unstated is null, never defaulted. */
export interface FeedFlightStatus {
  carrierCode: string;
  flightNumber: string;
  departureAirport: string | null;
  arrivalAirport: string | null;
  scheduledDepartureAt: string;
  scheduledArrivalAt: string | null;
  estimatedDepartureAt: string | null;
  estimatedArrivalAt: string | null;
  departureTerminal: string | null;
  arrivalTerminal: string | null;
  departureGate: string | null;
  arrivalGate: string | null;
  status: FlightStatus;
  observedAt: string;
  sourceRef: string;
}

export interface FlightStatusQuery {
  carrierCode: string;
  flightNumber: string;
  /** The scheduled departure's LOCAL date at the departure airport, YYYY-MM-DD. */
  date: string;
}

export interface FlightStatusFeed {
  readonly id: string;
  /** True only for an adapter bound to a real feed. Never set on a stand-in. */
  readonly live: boolean;
  status(q: FlightStatusQuery): Promise<ProviderResult<FeedFlightStatus>>;
}

/** Every deployment has this today: no feed is licensed. Refuses by name, always. */
export const NO_FLIGHT_STATUS_FEED: FlightStatusFeed = {
  id: "no-flight-status-feed",
  live: false,
  async status() {
    return refuse("no-flight-status-feed", "PROVIDER_UNBOUND",
      "no flight-status feed is licensed or configured for this deployment. Flight changes are taken from the traveller only (source traveller); nothing is guessed from the schedule.");
  },
};

export type FlightStatusMapper = (body: unknown, q: FlightStatusQuery, observedAt: string) => FeedFlightStatus | { error: string };

export const FLIGHT_STATUS_FEED_URL_ENV = "FLIGHT_STATUS_FEED_URL";
export const FLIGHT_STATUS_FEED_KEY_ENV = "FLIGHT_STATUS_FEED_API_KEY";

export interface HttpFlightStatusFeedConfig {
  id: string;
  /** A URL template: {designator}, {date} and optionally {key} are substituted (encoded). */
  urlTemplate: string;
  credentialEnv: string;
  mapper: FlightStatusMapper;
  timeoutMs?: number;
}

/** The vendor-independent half of a status feed: refuses by name, never a guessed flight. */
export function createHttpFlightStatusFeed(
  cfg: HttpFlightStatusFeedConfig,
  opts: { fetchImpl?: typeof fetch; readEnv?: (n: string) => string | undefined; now?: () => Date } = {},
): FlightStatusFeed {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const readEnv = opts.readEnv ?? ((n: string) => process.env[n]);
  const now = opts.now ?? (() => new Date());
  return {
    id: cfg.id,
    live: true,
    async status(q: FlightStatusQuery): Promise<ProviderResult<FeedFlightStatus>> {
      const d = parseDesignator(`${q.carrierCode}${q.flightNumber}`);
      if (!d) return refuse(cfg.id, "REQUEST_INCOMPLETE", "not an airline designator");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date)) return refuse(cfg.id, "REQUEST_INCOMPLETE", "date must be YYYY-MM-DD");
      const noKey = credentialRefusal(cfg.id, cfg.credentialEnv, readEnv);
      if (noKey) return noKey;
      const key = readEnv(cfg.credentialEnv) as string;
      if (typeof doFetch !== "function") return refuse(cfg.id, "PROVIDER_UNAVAILABLE", "no fetch implementation");
      const designator = d.carrierCode + d.flightNumber;
      const usesKeyInUrl = cfg.urlTemplate.includes("{key}");
      const url = cfg.urlTemplate
        .replace("{designator}", encodeURIComponent(designator))
        .replace("{date}", encodeURIComponent(q.date))
        .replace("{key}", encodeURIComponent(key));
      let res: Response;
      try {
        res = await doFetch(url, {
          headers: { Accept: "application/json", ...(usesKeyInUrl ? {} : { Authorization: `Bearer ${key}` }) },
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 6_000),
        });
      } catch (e) {
        return refuse(cfg.id, "PROVIDER_UNAVAILABLE", e instanceof Error ? `${e.name}: ${e.message}` : "fetch failed");
      }
      if (res.status === 401 || res.status === 403) return refuse(cfg.id, "PROVIDER_REJECTED", `HTTP ${res.status}: the credential was rejected`, cfg.credentialEnv);
      if (res.status === 429) return refuse(cfg.id, "PROVIDER_REJECTED", "HTTP 429: quota exhausted");
      if (!res.ok) return refuse(cfg.id, "PROVIDER_UNAVAILABLE", `HTTP ${res.status}`);
      let body: unknown;
      try { body = await res.json(); } catch { return refuse(cfg.id, "PROVIDER_MALFORMED", "body is not JSON"); }
      const mapped = cfg.mapper(body, { ...q, carrierCode: d.carrierCode, flightNumber: d.flightNumber }, now().toISOString());
      if ("error" in mapped) return refuse(cfg.id, "PROVIDER_MALFORMED", mapped.error);
      return answer(mapped);
    },
  };
}

/** The feed bound by the environment: the two variables, both set, or the refusing stand-in. */
export function flightStatusFeedFromEnv(readEnv: (n: string) => string | undefined = (n) => process.env[n], fetchImpl?: typeof fetch): FlightStatusFeed {
  const url = (readEnv(FLIGHT_STATUS_FEED_URL_ENV) ?? "").trim();
  if (!url) return NO_FLIGHT_STATUS_FEED;
  return createHttpFlightStatusFeed(
    { id: "flight-status-feed", urlTemplate: url, credentialEnv: FLIGHT_STATUS_FEED_KEY_ENV, mapper: flightRecordShape },
    { readEnv, ...(fetchImpl ? { fetchImpl } : {}) },
  );
}

/**
 * ONE MAPPER, FOR A WIDELY PUBLISHED "flight record" SHAPE — not a vendor
 * recommendation and bound to nothing until the owner licenses a feed. The
 * shape: `{ data: [ { flight: { iata }, flight_status, departure: { iata,
 * terminal, gate, scheduled, estimated }, arrival: { ... } } ] }` — the shape
 * lib/providers/flightItineraryProvider.ts's `aviationStackShape` reads. A
 * record missing its designator or scheduled departure is not this flight.
 * A status this code cannot read is `unknown`, never `scheduled`.
 */
export function flightRecordShape(body: unknown, q: FlightStatusQuery, observedAt: string): FeedFlightStatus | { error: string } {
  const rows = (body as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return { error: "response has no data array" };
  const want = q.carrierCode + q.flightNumber;
  for (const row of rows as any[]) {
    const iata = typeof row?.flight?.iata === "string" ? parseDesignator(row.flight.iata) : null;
    if (!iata || iata.carrierCode + iata.flightNumber !== want) continue;
    const dep = row.departure ?? {};
    const arr = row.arrival ?? {};
    const iso = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 32) : null);
    const sched = iso(dep.scheduled);
    if (!sched) continue;
    return {
      carrierCode: iata.carrierCode, flightNumber: iata.flightNumber,
      departureAirport: typeof dep.iata === "string" ? dep.iata.toUpperCase() : null,
      arrivalAirport: typeof arr.iata === "string" ? arr.iata.toUpperCase() : null,
      scheduledDepartureAt: sched, scheduledArrivalAt: iso(arr.scheduled),
      estimatedDepartureAt: iso(dep.estimated), estimatedArrivalAt: iso(arr.estimated),
      departureTerminal: text(dep.terminal), arrivalTerminal: text(arr.terminal),
      departureGate: text(dep.gate), arrivalGate: text(arr.gate),
      status: feedStatus(row.flight_status),
      observedAt,
      sourceRef: `${want}:${sched}`,
    };
  }
  return { error: `no readable record for ${want}` };
}

function feedStatus(raw: unknown): FlightStatus {
  switch (String(raw ?? "").toLowerCase()) {
    case "scheduled": return "scheduled";
    case "active": case "en-route": case "airborne": return "departed";
    case "landed": return "landed";
    case "cancelled": case "canceled": return "cancelled";
    case "diverted": return "diverted";
    case "delayed": return "delayed";
    case "boarding": return "boarding";
    default: return "unknown";
  }
}

/**
 * A feed answer as an update. Only what the feed STATED is sent: a null
 * estimate means the feed said nothing about it, so the key is omitted rather
 * than recorded as "unknown" over a traveller's own statement.
 */
export function updateFromFeed(feedId: string, f: FeedFlightStatus): FlightStatusUpdate {
  const o: FlightObservation = { status: f.status };
  if (f.estimatedDepartureAt) o.estimatedDepartureAt = f.estimatedDepartureAt;
  if (f.estimatedArrivalAt) o.estimatedArrivalAt = f.estimatedArrivalAt;
  if (f.departureTerminal) o.departureTerminal = f.departureTerminal;
  if (f.arrivalTerminal) o.arrivalTerminal = f.arrivalTerminal;
  if (f.departureGate) o.departureGate = f.departureGate;
  if (f.arrivalGate) o.arrivalGate = f.arrivalGate;
  return {
    source: "feed", feedId, sourceRef: f.sourceRef, observedAt: f.observedAt, observation: o,
    flight: { carrierCode: f.carrierCode, flightNumber: f.flightNumber, scheduledDepartureAt: f.scheduledDepartureAt },
  };
}

export interface FeedRefreshReport {
  ok: boolean;
  feed: string;
  live: boolean;
  queried: number;
  applied: number;
  refusals: Array<{ segmentId: string; reason: string }>;
}

/**
 * Ask the feed about every flight a live, linked session depends on, and apply
 * each answer. Not scheduled by this lane: it needs a licensed feed first, and
 * a schedule then (named in the handback). With no feed bound it asks nothing
 * and reports the refusal.
 */
export async function refreshFlightStatusFromFeed(db: SupabaseClient, feed: FlightStatusFeed, opts: { nowMs: number; limit?: number }): Promise<FeedRefreshReport> {
  const report: FeedRefreshReport = { ok: true, feed: feed.id, live: feed.live, queried: 0, applied: 0, refusals: [] };
  if (!await isFlagEnabled(db, "layover_flight_connections_enabled")) return { ...report, ok: false, refusals: [{ segmentId: "", reason: "feature_disabled" }] };
  if (!feed.live) return { ...report, ok: false, refusals: [{ segmentId: "", reason: "PROVIDER_UNBOUND" }] };
  const ids = new Set<string>();
  for (const col of ["arrival_segment_id", "departure_segment_id"] as const) {
    const { data, error } = await (col === "arrival_segment_id" ? db.from("layover_sessions").select("arrival_segment_id").eq("status", "active").not("arrival_segment_id", "is", null) : db.from("layover_sessions").select("departure_segment_id").eq("status", "active").not("departure_segment_id", "is", null)).limit(opts.limit ?? 200);
    if (error) {
      logger.warn({ err: error.message, col }, "flight-status refresh: linked sessions unreadable — nothing asked of the feed");
      return { ...report, ok: false, refusals: [{ segmentId: "", reason: "sessions_unreadable" }] };
    }
    for (const r of (data ?? []) as any[]) if (typeof r[col] === "string") ids.add(r[col]);
  }
  const segs = await readFlightSegmentsByIds(db, [...ids]);
  if (!segs.ok) return { ...report, ok: false, refusals: [{ segmentId: "", reason: "segments_unreadable" }] };
  const tzCache = new Map<string, string | null>();
  for (const s of segs.segments) {
    if (!s.carrierCode || !s.flightNumber || !s.scheduledDepartureAt || !s.departureAirport) { report.refusals.push({ segmentId: s.id, reason: "flight_identity_unknown" }); continue; }
    if (!tzCache.has(s.departureAirport)) {
      const looked = await lookupByIata(db, s.departureAirport);
      tzCache.set(s.departureAirport, looked.kind === "read" ? looked.value.airport?.timezone ?? null : null);
    }
    const tz = tzCache.get(s.departureAirport);
    if (!tz) { report.refusals.push({ segmentId: s.id, reason: "departure_airport_zone_unknown" }); continue; }
    report.queried += 1;
    const answerOrRefusal = await feed.status({ carrierCode: s.carrierCode, flightNumber: s.flightNumber, date: localDayString(tz, new Date(s.scheduledDepartureAt)) });
    if (!answerOrRefusal.ok) { report.refusals.push({ segmentId: s.id, reason: answerOrRefusal.reason }); continue; }
    const applied = await applyFlightStatusUpdate(db, updateFromFeed(feed.id, answerOrRefusal.value), { nowMs: opts.nowMs });
    if (!applied.ok) report.refusals.push({ segmentId: s.id, reason: applied.reason });
    else report.applied += applied.segments.filter((x) => x.recorded && !x.duplicate).length;
  }
  return report;
}
