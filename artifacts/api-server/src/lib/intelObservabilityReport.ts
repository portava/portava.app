/**
 * §24 / Table-32 OBSERVABILITY REPORT — the shaped read behind the four admin
 * dashboards (Truth health, Calibration, Decision, Economy).
 *
 * WHY THIS MODULE EXISTS
 * ======================
 * Table 32 names six dashboards and the metrics each owes. Four of them had no
 * rendered surface at all: the numbers existed only inside lib/intelFunnelReport
 * (a pure tally with two callers — a script and the daily calibration
 * scheduler, which LOGS its verdict and returns), inside intel_reward_ledger,
 * and inside the intel.* domain events on canonical_events. An operator could
 * not see any of it without reading server logs.
 *
 * This module turns those already-existing rows into the dashboard shape. It is
 * PURE — a deterministic map from fetched rows to sections — so the arithmetic
 * is testable against inputs whose right answer is known, exactly like
 * intelFunnelReport. routes/intelObservability.ts keeps only the I/O.
 *
 * THE ONE INVARIANT: A METRIC CARRIES ITS INSTRUMENTATION STATUS
 * =============================================================
 * Inherited from intelFunnelReport's DENSITY_INPUT_STATUS and from
 * discoveryServePointReport before it: *absence of evidence must never silently
 * become evidence of absence.* Table 32 asks for numbers this system does not
 * yet measure — expiry latency (there is no serve-time log), calibration
 * accuracy (the outcome payload carries a satisfaction judgment, not the crowd
 * after-proof value), reroute recovery (no reroute event is recorded), fraud and
 * API margin (no partner surface exists). Rendering any of those as `0` would
 * read as "measured, and it is zero" — the single most dangerous thing an
 * observability dashboard can do.
 *
 * So every metric is a {status, value} pair and the type system enforces the
 * rule that matters: an UNINSTRUMENTED metric has `value: null`, always. There
 * is no code path that can produce an UNINSTRUMENTED metric holding a number —
 * `uninstrumented()` is the only constructor for one, and it hard-codes null.
 * The renderer's contract is therefore trivial: status UNINSTRUMENTED ⇒ print
 * "not instrumented", never a figure.
 *
 * UPPER_BOUND is the third status, also inherited: a number that is real but
 * larger than the truth (distinct actors over-counts "reliable contributors",
 * because reliability is not modelled). It carries its value — hiding it would
 * be its own dishonesty — but a threshold it clears is not proven cleared.
 *
 * WHAT THIS MODULE MAY NOT DO
 * ===========================
 *   • It never writes. Nothing here feeds back into confidence, trust or
 *     ranking (§23: monetization/measurement consumes finalized intelligence and
 *     never changes factual confidence).
 *   • It emits no coordinate, no contributor id and no exact k-anonymity cohort
 *     size. Every figure below is a COUNT over rows or a distribution over a
 *     closed enum; per-subject and per-actor rows never enter the shape.
 *   • It never relabels a prediction as an observation (§37). The outcome-derived
 *     figures are named for what they are (reported satisfaction outcomes), and
 *     calibration ACCURACY stays UNINSTRUMENTED rather than being approximated
 *     from them.
 */
import {
  CLAIM_STATUSES,
  CONFIDENCE_BANDS,
  MODERATION_STATES,
  SOURCE_CLASSES,
  confidenceBand,
} from "./intelContracts.js";
import { INTEL_OUTCOMES } from "./intelOutcomes.js";
import {
  assessDensityGate,
  tallyIntelFunnel,
  type ClaimRow,
  type ConfirmationRow,
  type FunnelRows,
  type IntelFunnel,
  type ObservationRow,
  type OutcomeRow,
  type SnapshotRow,
} from "./intelFunnelReport.js";

// ── Status vocabulary (the same three intelFunnelReport already uses) ─────────

export type InstrumentationStatus = "MEASURED" | "UPPER_BOUND" | "UNINSTRUMENTED";

export interface ObservabilityMetric {
  key: string;
  label: string;
  status: InstrumentationStatus;
  /** ALWAYS null when status is UNINSTRUMENTED — see the header. */
  value: number | null;
  /**
   * The denominator when this metric is a share (e.g. "servable live snapshots
   * out of all snapshots"). Kept beside the numerator instead of pre-dividing so
   * a 0-of-0 renders honestly as "0 of 0" and never as a fabricated ratio.
   */
  denominator: number | null;
  /** 'count' | 'ratio' — a ratio's `value` is already 0..1 and has no denominator. */
  unit: "count" | "ratio";
  /** Why this metric reads the way it does. Always present on a non-MEASURED one. */
  note: string | null;
}

export interface ObservabilityDistribution {
  key: string;
  label: string;
  status: InstrumentationStatus;
  /** ALWAYS null when status is UNINSTRUMENTED. */
  buckets: { key: string; count: number }[] | null;
  /** Values the writer emitted that this build's enum does not contain (a reader defect). */
  unknownValues: string[];
  note: string | null;
}

export interface ObservabilitySection {
  key: "truth_health" | "calibration" | "decision" | "economy";
  title: string;
  /** The Table-32 line this section implements, verbatim. */
  requiredMetrics: string;
  metrics: ObservabilityMetric[];
  distributions: ObservabilityDistribution[];
}

export interface ObservabilityReport {
  schemaVersion: number;
  generatedAt: string;
  windowDays: number;
  sections: ObservabilitySection[];
  /**
   * The §26 density gate as the calibration scheduler computes it — verdict,
   * unmet thresholds, and the inputs that are not certifiable. `certifiable` is
   * fail-closed and is false while ANY input is uninstrumented or an unproven
   * upper bound, which is why it can be false even when `met` is true.
   */
  densityGate: {
    met: boolean;
    certifiable: boolean;
    failures: string[];
    uninstrumented: string[];
    upperBound: string[];
  };
}

export const OBSERVABILITY_SCHEMA_VERSION = 1;

// ── Metric constructors — the ONLY way a metric is built ─────────────────────

function measured(key: string, label: string, value: number, denominator: number | null = null, note: string | null = null): ObservabilityMetric {
  return { key, label, status: "MEASURED", value, denominator, unit: "count", note };
}

function ratio(key: string, label: string, value: number, note: string | null = null): ObservabilityMetric {
  return { key, label, status: "MEASURED", value, denominator: null, unit: "ratio", note };
}

function upperBound(key: string, label: string, value: number, note: string): ObservabilityMetric {
  return { key, label, status: "UPPER_BOUND", value, denominator: null, unit: "count", note };
}

/**
 * The ONLY constructor for an UNINSTRUMENTED metric. `value` is hard-coded null,
 * so no caller can hand a number to a metric that is not measured. `note` is
 * required: an operator must be able to see WHY the figure is absent.
 */
function uninstrumented(key: string, label: string, note: string): ObservabilityMetric {
  return { key, label, status: "UNINSTRUMENTED", value: null, denominator: null, unit: "count", note };
}

function distribution(key: string, label: string, buckets: { key: string; count: number }[], unknownValues: string[] = [], note: string | null = null): ObservabilityDistribution {
  return { key, label, status: "MEASURED", buckets, unknownValues, note };
}

/** The ONLY constructor for an UNINSTRUMENTED distribution — buckets hard-coded null. */
function uninstrumentedDistribution(key: string, label: string, note: string): ObservabilityDistribution {
  return { key, label, status: "UNINSTRUMENTED", buckets: null, unknownValues: [], note };
}

// ── Row shapes ────────────────────────────────────────────────────────────────
// Each extends the funnel's row with the extra columns THIS report reads, so one
// fetch feeds both and the two can never disagree about the same rows.

export interface ObsObservationRow extends ObservationRow {
  /** Appendix-A source_class — the §24 "source diversity" input. */
  source_class?: string | null;
}
export interface ObsClaimRow extends ClaimRow {
  /** Set when this claim was superseded — the correction-propagation input. */
  superseded_by?: string | null;
}
export interface ObsSnapshotRow extends SnapshotRow {
  /** §10 conflict state (2275) — the §24 "conflict rate" input. */
  conflict_state?: string | null;
}
export interface ObsOutcomeRow extends OutcomeRow {
  /**
   * canonical_events.confidence — the SERVED confidence recorded on the outcome
   * event's envelope. Used only to GROUP reported outcomes by the band that was
   * served; it is never turned into an accuracy score (see the header).
   */
  confidence?: number | null;
}
/** intel_reward_ledger (2170). cash_amount is CHECK = 0 — see the economy note. */
export interface RewardLedgerRow {
  qiu?: number | null;
  earned_units?: number | null;
  cash_amount?: number | null;
}
/** intel_attributions (2277) — the §14 decision feedback ledger. */
export interface AttributionRow {
  outcome?: string | null;
  counterfactual?: boolean | null;
  contradiction?: boolean | null;
}

export interface ObservabilityRows {
  observations: readonly ObsObservationRow[];
  /** Full fresh cohort for the gate re-derivation (see FunnelRows.freshObservations). */
  freshObservations?: readonly ObsObservationRow[];
  claims: readonly ObsClaimRow[];
  snapshots: readonly ObsSnapshotRow[];
  confirmations: readonly ConfirmationRow[];
  outcomes?: readonly ObsOutcomeRow[];
  rewards?: readonly RewardLedgerRow[];
  attributions?: readonly AttributionRow[];
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function tallyByKnownKeys(
  values: readonly (string | null | undefined)[],
  known: readonly string[],
  nullKey = "(null)",
): { buckets: { key: string; count: number }[]; unknownValues: string[] } {
  const counts = new Map<string, number>();
  for (const k of known) counts.set(k, 0);
  counts.set(nullKey, 0);
  const unknownValues: string[] = [];
  for (const raw of values) {
    const v = raw == null || raw === "" ? nullKey : String(raw);
    if (counts.has(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
    else if (!unknownValues.includes(v)) unknownValues.push(v);
  }
  return { buckets: [...counts].map(([key, count]) => ({ key, count })), unknownValues };
}

function sumOf(rows: readonly Record<string, unknown>[], column: string): number {
  let total = 0;
  for (const r of rows) {
    const v = r[column];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

// ── The four sections ─────────────────────────────────────────────────────────

function truthHealthSection(rows: ObservabilityRows, funnel: IntelFunnel): ObservabilitySection {
  const snapshots = rows.snapshots;
  const materialConflicts = snapshots.filter((s) => s.conflict_state === "material").length;
  const conflictTally = tallyByKnownKeys(snapshots.map((s) => s.conflict_state), ["none", "soft", "material"], "(none)");

  // Source diversity: how many of the eight Appendix-A source classes are
  // actually represented among the observations. One class only = no diversity.
  const sourceClassTally = tallyByKnownKeys(rows.observations.map((o) => o.source_class), SOURCE_CLASSES);
  const representedClasses = sourceClassTally.buckets.filter((b) => b.key !== "(null)" && b.count > 0).length;

  // Correction propagation: a correction supersedes the prior claim, so a
  // superseded claim IS an accepted correction that reached the store. How far
  // the resulting invalidation got is a different question — see the note below.
  const supersededClaims = rows.claims.filter((c) => c.status === "superseded" || (c.superseded_by != null && c.superseded_by !== "")).length;

  return {
    key: "truth_health",
    title: "Truth health",
    requiredMetrics: "Fresh claim coverage, conflict rate, expiry latency, source diversity, correction propagation",
    metrics: [
      measured("servableLiveSnapshots", "Fresh claim coverage — snapshots a reader could serve now", funnel.snapshots.servableLive, funnel.snapshots.total),
      measured("liveEligibleClaims", "Live-eligible claims (active + conflicting)", funnel.claims.liveEligible, funnel.claims.tally.total),
      measured("materialConflictSnapshots", "Conflict rate — snapshots in material conflict", materialConflicts, snapshots.length,
        "A material conflict is already capped below the Live band on the serve path; it is surfaced here, never averaged away."),
      measured("expiredSnapshotsHeld", "Snapshots past their TTL still stored", funnel.snapshots.expired, funnel.snapshots.total,
        "Stored ≠ served: the read path drops an expired snapshot. This counts what the expiry sweep has yet to clear."),
      uninstrumented("expiryLatencySeconds", "Expiry latency — how long a Live label outlived its valid_until",
        "There is no serve-time log, so 'was a Live label ever shown after expiry, and for how long?' cannot be sampled from stored state. Left absent rather than reported as zero."),
      measured("sourceClassesRepresented", "Source diversity — Appendix-A source classes present", representedClasses, SOURCE_CLASSES.length),
      ratio("topContributorShare", "Contributor concentration — the busiest actor's share of observations", funnel.contributor.topActorShare,
        "1.0 means a single contributor is the entire supply. Actor-level only; no contributor is identified."),
      measured("correctionsAccepted", "Correction propagation — claims superseded by an accepted correction", supersededClaims, funnel.claims.tally.total),
      uninstrumented("correctionInvalidationCompleted", "Correction propagation — invalidations confirmed complete",
        "The correction path emits its invalidation targets to the structured log; completion is not recorded in a queryable store, so the completion rate cannot be read back."),
    ],
    distributions: [
      distribution("observationModeration", "Observations by moderation state",
        MODERATION_STATES.map((k) => ({ key: k, count: funnel.observations.tally.byKey[k] ?? 0 })),
        funnel.observations.tally.unknownValues),
      distribution("claimStatus", "Claims by status",
        CLAIM_STATUSES.map((k) => ({ key: k, count: funnel.claims.tally.byKey[k] ?? 0 })),
        funnel.claims.tally.unknownValues),
      distribution("snapshotBand", "Snapshots by confidence band",
        [...CONFIDENCE_BANDS, "(null)"].map((k) => ({ key: k, count: funnel.snapshots.bandTally.byKey[k] ?? 0 })),
        funnel.snapshots.bandTally.unknownValues),
      distribution("snapshotConflictState", "Snapshots by §10 conflict state", conflictTally.buckets, conflictTally.unknownValues),
      distribution("observationSourceClass", "Observations by source class", sourceClassTally.buckets, sourceClassTally.unknownValues),
    ],
  };
}

function calibrationSection(
  funnel: IntelFunnel,
  outcomes: readonly ObsOutcomeRow[],
  assessment: ReturnType<typeof assessDensityGate>,
): ObservabilitySection {
  // Reported outcomes grouped by the confidence band that was SERVED. This is a
  // real, measured distribution — and it is deliberately NOT called accuracy:
  // the outcome payload records how the traveler felt about the visit, not the
  // crowd value observed afterwards, so it cannot grade the crowd model. Naming
  // it for what it is keeps §37's truth boundary intact on the dashboard.
  const bandKeys = [...CONFIDENCE_BANDS, "(null)"];
  const byBand = new Map<string, number>(bandKeys.map((k) => [k, 0]));
  for (const o of outcomes) {
    const band = typeof o.confidence === "number" ? confidenceBand(o.confidence) : "(null)";
    byBand.set(band, (byBand.get(band) ?? 0) + 1);
  }

  const dimensionNote = (dimension: string) =>
    `Table 32 asks for accuracy by ${dimension}. Accuracy needs the after-proof value of the claim itself; the outcome envelope carries a satisfaction judgment instead, so no accuracy figure exists to break down. Absent, not zero.`;

  return {
    key: "calibration",
    title: "Calibration",
    requiredMetrics: "Accuracy by confidence band, claim family, city, zone, hour and source class",
    metrics: [
      measured("outcomeConfirmations", "Finalized outcome events", funnel.density.outcomeConfirmations),
      measured("afterProofPairs", "After-proof pairs — outcomes that name the state they followed", funnel.density.afterProofPairs, funnel.density.outcomeConfirmations,
        "The evidence a calibration score would eventually be computed from. Accumulating it is not the same as having the score."),
      measured("qualifyingWeeklyObservations", "Qualifying observations in the window", assessment.metrics.qualifyingWeeklyObservations),
      measured("minIndependentSourcesPerKeyVenueNight", "Weakest key venue/night — independent sources", assessment.metrics.minIndependentSourcesPerKeyVenueNight),
      upperBound("activeContributorsCitywide", "Active contributors citywide", assessment.metrics.activeReliableContributorsCitywide,
        "Distinct actors. Reliability is not modelled, so this over-counts 'active reliable contributors' — a threshold it clears is not proven cleared."),
      upperBound("minContributorsPerCluster", "Weakest key cluster — contributors", assessment.metrics.minContributorsPerCluster,
        "Distinct actors per zone; the same reliability caveat applies."),
      uninstrumented("crowdCalibrationAccuracy", "Crowd-state calibration accuracy",
        "The outcome payload carries a satisfaction judgment, not the crowd after-proof value a directional-accuracy score needs. The density gate treats this as UNMET rather than assuming it passes."),
      uninstrumented("expiryCorrectness", "Expiry correctness (no stale Live label beyond SLA)",
        "There is no serve-time log to sample, so the SLA cannot be evidenced. Fail-closed in the density gate."),
    ],
    distributions: [
      distribution("outcomesByServedConfidenceBand", "Reported outcomes by the confidence band that was served",
        bandKeys.map((k) => ({ key: k, count: byBand.get(k) ?? 0 })), [],
        "A count of reported outcomes, grouped by served band. NOT an accuracy score — see crowdCalibrationAccuracy."),
      uninstrumentedDistribution("accuracyByConfidenceBand", "Accuracy by confidence band", dimensionNote("confidence band")),
      uninstrumentedDistribution("accuracyByClaimFamily", "Accuracy by claim family", dimensionNote("claim family")),
      uninstrumentedDistribution("accuracyByCity", "Accuracy by city", dimensionNote("city")),
      uninstrumentedDistribution("accuracyByZone", "Accuracy by zone", dimensionNote("zone")),
      uninstrumentedDistribution("accuracyByHour", "Accuracy by hour", dimensionNote("hour")),
      uninstrumentedDistribution("accuracyBySourceClass", "Accuracy by source class", dimensionNote("source class")),
    ],
  };
}

function decisionSection(outcomes: readonly ObsOutcomeRow[], attributions: readonly AttributionRow[]): ObservabilitySection {
  const total = outcomes.length;
  // Appendix-A outcome semantics (lib/intelOutcomes): 'did_not_go' means the
  // recommendation was declined, so ARRIVAL is every other outcome;
  // 'could_not_enter' means arrival succeeded but entry failed.
  const didNotGo = outcomes.filter((o) => o.outcome === "did_not_go").length;
  const couldNotEnter = outcomes.filter((o) => o.outcome === "could_not_enter").length;
  const arrived = total - didNotGo;
  const entered = arrived - couldNotEnter;

  const outcomeTally = tallyByKnownKeys(outcomes.map((o) => o.outcome), INTEL_OUTCOMES);
  const counterfactualSame = attributions.filter((a) => a.counterfactual === true).length;
  const contradictions = attributions.filter((a) => a.contradiction === true).length;

  return {
    key: "decision",
    title: "Decision",
    requiredMetrics: "Arrival success, entry success, outcome, reroute recovery and regret feedback",
    metrics: [
      measured("outcomesReported", "Outcomes reported", total),
      measured("arrivalSuccess", "Arrival success — the traveler went", arrived, total,
        "Arrival = every outcome except 'did_not_go' (a declined recommendation)."),
      measured("entrySuccess", "Entry success — entry succeeded once there", entered, arrived,
        "Denominator is arrivals, not all outcomes: entry can only fail after arriving."),
      uninstrumented("rerouteRecovery", "Reroute recovery",
        "No reroute is recorded anywhere: the Appendix-A outcome enum has no reroute member and no reroute verb exists on the event spine, so a recovery rate has no source. Absent, not zero."),
      measured("regretFeedbackAnswers", "Regret feedback — counterfactual answers recorded", attributions.length, null,
        "Table 22's 'would you have made the same choice without this?' as stored on the attribution ledger."),
      measured("counterfactualSameChoice", "…of which 'I would have chosen the same anyway'", counterfactualSame, attributions.length,
        "A high share means the intelligence was consulted but did not change the decision. It discounts attribution weight; it never changes a claim's confidence."),
      measured("contradictingOutcomes", "Outcomes that contradicted the served state", contradictions, attributions.length,
        "Recorded for the correction path. A contradiction never mutates the claim from here."),
    ],
    distributions: [
      distribution("outcomeDistribution", "Outcomes by Appendix-A value", outcomeTally.buckets, outcomeTally.unknownValues),
    ],
  };
}

function economySection(rewards: readonly RewardLedgerRow[]): ObservabilitySection {
  const qiu = sumOf(rewards as readonly Record<string, unknown>[], "qiu");
  const units = sumOf(rewards as readonly Record<string, unknown>[], "earned_units");
  const cash = sumOf(rewards as readonly Record<string, unknown>[], "cash_amount");

  return {
    key: "economy",
    title: "Economy",
    requiredMetrics: "QIU shadow cost, funded payouts, fraud, API attribution and margin",
    metrics: [
      measured("ledgerEntries", "Reward-ledger entries booked", rewards.length),
      measured("qiuShadowTotal", "QIU shadow cost — total QIU booked", Math.round(qiu * 1000) / 1000, null,
        "Shadow accounting only (§23). QIU is calculated and recorded; it creates no liability and no cash obligation."),
      measured("earnedUnitsTotal", "Non-cash credits earned", units),
      measured("fundedCashPayouts", "Funded payouts (cash)", cash, null,
        "Structurally zero: intel_reward_ledger CHECKs cash_amount = 0, so platform cash cannot be booked against a contributor through this ledger at all. This zero is a property of the schema, not an empty table."),
      uninstrumented("fraudSignals", "Fraud",
        "No fraud or integrity-incident ledger exists for the intel path; integrity currently gates earning rather than being counted. Absent, not zero."),
      uninstrumented("apiAttributedRevenue", "API attribution",
        "intel_external_api is off and no partner surface is built, so there is no attributable API revenue to read. Absent, not zero."),
      uninstrumented("apiMargin", "API margin",
        "Margin needs both attributed revenue and a cost basis; neither is recorded. Absent, not zero."),
    ],
    distributions: [],
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Build the whole §24 report from already-fetched rows. Pure; `now` is injected
 * so freshness/expiry are deterministic and testable.
 */
export function buildObservabilityReport(
  rows: ObservabilityRows,
  opts: { now: Date; windowDays: number },
): ObservabilityReport {
  const { now, windowDays } = opts;
  const funnel = tallyIntelFunnel(rows as unknown as FunnelRows, now);
  const assessment = assessDensityGate(funnel, { qualifyingWeeklyObservations: funnel.observations.pilotClaimable });
  const outcomes = rows.outcomes ?? [];
  const attributions = rows.attributions ?? [];
  const rewards = rows.rewards ?? [];

  return {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    windowDays,
    sections: [
      truthHealthSection(rows, funnel),
      calibrationSection(funnel, outcomes, assessment),
      decisionSection(outcomes, attributions),
      economySection(rewards),
    ],
    densityGate: {
      met: assessment.gate.met,
      certifiable: assessment.certifiable,
      failures: assessment.gate.failures,
      uninstrumented: assessment.uninstrumented,
      upperBound: assessment.upperBound,
    },
  };
}
