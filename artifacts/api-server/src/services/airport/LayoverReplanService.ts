/**
 * LayoverReplanService — the wiring §11 did not have.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §11    the canonical event envelope
 *   §11.1  the eight-step replanner pipeline (this file drives steps 1-8)
 *   §18    `LayoverReplanner.handleEvent(event)` — the I/O half of it
 *   §20    the DecisionRecord, and `replan_rate`
 *   §21.1  arrival delay → freedom shrinks; departure delay → freedom may expand
 *   App A  RECOMMENDATION_EXPIRED
 *
 * ── WHAT THIS FILE IS FOR ────────────────────────────────────────────────────
 * `LayoverEventReplanner.ts` is a pure pipeline whose own header says nothing
 * produces a layover event. That was true. It is no longer the whole truth:
 * **a traveller editing their own flight window IS a producer**, it is a
 * producer that exists today, on an applied table, with no feed, no webhook and
 * no migration in the way. `PATCH /api/airport/sessions/:id` is the ingest.
 *
 * This module turns that edit into a §11 envelope, runs the pipeline over it,
 * and hands back both a decision the route can publish to the traveller and a
 * §20 DecisionRecord the route can write to `layover_events`. It is the only
 * thing between the pipeline and a real caller.
 *
 * ── WHAT IT DELIBERATELY REFUSES TO DO ───────────────────────────────────────
 * The §11 vocabulary is CLOSED (eleven types). A session edit that no member of
 * it describes is REFUSED with a named reason rather than squeezed into the
 * nearest-looking type:
 *
 *   - both ends of the window moved            → `both_ends_moved`
 *   - boarding moved on its own, or by a
 *     different amount than departure          → `boarding_moved_independently`
 *   - a non-window feasibility input changed
 *     (flight type, immigration, bags, intent) → `non_window_fields_changed`
 *
 * Each of those is a real edit the route still performs; what it does not do is
 * claim a replan it cannot honestly compute. `flight.departure_delayed` shifts
 * boarding by the same minutes as departure (`applyEventToInputs`), so an edit
 * that moves them apart is not that event — and reporting it as one would make
 * the published `before`/`after` differ from the row that was actually written.
 *
 * That is not argued, it is CHECKED: `replanForWindowChange` re-derives the
 * post-event session with the pipeline's own `applyEventToInputs` and compares
 * it field by field against the session the route is about to persist. A
 * mismatch refuses with `inputs_diverged` and publishes nothing.
 *
 * ── WHAT IS STILL NOT BUILT, SO NOBODY READS THIS AS FINISHED ────────────────
 *   - §11.1 step 4: no snapshot is persisted. `snapshotId` in the DecisionRecord
 *     below is `null` with a named reason; `layover_certified_computations`
 *     (2700) is written and unapplied.
 *   - Step 6 DECIDES and nothing applies the decision server-side:
 *     `layover_recommendations` has no snapshot column to invalidate against
 *     (census L64), so `staleCertification` is empty on every real call and only
 *     `noLongerFeasible` can fire.
 *   - Step 2 is handed ONE session — the edited one. There is no airport fanout
 *     because there is no airport-subject producer and no index for one.
 *   - The only event types reachable from here are the two flight ones. The
 *     other nine still have no producer.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  certificationHeader,
  type FeasibilityAirport,
  type FeasibilitySession,
} from "./LayoverFeasibility.js";
import type { LayoverReasonCode } from "./LayoverSafetyEngine.js";
import {
  applyEventToInputs,
  handleEvent,
  normalizeEvent,
  LAYOVER_REPLANNER_VERSION,
  type HandleEventResult,
  type LayoverEventEnvelope,
  type RawLayoverEvent,
  type ReplanCandidate,
  type ReplanOutcome,
} from "./LayoverEventReplanner.js";
// L47's classifier. One rule for "nobody stated this leg", not a fourth copy.
import { statedDurationMin, statedTravelMin } from "./LayoverPlanFit.js";
import { emitLayoverEvent } from "./LayoverSessionService.js";
import { logger } from "../../lib/logger.js";

/**
 * The `source` every envelope minted here carries. A traveller editing their
 * own itinerary is a first-party producer and is named as one: a later flight
 * feed must NOT reuse this string, because `dedupKey` is `source:sourceEventId`
 * and two producers sharing a source name would deduplicate each other.
 */
export const SESSION_EDIT_EVENT_SOURCE = "portava.layover.session_edit";

/**
 * Version of THIS wiring's decisions — which edits become which event, and
 * which refusals are named. Separate from `LAYOVER_REPLANNER_VERSION`, which
 * versions the pipeline's arithmetic: the two move for different reasons and a
 * shared constant would hide that.
 *
 * History:
 *   2026.09.13-1  first wiring: session-edit ingest, DecisionRecord, ledger.
 */
export const LAYOVER_REPLAN_WIRING_VERSION = "2026.09.13-1";

/** Why no replan ran. Every refusal is exactly one of these, and it is published. */
export type ReplanRefusal =
  | "window_unchanged"
  | "non_window_fields_changed"
  | "both_ends_moved"
  | "boarding_moved_independently"
  | "event_rejected"
  | "inputs_diverged"
  | "session_not_replannable"
  /** The airport profile could not be read, so there is nothing to certify against. */
  | "airport_unreadable"
  /**
   * The plan stops could not be read. REFUSED rather than replanned against an
   * empty candidate list: an unreadable plan would publish "0 options lost",
   * which is the same failure `stopsOr503` exists to stop on every other route.
   */
  | "plan_unreadable";

export type WindowChangeEvent =
  | { ok: true; raw: RawLayoverEvent }
  | { ok: false; reason: ReplanRefusal; detail: string };

function ms(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Turn a window edit into the §11 event that describes it, or refuse.
 *
 * PURE, and takes the two sessions rather than the patch on purpose: what
 * matters is whether the FEASIBILITY INPUTS moved, not which JSON keys the
 * client happened to send. A patch that sets `departureTime` to the value it
 * already had is `window_unchanged`, which is the correct answer and not one a
 * patch-shaped check would give.
 *
 * `occurredAt` is the edit instant, NOT the new flight time. Two edits made at
 * two instants are two events even when they describe the same transition, so
 * the content `dedupKey` never collapses a traveller's second, deliberate edit
 * into their first. A feed replaying one upstream event is the case dedup is
 * for; a person pressing a button twice on purpose is not.
 */
export function windowChangeEvent(
  before: FeasibilitySession,
  after: FeasibilitySession,
  opts: { nowMs: number; airportRef: string },
): WindowChangeEvent {
  if (
    before.flightType !== after.flightType ||
    before.immigrationRequired !== after.immigrationRequired ||
    before.checkedBags !== after.checkedBags ||
    before.wantsToLeave !== after.wantsToLeave
  ) {
    return {
      ok: false,
      reason: "non_window_fields_changed",
      detail: "the §11 vocabulary has no event for a constraint edit — only the window moves",
    };
  }

  const arrivalBefore = ms(before.arrivalTime);
  const arrivalAfter = ms(after.arrivalTime);
  const departureBefore = ms(before.departureTime);
  const departureAfter = ms(after.departureTime);
  if (arrivalBefore === null || arrivalAfter === null || departureBefore === null || departureAfter === null) {
    return { ok: false, reason: "event_rejected", detail: "the session window is not a pair of instants" };
  }
  const boardingBefore = ms(before.boardingTime);
  const boardingAfter = ms(after.boardingTime);
  const boardingPresenceChanged = (before.boardingTime === null) !== (after.boardingTime === null);

  const arrivalDelta = Math.round((arrivalAfter - arrivalBefore) / 60_000);
  const departureDelta = Math.round((departureAfter - departureBefore) / 60_000);
  const boardingDelta = boardingBefore !== null && boardingAfter !== null
    ? Math.round((boardingAfter - boardingBefore) / 60_000)
    : 0;

  if (arrivalDelta === 0 && departureDelta === 0 && boardingDelta === 0 && !boardingPresenceChanged) {
    return { ok: false, reason: "window_unchanged", detail: "no feasibility input moved" };
  }
  if (arrivalDelta !== 0 && departureDelta !== 0) {
    return {
      ok: false,
      reason: "both_ends_moved",
      detail: "one event cannot describe an arrival and a departure move; the edit still applied",
    };
  }

  const subjectRefs = [
    { kind: "session", ref: after.id },
    { kind: "airport", ref: opts.airportRef },
  ];
  const common = {
    eventId: randomUUID(),
    occurredAt: new Date(opts.nowMs).toISOString(),
    source: SESSION_EDIT_EVENT_SOURCE,
    subjectRefs,
    confidence: "HIGH" as const,
  };

  if (arrivalDelta !== 0) {
    // An arrival move must not silently drag boarding: `applyEventToInputs`
    // leaves boarding alone for this type, so an edit that moved both is not
    // this event.
    if (boardingDelta !== 0 || boardingPresenceChanged) {
      return {
        ok: false,
        reason: "boarding_moved_independently",
        detail: "an arrival move that also changes boarding is not flight.arrival_delayed",
      };
    }
    return {
      ok: true,
      raw: { ...common, eventType: "flight.arrival_delayed", payload: { delayMinutes: arrivalDelta } },
    };
  }

  // Departure moved. `applyEventToInputs` shifts boarding by the SAME minutes,
  // so anything else diverges from the row the route is about to write.
  if (boardingPresenceChanged || (boardingBefore !== null && boardingDelta !== departureDelta)) {
    return {
      ok: false,
      reason: "boarding_moved_independently",
      detail: "flight.departure_delayed moves boarding by the same minutes; this edit did not",
    };
  }
  return {
    ok: true,
    raw: {
      ...common,
      eventType: "flight.departure_delayed",
      payload: { delayMinutes: departureDelta, newDepartureTime: after.departureTime },
    },
  };
}

/**
 * §20 `DecisionRecord`, as far as this tree can honestly fill it in.
 *
 * NINE of the spec's ten members carry a real value. `snapshotId` is `null`
 * with `snapshotUnavailableReason`, because §11.1 step 4 is not built and
 * 2700 is unapplied — a content hash renamed `snapshotId` would be a
 * substitution, and the census scores this row on the missing member.
 */
export interface LayoverDecisionRecord {
  sessionId: string;
  snapshotId: null;
  snapshotUnavailableReason: "no_snapshot_storage";
  engineVersion: string;
  inputHash: string;
  inputFacts: Array<{ node: string; before: string | number | null; after: string | number | null }>;
  sourceRefs: string[];
  rulesApplied: string[];
  result: {
    verdict: string;
    tier: string;
    returnState: string;
    usableMinutes: number;
    hardReturnTime: string;
  };
  reasonCodes: LayoverReasonCode[];
  computedAt: string;
}

/** What the route publishes to the traveller, and what the ledger row holds. */
export interface ReplanPublication {
  wiringVersion: string;
  replannerVersion: string;
  event: {
    eventId: string;
    eventType: LayoverEventEnvelope["eventType"];
    occurredAt: string;
    receivedAt: string;
    source: string;
    dedupKey: string;
    confidence: string;
  };
  diff: ReplanOutcome["diff"];
  invalidation: ReplanOutcome["invalidation"];
  opportunity: { why: string[]; reasonCodes: LayoverReasonCode[] } | null;
  notify: ReplanOutcome["notify"];
  disruptionState: ReplanOutcome["disruptionState"];
  certification: ReturnType<typeof certificationHeader>;
  reasonCodes: LayoverReasonCode[];
  snapshotPersisted: false;
  snapshotUnavailableReason: "no_snapshot_storage";
  /** §20 `replan_rate` numerator/denominator for THIS call. */
  counts: { impacted: number; replanned: number; skipped: number; notifications: number };
}

export type ReplanResult =
  | { ran: true; publication: ReplanPublication; decision: LayoverDecisionRecord; raw: HandleEventResult }
  | { ran: false; reason: ReplanRefusal; detail: string };

/**
 * The name of every constraint node this pipeline can move, paired with the
 * value it held before and after. These are the `inputFacts[]` of §20's record
 * — the spec asks which facts a decision was made ON, and "the whole session"
 * is not an answer.
 */
function inputFactsFor(
  before: FeasibilitySession,
  after: FeasibilitySession,
): LayoverDecisionRecord["inputFacts"] {
  const facts: LayoverDecisionRecord["inputFacts"] = [];
  if (before.arrivalTime !== after.arrivalTime) {
    facts.push({ node: "session.arrivalTime", before: before.arrivalTime, after: after.arrivalTime });
  }
  if (before.departureTime !== after.departureTime) {
    facts.push({ node: "session.departureTime", before: before.departureTime, after: after.departureTime });
  }
  if (before.boardingTime !== after.boardingTime) {
    facts.push({ node: "session.boardingTime", before: before.boardingTime, after: after.boardingTime });
  }
  return facts;
}

/**
 * Appendix A `RECOMMENDATION_EXPIRED`, emitted for the first time on this tree.
 *
 * It is a statement about a CHANGE — "what you had planned no longer fits" —
 * so no single certified record can carry it and the safety engine never
 * could. Step 6's decision is the only place that knows it.
 *
 * Emitted for `noLongerFeasible` and for `staleCertification` alike; the second
 * is empty on every real call today because `layover_recommendations` has no
 * column holding the hash a card was certified under (census L64).
 */
function invalidationReasonCodes(invalidation: ReplanOutcome["invalidation"]): LayoverReasonCode[] {
  return invalidation.noLongerFeasible.length > 0 || invalidation.staleCertification.length > 0
    ? ["RECOMMENDATION_EXPIRED"]
    : [];
}

/**
 * §11.1 steps 1-8 over one real session edit.
 *
 * `after` is what the route is ABOUT TO WRITE, not what it has written: the
 * decision has to be computed from the same inputs the row will hold, and
 * computing it afterwards would make a second read of a row a second source of
 * truth. The route verifies the persisted row against `after` and drops the
 * publication if they differ.
 */
export function replanForWindowChange(args: {
  airport: FeasibilityAirport;
  airportRef: string;
  before: FeasibilitySession;
  after: FeasibilitySession;
  status: string;
  candidates: ReplanCandidate[];
  heldRecommendations?: Array<{ id: string; inputHash: string }>;
  nowMs: number;
}): ReplanResult {
  if (args.status !== "active") {
    return { ran: false, reason: "session_not_replannable", detail: `session status is ${args.status}` };
  }

  // Step 1a: which §11 event is this edit, if any.
  const proposed = windowChangeEvent(args.before, args.after, {
    nowMs: args.nowMs,
    airportRef: args.airportRef,
  });
  if (!proposed.ok) return { ran: false, reason: proposed.reason, detail: proposed.detail };

  // Step 1b: normalise through the pipeline's own door. Nothing here is
  // trusted just because this file built it — the payload validator, the
  // future-dating check and the dedup key all run.
  const normalized = normalizeEvent(proposed.raw, { receivedAtMs: args.nowMs });
  if (!normalized.ok) {
    return { ran: false, reason: "event_rejected", detail: `${normalized.reason}: ${normalized.detail}` };
  }
  const event = normalized.event;

  // The check that makes the whole thing safe: the event, applied to the
  // pre-edit session by the PIPELINE's own function, must reproduce the session
  // the route is about to persist. If it does not, the published before/after
  // would describe a session that never existed.
  const applied = applyEventToInputs(event, args.before, null);
  if (
    applied.session.arrivalTime !== args.after.arrivalTime ||
    applied.session.departureTime !== args.after.departureTime ||
    applied.session.boardingTime !== args.after.boardingTime
  ) {
    return {
      ran: false,
      reason: "inputs_diverged",
      detail: "the event does not reproduce the edited window; no replan was published",
    };
  }

  // Steps 2-8.
  const raw = handleEvent(event, {
    airport: args.airport,
    sessions: [{ session: args.before, airportRef: args.airportRef, status: args.status }],
    candidates: { [args.before.id]: args.candidates },
    heldRecommendations: { [args.before.id]: args.heldRecommendations ?? [] },
    nowMs: args.nowMs,
  });

  const outcome = raw.replanned[0];
  if (!outcome) {
    return {
      ran: false,
      reason: "session_not_replannable",
      detail: raw.skipped[0]?.reason ?? "the pipeline returned no outcome for this session",
    };
  }

  const reasonCodes = [
    ...new Set<LayoverReasonCode>([
      ...(outcome.opportunity?.reasonCodes ?? []),
      ...invalidationReasonCodes(outcome.invalidation),
    ]),
  ];

  const rulesApplied = [
    "11.1.1 normalize+dedupe",
    "11.1.2 impacted sessions",
    "11.1.3 affected constraint nodes",
    "11.1.5 diff action universe",
    "11.1.6 invalidate recommendations",
    outcome.opportunity ? "11.1.7 opportunity emitted" : "11.1.7 no material change",
    outcome.notify.notify ? "11.1.8 notify" : "11.1.8 no notification",
  ];

  const publication: ReplanPublication = {
    wiringVersion: LAYOVER_REPLAN_WIRING_VERSION,
    replannerVersion: LAYOVER_REPLANNER_VERSION,
    event: {
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
      source: event.source,
      dedupKey: event.dedupKey,
      confidence: event.confidence,
    },
    diff: outcome.diff,
    invalidation: outcome.invalidation,
    opportunity: outcome.opportunity
      ? { why: outcome.opportunity.why, reasonCodes: outcome.opportunity.reasonCodes }
      : null,
    notify: outcome.notify,
    disruptionState: outcome.disruptionState,
    certification: certificationHeader(outcome.after),
    reasonCodes,
    snapshotPersisted: false,
    snapshotUnavailableReason: "no_snapshot_storage",
    counts: {
      impacted: raw.impacted,
      replanned: raw.replanned.length,
      skipped: raw.skipped.length,
      notifications: raw.notifications,
    },
  };

  const decision: LayoverDecisionRecord = {
    sessionId: outcome.sessionId,
    snapshotId: null,
    snapshotUnavailableReason: "no_snapshot_storage",
    engineVersion: outcome.after.engineVersion,
    inputHash: outcome.after.inputHash,
    inputFacts: inputFactsFor(args.before, args.after),
    sourceRefs: [`${event.source}:${event.eventId}`, `dedupKey:${event.dedupKey}`],
    rulesApplied,
    result: {
      verdict: outcome.after.verdict,
      tier: outcome.after.envelope.tier,
      returnState: outcome.after.envelope.returnState,
      usableMinutes: outcome.after.envelope.usableMinutes,
      hardReturnTime: outcome.after.deadline.hardReturnTime.toISOString(),
    },
    reasonCodes: [...new Set<LayoverReasonCode>([...outcome.after.reasonCodes, ...reasonCodes])],
    computedAt: new Date(args.nowMs).toISOString(),
  };

  return { ran: true, publication, decision, raw };
}

/**
 * Write the §20 record to the decision ledger.
 *
 * TWO `session_updated` ROWS PER REPLANNED EDIT, and that is a stated cost
 * rather than an accident. `updateSession` emits its own bare `session_updated`
 * before this one, and the two cannot be merged today:
 * `layover_events.event_type` is a CLOSED CHECK constraint (`0127:197-208`,
 * widened once by 2741) with no value for a replan, and widening it needs an
 * applied migration. A query that wants edits counts `session_updated`; a query
 * that wants §20's `replan_rate` counts the ones whose `metadata.replan` is
 * present, and must not count both.
 *
 * Non-fatal by the same rule as every other ledger write in this surface: the
 * traveller's edit has already committed and a failed audit row must not
 * present as a failed edit. It is logged at WARN, not swallowed.
 */
export async function recordReplanDecision(
  db: SupabaseClient,
  userId: string,
  publication: ReplanPublication,
  decision: LayoverDecisionRecord,
): Promise<void> {
  try {
    await emitLayoverEvent(db, decision.sessionId, userId, "session_updated", {
      replan: publication,
      decision,
    });
  } catch (err) {
    logger.warn({ err, sessionId: decision.sessionId }, "layover replan decision ledger write failed (non-fatal)");
  }
}

/**
 * Plan stops as the replanner sees candidates.
 *
 * THE THIRD PLACE THE SAME UNKNOWN WAS LAUNDERED (census L47, §16.8 item 4).
 * This read `Number(s.travelMin ?? 0)` and `Number(s.durationMin ?? 0)`, which
 * turned `layover_plan_stops`' `NOT NULL DEFAULT 0` into a zero-minute journey
 * to a place outside the airport — charged twice, because `candidateFits`
 * doubles the outbound leg — and then reported the stop as fitting the
 * certified window. §16.8 recorded it as reachable only by rows written before
 * L47's write boundary landed; those rows exist, and "the table cannot contain
 * the value any more" is an argument about data, not about code.
 *
 * It now goes through `LayoverPlanFit`'s classifier — the same one the plan
 * routes, the Compass tool and the crew solver use — so there is ONE rule for
 * what an unstated leg is, not a fourth copy of it.
 */
export function candidatesFromStops(stops: Array<Record<string, unknown>>): ReplanCandidate[] {
  return stops.map((s) => {
    const shape = {
      travelMin: s.travelMin as number | null | undefined,
      durationMin: s.durationMin as number | null | undefined,
      insideAirport: Boolean(s.insideAirport),
    };
    return {
      id: String(s.id),
      travelTimeMin: statedTravelMin(shape),
      activityTimeMin: statedDurationMin(shape),
      insideAirport: shape.insideAirport,
    };
  });
}
