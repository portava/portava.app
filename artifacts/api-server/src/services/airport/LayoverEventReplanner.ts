/**
 * LayoverEventReplanner — §11 event-driven replanning.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §11    the canonical event envelope, and the eleven-member vocabulary
 *   §11.1  the eight-step replanner pipeline, in order
 *   §15.2  disruption states, driven from a flight event instead of by hand
 *   §18    `LayoverReplanner.handleEvent(event)`
 *   §23    "Validate all external event payloads and deduplicate by stable
 *          source keys"
 *   §24    "Duplicate events — unique dedup key / source event id"
 *   App A  FLIGHT_MOVED_EARLIER, FLIGHT_DELAY_CREATED_OPPORTUNITY
 *
 * ── THE HONEST HEADER, CORRECTED 2026-09-22 ─────────────────────────────────
 * NO FEED PRODUCES A LAYOVER EVENT YET: no flight feed, no airport feed, no
 * webhook. What HAS changed is the two claims this header used to make. The
 * store `layover_external_events` (2860) IS APPLIED to production — it is in
 * production-applied-migrations.json and all twelve of its columns are in the
 * capture named by lib/capability/snapshots/current.ts — and an ingest route
 * exists (`routes/layoverEvents.ts`, behind a flag 2981 seeds FALSE) whose
 * consumer reaches `handleEvent` through a port. The census records both.
 *
 * That is also why the whole pipeline is PURE. `handleEvent` takes the sessions
 * and the airport it is to consider, returns a decision, and writes nothing:
 * the two things a real replanner would do next — persist the snapshot and send
 * the notification — are the two things this tree has no storage and no
 * transport for, and faking either inside a pure function would make the
 * pipeline untestable in exchange for looking finished.
 *
 * ── WHY THE STEP BOUNDARIES ARE THE SPEC'S, LITERALLY ────────────────────────
 * §11.1 numbers eight steps and the census counts them as eight requirements.
 * Each is a separately exported function with the step number in its doc
 * comment, so a reader can check the tree against the specification one line at
 * a time instead of taking a pipeline's word for it.
 */
import { createHash } from "node:crypto";
import type { EstimateConfidence } from "./LayoverFeasibility.js";
import {
  certifySessionFeasibility,
  type FeasibilityAirport,
  type FeasibilitySession,
  type LayoverFeasibilityRecord,
} from "./LayoverFeasibility.js";
import type { LayoverReasonCode, LiveConditions } from "./LayoverSafetyEngine.js";
import {
  nextDisruptionState,
  type DisruptionEvent,
  type DisruptionState,
} from "./LayoverSafeReturnService.js";

/**
 * Version of the PIPELINE's decisions — the materiality thresholds, the
 * node map and the notification rule below.
 *
 * History:
 *   2026.09.13-1  first replanner: envelope, vocabulary, dedup, impact,
 *                 affected nodes, action-universe diff, opportunity, notify.
 */
export const LAYOVER_REPLANNER_VERSION = "2026.09.13-1";

// ── §11 the vocabulary ───────────────────────────────────────────────────────

/**
 * §11's eleven event types, exactly as the specification spells them and in
 * the order it lists them.
 *
 * This is the whole vocabulary, closed. `normalizeEvent` refuses anything that
 * is not in it, so a producer cannot introduce a twelfth by writing one — which
 * is the difference between a vocabulary and a convention.
 */
export const LAYOVER_EVENT_TYPES = [
  "flight.arrival_delayed",
  "flight.departure_delayed",
  "flight.gate_changed",
  "flight.cancelled",
  "airport.security_wait_changed",
  "airport.immigration_wait_changed",
  "mobility.route_degraded",
  "weather.condition_changed",
  "layover.checkpoint_observed",
  "layover.return_started",
  "layover.airport_reentered",
] as const;
export type LayoverEventType = (typeof LAYOVER_EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(LAYOVER_EVENT_TYPES);

export function isLayoverEventType(v: unknown): v is LayoverEventType {
  return typeof v === "string" && EVENT_TYPE_SET.has(v);
}

/** What an event is ABOUT. `subjectRefs` is a list of these. */
export const EVENT_SUBJECT_KINDS = ["airport", "session", "flight", "route", "user"] as const;
export type EventSubjectKind = (typeof EVENT_SUBJECT_KINDS)[number];

export interface EventSubjectRef {
  kind: EventSubjectKind;
  ref: string;
}

/**
 * §11's canonical envelope. All ten members, and none of them optional: an
 * envelope missing `dedupKey` is not a slightly worse envelope, it is the one
 * shape §24's duplicate-event guarantee cannot be built on.
 */
export interface LayoverEventEnvelope {
  eventId: string;
  eventType: LayoverEventType;
  occurredAt: string;
  receivedAt: string;
  source: string;
  sourceEventId: string;
  subjectRefs: EventSubjectRef[];
  payload: Record<string, unknown>;
  dedupKey: string;
  confidence: EstimateConfidence;
}

// ── §11.1 step 1 — normalise and deduplicate ─────────────────────────────────

export type EventRejection =
  | "unknown_event_type"
  | "missing_event_id"
  | "missing_source"
  | "bad_occurred_at"
  | "occurred_in_future"
  | "no_subject"
  | "bad_payload"
  | "bad_confidence";

export type NormalizeResult =
  | { ok: true; event: LayoverEventEnvelope }
  | { ok: false; reason: EventRejection; detail: string };

/** The raw shape a producer would hand in: everything optional, nothing trusted. */
export interface RawLayoverEvent {
  eventId?: unknown;
  eventType?: unknown;
  occurredAt?: unknown;
  source?: unknown;
  sourceEventId?: unknown;
  subjectRefs?: unknown;
  payload?: unknown;
  confidence?: unknown;
}

/**
 * §23 "Validate all external event payloads". One validator per event type,
 * so a `flight.departure_delayed` carrying no minutes is rejected at the door
 * rather than defaulting to zero somewhere in the recompute.
 *
 * The validators return an error string or null. They check the fields the
 * pipeline actually READS and nothing else — a validator that insists on
 * fields nobody consumes rejects good events for no safety gain.
 */
const PAYLOAD_VALIDATORS: Record<LayoverEventType, (p: Record<string, unknown>) => string | null> = {
  "flight.arrival_delayed": (p) => finiteMinutes(p.delayMinutes, "delayMinutes"),
  "flight.departure_delayed": (p) => finiteMinutes(p.delayMinutes, "delayMinutes")
    ?? isoOrNull(p.newDepartureTime, "newDepartureTime"),
  "flight.gate_changed": (p) => (typeof p.gate === "string" && p.gate.length > 0 ? null : "gate must be a non-empty string"),
  "flight.cancelled": () => null,
  "airport.security_wait_changed": (p) => finiteMinutes(p.waitMinutes, "waitMinutes"),
  "airport.immigration_wait_changed": (p) => finiteMinutes(p.waitMinutes, "waitMinutes"),
  "mobility.route_degraded": (p) => finiteMinutes(p.extraMinutes, "extraMinutes"),
  "weather.condition_changed": (p) => (typeof p.condition === "string" && p.condition.length > 0 ? null : "condition must be a non-empty string"),
  "layover.checkpoint_observed": (p) => (typeof p.checkpoint === "string" && p.checkpoint.length > 0 ? null : "checkpoint must be a non-empty string"),
  "layover.return_started": () => null,
  "layover.airport_reentered": () => null,
};

function finiteMinutes(v: unknown, name: string): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return `${name} must be a finite number`;
  if (v < -24 * 60 || v > 72 * 60) return `${name} outside the plausible range`;
  return null;
}

function isoOrNull(v: unknown, name: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) return `${name} must be an ISO instant`;
  return null;
}

const CONFIDENCES: ReadonlySet<string> = new Set(["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"]);

/**
 * §11.1 step 1, first half: NORMALISE.
 *
 * Turns an untrusted producer payload into a canonical envelope or refuses it
 * with a named reason. The `dedupKey` is computed here and nowhere else:
 *
 *   - when the producer supplied a `sourceEventId`, the key is
 *     `source:sourceEventId` — the "stable source key" §23 asks for, so the
 *     same upstream event replayed through two transports collapses to one;
 *   - when it did not, the key is a sha256 over the CONTENT that decides what
 *     the event means (type, occurredAt, sorted subjectRefs, payload). Two
 *     producers describing the same fact the same way still collapse; two
 *     genuinely different facts do not.
 *
 * `eventId` is deliberately NOT part of the key. A producer that mints a fresh
 * uuid per delivery would otherwise defeat deduplication entirely, which is the
 * failure §24 names.
 */
export function normalizeEvent(
  raw: RawLayoverEvent,
  opts: { receivedAtMs: number },
): NormalizeResult {
  if (!isLayoverEventType(raw.eventType)) {
    return { ok: false, reason: "unknown_event_type", detail: String(raw.eventType) };
  }
  const eventType = raw.eventType;

  if (typeof raw.eventId !== "string" || raw.eventId.length === 0) {
    return { ok: false, reason: "missing_event_id", detail: "eventId must be a non-empty string" };
  }
  if (typeof raw.source !== "string" || raw.source.length === 0) {
    return { ok: false, reason: "missing_source", detail: "source must be a non-empty string" };
  }
  if (typeof raw.occurredAt !== "string" || !Number.isFinite(Date.parse(raw.occurredAt))) {
    return { ok: false, reason: "bad_occurred_at", detail: String(raw.occurredAt) };
  }
  const occurredMs = Date.parse(raw.occurredAt);
  // A future-dated event is not early news; it is a clock fault or a forgery,
  // and admitting it lets a producer pre-empt every later real event.
  if (occurredMs > opts.receivedAtMs) {
    return { ok: false, reason: "occurred_in_future", detail: raw.occurredAt };
  }

  const subjectRefs = normalizeSubjects(raw.subjectRefs);
  if (subjectRefs.length === 0) {
    return { ok: false, reason: "no_subject", detail: "at least one subjectRef is required" };
  }

  const payload: Record<string, unknown> =
    raw.payload !== null && typeof raw.payload === "object" && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : {};
  const payloadError = PAYLOAD_VALIDATORS[eventType](payload);
  if (payloadError !== null) {
    return { ok: false, reason: "bad_payload", detail: payloadError };
  }

  const confidence = raw.confidence === undefined ? "MEDIUM" : raw.confidence;
  if (typeof confidence !== "string" || !CONFIDENCES.has(confidence)) {
    return { ok: false, reason: "bad_confidence", detail: String(raw.confidence) };
  }

  const sourceEventId = typeof raw.sourceEventId === "string" && raw.sourceEventId.length > 0
    ? raw.sourceEventId
    : "";
  const dedupKey = sourceEventId
    ? `${raw.source}:${sourceEventId}`
    : "sha256:" + createHash("sha256")
        .update(JSON.stringify([
          eventType,
          raw.occurredAt,
          subjectRefs.map((s) => `${s.kind}:${s.ref}`),
          stableStringify(payload),
        ]))
        .digest("hex");

  return {
    ok: true,
    event: {
      eventId: raw.eventId,
      eventType,
      occurredAt: new Date(occurredMs).toISOString(),
      receivedAt: new Date(opts.receivedAtMs).toISOString(),
      source: raw.source,
      sourceEventId,
      subjectRefs,
      payload,
      dedupKey,
      confidence: confidence as EstimateConfidence,
    },
  };
}

function normalizeSubjects(v: unknown): EventSubjectRef[] {
  if (!Array.isArray(v)) return [];
  const kinds: ReadonlySet<string> = new Set<string>(EVENT_SUBJECT_KINDS);
  const out: EventSubjectRef[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const { kind, ref } = item as { kind?: unknown; ref?: unknown };
    if (typeof kind !== "string" || !kinds.has(kind)) continue;
    if (typeof ref !== "string" || ref.length === 0) continue;
    const key = `${kind}:${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: kind as EventSubjectKind, ref });
  }
  // Sorted so the content dedup key does not depend on the order a producer
  // happened to list the subjects in.
  return out.sort((a, b) => (a.kind + a.ref).localeCompare(b.kind + b.ref));
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

export interface DedupeResult {
  kept: LayoverEventEnvelope[];
  /** Dropped duplicates, each paired with the dedupKey it collided on. */
  dropped: Array<{ event: LayoverEventEnvelope; dedupKey: string }>;
}

/**
 * §11.1 step 1, second half: DEDUPLICATE.
 *
 * First occurrence wins. Not "the highest confidence one" and not "the latest
 * one": a replanner that re-decides which copy of an event is authoritative is
 * a replanner whose output depends on delivery order, and §24's requirement is
 * that a duplicate is a no-op, not a re-run.
 */
export function dedupeEvents(events: LayoverEventEnvelope[]): DedupeResult {
  const seen = new Set<string>();
  const kept: LayoverEventEnvelope[] = [];
  const dropped: DedupeResult["dropped"] = [];
  for (const e of events) {
    if (seen.has(e.dedupKey)) { dropped.push({ event: e, dedupKey: e.dedupKey }); continue; }
    seen.add(e.dedupKey);
    kept.push(e);
  }
  return { kept, dropped };
}

// ── §11.1 step 2 — identify impacted active sessions ─────────────────────────

/** The session facts the fanout needs, beside the feasibility input set. */
export interface ReplanSession {
  session: FeasibilitySession;
  /** IATA or profile ref, matched against an `airport` subjectRef. */
  airportRef: string;
  /** Only `active` sessions are impacted. A closed session is not replanned. */
  status: string;
}

export interface ImpactedSession {
  session: ReplanSession;
  /** Which rule matched: a direct subject reference, or the airport fanout. */
  via: "session_subject" | "airport_subject";
}

/**
 * §11.1 step 2: identify impacted ACTIVE sessions.
 *
 * Two ways to be impacted and no third:
 *   - the event names the session directly (`{kind:"session"}`), or
 *   - the event names the session's airport AND the event happened inside the
 *     session's own window.
 *
 * The window test is what keeps an airport-wide security-queue event from
 * fanning out to every session that airport has ever had. An event that
 * occurred after a session's flight has already left cannot change that
 * session's plan, and recomputing it would produce a "your deadline moved"
 * decision about a flight in the past.
 */
export function impactedSessions(
  event: LayoverEventEnvelope,
  sessions: ReplanSession[],
): ImpactedSession[] {
  const sessionRefs = new Set(event.subjectRefs.filter((s) => s.kind === "session").map((s) => s.ref));
  const airportRefs = new Set(event.subjectRefs.filter((s) => s.kind === "airport").map((s) => s.ref));
  const occurredMs = Date.parse(event.occurredAt);
  const out: ImpactedSession[] = [];

  for (const s of sessions) {
    if (s.status !== "active") continue;
    if (sessionRefs.has(s.session.id)) { out.push({ session: s, via: "session_subject" }); continue; }
    if (!airportRefs.has(s.airportRef)) continue;
    const arrivalMs = Date.parse(s.session.arrivalTime);
    const cutoffMs = Date.parse(s.session.boardingTime ?? s.session.departureTime);
    if (!Number.isFinite(arrivalMs) || !Number.isFinite(cutoffMs)) continue;
    if (occurredMs > cutoffMs) continue;
    out.push({ session: s, via: "airport_subject" });
  }
  return out;
}

// ── §11.1 step 3 — recompute only the affected constraint nodes ──────────────

/**
 * The named inputs of the certified computation, as the constraint nodes an
 * event can move. These are literal paths into `FeasibilityInputs`, so a node
 * that stops existing stops compiling in the test that walks them.
 */
export const CONSTRAINT_NODES = [
  "session.arrivalTime",
  "session.departureTime",
  "session.boardingTime",
  "liveConditions.securityWaitExtraMin",
  "liveConditions.immigrationWaitExtraMin",
  "liveConditions.groundTransportExtraMin",
] as const;
export type ConstraintNode = (typeof CONSTRAINT_NODES)[number];

/**
 * §11.1 step 3: which constraint nodes can THIS event type move.
 *
 * FIVE OF THE ELEVEN EVENT TYPES MOVE NOTHING, and that is a finding rather
 * than an omission: this tree's feasibility ladder has no gate term, no weather
 * term, no checkpoint term and no re-entry term (census L62, L79, L30), so a
 * `weather.condition_changed` cannot change any number in it. The pipeline
 * therefore SKIPS the recompute for those events instead of re-certifying an
 * identical record and calling it a replan — which is what "recompute only the
 * affected constraint nodes" reduces to on a model with one derivation.
 *
 * When a term for one of them is built, its entry here changes and the skip
 * stops applying. Until then, claiming those events replan anything would be
 * the substitution Appendix C1 forbids.
 */
export const EVENT_AFFECTS: Record<LayoverEventType, readonly ConstraintNode[]> = {
  "flight.arrival_delayed": ["session.arrivalTime"],
  "flight.departure_delayed": ["session.departureTime", "session.boardingTime"],
  "flight.gate_changed": [],
  "flight.cancelled": ["session.departureTime", "session.boardingTime"],
  "airport.security_wait_changed": ["liveConditions.securityWaitExtraMin"],
  "airport.immigration_wait_changed": ["liveConditions.immigrationWaitExtraMin"],
  "mobility.route_degraded": ["liveConditions.groundTransportExtraMin"],
  "weather.condition_changed": [],
  "layover.checkpoint_observed": [],
  "layover.return_started": [],
  "layover.airport_reentered": [],
};

export function affectedConstraintNodes(t: LayoverEventType): readonly ConstraintNode[] {
  return EVENT_AFFECTS[t];
}

/**
 * Apply an event to the named inputs, producing the session and live conditions
 * the recompute should run against.
 *
 * Every branch here is a NAMED NODE from `EVENT_AFFECTS`; there is no path by
 * which an event changes an input the map does not list, which is what makes
 * the map a contract rather than documentation.
 */
export function applyEventToInputs(
  event: LayoverEventEnvelope,
  session: FeasibilitySession,
  live: LiveConditions | null,
): { session: FeasibilitySession; live: LiveConditions | null } {
  const p = event.payload;
  const shiftIso = (iso: string | null, minutes: number): string | null =>
    iso === null ? null : new Date(Date.parse(iso) + minutes * 60_000).toISOString();

  switch (event.eventType) {
    case "flight.arrival_delayed": {
      const delay = Number(p.delayMinutes);
      return { session: { ...session, arrivalTime: shiftIso(session.arrivalTime, delay)! }, live };
    }
    case "flight.departure_delayed": {
      const delay = Number(p.delayMinutes);
      const newDeparture = typeof p.newDepartureTime === "string"
        ? p.newDepartureTime
        : shiftIso(session.departureTime, delay)!;
      return {
        session: {
          ...session,
          departureTime: newDeparture,
          boardingTime: shiftIso(session.boardingTime, delay),
        },
        live,
      };
    }
    case "flight.cancelled":
      // A cancelled flight has no cutoff to plan against. The schedule is left
      // exactly as it was and the DISRUPTION STATE carries the fact — inventing
      // a replacement departure time is precisely the fabrication C1 forbids,
      // and a rebooking is a fact only the airline has.
      return { session, live };
    case "airport.security_wait_changed":
      return { session, live: withLiveTerm(live, "securityWaitExtraMin", Number(p.waitMinutes), event) };
    case "airport.immigration_wait_changed":
      return { session, live: withLiveTerm(live, "immigrationWaitExtraMin", Number(p.waitMinutes), event) };
    case "mobility.route_degraded":
      return { session, live: withLiveTerm(live, "groundTransportExtraMin", Number(p.extraMinutes), event) };
    default:
      return { session, live };
  }
}

/**
 * Set one live term from an event.
 *
 * NOTE WHAT THIS DOES NOT DO: it does not reconcile. An event carrying a wait
 * is a single source, and `LayoverAirportTruth.reconcile` is where several of
 * them become a believed number. A caller with a corpus should reconcile first
 * and pass the result in as `live`; this path exists for the single-event case
 * and is deliberately conservative — the term only ever grows.
 */
function withLiveTerm(
  live: LiveConditions | null,
  term: "securityWaitExtraMin" | "immigrationWaitExtraMin" | "groundTransportExtraMin",
  observedMinutes: number,
  event: LayoverEventEnvelope,
): LiveConditions {
  const base: LiveConditions = live ?? {
    securityWaitExtraMin: 0,
    immigrationWaitExtraMin: 0,
    groundTransportExtraMin: 0,
    reasonCodes: [],
    observedAt: null,
    expiresAt: null,
  };
  const value = Number.isFinite(observedMinutes) ? Math.max(0, observedMinutes) : 0;
  return {
    ...base,
    [term]: Math.max(base[term], value),
    reasonCodes: [...base.reasonCodes],
    observedAt: base.observedAt ?? event.occurredAt,
  };
}

// ── §11.1 step 5 — the action universe, and its diff ─────────────────────────

/**
 * A candidate as the replanner needs to see it: an id and its time cost.
 *
 * THE TERMS ARE NULLABLE, AND THAT IS THE POINT (census L47, §16.8 item 4).
 * `layover_plan_stops.travel_min` is `INTEGER NOT NULL DEFAULT 0`, so a stop
 * whose journey nobody measured is STORED as the number zero. Reading that back
 * as a zero-minute journey charged a traveller nothing to get to a place
 * outside the airport and nothing to get back, and `candidateFits` then
 * certified the stop against the return deadline. `null` is the value the
 * column cannot hold and the arithmetic must have.
 *
 * Inside the terminal a 0 is a FACT — an airside stop has no landside leg by
 * construction — and it stays a number. `candidatesFromStops` draws the line.
 */
export interface ReplanCandidate {
  id: string;
  travelTimeMin: number | null;
  /**
   * The ride BACK, when somebody measured it separately. §12.1's ladder names
   * the return term *"(future conditions, not symmetric)"*, and a traveller
   * starts back an activity later than they set out — into a different hour of
   * a different day's traffic.
   *
   * OPTIONAL, AND ITS ABSENCE IS NOT AN ABSENT TERM. `undefined` / `null` means
   * nobody measured the return separately, and the charge falls back to the
   * outbound doubled — the number every caller on this tree got before this
   * field existed, and the only honest reading of the single self-reported
   * figure `layover_plan_stops.travel_min` can hold. Making it REQUIRED would
   * turn every candidate on the tree `UNMEASURED` overnight, which is the
   * fabricated-ABSENCE mirror of the fabricated-VALUE defect census L47 exists
   * for, so `candidateIsUnmeasured` deliberately does not consult it.
   */
  returnTravelTimeMin?: number | null;
  activityTimeMin: number | null;
  insideAirport: boolean;
}

/**
 * "The user's actionable options", reduced to the things a change of which
 * would change what the traveller can do. Deliberately NOT the whole record:
 * `computedAt` moves on every request and diffing it would make every
 * recomputation material.
 */
export interface ActionUniverse {
  verdict: LayoverFeasibilityRecord["verdict"];
  returnState: LayoverFeasibilityRecord["envelope"]["returnState"];
  tier: LayoverFeasibilityRecord["envelope"]["tier"];
  usableMinutes: number;
  hardReturnMs: number;
  reasonCodes: LayoverReasonCode[];
  /** Ids that still fit inside the certified window, sorted. */
  feasibleCandidateIds: string[];
  /**
   * Ids that are absent from `feasibleCandidateIds` because a term of theirs is
   * unstated, NOT because the arithmetic refused them — census L47's three
   * valued rule at candidate level. A plan nobody measured and a plan that
   * overflows are different answers, and folding them together is how "does not
   * fit" came to mean "we did not look".
   */
  unmeasuredCandidateIds: string[];
}

/**
 * Does a candidate still fit inside the certified usable window?
 *
 * FALSE FOR AN UNMEASURED CANDIDATE, and that is a refusal to certify rather
 * than a claim of infeasibility — `unmeasuredCandidateIds` above is what keeps
 * the two apart. An unstated term makes the cost a LOWER BOUND, and a lower
 * bound can refuse a plan but can never certify one (census L47).
 */
export function candidateFits(record: LayoverFeasibilityRecord, c: ReplanCandidate): boolean {
  if (candidateIsUnmeasured(c)) return false;
  const round = c.insideAirport ? 0 : c.travelTimeMin! + returnLegMin(c);
  return round + c.activityTimeMin! <= record.envelope.usableMinutes;
}

/**
 * What the ride BACK costs a landside candidate, in minutes.
 *
 * THE OUTBOUND IS THE FALLBACK, NOT THE RULE. A stated return leg is used as
 * stated — §12.1's *"return (future conditions, not symmetric)"* — and only
 * when nobody stated one does this charge the outbound again, which is what
 * every caller got before `returnTravelTimeMin` existed.
 *
 * A NEGATIVE OR NON-FINITE FIGURE IS NOT A STATEMENT. `Math.max(0, …)` would
 * silently read a bad return leg as a free ride home; a caller that hands over
 * `-30` has a bug, and charging the symmetric fallback for it keeps that bug
 * from BUYING the traveller thirty minutes they do not have. Only a finite,
 * non-negative figure supersedes the fallback.
 *
 * `travelTimeMin` is non-null at every call site: `candidateIsUnmeasured` has
 * already refused a landside candidate without one.
 */
function returnLegMin(c: ReplanCandidate): number {
  const back = c.returnTravelTimeMin;
  if (typeof back !== "number" || !Number.isFinite(back) || back < 0) return c.travelTimeMin!;
  return back;
}

/** A term nobody stated. Airside carries no landside leg, so only dwell can be absent. */
export function candidateIsUnmeasured(c: ReplanCandidate): boolean {
  if (c.activityTimeMin === null) return true;
  return !c.insideAirport && c.travelTimeMin === null;
}

export function actionUniverseOf(
  record: LayoverFeasibilityRecord,
  candidates: ReplanCandidate[],
): ActionUniverse {
  return {
    verdict: record.verdict,
    returnState: record.envelope.returnState,
    tier: record.envelope.tier,
    usableMinutes: record.envelope.usableMinutes,
    hardReturnMs: record.deadline.hardReturnTime.getTime(),
    reasonCodes: [...record.reasonCodes].sort(),
    feasibleCandidateIds: candidates.filter((c) => candidateFits(record, c)).map((c) => c.id).sort(),
    unmeasuredCandidateIds: candidates.filter(candidateIsUnmeasured).map((c) => c.id).sort(),
  };
}

export interface ActionUniverseDiff {
  verdictChanged: boolean;
  returnStateChanged: boolean;
  tierChanged: boolean;
  usableMinutesDelta: number;
  /** Positive = the deadline moved LATER (more freedom). */
  deadlineDeltaMinutes: number;
  candidatesGained: string[];
  candidatesLost: string[];
  /**
   * Ids the recomputation could not judge at all, after the event. Published so
   * that a candidate missing from `candidatesGained` is legibly "not measured"
   * rather than silently "does not fit" (census L47, §16.8 item 4).
   */
  candidatesUnmeasured: string[];
  reasonCodesAdded: LayoverReasonCode[];
  reasonCodesRemoved: LayoverReasonCode[];
}

/**
 * §11.1 step 5: diff the previous action universe against the new one.
 *
 * Every field is a difference a traveller could act on. `candidatesLost` is the
 * one that matters most and the one a naive diff omits: a plan that no longer
 * fits is the change worth telling someone about, and it can happen with the
 * verdict, the tier and the return state all unchanged.
 */
export function diffActionUniverse(before: ActionUniverse, after: ActionUniverse): ActionUniverseDiff {
  const beforeIds = new Set(before.feasibleCandidateIds);
  const afterIds = new Set(after.feasibleCandidateIds);
  const beforeCodes = new Set(before.reasonCodes);
  const afterCodes = new Set(after.reasonCodes);
  return {
    verdictChanged: before.verdict !== after.verdict,
    returnStateChanged: before.returnState !== after.returnState,
    tierChanged: before.tier !== after.tier,
    usableMinutesDelta: after.usableMinutes - before.usableMinutes,
    deadlineDeltaMinutes: Math.round((after.hardReturnMs - before.hardReturnMs) / 60_000),
    candidatesGained: after.feasibleCandidateIds.filter((id) => !beforeIds.has(id)),
    candidatesLost: before.feasibleCandidateIds.filter((id) => !afterIds.has(id)),
    candidatesUnmeasured: [...after.unmeasuredCandidateIds],
    reasonCodesAdded: after.reasonCodes.filter((c) => !beforeCodes.has(c)),
    reasonCodesRemoved: before.reasonCodes.filter((c) => !afterCodes.has(c)),
  };
}

// ── §11.1 step 6 — invalidate stale or infeasible recommendations ────────────

export interface InvalidationDecision {
  /** Candidate ids that were feasible and are not any more. */
  noLongerFeasible: string[];
  /**
   * Ids whose stored certification does not match the new one. Every id in
   * `heldUnderInputHash` that is not the new record's hash is stale by
   * definition — §21 App C5, "never certify a recommendation against a
   * snapshot other than the one returned with it".
   */
  staleCertification: string[];
  newInputHash: string;
}

/**
 * §11.1 step 6.
 *
 * DECIDES, DOES NOT DELETE. Nothing here writes: there is no snapshot column on
 * `layover_recommendations` to compare against in the first place (census L64),
 * so the caller supplies what it holds. Returning a decision rather than
 * performing one is also what lets the property be swept — a delete would need
 * a database to observe.
 */
export function invalidateRecommendations(
  after: LayoverFeasibilityRecord,
  candidates: ReplanCandidate[],
  heldUnderInputHash: Array<{ id: string; inputHash: string }>,
): InvalidationDecision {
  const newHash = after.inputHash;
  return {
    noLongerFeasible: candidates.filter((c) => !candidateFits(after, c)).map((c) => c.id).sort(),
    staleCertification: heldUnderInputHash
      .filter((r) => r.inputHash !== newHash)
      .map((r) => r.id)
      .sort(),
    newInputHash: newHash,
  };
}

// ── §11.1 step 7 — the OpportunityEvent ──────────────────────────────────────

/**
 * What counts as a MATERIAL change to the actionable options.
 *
 * The two minute thresholds exist so that clock drift and one-minute rounding
 * do not manufacture opportunities. They are the reason `handleEvent` can be
 * called on a stream of small delay corrections without emitting anything.
 */
export const MATERIALITY = {
  usableMinutes: 10,
  deadlineMinutes: 5,
} as const;

export interface OpportunityEvent {
  replannerVersion: string;
  sessionId: string;
  causedByEventId: string;
  causedByEventType: LayoverEventType;
  diff: ActionUniverseDiff;
  reasonCodes: LayoverReasonCode[];
  /** Human-readable, and derived from the diff rather than written per site. */
  why: string[];
}

/**
 * §11.1 step 7: emit an OpportunityEvent ONLY IF the user's actionable options
 * materially changed.
 *
 * Returns null otherwise, and null is the common case: most events move a
 * number by less than the thresholds above, and a replanner that emitted on
 * every recompute would be a notification storm with extra steps (§24).
 *
 * The two Appendix A flight codes are emitted here because here is the only
 * place that can know them — they are statements about a CHANGE, and no
 * single certified record can carry one.
 */
export function opportunityEventFor(
  sessionId: string,
  event: LayoverEventEnvelope,
  diff: ActionUniverseDiff,
): OpportunityEvent | null {
  const why: string[] = [];
  if (diff.verdictChanged) why.push("the landside verdict changed");
  if (diff.returnStateChanged) why.push("the return state changed");
  if (diff.tierChanged) why.push("the layover tier changed");
  if (diff.candidatesLost.length > 0) why.push(`${diff.candidatesLost.length} planned option(s) no longer fit`);
  if (diff.candidatesGained.length > 0) why.push(`${diff.candidatesGained.length} new option(s) fit`);
  if (Math.abs(diff.usableMinutesDelta) >= MATERIALITY.usableMinutes) {
    why.push(`usable time moved by ${diff.usableMinutesDelta} min`);
  }
  if (Math.abs(diff.deadlineDeltaMinutes) >= MATERIALITY.deadlineMinutes) {
    why.push(`the return deadline moved by ${diff.deadlineDeltaMinutes} min`);
  }
  if (diff.reasonCodesAdded.length > 0) why.push(`new reason code(s): ${diff.reasonCodesAdded.join(", ")}`);

  if (why.length === 0) return null;

  const reasonCodes: LayoverReasonCode[] = [...diff.reasonCodesAdded];
  // FLIGHT_MOVED_EARLIER: the deadline moved earlier because the flight did.
  // Only for flight events — a security queue can move the deadline earlier
  // too, and calling that "the flight moved" would be a lie with a code number.
  if (diff.deadlineDeltaMinutes < 0 && event.eventType.startsWith("flight.")) {
    reasonCodes.push("FLIGHT_MOVED_EARLIER");
  }
  // FLIGHT_DELAY_CREATED_OPPORTUNITY: a delay that actually widened the window
  // by a material amount. Not every delay does — a delay into the night
  // traffic band can widen the schedule and shrink the usable window.
  if (
    event.eventType === "flight.departure_delayed" &&
    diff.usableMinutesDelta >= MATERIALITY.usableMinutes
  ) {
    reasonCodes.push("FLIGHT_DELAY_CREATED_OPPORTUNITY");
  }

  return {
    replannerVersion: LAYOVER_REPLANNER_VERSION,
    sessionId,
    causedByEventId: event.eventId,
    causedByEventType: event.eventType,
    diff,
    reasonCodes: [...new Set(reasonCodes)],
    why,
  };
}

// ── §11.1 step 8 — notify only when user action should change ────────────────

export type NotifyDecision =
  | { notify: false; reason: string }
  | { notify: true; priority: "high" | "normal"; reason: string };

/**
 * §11.1 step 8.
 *
 * STRICTLY NARROWER THAN STEP 7, and that difference is the requirement. An
 * opportunity is "something changed that you could act on". A notification is
 * "you should now do something different from what you were going to do". Most
 * materially-changed universes do not clear that bar: a deadline that moved
 * eight minutes later while the advice, the state and the plan all held is a
 * fact, not an instruction.
 *
 * High priority is reserved for the two cases where NOT acting is unsafe: the
 * return state escalated, or something the traveller was going to do no longer
 * fits.
 */
export function shouldNotify(opportunity: OpportunityEvent | null): NotifyDecision {
  if (!opportunity) return { notify: false, reason: "no material change" };
  const d = opportunity.diff;

  if (d.candidatesLost.length > 0) {
    return { notify: true, priority: "high", reason: "a planned option no longer fits the window" };
  }
  if (d.returnStateChanged && d.deadlineDeltaMinutes <= 0) {
    return { notify: true, priority: "high", reason: "the return state escalated" };
  }
  if (d.verdictChanged) {
    return { notify: true, priority: "high", reason: "the landside verdict changed" };
  }
  if (opportunity.reasonCodes.includes("FLIGHT_DELAY_CREATED_OPPORTUNITY")) {
    return { notify: true, priority: "normal", reason: "a delay opened a materially larger window" };
  }
  return { notify: false, reason: "options moved, but nothing the traveller should do differently" };
}

// ── §18 LayoverReplanner.handleEvent ─────────────────────────────────────────

export interface ReplanSkip {
  sessionId: string;
  reason: "no_affected_constraint_node";
  affectedNodes: readonly ConstraintNode[];
}

export interface ReplanOutcome {
  sessionId: string;
  affectedNodes: readonly ConstraintNode[];
  before: LayoverFeasibilityRecord;
  after: LayoverFeasibilityRecord;
  diff: ActionUniverseDiff;
  invalidation: InvalidationDecision;
  opportunity: OpportunityEvent | null;
  notify: NotifyDecision;
  disruptionState: DisruptionState;
  /**
   * ALWAYS FALSE ON THIS TREE. §11.1 step 4 asks for a new immutable snapshot;
   * `after` IS an immutable certified record and there is nowhere to put it:
   * `layover_certified_computations` (2700) is written and unapplied. NOT
   * `layover_external_events` (2860), which this comment used to name and which
   * IS applied — but that table stores events, not snapshots. Reported, never assumed.
   */
  snapshotPersisted: false;
  snapshotUnavailableReason: "no_snapshot_storage";
}

export interface HandleEventResult {
  replannerVersion: string;
  event: LayoverEventEnvelope;
  impacted: number;
  replanned: ReplanOutcome[];
  skipped: ReplanSkip[];
  notifications: number;
}

/**
 * Spec §18 `LayoverReplanner.handleEvent(event)` — the eight steps, in order,
 * each delegating to the exported function that owns it.
 *
 * Step 1 (normalise/dedup) happens BEFORE this, in the caller, because a
 * duplicate must not reach a per-session pipeline at all; `handleEvent` takes
 * an envelope that already survived it. Step 4 (persist a snapshot) does not
 * happen: see `ReplanOutcome.snapshotPersisted`.
 */
export function handleEvent(
  event: LayoverEventEnvelope,
  ctx: {
    airport: FeasibilityAirport;
    sessions: ReplanSession[];
    candidates: Record<string, ReplanCandidate[]>;
    heldRecommendations?: Record<string, Array<{ id: string; inputHash: string }>>;
    liveConditions?: Record<string, LiveConditions | null>;
    disruptionStates?: Record<string, DisruptionState>;
    nowMs: number;
  },
): HandleEventResult {
  // Step 2.
  const impacted = impactedSessions(event, ctx.sessions);
  // Step 3.
  const nodes = affectedConstraintNodes(event.eventType);

  const replanned: ReplanOutcome[] = [];
  const skipped: ReplanSkip[] = [];

  for (const { session } of impacted) {
    const id = session.session.id;
    const priorLive = ctx.liveConditions?.[id] ?? null;
    const disruptionState = disruptionAfter(ctx.disruptionStates?.[id] ?? "CONNECTION", event);

    if (nodes.length === 0) {
      skipped.push({ sessionId: id, reason: "no_affected_constraint_node", affectedNodes: nodes });
      continue;
    }

    const before = certifySessionFeasibility(ctx.airport, session.session, {
      nowMs: ctx.nowMs,
      liveConditions: priorLive,
    });
    const applied = applyEventToInputs(event, session.session, priorLive);
    const after = certifySessionFeasibility(ctx.airport, applied.session, {
      nowMs: ctx.nowMs,
      liveConditions: applied.live,
    });

    const candidates = ctx.candidates[id] ?? [];
    // Step 5.
    const diff = diffActionUniverse(
      actionUniverseOf(before, candidates),
      actionUniverseOf(after, candidates),
    );
    // Step 6.
    const invalidation = invalidateRecommendations(after, candidates, ctx.heldRecommendations?.[id] ?? []);
    // Step 7.
    const opportunity = opportunityEventFor(id, event, diff);
    // Step 8.
    const notify = shouldNotify(opportunity);

    replanned.push({
      sessionId: id,
      affectedNodes: nodes,
      before,
      after,
      diff,
      invalidation,
      opportunity,
      notify,
      disruptionState,
      snapshotPersisted: false,
      snapshotUnavailableReason: "no_snapshot_storage",
    });
  }

  return {
    replannerVersion: LAYOVER_REPLANNER_VERSION,
    event,
    impacted: impacted.length,
    replanned,
    skipped,
    notifications: replanned.filter((r) => r.notify.notify).length,
  };
}

/**
 * §15.2 driven from §11: turn an event into the disruption transition it
 * implies, and walk the existing state machine.
 *
 * The mapping is deliberately narrow. Only the flight events say anything about
 * a disruption; a security queue is not a disruption, and treating one as a
 * DELAYED flight would put a session into a recovery chain no airline agrees
 * with. Everything else leaves the state exactly where it was.
 */
export function disruptionEventFor(event: LayoverEventEnvelope): DisruptionEvent | null {
  switch (event.eventType) {
    case "flight.cancelled":
      return { kind: "cancellation" };
    case "flight.departure_delayed": {
      const d = Number(event.payload.delayMinutes);
      if (!Number.isFinite(d)) return null;
      return { kind: "delay", delayMinutes: d };
    }
    default:
      return null;
  }
}

export function disruptionAfter(current: DisruptionState, event: LayoverEventEnvelope): DisruptionState {
  const de = disruptionEventFor(event);
  return de === null ? current : nextDisruptionState(current, de);
}
