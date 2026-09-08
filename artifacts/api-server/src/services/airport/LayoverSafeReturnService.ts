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
 * There is no routing provider on this tree, so "fastest certified route"
 * cannot be produced and `returnContract.route` is `null` with a named reason
 * rather than a plausible-looking line — spec §2.1, "missing live intelligence
 * degrades VISIBLY; never fabricate freshness." There is no crew storage
 * (census L28), so `crewNotified` is an empty list with a named reason, not a
 * silent success. There is no gate/terminal feed (census L80), so the pinned
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
  certifySessionFeasibility,
  certificationHeader,
  type FeasibilityAirport,
  type FeasibilitySession,
  type LayoverFeasibilityRecord,
} from "./LayoverFeasibility.js";

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
   * NULL on this tree, always. No routing provider exists, and a route is the
   * one thing on this response a traveller would follow with their feet.
   */
  route: null;
  routeUnavailableReason: "no_routing_provider";
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
      (record.deadline.hardReturnTime.getTime() - record.inputs.nowMs) / 60_000,
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
    routeUnavailableReason: "no_routing_provider",
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
  | "crew_notify_unavailable";

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
  /** Empty, with a reason: no crew storage exists on this tree. */
  crewNotified: string[];
  crewNotifyUnavailableReason: "no_crew_storage" | null;
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
): Promise<{ applied: boolean; failed: boolean }> {
  const { data, error } = await db
    .from("layover_sessions")
    .update({ status: "returning", updated_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("user_id", userId)
    .eq("status", "active")
    .select("id");
  if (error) {
    logger.error({ err: error, sessionId }, "abort: could not mark session returning");
    return { applied: false, failed: true };
  }
  // A write with `.select()` that matched nothing is not a failure — the
  // session may already have left `active` — but it is not an application
  // either, and saying so is the difference between the two.
  return { applied: ((data ?? []) as any[]).length > 0, failed: false };
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
    statusEnabled: boolean;
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
    statusApplied = marked.applied;
    statusFailed = marked.failed;
    if (marked.failed) effects.push("status_write_failed");
    else if (marked.applied) effects.push("status_marked_returning");
    // Flag ON and nothing matched means the session had already left `active`.
    // Reporting that as `status_unchanged_flag_off` would name the wrong cause.
    else effects.push("status_unchanged_no_active_row");
  } else {
    effects.push("status_unchanged_flag_off");
  }

  const contract = buildReturnContract(airport, record);
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

  effects.push("crew_notify_unavailable");

  return {
    ok: cancelled.ok && !statusFailed && !ledgerError,
    safeReturnVersion: LAYOVER_SAFE_RETURN_VERSION,
    abortedAt: new Date(nowMs).toISOString(),
    returnContract: contract,
    posture,
    cancelledStopIds: cancelled.ids,
    effects,
    crewNotified: [],
    crewNotifyUnavailableReason: "no_crew_storage",
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
    nowMs: number;
  },
): DisruptionRecompute {
  const before = certifySessionFeasibility(airport, session, { nowMs: input.nowMs });
  const newSession: FeasibilitySession = {
    ...session,
    departureTime: input.newDepartureTime,
    boardingTime: input.newBoardingTime === undefined ? session.boardingTime : input.newBoardingTime,
  };
  const after = certifySessionFeasibility(airport, newSession, { nowMs: input.nowMs });

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
