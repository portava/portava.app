/**
 * LayoverSafeReturnService — §15 Safe Return, §15.1 one-tap abort,
 * §15.2 disruption mode.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §15   NORMAL → RETURN_SOON → RETURN_NOW → CONNECTION_AT_RISK, and what
 *         happens AT the escalated state (census L140 built, L141-L145 not)
 *   §15.1 "Every active landside plan must expose RETURN TO AIRPORT"; the
 *         action cancels optional itinerary state, marks the session
 *         RETURNING, surfaces the fastest certified route, notifies crew/buddy
 *         flows, preserves the offline route/deadline, and records the
 *         transition in the decision ledger   (census L146, L147)
 *   §15.2 CONNECTION → DELAYED → SEVERE_DELAY → OVERNIGHT, ↘ CANCELLED →
 *         REBOOKING/RECOVERY; "Disruption may expand or shrink the
 *         FreedomWindow. Recompute; do not simply append delay minutes."
 *                                              (census L148, L149)
 *
 * ── THE LADDER IS ALREADY CERTIFIED; THIS FILE IS WHAT HAPPENS AT IT ────────
 * `LayoverSafetyEngine.computeReturnState` derives the four states
 * deterministically and is swept for two monotonicity properties (census L140,
 * verdict C). What the census scores NOT-BUILT is every consequence: at
 * CONNECTION_AT_RISK the dashboard still renders the same eight sections
 * (L141), no route is primary (L142), no gate context is pinned (L143), no
 * crew is notified (L144), no rebooking help appears (L145). `safeReturnPosture`
 * below is the server half of those five: one additive object per response
 * saying what the surface must do. It changes no existing field.
 *
 * ── WHAT IS HONESTLY UNAVAILABLE, AND SAYS SO ───────────────────────────────
 * The routed port supplies a measured way back only with a fresh explicit origin.
 * Missing provider or current-origin evidence leaves `returnContract.route` null with a named reason
 * rather than a plausible-looking line — spec §2.1, "missing live intelligence
 * degrades VISIBLY; never fabricate freshness." A crew is told only behind a flag
 * AND the traveller's own per-abort choice (census L144, LayoverCrewAbortNotice.ts);
 * otherwise `crewNotifiedCount` is 0 with a named reason, not a silent success. There is no gate/terminal feed (census L80), so the pinned
 * context carries the airport's `terminalInfo` when the profile has one and
 * `null` when it does not.
 *
 * ── OWNER BOUNDARY, NOT DECIDED HERE ────────────────────────────────────────
 * `LAYOVER_RETURN_REMINDER_DELIVERY` (docs/architecture/blocker-ledger.md) —
 * whether the return reminder is server-pushed or scheduled locally by the
 * client — is untouched. Nothing in this file sends a push, and
 * `LayoverNotificationService.sendReturnDeadlineReminder` is neither called nor
 * changed by it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import type { LayoverReturnState } from "./LayoverSafetyEngine.js";
import {
  returnNotificationPosture,
  type ReturnNotificationPosture,
} from "./LayoverReturnEscalation.js";
import {
  certifySessionFeasibility,
  certificationHeader,
  type FeasibilityAirport,
  type FeasibilitySession,
  type LayoverFeasibilityRecord,
} from "./LayoverFeasibility.js"; import type { EntryEligibility } from "./layoverEntryGate.js"; import { tellCrewOfAbortWithin, CREW_ABORT_NOTICE_OFF, type CrewAbortNoticeReason, type CrewAbortNoticeRequest } from "../layover/LayoverCrewAbortNotice.js"; // census-layover L144 (§74); same line, so no cited line below moves

const logger = rootLogger.child({ service: "LayoverSafeReturnService" });

/** Version of the Safe Return posture and abort rules. Travels on every result. */
export const LAYOVER_SAFE_RETURN_VERSION = "2026.09.08-1";

// ─────────────────────────────────────────────────────────────────────────────
// §15 — what the surface must do at each escalation state
// ─────────────────────────────────────────────────────────────────────────────

export type SafeReturnPrimaryAction = "explore" | "plan_return" | "return_now" | "recover_connection";

export interface SafeReturnPosture {
  safeReturnVersion: string;
  returnState: LayoverReturnState;
  /** §15 "exploration surfaces collapse" — true from RETURN_NOW onward. */
  explorationCollapsed: boolean;
  /** §15 "fastest return route is primary" — true from RETURN_NOW onward. */
  returnRoutePrimary: boolean;
  /** §15 "terminal/gate context is pinned" — true from RETURN_NOW onward. */
  pinTerminalContext: boolean;
  /** §15 "crew/buddy is notified if policy + user settings allow". */
  notifyCrew: boolean;
  /** §15 "rebooking / airline / airport help becomes available". */
  offerRecoveryHelp: boolean;
  /** §13 "when RETURN_NOW is active, suppress exploration-first affordances". */
  primaryAction: SafeReturnPrimaryAction;
  /** §15.1 the abort control is offered on EVERY active landside plan. */
  abortAvailable: boolean;
  minutesToHardReturn: number;
  /**
   * census L18 — "Safe Return owns … notification priority". The rung this
   * state sits on, DECIDED IN `services/airport/LayoverReturnEscalation.ts`
   * and only asked for here, so the priority a message would carry is not a
   * second thing the layover surface invents for itself. Nothing is sent: see
   * that file's owner boundary.
   */
  notification: ReturnNotificationPosture;
}

/**
 * The five §15 consequences, derived from the certified state and nothing else.
 *
 * `abortAvailable` is deliberately TRUE in every state including NORMAL: §15.1
 * says "every active landside plan must expose RETURN TO AIRPORT", not "every
 * escalated one". Making it conditional is how that requirement quietly becomes
 * a warning banner.
 *
 * `notifyCrew` turns on one step EARLIER than the others (RETURN_SOON), because
 * a crew that learns at RETURN_NOW that a member is leaving learns it too late
 * to change their own plan. The spec attaches notification to
 * CONNECTION_AT_RISK; this is stricter, never looser.
 */
export function safeReturnPosture(record: LayoverFeasibilityRecord): SafeReturnPosture {
  const state = record.envelope.returnState;
  const escalated = state === "RETURN_NOW" || state === "CONNECTION_AT_RISK";
  const minutesToHardReturn = Math.round(
    (record.deadline.hardReturnTime.getTime() - record.inputs.nowMs) / 60_000,
  );
  const primaryAction: SafeReturnPrimaryAction =
    state === "CONNECTION_AT_RISK" ? "recover_connection"
    : state === "RETURN_NOW" ? "return_now"
    : state === "RETURN_SOON" ? "plan_return"
    : "explore";
  return {
    safeReturnVersion: LAYOVER_SAFE_RETURN_VERSION,
    returnState: state,
    explorationCollapsed: escalated,
    returnRoutePrimary: escalated,
    pinTerminalContext: escalated,
    notifyCrew: state !== "NORMAL",
    offerRecoveryHelp: state === "CONNECTION_AT_RISK",
    primaryAction,
    abortAvailable: true,
    minutesToHardReturn,
    notification: returnNotificationPosture(state),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §15.1 — the return contract handed back on abort (and cacheable offline)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReturnContract {
  safeReturnVersion: string;
  hardReturnTime: string;
  returnState: LayoverReturnState;
  minutesToHardReturn: number;
  bufferMinutes: number;
  breakdown: LayoverFeasibilityRecord["deadline"]["breakdown"];
  airport: {
    id: string | null;
    iataCode: string;
    name: string;
    city: string;
    country: string;
    timezone: string;
    lat: number | null;
    lng: number | null;
    terminalInfo: unknown | null;
  };
  /**
   * A measured return from an explicitly supplied current origin; absent until
   * the origin and provider answer pass the return-route checks below.
   */
  route: AbortReturnRoute | null;
  routeUnavailableReason: string | null;
  certification: ReturnType<typeof certificationHeader>;
}

export function buildReturnContract(
  airport: AirportProfile,
  record: LayoverFeasibilityRecord,
): ReturnContract {
  return {
    safeReturnVersion: LAYOVER_SAFE_RETURN_VERSION,
    hardReturnTime: record.deadline.hardReturnTime.toISOString(),
    returnState: record.envelope.returnState,
    minutesToHardReturn: Math.round(
      (record.deadline.hardReturnTime.getTime() - certifiedPlanningInstant(record)) / 60_000,
    ),
    bufferMinutes: record.deadline.breakdown.totalBuffer,
    breakdown: record.deadline.breakdown,
    airport: {
      id: airport.id ?? null,
      iataCode: airport.iataCode,
      name: airport.name,
      city: airport.city,
      country: airport.country,
      timezone: airport.timezone ?? "UTC",
      lat: airport.lat ?? null,
      lng: airport.lng ?? null,
      terminalInfo: (airport as any).terminalInfo ?? null,
    },
    route: null,
    routeUnavailableReason: "origin_unavailable",
    certification: certificationHeader(record),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §15.1 — one-tap abort
// ─────────────────────────────────────────────────────────────────────────────

export type AbortEffect =
  | "itinerary_cancelled"
  | "itinerary_cancel_failed"
  | "itinerary_nothing_to_cancel"
  | "status_marked_returning"
  | "status_unchanged_flag_off"
  | "status_unchanged_no_active_row"
  | "status_write_failed"
  | "ledger_recorded"
  | "ledger_write_failed"
  | "buddy_notify_unavailable" | "buddy_notified" | "crew_notify_unavailable" | /** census-layover L144: at least one crewmate now holds the "heading back" notice (LayoverCrewAbortNotice.ts) */ "crew_notified";

export interface AbortResult {
  ok: boolean;
  safeReturnVersion: string;
  /** ISO instant the abort was decided. */
  abortedAt: string;
  returnContract: ReturnContract;
  posture: SafeReturnPosture;
  /** Ids of landside stops removed from the plan. */
  cancelledStopIds: string[];
  /** Every effect that ran, successful or not. Failures are NOT swallowed. */
  effects: AbortEffect[];
  /** census-layover L144 (§74): how many crewmates hold the "heading back" notice — a COUNT, never a person (crewmates' ids are not published; census §48 `bindingMemberHidden`). 0 with a reason unless the flag is on AND the traveller asked on THIS abort. */
  crewNotifiedCount: number; buddyNotifiedCount: number; buddyNotifyUnavailableReason: BuddyAbortNoticeReason | null;
  crewNotifyUnavailableReason: CrewAbortNoticeReason | null;
  statusApplied: boolean;
}

/**
 * Cancel the optional (landside) itinerary for an aborting session.
 *
 * Only stops with `inside_airport = false` are removed: an airside stop is not
 * "optional itinerary state" the traveller is abandoning, it is something they
 * can still do behind security, and deleting it would be destroying data the
 * abort did not ask about.
 *
 * `.select("id")` is not decoration. A PostgREST DELETE with no `.select()`
 * returns 204 with no body, so `data` is null and NOTHING can distinguish
 * "removed four rows" from "removed none" — the affected-row count is
 * unknowable without it. This function reports the ids it actually removed.
 */
async function cancelLandsideStops(
  db: SupabaseClient,
  sessionId: string,
): Promise<{ ok: boolean; ids: string[]; message?: string }> {
  const { data, error } = await db
    .from("layover_plan_stops")
    .delete()
    .eq("session_id", sessionId)
    .eq("inside_airport", false)
    .select("id");
  if (error) {
    logger.error({ err: error, sessionId }, "abort: landside stops could not be cancelled");
    return { ok: false, ids: [], message: String(error.message ?? "layover_plan_stops delete failed") };
  }
  return { ok: true, ids: ((data ?? []) as any[]).map((r) => String(r.id)) };
}

/**
 * Mark the session RETURNING.
 *
 * GATED, and the gate is not a preference. `layover_sessions.status` is a TEXT
 * column with `CHECK (status IN ('active','completed','cancelled','expired'))`
 * (0127:85-86) — `returning` is NOT a legal value on any database that has not
 * run migration 2741, and writing it there fails the whole statement with a
 * check violation. So the write only happens when
 * `layover_safe_return_status_enabled` is on, which 2741 seeds FALSE, and the
 * flag is read through the shared fail-closed reader: an unreadable
 * `feature_flags` leaves the status alone. Flag off is reported as
 * `status_unchanged_flag_off`, never as success.
 */
async function markReturning(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<{ ok: true; applied: boolean } | { ok: false; reason: "status_write_failed" }> {
  try { const { data, error } = await db
    .from("layover_sessions")
    .update({ status: "returning", updated_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("user_id", userId)
    .eq("status", "active")
    .select("id");
  if (error) {
    logger.error({ err: error, sessionId, operation: "markReturning", reason: "status_write_failed" }, "abort: could not mark session returning");
    return { ok: false, reason: "status_write_failed" };
  }
  // A write with `.select()` that matched nothing is not a failure — the
  // session may already have left `active` — but it is not an application
  // either, and saying so is the difference between the two.
  return { ok: true, applied: ((data ?? []) as any[]).length > 0 }; } catch (err) { logger.error({ err, sessionId, operation: "markReturning", reason: "status_write_failed" }, "abort: returning status write threw"); return { ok: false, reason: "status_write_failed" }; }
}

/**
 * §15.1 RETURN TO AIRPORT.
 *
 * Six effects, and every one of them reports. The function returns `ok: false`
 * when any effect that was attempted failed, so a caller cannot render "you are
 * heading back, your plan is cleared" over a delete that did not happen.
 *
 * `statusEnabled` is passed in rather than read here so the caller does one
 * flag read alongside the others it already performs, and so the tests can
 * drive both arms without staging a flag table.
 */
export async function abortToAirport(
  db: SupabaseClient,
  input: {
    session: LayoverSession;
    airport: AirportProfile;
    record: LayoverFeasibilityRecord;
    userId: string;
    nowMs: number;
    statusEnabled: boolean; /** census-layover L144: the traveller's per-abort choice and the flag, read by the route (`crewAbortNoticeRequest`). Omitted = nobody is told. */ crewNotice?: CrewAbortNoticeRequest; /** Tests only: the crew notice's bound (default CREW_ABORT_NOTICE_DEADLINE_MS). */ crewNoticeDeadlineMs?: number; buddyNotice?: BuddyAbortNoticeRequest; buddyNoticeDeadlineMs?: number; origin?: unknown;
  },
): Promise<AbortResult> {
  const effects: AbortEffect[] = [];
  const { session, airport, record, userId, nowMs } = input;

  const cancelled = await cancelLandsideStops(db, session.id);
  if (!cancelled.ok) effects.push("itinerary_cancel_failed");
  else if (cancelled.ids.length > 0) effects.push("itinerary_cancelled");
  else effects.push("itinerary_nothing_to_cancel");

  let statusApplied = false;
  let statusFailed = false;
  if (input.statusEnabled) {
    const marked = await markReturning(db, session.id, userId);
    statusApplied = marked.ok && marked.applied;
    statusFailed = !marked.ok;
    if (!marked.ok) effects.push(marked.reason);
    else if (marked.applied) effects.push("status_marked_returning");
    // Flag ON and nothing matched means the session had already left `active`.
    // Reporting that as `status_unchanged_flag_off` would name the wrong cause.
    else effects.push("status_unchanged_no_active_row");
  } else {
    effects.push("status_unchanged_flag_off");
  }

  const contract = await buildRoutedReturnContract(airport, record, session, input.origin);
  const posture = safeReturnPosture(record);

  // §15.1 "records the transition in the decision ledger". This is the one
  // effect that must survive: it is the only durable evidence the traveller
  // pressed abort. Certification travels with it (spec §20) so the deadline in
  // the ledger can be traced to the rules and inputs that produced it.
  const { error: ledgerError } = await db.from("layover_events").insert({
    session_id: session.id,
    user_id: userId,
    event_type: "safe_return_aborted",
    metadata: {
      safeReturnVersion: LAYOVER_SAFE_RETURN_VERSION,
      returnState: record.envelope.returnState,
      hardReturnTime: contract.hardReturnTime,
      minutesToHardReturn: contract.minutesToHardReturn,
      cancelledStopIds: cancelled.ids,
      statusApplied,
      ...certificationHeader(record),
    },
  });
  if (ledgerError) {
    logger.error({ err: ledgerError, sessionId: session.id }, "abort: decision ledger write failed");
    effects.push("ledger_write_failed");
  } else {
    effects.push("ledger_recorded");
  }
  // census-layover L144 — AFTER the ledger, outside `ok`, and BOUNDED: telling the crew never fails or holds the abort, and a failed abort is still a traveller heading back.
  const [crew,buddy] = await Promise.all([tellCrewOfAbortWithin(db, { userId, sessionId: session.id, nowMs, request: input.crewNotice ?? CREW_ABORT_NOTICE_OFF, tripId: session.tripId }, input.crewNoticeDeadlineMs),tellBuddyOfAbortWithin(db,{userId,sessionId:session.id,nowMs,request:input.buddyNotice??BUDDY_ABORT_NOTICE_OFF},input.buddyNoticeDeadlineMs)]); effects.push(crew.notifiedCount > 0 ? "crew_notified" : "crew_notify_unavailable"); if(input.buddyNotice?.requested)effects.push(buddy.notifiedCount>0?"buddy_notified":"buddy_notify_unavailable");

  return {
    ok: cancelled.ok && !statusFailed && !ledgerError,
    safeReturnVersion: LAYOVER_SAFE_RETURN_VERSION,
    abortedAt: new Date(nowMs).toISOString(),
    returnContract: contract,
    posture,
    cancelledStopIds: cancelled.ids,
    effects,
    crewNotifiedCount: crew.notifiedCount, buddyNotifiedCount: buddy.notifiedCount, buddyNotifyUnavailableReason: buddy.reason,
    crewNotifyUnavailableReason: crew.reason, // §74 — was the hard-coded "crew_notify_not_enabled" (§48), which is now the flag-OFF answer of tellCrewOfAbort
    statusApplied,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §15.2 — disruption mode
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §15.2's two chains, as one state set.
 *
 *   CONNECTION → DELAYED → SEVERE_DELAY → OVERNIGHT
 *              ↘ CANCELLED → REBOOKING → RECOVERY
 *
 * `OVERNIGHT` here is a DISRUPTION state — the connection has slipped past the
 * night — and is a different thing from `LayoverTier "overnight"`, which the
 * safety engine computes from the SCHEDULED window and which exists on a
 * perfectly on-time twelve-hour layover. Census L148 names that confusion
 * explicitly; the two are kept in separate type spaces so they cannot be
 * assigned to one another.
 */
export const DISRUPTION_STATES = [
  "CONNECTION",
  "DELAYED",
  "SEVERE_DELAY",
  "OVERNIGHT",
  "CANCELLED",
  "REBOOKING",
  "RECOVERY",
] as const;
export type DisruptionState = (typeof DISRUPTION_STATES)[number];

/** Minutes of delay at which DELAYED becomes SEVERE_DELAY. */
export const SEVERE_DELAY_MIN = 180;
/** Minutes of delay at which the disruption is treated as an overnight. */
export const OVERNIGHT_DELAY_MIN = 8 * 60;

export type DisruptionEvent =
  | { kind: "delay"; delayMinutes: number }
  | { kind: "cancellation" }
  | { kind: "rebooking_offered" }
  | { kind: "rebooking_confirmed" }
  | { kind: "on_time" };

/**
 * The transition function. Total, deterministic, and NOT a delay accumulator:
 * a `delay` event carries the CURRENT total delay against the original
 * schedule, and the state is a function of that total, so two 90-minute delay
 * events do not silently make a three-hour one.
 *
 * The delay chain cannot re-enter from the cancellation chain: once a flight is
 * CANCELLED, a delay event does not make it merely DELAYED again. Recovery runs
 * CANCELLED → REBOOKING → RECOVERY and terminates there.
 */
export function nextDisruptionState(
  current: DisruptionState,
  event: DisruptionEvent,
): DisruptionState {
  const cancelledChain = current === "CANCELLED" || current === "REBOOKING" || current === "RECOVERY";
  switch (event.kind) {
    case "cancellation":
      return "CANCELLED";
    case "rebooking_offered":
      return cancelledChain ? "REBOOKING" : current;
    case "rebooking_confirmed":
      return cancelledChain ? "RECOVERY" : current;
    case "on_time":
      return cancelledChain ? current : "CONNECTION";
    case "delay": {
      if (cancelledChain) return current;
      const d = event.delayMinutes;
      if (d >= OVERNIGHT_DELAY_MIN) return "OVERNIGHT";
      if (d >= SEVERE_DELAY_MIN) return "SEVERE_DELAY";
      if (d > 0) return "DELAYED";
      return "CONNECTION";
    }
  }
}

export interface DisruptionRecompute {
  safeReturnVersion: string;
  state: DisruptionState;
  /** The certified record BEFORE the disruption. */
  before: LayoverFeasibilityRecord;
  /** The certified record AFTER, recomputed from the new schedule. */
  after: LayoverFeasibilityRecord;
  /** after.usableMinutes − before.usableMinutes. May be negative. */
  usableMinutesDelta: number;
  /** Minutes the departure moved. Positive = later. */
  scheduleDeltaMinutes: number;
  /**
   * TRUE when the window did NOT move by the same amount as the schedule —
   * i.e. the recompute produced something an "append the delay minutes"
   * shortcut could not have. The §15.2 requirement in one boolean.
   */
  recomputedNotAppended: boolean;
  returnStateChanged: boolean;
}

/**
 * §15.2 "Disruption may expand or shrink the FreedomWindow. Recompute; do not
 * simply append delay minutes."
 *
 * The recompute is a FULL re-certification against the new schedule through
 * `certifySessionFeasibility` — the same single canonical derivation every
 * route uses — not an adjustment of the old numbers. That is what makes the
 * shrink case possible at all: a two-hour delay that pushes the return into the
 * night traffic band adds time-of-day buffer, so the usable window grows by
 * LESS than two hours, and a delay past the last departure of the day can leave
 * it smaller than it started. An appender cannot produce either result.
 *
 * `recomputedNotAppended` records when that actually happened for this input.
 * It is FALSE for the many delays that land inside one buffer band, and that is
 * correct: the claim is that the arithmetic recomputes, not that every delay
 * must be non-linear.
 */
export function recomputeForDisruption(
  airport: FeasibilityAirport,
  session: FeasibilitySession,
  input: {
    state: DisruptionState;
    newDepartureTime: string;
    newBoardingTime?: string | null;
    nowMs: number; /** The traveller's corridor, as the route certified with it (census-discovery §65). Omitted = unresolved. */ entry?: EntryEligibility | null; /** census-discovery §81: the snapshot's record for THIS session at `nowMs`, when the route read one. */ before?: LayoverFeasibilityRecord;
  },
): DisruptionRecompute {
  const before = input.before ?? certifySessionFeasibility(airport, session, { nowMs: input.nowMs, entry: input.entry });
  const newSession: FeasibilitySession = {
    ...session,
    departureTime: input.newDepartureTime,
    boardingTime: input.newBoardingTime === undefined ? session.boardingTime : input.newBoardingTime,
  };
  const after = certifySessionFeasibility(airport, newSession, { nowMs: input.nowMs, entry: input.entry, liveConditions: before.inputs.liveConditions }); // lane B2-LIVE: the counterfactual holds the WORLD fixed — the live conditions `before` was certified under — so the diff is the disruption's, not the live term's disappearance

  const scheduleDeltaMinutes = Math.round(
    (new Date(input.newDepartureTime).getTime() - new Date(session.departureTime).getTime()) / 60_000,
  );
  const usableMinutesDelta = after.envelope.usableMinutes - before.envelope.usableMinutes;

  return {
    safeReturnVersion: LAYOVER_SAFE_RETURN_VERSION,
    state: input.state,
    before,
    after,
    usableMinutesDelta,
    scheduleDeltaMinutes,
    recomputedNotAppended: usableMinutesDelta !== scheduleDeltaMinutes,
    returnStateChanged: before.envelope.returnState !== after.envelope.returnState,
  };
}

// L221/L147: one-way return routing. Precise origin is request-only: never placed in the ledger, session or response.
import { withLayoverRoutesBudget, layoverRoutesGuardedCorridor, airportPoint } from "./LayoverTravelTime.js";
import { LAYOVER_RETURN_CORRIDOR_PROVIDER, routedLegOf, type RoutedLegs, type RoutedLeg } from "./LayoverReturnCorridor.js";
import { conservativeReturnMinutes, robustnessOf } from "./LayoverRoutedFeasibility.js";
import { worstTravelConfidence, type TravelConfidence } from "../../lib/travelEstimate.js";
import type { CorridorResult } from "../../lib/providers/routeCorridorProvider.js";

export interface AbortReturnRoute {
  mode: "walk" | "drive";
  departAt: string;
  minutes: number;
  conservativeMinutes: number;
  hardReturnBy: string;
  leaveBy: string;
  expectedAirportReturnAt: string;
  canMeetDeadline: boolean;
  confidence: TravelConfidence;
  expiresAt: string;
  independentRoutes: number;
  conveyances: RoutedLeg["conveyances"];
}

/** Client location is a claimed origin, not proof of presence. Validate freshness/accuracy/range before spending. */
function currentReturnOrigin(value: unknown, nowMs: number): { lat: number; lng: number; mode: "walk" | "drive" } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.lat !== "number" || !Number.isFinite(v.lat) || Math.abs(v.lat) > 90 || typeof v.lng !== "number" || !Number.isFinite(v.lng) || Math.abs(v.lng) > 180) return null;
  if (typeof v.accuracyMeters !== "number" || !Number.isFinite(v.accuracyMeters) || v.accuracyMeters < 0 || v.accuracyMeters > 1000) return null;
  const observed = typeof v.observedAt === "string" ? Date.parse(v.observedAt) : NaN;
  if (!Number.isFinite(observed) || observed > nowMs + 30_000 || nowMs - observed > 120_000 || (v.mode !== "walk" && v.mode !== "drive")) return null;
  return { lat: v.lat, lng: v.lng, mode: v.mode };
}

export async function buildRoutedReturnContract(airport: AirportProfile, record: LayoverFeasibilityRecord, session: LayoverSession, originValue: unknown): Promise<ReturnContract> {
  const base = buildReturnContract(airport, record);
  const absent = (reason: string): ReturnContract => ({ ...base, route: null, routeUnavailableReason: reason });
  const nowMs = certifiedPlanningInstant(record);
  const origin = currentReturnOrigin(originValue, nowMs);
  if (!origin) return absent("origin_unavailable");
  const destination = airportPoint(airport);
  if (!destination) return absent("airport_position_unavailable");
  const provider = layoverRoutesGuardedCorridor(LAYOVER_RETURN_CORRIDOR_PROVIDER);
  if (!provider.routed) return absent("PROVIDER_UNBOUND");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await withLayoverRoutesBudget(session, () => Promise.race<CorridorResult>([
      provider.corridor({ from: { lat: origin.lat, lng: origin.lng }, to: destination, mode: origin.mode, departAt: new Date(nowMs), wantAlternatives: true, cachePolicy:'no_store' }),
      new Promise<CorridorResult>((resolve) => { timer = setTimeout(() => resolve({ ok: false, provider: provider.id, reason: "PROVIDER_UNAVAILABLE", detail: "return-route deadline exceeded", envVar: null }), 3500); }),
    ]));
    if (!result.ok) return absent(result.reason);
    const c = result.value;
    if (!Number.isFinite(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt) <= nowMs) return absent("route_stale");
    if (Date.parse(c.departAt) !== nowMs || c.from.lat !== origin.lat || c.from.lng !== origin.lng || c.to.lat !== destination.lat || c.to.lng !== destination.lng || !c.routes.length) return absent("PROVIDER_MALFORMED");
    if (c.routes.some((r) => !Number.isFinite(r.totalMinutes) || r.totalMinutes < 0 || !r.legs.length || r.legs.some((l) => !Number.isFinite(l.minutes) || l.minutes < 0))) return absent("PROVIDER_MALFORMED");
    // Fastest returned option in the traveller's chosen mode. No route from another mode, or an outbound leg, is invented.
    const leg = routedLegOf({ ...c, routes: [...c.routes].sort((a,b) => a.totalMinutes - b.totalMinutes) }, origin.mode);
    if (!leg.forecast) return absent("return_forecast_unavailable");
    // robustnessOf reads returnLeg only; this one-way query intentionally carries no outbound measurement.
    const robustness = robustnessOf({ returnLeg: leg } as RoutedLegs);
    const rawConfidence = String(record.confidence).toUpperCase();
    const recordConfidence: TravelConfidence = rawConfidence === "HIGH" || rawConfidence === "MEDIUM" || rawConfidence === "LOW" ? rawConfidence : "INSUFFICIENT";
    let confidence = worstTravelConfidence(recordConfidence, leg.confidence);
    if (leg.transferCount >= 2) confidence = worstTravelConfidence(confidence, "LOW");
    const conservative = conservativeReturnMinutes(leg.minutes, confidence, robustness);
    if (!conservative) return absent("confidence_insufficient");
    const arrivalMs = nowMs + conservative.minutes * 60_000;
    return { ...base, routeUnavailableReason: null, route: { mode: origin.mode, departAt: c.departAt, minutes: leg.minutes, conservativeMinutes: conservative.minutes, hardReturnBy: base.hardReturnTime, leaveBy: new Date(record.deadline.hardReturnTime.getTime() - conservative.minutes * 60_000).toISOString(), expectedAirportReturnAt: new Date(arrivalMs).toISOString(), canMeetDeadline: arrivalMs <= record.deadline.hardReturnTime.getTime(), confidence, expiresAt: c.expiresAt, independentRoutes: leg.independentRoutes, conveyances: leg.conveyances } };
  } catch (err) {
    // Provider shape/transport failures never prevent clearing the optional plan and recording the abort.
    logger.warn({err:{code:"PROVIDER_UNAVAILABLE",kind:typeof err},provider:provider.id},"return route provider unavailable"); return absent("PROVIDER_UNAVAILABLE");
  } finally { if (timer) clearTimeout(timer); }
}

// L272: reuse the Safe Return product. Only the server supplies its deadline; setup still owns contact consent.
import { isFlagEnabled as safeReturnFlag } from "../../lib/featureFlags.js";
import { getSession as readOwnedLayover, LAYOVER_LIVE_SESSION_STATUSES } from "./LayoverSessionService.js";
import { consumerLayoverRecord, resolveSessionAirport } from "./LayoverSnapshot.js";
import { resolveLayoverEntry, layoverAirportCountry } from "./layoverEntryGate.js";
import { readTravellerCheckpoints, airportPresenceFrom } from "../layover/LayoverCheckpointStore.js";
import { confirmSafe as confirmReturnProduct, getSessionById as readReturnProduct } from "../safeReturn/SafeReturnService.js";
import { toPublicSession as publicReturnProduct } from "../safeReturn/SafeReturnPrivacyGuard.js";
type ReturnProductRefusal = { ok: false; status: 403 | 404 | 409 | 503; reason: string };
export interface LayoverSafeReturnLink { layover_session_id: string; safe_return_session_id: string; user_id: string; certified_deadline: string; return_started_at: string | null }
async function layoverProductGate(db:SupabaseClient):Promise<"on"|"off"|"unavailable"> {
  try {const {data,error}=await db.from("feature_flags").select("enabled").eq("flag","layover_safe_return_product_enabled").maybeSingle();if(error){logger.warn({err:error},"layover Safe Return product flag unreadable — gate unavailable");return "unavailable";}return data?.enabled===true?"on":"off";} catch (err) {logger.warn({err},"layover Safe Return product flag read threw — gate unavailable");return "unavailable";}
}
export async function readLayoverSafeReturnLink(db: SupabaseClient, userId: string, safeReturnId: string): Promise<{ ok: true; link: LayoverSafeReturnLink | null } | ReturnProductRefusal> {
  const gate=await layoverProductGate(db); if(gate==="unavailable")return {ok:false,status:503,reason:"layover_safe_return_unavailable"}; if(gate==="off")return {ok:true,link:null};
  try {
    const { data, error } = await db.from("layover_safe_return_links").select("layover_session_id,safe_return_session_id,user_id,certified_deadline,return_started_at").eq("safe_return_session_id",safeReturnId).eq("user_id",userId).maybeSingle();
    if (error) { logger.warn({err:error,safeReturnId},"layover Safe Return link unreadable — refusing"); return { ok:false,status:503,reason:"layover_safe_return_unavailable" }; }
    return { ok:true,link:data as LayoverSafeReturnLink | null };
  } catch { return { ok:false,status:503,reason:"layover_safe_return_unavailable" }; }
}
export async function prepareLayoverSafeReturn(db: SupabaseClient, userId: string, sessionId: string): Promise<{ ok:true; session:LayoverSession; record:LayoverFeasibilityRecord; deadline:string } | ReturnProductRefusal> {
  if (!await safeReturnFlag(db,"layover_safe_return_product_enabled") || !await safeReturnFlag(db,"layover_safe_return_status_enabled") || !await safeReturnFlag(db,"safe_return_enabled")) return {ok:false,status:403,reason:"layover_safe_return_disabled"};
  try {
    const owned = await readOwnedLayover(db,sessionId,userId);
    if (!owned.ok) return {ok:false,status:503,reason:"layover_unavailable"};
    const session = owned.session;
    if (!session) return {ok:false,status:404,reason:"layover_not_found"};
    if (!(LAYOVER_LIVE_SESSION_STATUSES as readonly string[]).includes(session.status)) return {ok:false,status:409,reason:"layover_ended"};
    const nowMs=Date.now(), presence=await readTravellerCheckpoints(db,sessionId,nowMs);
    if (!presence.ok) return {ok:false,status:503,reason:"airport_presence_unavailable"};
    if (airportPresenceFrom(presence.checkpoints)!=="landside") return {ok:false,status:409,reason:"report_landside_exit_first"};
    const resolved=await resolveSessionAirport(db,session);
    if (!resolved.ok) return {ok:false,status:503,reason:"airport_unavailable"};
    const airport=resolved.airport;
    const record=await consumerLayoverRecord(db,airport,session,nowMs) ?? certifySessionFeasibility(airport,session,{nowMs,entry:await resolveLayoverEntry(db,userId,layoverAirportCountry(airport)),liveConditions:await resolveLayoverLiveConditions(db,airport,session,nowMs)});
    return {ok:true,session,record,deadline:record.deadline.hardReturnTime.toISOString()};
  } catch (err) { logger.warn({err,sessionId},"layover Safe Return certification unavailable"); return {ok:false,status:503,reason:"layover_certification_unavailable"}; }
}
export async function bindLayoverSafeReturn(db: SupabaseClient, input: { userId:string; safeReturnId:string; context:Extract<Awaited<ReturnType<typeof prepareLayoverSafeReturn>>,{ok:true}> }): Promise<{ok:true} | ReturnProductRefusal> {
  try {
    const {error,data}=await db.from("layover_safe_return_links").insert({layover_session_id:input.context.session.id,safe_return_session_id:input.safeReturnId,user_id:input.userId,certified_deadline:input.context.deadline,certification:certificationHeader(input.context.record)}).select("layover_session_id");
    if (error || !data?.length) { logger.warn({err:error,rowsReturned:data?.length??0,sessionId:input.context.session.id,safeReturnId:input.safeReturnId},"layover Safe Return link not bound"); return {ok:false,status:error?.code==="23505"?409:503,reason:"layover_safe_return_not_bound"}; }
    return {ok:true};
  } catch { return {ok:false,status:503,reason:"layover_safe_return_not_bound"}; }
}
/** A new certificate may tighten an existing timer, never grant extra time. The DB trigger makes the two writes atomic. */
export async function syncLayoverSafeReturnDeadline(db: SupabaseClient, sessionId: string, record: LayoverFeasibilityRecord): Promise<{ok:true} | {ok:false;reason:string}> {
  const gate=await layoverProductGate(db); if(gate==="unavailable")return {ok:false,reason:"layover_safe_return_gate_unavailable"}; if(gate==="off")return {ok:true};
  try {
    const deadline=record.deadline.hardReturnTime.toISOString();
    const {error}=await db.from("layover_safe_return_links").update({certified_deadline:deadline,certification:certificationHeader(record)}).eq("layover_session_id",sessionId).gt("certified_deadline",deadline);
    if (error) { logger.error({err:error,sessionId},"bound Safe Return deadline could not tighten"); return {ok:false,reason:"layover_safe_return_sync_failed"}; }
    return {ok:true};
  } catch (err) { logger.error({err,sessionId},"bound Safe Return deadline sync threw"); return {ok:false,reason:"layover_safe_return_sync_failed"}; }
}
export async function guardLayoverSafeReturnMutation(db: SupabaseClient, userId:string, safeReturnId:string, action:"start"|"extend"|"confirm"): Promise<{ok:true} | ReturnProductRefusal> {
  const bound=await readLayoverSafeReturnLink(db,userId,safeReturnId);
  if (!bound.ok || !bound.link) return bound.ok ? {ok:true} : bound;
  if (action==="extend") return {ok:false,status:403,reason:"layover_deadline_cannot_extend"};
  if (action==="confirm") {
    const checkpoints=await readTravellerCheckpoints(db,bound.link.layover_session_id,Date.now());
    if (!checkpoints.ok) return {ok:false,status:503,reason:"airport_presence_unavailable"};
    return airportPresenceFrom(checkpoints.checkpoints)==="airside" ? {ok:true} : {ok:false,status:403,reason:"record_airport_arrival_on_layover"};
  }
  const context=await prepareLayoverSafeReturn(db,userId,bound.link.layover_session_id);
  if (!context.ok) return context;
  const sync=await syncLayoverSafeReturnDeadline(db,context.session.id,context.record);
  return sync.ok ? {ok:true} : {ok:false,status:503,reason:sync.reason};
}
/** Called only AFTER the traveller's AIRPORT_REENTRY checkpoint is persisted. No location or contact inference. */
export async function closeLayoverSafeReturnAtAirport(db:SupabaseClient,userId:string,sessionId:string): Promise<{ok:true;closed:boolean} | {ok:false;reason:string}> {
  const gate=await layoverProductGate(db); if(gate==="unavailable")return {ok:false,reason:"layover_safe_return_gate_unavailable"}; if(gate==="off")return {ok:true,closed:false};
  try {
    const {data,error}=await db.from("layover_safe_return_links").select("safe_return_session_id").eq("layover_session_id",sessionId).eq("user_id",userId).maybeSingle();
    if (error) { logger.warn({err:error,sessionId},"layover Safe Return link unreadable at airport re-entry — close unavailable"); return {ok:false,reason:"safe_return_close_unavailable"}; }
    if (!data) return {ok:true,closed:false};
    const guard=await guardLayoverSafeReturnMutation(db,userId,data.safe_return_session_id,"confirm");
    if (!guard.ok) return {ok:false,reason:guard.reason};
    const result=await confirmReturnProduct(db,data.safe_return_session_id,userId);
    if(result.outcome==="unavailable")return {ok:false,reason:"safe_return_close_unavailable"}; if(result.outcome==="ok")return {ok:true,closed:true}; const existing=await readReturnProduct(db,data.safe_return_session_id,userId);return existing.ok && existing.value && ["safe","cancelled"].includes(existing.value.status) ? {ok:true,closed:true} : {ok:false,reason:"safe_return_close_unavailable"};
  } catch { return {ok:false,reason:"safe_return_close_unavailable"}; }
}
export async function layoverSafeReturnProductState(db:SupabaseClient,userId:string,sessionId:string) {
  const context=await prepareLayoverSafeReturn(db,userId,sessionId);
  if (!context.ok) return {available:false,reason:context.reason,certifiedDeadline:null,session:null};
  const sync=await syncLayoverSafeReturnDeadline(db,sessionId,context.record);
  if (!sync.ok) return {available:false,reason:sync.reason,certifiedDeadline:null,session:null};
  const {data,error}=await db.from("layover_safe_return_links").select("safe_return_session_id,certified_deadline").eq("layover_session_id",sessionId).eq("user_id",userId).maybeSingle();
  if (error) { logger.warn({err:error,sessionId},"layover Safe Return link unreadable — product state unavailable"); return {available:false,reason:"layover_safe_return_unavailable",certifiedDeadline:null,session:null}; }
  if (!data) return {available:true,reason:null,certifiedDeadline:context.deadline,session:null};
  const linked=await readReturnProduct(db,data.safe_return_session_id,userId);
  if (!linked.ok || !linked.value) return {available:false,reason:"layover_safe_return_unavailable",certifiedDeadline:null,session:null};
  return {available:true,reason:null,certifiedDeadline:data.certified_deadline,session:publicReturnProduct(linked.value)};
}

import { tellBuddyOfAbortWithin, BUDDY_ABORT_NOTICE_OFF, type BuddyAbortNoticeRequest, type BuddyAbortNoticeReason } from '../layover/LayoverBuddyAbortNotice.js';
import { certifiedPlanningInstant } from '../layover/layoverCanonicalValidity.js';
import { resolveLayoverLiveConditions } from './layoverLiveSignals.js';
