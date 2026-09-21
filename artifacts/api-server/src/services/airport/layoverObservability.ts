/**
 * layoverObservability — the ten §20 metrics, and an honest answer for the six
 * that cannot be computed on this tree.
 *
 * Spec §20 (observability and decision ledger) names ten measures. Census
 * L208–L217 scores one BUILT-BUT-WRONG and nine NOT-BUILT, each with a reason
 * of the form "there is no X to count".
 *
 * ── THE DESIGN RULE ──────────────────────────────────────────────────────────
 * A METRIC WHOSE INPUT DOES NOT EXIST REPORTS `null`, NEVER `0`.
 *
 * `replan_rate: 0` and "there is no replanner" are opposite claims that render
 * identically on a dashboard. Emitting the second as the first is the semantic
 * substitution Appendix C1 forbids, and observability is the worst place to do
 * it: a metric exists precisely so that nobody re-derives the number by hand,
 * so a wrong one is believed for longer than a wrong anything else. Every
 * unproducible metric therefore carries `blockedBy` naming the exact table,
 * column, enum literal or module that would have to exist.
 *
 * The distinction is not decoration. THREE OF THE SIX BLOCKED METRICS COULD
 * EACH BE FAKED CONVINCINGLY from something already in the schema, and each
 * would be wrong in the traveller's disfavour:
 *   - `safe_return_completion_rate` from `session_completed` — but a session
 *     that ended is not a return that completed; a traveller who missed the
 *     flight also ends the session.
 *   - `replan_rate` from `session_updated` — but a user editing their flight
 *     time is not the system replanning.
 *   - `recommendation_contract_violation` from a verdict/recommendation
 *     mismatch — but with no `snapshot_id` on the card there is no contract to
 *     violate, only two numbers that disagree for unknown reasons.
 *
 * ── AND A RATE WITH AN EMPTY DENOMINATOR IS ALSO UNPRODUCIBLE ────────────────
 * 0/0 is not 0. A rate computed over no decisions says nothing and must not
 * present as a healthy zero. Counters are different: "no sessions were
 * detected" is a fact about the window, and reports 0.
 *
 * NO PRODUCTION CALLER, and a second reason beyond the usual one: there is no
 * exporter in this repository to emit these to, and no `report*` script for
 * layover under `src/scripts/` (census L208 names that absence exactly). This
 * module computes; where the numbers go is a separate decision that needs a
 * destination.
 */
import type { LayoverReasonCode } from "./LayoverSafetyEngine.js";
import type { DecisionRecord } from "./layoverLedger.js";
import type { ReplaySummary } from "./layoverReplay.js";

/**
 * A `layover_events` row, projected onto the three fields a metric reads.
 * `eventType` is a bare string rather than a union because the CHECK
 * constraint on `layover_events.event_type` is the authority and this module
 * must be able to read a row written by a build that knows a literal this one
 * does not.
 */
export interface LayoverEventRow {
  sessionId: string;
  eventType: string;
  at: string;
}

export interface LayoverMetricInput {
  events: LayoverEventRow[];
  decisions: DecisionRecord[];
  /** The §21 replay pass over the ledger, when one was run. */
  replay: ReplaySummary | null;
}

export type MetricKind = "counter" | "rate";

export interface LayoverMetricDefinition {
  name: string;
  kind: MetricKind;
  /** The value the spec asks this metric to hold, when it names one. */
  target: number | null;
  what: string;
}

/**
 * Reason codes that mean a SAFETY-CRITICAL fact was unknown at decision time.
 *
 * Drawn from Appendix A and deliberately narrow: an unknown that does not bear
 * on whether leaving is safe is not a critical unknown, and folding those in
 * would push the rate to 1.0 for reasons nobody would act on. As it happens the
 * rate is 1.0 anyway — `ENTRY_NOT_CONFIRMED` is emitted for every session
 * because nothing on this tree reads entry permission (census L48) — and that
 * is reported rather than suppressed: it is the number that makes the gap
 * visible.
 */
export const CRITICAL_UNKNOWN_CODES: readonly LayoverReasonCode[] = [
  "ENTRY_NOT_CONFIRMED",
  "BAGGAGE_STATUS_CRITICAL_UNKNOWN",
  "AIRPORT_CHANGE_REQUIRED",
  "SELF_TRANSFER_FRICTION",
  "RETURN_ROUTE_UNRELIABLE",
];

/** Verdicts under which a traveller is told they may go landside. */
const LANDSIDE_VERDICTS = new Set(["yes", "tight"]);

/** Return states at or past the first warning rung (§15). */
const WARNING_STATES = new Set(["RETURN_SOON", "RETURN_NOW", "CONNECTION_AT_RISK"]);

export const LAYOVER_METRICS: readonly LayoverMetricDefinition[] = [
  {
    name: "layover_sessions_detected",
    kind: "counter",
    target: null,
    what: "distinct sessions with a `session_created` event in the window.",
  },
  {
    name: "layover_sessions_evaluated",
    kind: "counter",
    target: null,
    what: "distinct sessions that received a certified decision — the subset of detected that got an answer.",
  },
  {
    name: "critical_unknown_rate",
    kind: "rate",
    target: null,
    what: "decisions carrying at least one safety-critical unknown reason code.",
  },
  {
    name: "landside_eligible_rate",
    kind: "rate",
    target: null,
    what: "decisions whose verdict permits leaving the airport.",
  },
  {
    name: "replan_rate",
    kind: "rate",
    target: null,
    what: "sessions replanned in response to an event.",
  },
  {
    name: "return_warning_rate",
    kind: "rate",
    target: null,
    what: "decisions at or past RETURN_SOON on the §15 ladder.",
  },
  {
    name: "safe_return_completion_rate",
    kind: "rate",
    target: null,
    what: "safe returns that completed, of those started.",
  },
  {
    name: "stale_fallback_rate",
    kind: "rate",
    target: null,
    what: "decisions whose airport numbers came from no airport row, or from an expired observation.",
  },
  {
    name: "recommendation_contract_violation",
    kind: "counter",
    target: 0,
    what: "recommendations published against a snapshot other than the one returned with them.",
  },
  {
    name: "decision_replay_mismatch",
    kind: "rate",
    target: 0,
    what: "replayed decisions whose stored result does not follow from their stored inputs.",
  },
];

export const LAYOVER_METRIC_NAMES = LAYOVER_METRICS.map((m) => m.name);

export interface LayoverMetricValue {
  name: string;
  kind: MetricKind;
  target: number | null;
  status: "OK" | "UNPRODUCIBLE";
  value: number | null;
  /** The exact artifact whose absence blocks this metric. `null` when OK. */
  blockedBy: string | null;
  /** Denominator actually used, so a rate can be read with its sample size. */
  sampleSize: number;
}

function ok(def: LayoverMetricDefinition, value: number, sampleSize: number): LayoverMetricValue {
  return { name: def.name, kind: def.kind, target: def.target, status: "OK", value, blockedBy: null, sampleSize };
}

function blocked(def: LayoverMetricDefinition, blockedBy: string, sampleSize = 0): LayoverMetricValue {
  return { name: def.name, kind: def.kind, target: def.target, status: "UNPRODUCIBLE", value: null, blockedBy, sampleSize };
}

/**
 * A rate over a set, or UNPRODUCIBLE when the set is empty.
 *
 * 0/0 IS NOT 0. A rate with no denominator is the most dangerous number on a
 * dashboard: it is indistinguishable from a healthy one and it moves the moment
 * a single sample arrives.
 */
function rate(
  def: LayoverMetricDefinition,
  matching: number,
  total: number,
  emptyReason: string,
): LayoverMetricValue {
  if (total === 0) return blocked(def, emptyReason, 0);
  return ok(def, matching / total, total);
}

const byName = (name: string): LayoverMetricDefinition =>
  LAYOVER_METRICS.find((m) => m.name === name)!;

/**
 * Whether a decision's airport numbers came from a real airport row.
 *
 * Read off `inputFacts`, not off the record's inputs, because the ledger is
 * where provenance is decided once — asking the question a second way here is
 * how two answers to "was this airport curated" start disagreeing.
 */
function ranOnFallback(d: DecisionRecord): boolean {
  const f = d.inputFacts.find((x) => x.key === "airport.internationalBufferMin");
  return f ? f.source === "GENERIC" : false;
}

export function computeLayoverMetrics(input: LayoverMetricInput): LayoverMetricValue[] {
  const { events, decisions, replay } = input;

  const detected = new Set(
    events.filter((e) => e.eventType === "session_created").map((e) => e.sessionId),
  );
  const evaluated = new Set(decisions.map((d) => d.sessionId));
  const n = decisions.length;
  const noDecisions =
    "no certified decisions in the window — `layover_certified_computations` has no writer " +
    "(migration src/migrations/2700_layover_certified_feasibility.sql landed the table without one).";

  return [
    ok(byName("layover_sessions_detected"), detected.size, events.length),
    ok(byName("layover_sessions_evaluated"), evaluated.size, decisions.length),

    rate(
      byName("critical_unknown_rate"),
      decisions.filter((d) => d.reasonCodes.some((c) => CRITICAL_UNKNOWN_CODES.includes(c))).length,
      n,
      noDecisions,
    ),

    rate(
      byName("landside_eligible_rate"),
      decisions.filter((d) => LANDSIDE_VERDICTS.has(d.result.verdict)).length,
      n,
      noDecisions,
    ),

    blocked(
      byName("replan_rate"),
      "no replan event literal exists: `layover_events.event_type`'s CHECK constraint " +
        "(src/migrations/0127_layover_system.sql) has no `replan_*` member, and " +
        "`session_updated` is a USER edit, not a system replan — counting it would be a " +
        "semantic substitute (Appendix C1).",
    ),

    rate(
      byName("return_warning_rate"),
      decisions.filter((d) => WARNING_STATES.has(d.result.returnState)).length,
      n,
      noDecisions,
    ),

    blocked(
      byName("safe_return_completion_rate"),
      "no return completion is recorded anywhere: `layover_events.event_type` carries " +
        "`safe_return_suggested` but no `safe_return_completed`, and `session_completed` " +
        "is not a return — a traveller who missed the flight also ends the session.",
    ),

    rate(
      byName("stale_fallback_rate"),
      decisions.filter(ranOnFallback).length,
      n,
      noDecisions,
    ),

    blocked(
      byName("recommendation_contract_violation"),
      "there is no contract to violate: `layover_recommendations` has no snapshot_id column " +
        "citing the computation that certified the card (see LEDGER_MISSING_COLUMNS in " +
        "layoverLedger.ts), so a card and a decision can only be compared by re-deriving both.",
    ),

    replay === null || replay.replayed === 0
      ? blocked(
          byName("decision_replay_mismatch"),
          "nothing was replayable: no stored ledger rows exist to replay " +
            "(`layover_certified_computations` has no writer). A zero here would report a " +
            "clean replay pass that never ran.",
          replay?.read ?? 0,
        )
      : ok(byName("decision_replay_mismatch"), replay.mismatchRate, replay.replayed),
  ];
}
