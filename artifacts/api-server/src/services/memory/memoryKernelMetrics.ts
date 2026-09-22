/**
 * §24 Observability and Quality Metrics — the counted half.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       Section 24 "Observability and Quality Metrics"
 *       (docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:612)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * "THERE IS NO METRICS BACKEND" IS HALF TRUE, AND THE HALF THAT IS FALSE MATTERS
 * ══════════════════════════════════════════════════════════════════════════════
 * A previous lane declined §24's metrics on the grounds that this repository has
 * no metrics backend. Re-measured here: there is no AGGREGATOR — no Prometheus,
 * no StatsD, no OTel metric exporter, no dashboard, no alert rule. That part is
 * correct and is restated rather than papered over.
 *
 * But a metrics SINK is a different thing from an aggregator, and this tree has
 * two, both already load-bearing:
 *
 *   1. AN IN-PROCESS COUNTER read by tests and by whatever exporter the platform
 *      grows. `src/lib/memoryCommandBus.ts:412#readMemoryCommandRejectedTotal`
 *      is §24's `memory_command_rejected_total` by reason code, and its own
 *      comment names the shape it copied: domain/trips/commands/tripKernel.ts.
 *      Two subsystems already keep metrics this way.
 *   2. A STRUCTURED LOG SAMPLE. `src/lib/memoryPrivacyMetrics.ts` emits §24's
 *      `privacy_revocation_latency` as a log line carrying a `metric` field, and
 *      that module's header states the position outright: "There is no metrics
 *      backend in this repository: the sample is a structured log line, which is
 *      the same surface §24's operational log fields land on."
 *
 * So the standard for "built" was already set by a §24 metric that shipped.
 * This module meets that standard for the metrics whose events actually occur,
 * and refuses — by name, in `MEMORY_METRICS_NOT_MEASURABLE` — the ones whose
 * events do not. The refusals are the point: a metric reported as 0 when its
 * numerator is unobservable is worse than no metric, because 0 is also what
 * "measured, and fine" looks like.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * A RATE WITH NO DENOMINATOR IS `null`, NEVER 0
 * ══════════════════════════════════════════════════════════════════════════════
 * Every figure below is a RATE, and 0/0 is not 0. This repository has already
 * paid for that mistake once, in the opposite direction: migration 2999 exists
 * because `trust_profiles` stored "we have not measured this person" as a
 * fabricated neutral 50, byte-identical to a real measurement. A
 * `place_correction_rate` of 0 reported from zero commands is the same defect —
 * an operator reading it cannot tell "nobody corrects places" from "nothing has
 * happened yet". `rateOf` therefore returns `null` for an empty denominator,
 * and the sample carries the raw counts beside every rate so the reader can
 * always see what the rate was computed from.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * IN-PROCESS MEANS PER-PROCESS, AND THAT IS A REAL LIMIT
 * ══════════════════════════════════════════════════════════════════════════════
 * These counters live in one Node process's heap. They reset on deploy, they do
 * not aggregate across instances, and they are not durable. They are honest
 * about a single process's behaviour and they are NOT a fleet-wide measurement.
 * Making them one needs an exporter, which is named in the report as the
 * concrete missing piece rather than pretended around here.
 */

/** §24's own names. Never spell one twice. */
export const MEMORY_KERNEL_METRICS = {
  CANDIDATE_CONFIRM_RATE: "candidate_confirm_rate",
  CANDIDATE_REJECT_RATE: "candidate_reject_rate",
  PLACE_CORRECTION_RATE: "place_correction_rate",
  PARTICIPANT_CORRECTION_RATE: "participant_correction_rate",
  EXPLICIT_MEMORY_WITHOUT_CANDIDATE_RATE: "explicit_memory_without_candidate_rate",
  PROJECTION_LAG: "projection_lag",
} as const;

/** Bumped on any change to how a figure below is derived (§28.13). */
export const MEMORY_KERNEL_METRICS_ENGINE_VERSION = "memory-kernel-metrics@1";

/**
 * §24 metrics this module deliberately does NOT emit, each with the measured
 * reason. Exported so the gap is legible from the code rather than only from a
 * census row, and so a test can assert the two sets are disjoint — a metric
 * that appeared in both would be one claimed and refused at the same time.
 */
export const MEMORY_METRICS_NOT_MEASURABLE = {
  candidate_split_rate:
    "SPLIT_MEMORY is not a declared command (lib/memoryCommandBus.ts MEMORY_COMMAND_TYPES_NOT_DECLARED), so the numerator is structurally zero rather than measured. Reporting 0 would be indistinguishable from 'nobody splits Memories'.",
  candidate_merge_rate:
    "MERGE_MEMORY is likewise undeclared. Same reasoning.",
  false_memory_rate:
    "Defined as corrected-over-surfaced INFERRED assertions. Nothing in this tree surfaces an inferred Memory assertion to a user: the candidate pipeline's storage (memory_evidence / memory_episodes, migration 2320) is unapplied, so the denominator is not merely zero, it is unobservable.",
  resurfacing_suppression_violations:
    "§24 says this must be zero. Detecting a violation requires a resurfacing feed to observe, and the proactive feeds live in routes/highlights.ts and services/highlights/, owned by another lane. This module cannot count what it cannot see, and a zero emitted from here would be a claim about code it never ran.",
  do_again_conversion:
    "There is no do-again feature to convert (census H107/H108: a repository-wide grep for doAgain / do_again / takeMeBack returns nothing at all).",
} as const;

export type MemoryMetricNotMeasurable = keyof typeof MEMORY_METRICS_NOT_MEASURABLE;

// ── Counters ─────────────────────────────────────────────────────────────────
// The shape lib/memoryCommandBus.ts and domain/trips/commands/tripKernel.ts
// already established: a module-scoped record, a reader that copies, and a
// reset hook for tests.

interface Counters {
  /** §6 eligibility verdicts (services/memoryProjections/evidence.ts). */
  candidatesEvaluated: number;
  candidatesConfirmed: number;
  candidatesRejected: number;
  /** §17 accepted commands, by the correction class §24 asks about. */
  commandsAccepted: number;
  placeCorrections: number;
  participantCorrections: number;
  /** §17 CREATE_MEMORY with no originating candidate. */
  explicitMemoriesCreated: number;
  explicitMemoriesWithoutCandidate: number;
}

const zero = (): Counters => ({
  candidatesEvaluated: 0,
  candidatesConfirmed: 0,
  candidatesRejected: 0,
  commandsAccepted: 0,
  placeCorrections: 0,
  participantCorrections: 0,
  explicitMemoriesCreated: 0,
  explicitMemoriesWithoutCandidate: 0,
});

let counters: Counters = zero();

/** Test hook. */
export function _resetMemoryKernelMetrics(): void {
  counters = zero();
}

/**
 * §6 eligibility ran. `confirmed` is the gate's verdict, not a user's.
 * Called from the eligibility gate so the count is taken at the one place the
 * decision is actually made.
 */
export function countCandidateEvaluation(confirmed: boolean): void {
  counters.candidatesEvaluated += 1;
  if (confirmed) counters.candidatesConfirmed += 1;
  else counters.candidatesRejected += 1;
}

/**
 * An ACCEPTED §17 command crossed the boundary. Rejections are already counted
 * by reason at lib/memoryCommandBus.ts#readMemoryCommandRejectedTotal; this is
 * the accepted side, which §24's correction rates need as their denominator.
 *
 * `hadCandidate` is only meaningful for CREATE_MEMORY and is ignored otherwise.
 * It is a required parameter rather than an optional one so a caller has to
 * state the answer: defaulting it would quietly decide H218's numerator.
 */
export function countAcceptedCommand(
  commandType: string,
  hadCandidate: boolean,
): void {
  counters.commandsAccepted += 1;
  if (commandType === "CHANGE_PLACE") counters.placeCorrections += 1;
  if (commandType === "ADD_PERSON" || commandType === "REMOVE_PERSON") {
    counters.participantCorrections += 1;
  }
  if (commandType === "CREATE_MEMORY") {
    counters.explicitMemoriesCreated += 1;
    if (!hadCandidate) counters.explicitMemoriesWithoutCandidate += 1;
  }
}

/**
 * A rate, or `null` when nothing was measured. See the header: 0/0 is not 0,
 * and this repository has a migration (2999) that exists because a previous
 * answer to that question was "call it neutral".
 */
export function rateOf(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  // Four places: these are rates in [0,1], and a raw float would make two
  // different-looking samples compare unequal for no reason.
  return Math.round((numerator / denominator) * 10000) / 10000;
}

export interface MemoryKernelMetricsSample {
  readonly engineVersion: string;
  /** Every rate, `null` where the denominator is empty. */
  readonly candidate_confirm_rate: number | null;
  readonly candidate_reject_rate: number | null;
  readonly place_correction_rate: number | null;
  readonly participant_correction_rate: number | null;
  readonly explicit_memory_without_candidate_rate: number | null;
  /** The raw counts every rate above was computed from. */
  readonly counts: Readonly<Counters>;
  /** The §24 names this sample deliberately does not carry. */
  readonly notMeasurable: readonly MemoryMetricNotMeasurable[];
}

export function readMemoryKernelMetrics(): MemoryKernelMetricsSample {
  const c = { ...counters };
  return {
    engineVersion: MEMORY_KERNEL_METRICS_ENGINE_VERSION,
    candidate_confirm_rate: rateOf(c.candidatesConfirmed, c.candidatesEvaluated),
    candidate_reject_rate: rateOf(c.candidatesRejected, c.candidatesEvaluated),
    place_correction_rate: rateOf(c.placeCorrections, c.commandsAccepted),
    participant_correction_rate: rateOf(c.participantCorrections, c.commandsAccepted),
    explicit_memory_without_candidate_rate: rateOf(
      c.explicitMemoriesWithoutCandidate,
      c.explicitMemoriesCreated,
    ),
    counts: c,
    notMeasurable: Object.keys(MEMORY_METRICS_NOT_MEASURABLE) as MemoryMetricNotMeasurable[],
  };
}

// ── §24 projection_lag ───────────────────────────────────────────────────────

/**
 * §24 `projection_lag`, as a sample.
 *
 * WHICH CLOCK. The lag that matters to a reader of a projection is how stale
 * the projection was, which is the time from the domain event being RECORDED to
 * the projection being rebuilt — not how long the rebuild took. `lagMs` is the
 * former and is the one carrying §24's name; `rebuildMs` is the latter and
 * rides along so an operator optimising the wrong one can see both.
 *
 * WHY THE OUTBOX ROW'S `created_at` AND NOT THE EVENT'S. memoryOutbox.ts
 * records the measurement: `occurred_at`, `recorded_at` and `created_at` all
 * default to `now()`, which in PostgreSQL is TRANSACTION start time. Both
 * columns are written in the same transaction, so they are the same instant;
 * the outbox row's is used because the consumer already has it and a join back
 * to the event log would buy nothing.
 *
 * THE LAG IS NOT THE WHOLE TRUTH WHEN A REBUILD WAS SKIPPED. `projections`
 * carries what actually happened, so a lag figure is never read as "the
 * projection is now fresh" when nothing was rebuilt.
 */
export const PROJECTION_LAG = MEMORY_KERNEL_METRICS.PROJECTION_LAG;

export interface ProjectionLagSampleInput {
  /** The event this lag is measured for. An id, never content. */
  eventId: string;
  eventType: string;
  memoryId: string;
  /** `Date.parse` of the outbox row's created_at. */
  enqueuedAtMs: number;
  /** `Date.now()` when the consumer began this event's rebuilds. */
  startedAtMs: number;
  /** `Date.now()` when the last rebuild for this event finished. */
  finishedAtMs: number;
  projectionsRebuilt: number;
  projectionsSkipped: number;
  projectionsFailed: number;
  /** A named class, never a message (§24's eighth operational log field). */
  failureClass: string | null;
}

export interface ProjectionLagSample {
  readonly metric: typeof PROJECTION_LAG;
  readonly eventId: string;
  readonly eventType: string;
  readonly memoryId: string;
  /** §24's figure: event recorded -> projection rebuilt. */
  readonly lagMs: number;
  /** The rebuild loop alone. Never greater than `lagMs`. */
  readonly rebuildMs: number;
  readonly projectionsRebuilt: number;
  readonly projectionsSkipped: number;
  readonly projectionsFailed: number;
  readonly failureClass: string | null;
  readonly engineVersion: string;
}

/** Never negative: a backwards clock is a zero, not a headline. */
function elapsed(from: number, to: number): number {
  const d = to - from;
  return Number.isFinite(d) && d > 0 ? Math.round(d) : 0;
}

/** Pure. Same input, same sample — so a test can assert on the arithmetic. */
export function buildProjectionLagSample(
  input: ProjectionLagSampleInput,
): ProjectionLagSample {
  const rebuildMs = elapsed(input.startedAtMs, input.finishedAtMs);
  const lagMs = Math.max(rebuildMs, elapsed(input.enqueuedAtMs, input.finishedAtMs));
  return {
    metric: PROJECTION_LAG,
    eventId: input.eventId,
    eventType: input.eventType,
    memoryId: input.memoryId,
    lagMs,
    rebuildMs,
    projectionsRebuilt: input.projectionsRebuilt,
    projectionsSkipped: input.projectionsSkipped,
    projectionsFailed: input.projectionsFailed,
    failureClass: input.failureClass,
    engineVersion: MEMORY_KERNEL_METRICS_ENGINE_VERSION,
  };
}

export interface MetricLogger {
  info?: (obj: unknown, msg: string) => void;
}

/**
 * Emit the sample. A projection rebuild must never fail because nobody was
 * listening, so a missing or partial logger is a no-op rather than a throw —
 * memoryPrivacyMetrics.ts takes the same posture for the same reason.
 */
export function recordProjectionLag(
  log: MetricLogger | undefined,
  sample: ProjectionLagSample,
): void {
  if (!log || typeof log.info !== "function") return;
  log.info(
    sample,
    sample.projectionsFailed > 0
      ? "metrics: projection_lag — at least one projection did NOT rebuild; this lag is not 'time until the projection was fresh'"
      : "metrics: projection_lag",
  );
}
