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
 *   - §11.1 step 4: no snapshot is persisted WHILE `layover_decision_persistence_enabled`
 *     is off — production today (2700/2992/3792 unapplied), where `snapshotId` below is
 *     `null` with a named reason. ON, `recordReplanDecision` stores it and cites it (foot).
 *   - Step 6 DECIDES, and is applied server-side only WHILE `layover_recommendation_
 *     snapshot_enabled` is on (3623, unapplied): the stale and no-longer-feasible cards
 *     lose their snapshot citation (foot). `staleCertification` stays empty on every
 *     real call — the route holds no cards — and only `noLongerFeasible` can fire.
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
import type { LayoverReasonCode } from "./LayoverSafetyEngine.js"; import type { EntryEligibility } from "./layoverEntryGate.js";
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
import { logger } from "../../lib/logger.js"; import { readFlagState, isMissingSchemaError } from "../../lib/capability/schemaCapability.js"; import { persistDecision, type PersistRefusal } from "../layover/LayoverDecisionStore.js"; import { snapshotIdFor } from "./layoverLedger.js"; import type { LayoverFeasibilityRecord } from "./LayoverFeasibility.js"; // census L207/L44 (lane 5): the foot of this file

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
 * NINE of the spec's ten members carry a real value until the snapshot is STORED:
 * `snapshotId` is `null` with `snapshotUnavailableReason` while persistence is off
 * (2700/2992 unapplied in production) — a content hash renamed `snapshotId` would be a
 * substitution. Once stored, it cites the ledger row and the reason is absent (foot).
 */
export interface LayoverDecisionRecord {
  sessionId: string;
  snapshotId: string | null;
  snapshotUnavailableReason?: ReplanSnapshotUnavailableReason;
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
  snapshotPersisted: boolean; /** The stored snapshot, present exactly when `snapshotPersisted` (census L207). */ snapshotId?: string;
  snapshotUnavailableReason?: ReplanSnapshotUnavailableReason; /** census L44: step 6 as applied; absent while 3623's flag is off or absent. */ invalidationApplied?: ReplanInvalidationApplied;
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
  nowMs: number; /** The session owner's corridor, resolved by the route (census-discovery §65). Omitted = unresolved. */ entry?: EntryEligibility | null;
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
    heldRecommendations: { [args.before.id]: args.heldRecommendations ?? [] }, entries: { [args.before.id]: args.entry ?? null },
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

  REPLAN_CERTIFIED_RECORDS.set(decision, outcome.after); return { ran: true, publication, decision, raw };
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
    await settleReplanSnapshot(db, userId, publication, decision); await emitLayoverEvent(db, decision.sessionId, userId, "session_updated", {
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

// ── census L207 / L44 — the replan's snapshot stored and cited; step 6 applied ─
//
// Appended at the foot so no line above moves (this file is cited by line).
// Reached from `recordReplanDecision`, which `PATCH /api/airport/sessions/:id`
// already calls (routes/airport.ts `replanAfterSessionEdit`), so nothing in the
// route changed and the press alone switches both halves on.
//
// PRODUCTION TODAY — both flags absent, 2700/2992/3623/3792 unapplied — this
// reads two `feature_flags` rows and nothing else: no ledger read, no write, and
// the decision and publication are byte-identical to what they were.

/**
 * The certified record each published decision was computed from, held BESIDE
 * the decision rather than inside it: the decision is serialised into
 * `layover_events.metadata`, and a 40-field record riding along would change the
 * ledger row on every replan. Weak, so a decision nobody records is collected.
 */
const REPLAN_CERTIFIED_RECORDS = new WeakMap<LayoverDecisionRecord, LayoverFeasibilityRecord>();

/** Why the replan's record cites no snapshot. Exactly one, and it is published. */
export type ReplanSnapshotUnavailableReason =
  /** `layover_decision_persistence_enabled` is off or absent — production today. */
  | "no_snapshot_storage"
  /** The flag row could not be read. Not "off": nothing was stored because nothing could be established. */
  | "persistence_flag_unreadable"
  /** A decision this module did not produce — there is no certified record to store. */
  | "no_certified_record"
  /** `persistDecision`'s own refusal, verbatim. */
  | PersistRefusal;

export type ReplanInvalidationApplied =
  | {
      applied: true;
      /**
       * The identity of the computation this replan certified; every card citing
       * another one is stale. It names a STORED row only when the publication's
       * `snapshotPersisted` is true — nothing here writes it anywhere.
       */
      currentSnapshotId: string;
      /** The cards whose citation was cleared, and the snapshot each had cited. */
      uncited: Array<{ recommendationId: string; citedSnapshotId: string; why: Array<"stale_certification" | "no_longer_feasible"> }>;
    }
  | {
      applied: false;
      reason: "flag_unreadable" | "storage_unavailable" | "read_failed" | "write_failed";
      /** On `write_failed` only: the cards whose citation WAS cleared before the refusal. Never hidden. */
      uncitedBeforeFailure?: string[];
    };

/**
 * Runs inside `recordReplanDecision`, BEFORE the ledger row is written, so the
 * row records what was stored and what was applied. Never throws: a replan's
 * bookkeeping must not fail the edit the traveller already committed.
 */
async function settleReplanSnapshot(
  db: SupabaseClient,
  userId: string,
  publication: ReplanPublication,
  decision: LayoverDecisionRecord,
): Promise<void> {
  try {
    await storeReplanSnapshot(db, userId, publication, decision);
    await applyReplanInvalidation(db, publication, decision);
  } catch (err) {
    logger.warn({ err, sessionId: decision.sessionId }, "layover replan snapshot/invalidation bookkeeping threw (non-fatal)");
  }
}

function snapshotUnavailable(publication: ReplanPublication, decision: LayoverDecisionRecord, reason: ReplanSnapshotUnavailableReason): void {
  decision.snapshotId = null;
  decision.snapshotUnavailableReason = reason;
  publication.snapshotPersisted = false;
  publication.snapshotUnavailableReason = reason;
}

/**
 * census L207 — §11.1 step 4 and §20's tenth member. With
 * `layover_decision_persistence_enabled` ON the replan's certified record is
 * stored through `persistDecision` — the one §20 writer, the same row `/safety`
 * and `/overview` write — and the decision cites the snapshot that row holds.
 * The id is cited only when `persistDecision` confirmed the parent row exists
 * (`recorded`, `already_recorded`, `write_unconfirmed`), never on a refusal.
 */
async function storeReplanSnapshot(
  db: SupabaseClient,
  userId: string,
  publication: ReplanPublication,
  decision: LayoverDecisionRecord,
): Promise<void> {
  const flag = await readFlagState(db, "layover_decision_persistence_enabled");
  if (flag === "off" || flag === "absent") return;
  if (flag === "unreadable") return snapshotUnavailable(publication, decision, "persistence_flag_unreadable");

  const record = REPLAN_CERTIFIED_RECORDS.get(decision);
  if (!record) return snapshotUnavailable(publication, decision, "no_certified_record");

  const persisted = await persistDecision(db, userId, decision.sessionId, record);
  if (!persisted.ok) return snapshotUnavailable(publication, decision, persisted.reason);

  decision.snapshotId = persisted.snapshotId;
  delete decision.snapshotUnavailableReason;
  publication.snapshotPersisted = true;
  publication.snapshotId = persisted.snapshotId;
  delete publication.snapshotUnavailableReason;
}

/**
 * census L44 / L97 — §11.1 step 6 APPLIED, not only decided.
 *
 * The only invalidation marker this schema has is 3623's citation,
 * `layover_recommendations.snapshot_id`: a card that cites a snapshot claims it
 * was certified under that snapshot. A card is invalidated by CLEARING that
 * claim. Not deleted — L97 records that destroying a card loses its id for every
 * client holding it — and not `status = 'hidden'`, which is the admin
 * moderation state (`USER_HIDDEN_RECOMMENDATION_STATUS`) and survives
 * regeneration by design. The next certification re-stamps the card it still
 * stands behind.
 *
 * Which cards: every card of the session that cites a snapshot OTHER than the
 * one this replan certified (stale — App C5), and every cited card a plan stop
 * that no longer fits came from (`noLongerFeasible`, through the stop's
 * `recommendation_id`). Each clear is a compare-and-set on the citation it read,
 * so a card re-certified between the read and the write is left alone.
 *
 * OFF or absent (production today): nothing is read, nothing written, nothing
 * published. Unreadable: nothing written, and the publication says why.
 */
async function applyReplanInvalidation(
  db: SupabaseClient,
  publication: ReplanPublication,
  decision: LayoverDecisionRecord,
): Promise<void> {
  const flag = await readFlagState(db, "layover_recommendation_snapshot_enabled");
  if (flag === "off" || flag === "absent") return;
  if (flag === "unreadable") {
    publication.invalidationApplied = { applied: false, reason: "flag_unreadable" };
    return;
  }

  const sessionId = decision.sessionId;
  const currentSnapshotId = snapshotIdFor(sessionId, decision.inputHash);

  const held = await db.from("layover_recommendations").select("id,snapshot_id").eq("session_id", sessionId);
  if (held.error) {
    logger.warn({ err: held.error.message, sessionId }, "replan invalidation: held cards unreadable — nothing invalidated");
    publication.invalidationApplied = { applied: false, reason: isMissingSchemaError(held.error) ? "storage_unavailable" : "read_failed" };
    return;
  }

  const infeasibleCards = new Set<string>();
  const lostStops = publication.invalidation.noLongerFeasible;
  if (lostStops.length > 0) {
    const stops = await db.from("layover_plan_stops").select("id,recommendation_id").eq("session_id", sessionId).in("id", lostStops);
    if (stops.error) {
      logger.warn({ err: stops.error.message, sessionId }, "replan invalidation: plan stops unreadable — nothing invalidated");
      publication.invalidationApplied = { applied: false, reason: "read_failed" };
      return;
    }
    for (const s of (stops.data ?? []) as Array<{ recommendation_id: unknown }>) {
      if (typeof s.recommendation_id === "string" && s.recommendation_id.length > 0) infeasibleCards.add(s.recommendation_id);
    }
  }

  const uncited: Extract<ReplanInvalidationApplied, { applied: true }>["uncited"] = [];
  for (const r of (held.data ?? []) as Array<{ id: unknown; snapshot_id: unknown }>) {
    if (typeof r.id !== "string" || typeof r.snapshot_id !== "string" || r.snapshot_id.length === 0) continue;
    const why: Array<"stale_certification" | "no_longer_feasible"> = [];
    if (r.snapshot_id !== currentSnapshotId) why.push("stale_certification");
    if (infeasibleCards.has(r.id)) why.push("no_longer_feasible");
    if (why.length > 0) uncited.push({ recommendationId: r.id, citedSnapshotId: r.snapshot_id, why });
  }

  const byCitation = new Map<string, string[]>();
  for (const u of uncited) byCitation.set(u.citedSnapshotId, [...(byCitation.get(u.citedSnapshotId) ?? []), u.recommendationId]);
  const cleared: string[] = [];
  for (const [cited, ids] of byCitation) {
    const { error } = await db
      .from("layover_recommendations")
      .update({ snapshot_id: null })
      .eq("session_id", sessionId)
      .eq("snapshot_id", cited)
      .in("id", ids);
    if (error) {
      logger.warn({ err: error.message, sessionId }, "replan invalidation: citation clear refused — stale cards keep their citation");
      publication.invalidationApplied = { applied: false, reason: "write_failed", uncitedBeforeFailure: cleared };
      return;
    }
    cleared.push(...ids);
  }
  publication.invalidationApplied = { applied: true, currentSnapshotId, uncited };
}

// ── census L207, layover round 2 lane B — the EXTERNAL-event replan cites its snapshot too ─
//
// Appended at the foot so no line above moves (this file is cited by line).
// The traveller's PATCH replan (above) builds a §20 DecisionRecord and
// `recordReplanDecision` stores its certified record through `persistDecision`
// and cites the stored snapshot. The external-event replan
// (`LayoverExternalReplanPort.replanExternalEvent`, once per airport group,
// after `handleEvent`) built NO record and cited nothing — pass 10's C10. It
// now goes through the SAME `recordReplanDecision`: the same ten members, the
// same WeakMap hand-off to `storeReplanSnapshot`, the same `persistDecision`,
// the same step-6 application (`applyReplanInvalidation`, behind 3623's flag)
// and the same ledger row.
//
// INERT UNTIL THE PRESS, and inert in a stronger sense than the PATCH path:
// that path already wrote its ledger row before lane 5, so "inert" there meant
// "byte-identical". This path wrote nothing, so while
// `layover_decision_persistence_enabled` is off or absent (production today,
// 2700/2992/3792 unapplied) it reads that ONE flag row and returns — no record
// built, nothing written, and the port's report carries no new key. Unreadable
// is not off: nothing is written either, and the reason is NAMED. And the whole
// path is closed before it reaches here: the drain reads
// `layover_event_ingest_enabled` (2981 unapplied) first.

/** Version of THIS wiring's decisions: which external outcome becomes which record. */
export const LAYOVER_EXTERNAL_REPLAN_WIRING_VERSION = "2026.10.18-1";

/** One replanned session's citation, as the external path settled it. */
export interface ExternalReplanCitation {
  sessionId: string;
  snapshotPersisted: boolean;
  /** The stored snapshot the session's record cites; null with a named reason otherwise. */
  snapshotId: string | null;
  snapshotUnavailableReason?: ReplanSnapshotUnavailableReason | "owner_unknown";
}

export type ExternalReplanSettlement =
  /** Persistence is not ON: no record was built and nothing written. `sessions` names who went uncited. */
  | { recorded: false; reason: "no_snapshot_storage" | "persistence_flag_unreadable"; sessions: string[] }
  /** Persistence ON: one §20 record per replanned session, through `recordReplanDecision`. */
  | { recorded: true; citations: ExternalReplanCitation[] };

/**
 * Settle every replanned session of ONE `handleEvent` result: build its §20
 * record and record it — store the snapshot, cite it, apply step 6, write the
 * ledger row — exactly as the PATCH path does. Null when nothing was replanned
 * (no flag is read for a result that has nothing to cite).
 *
 * `owners` is the session → `user_id` map the port read with the sessions; a
 * session with no owner cannot be written to anybody's ledger and is NAMED
 * (`owner_unknown`), never attributed to someone else.
 *
 * Never throws: `recordReplanDecision` is non-fatal by contract, and the
 * consumer has already stamped the event processed.
 */
export async function recordExternalReplanDecisions(
  db: SupabaseClient,
  result: HandleEventResult,
  owners: Record<string, string>,
  nowMs: number,
): Promise<ExternalReplanSettlement | null> {
  if (result.replanned.length === 0) return null;
  const sessions = result.replanned.map((o) => o.sessionId);
  const flag = await readFlagState(db, "layover_decision_persistence_enabled");
  if (flag === "off" || flag === "absent") return { recorded: false, reason: "no_snapshot_storage", sessions };
  if (flag === "unreadable") {
    logger.warn({ eventId: result.event.eventId, sessions }, "external replan: persistence flag unreadable — no decision recorded, no snapshot cited");
    return { recorded: false, reason: "persistence_flag_unreadable", sessions };
  }

  const citations: ExternalReplanCitation[] = [];
  for (const outcome of result.replanned) {
    const owner = owners[outcome.sessionId];
    if (typeof owner !== "string" || owner.length === 0) {
      citations.push({ sessionId: outcome.sessionId, snapshotPersisted: false, snapshotId: null, snapshotUnavailableReason: "owner_unknown" });
      continue;
    }
    const { publication, decision } = externalReplanRecord(result, outcome, nowMs);
    await recordReplanDecision(db, owner, publication, decision);
    citations.push({
      sessionId: decision.sessionId,
      snapshotPersisted: publication.snapshotPersisted,
      snapshotId: decision.snapshotId,
      ...(decision.snapshotUnavailableReason ? { snapshotUnavailableReason: decision.snapshotUnavailableReason } : {}),
    });
  }
  return { recorded: true, citations };
}

/**
 * The §20 record and the publication for one EXTERNAL outcome — the same two
 * shapes `replanForWindowChange` builds for a traveller's edit (a test pins the
 * key sets equal), with three differences that are facts about the producer:
 *   - `wiringVersion` is this path's own;
 *   - `inputFacts` are the event's affected constraint nodes, read off the two
 *     certified records' own `inputs` — an external event can move a live term,
 *     which a window edit never does, so the PATCH helper's three window fields
 *     would drop exactly the fact the decision was made on;
 *   - `sourceRefs` name the producer's `source:eventId` and the stable key.
 * The certified record is registered for `storeReplanSnapshot` exactly as above.
 */
function externalReplanRecord(
  result: HandleEventResult,
  outcome: ReplanOutcome,
  nowMs: number,
): { publication: ReplanPublication; decision: LayoverDecisionRecord } {
  const event = result.event;
  const reasonCodes = [...new Set<LayoverReasonCode>([...(outcome.opportunity?.reasonCodes ?? []), ...invalidationReasonCodes(outcome.invalidation)])];
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
    wiringVersion: LAYOVER_EXTERNAL_REPLAN_WIRING_VERSION,
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
    opportunity: outcome.opportunity ? { why: outcome.opportunity.why, reasonCodes: outcome.opportunity.reasonCodes } : null,
    notify: outcome.notify,
    disruptionState: outcome.disruptionState,
    certification: certificationHeader(outcome.after),
    reasonCodes,
    snapshotPersisted: false,
    snapshotUnavailableReason: "no_snapshot_storage",
    counts: { impacted: result.impacted, replanned: result.replanned.length, skipped: result.skipped.length, notifications: result.notifications },
  };
  const decision: LayoverDecisionRecord = {
    sessionId: outcome.sessionId,
    snapshotId: null,
    snapshotUnavailableReason: "no_snapshot_storage",
    engineVersion: outcome.after.engineVersion,
    inputHash: outcome.after.inputHash,
    inputFacts: externalInputFacts(outcome),
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
    computedAt: new Date(nowMs).toISOString(),
  };
  REPLAN_CERTIFIED_RECORDS.set(decision, outcome.after);
  return { publication, decision };
}

/** Each affected node whose value moved, before → after, read off the certified inputs themselves. */
function externalInputFacts(outcome: ReplanOutcome): LayoverDecisionRecord["inputFacts"] {
  const read = (record: LayoverFeasibilityRecord, node: string): string | number | null => {
    const [root, leaf] = node.split(".") as [string, string];
    const holder = root === "session" ? record.inputs.session : root === "liveConditions" ? record.inputs.liveConditions : null;
    const v = holder ? (holder as unknown as Record<string, unknown>)[leaf] : null;
    return typeof v === "string" || typeof v === "number" ? v : null;
  };
  const facts: LayoverDecisionRecord["inputFacts"] = [];
  for (const node of outcome.affectedNodes) {
    const before = read(outcome.before, node);
    const after = read(outcome.after, node);
    if (before !== after) facts.push({ node, before, after });
  }
  return facts;
}
