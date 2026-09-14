/**
 * §24 `privacy_revocation_latency`, as a sample rather than as a sentence.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       Section 24 "Observability and Quality Metrics"
 *       (docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:612)
 *       — `privacy_revocation_latency`: "Time until all public derivatives are
 *       removed." And, in the same section: "Do not log sensitive raw content
 *       unless strictly necessary."
 *
 * CENSUS: H219 (docs/architecture/census-highlights-memories.md, section 24),
 *         NOT-BUILT on "`executeRevocation` produces a per-destination report
 *         and no timing at all". Re-executed before this file was written:
 *         accurate — neither revocation module contained the word.
 *
 * THERE ARE TWO CLOCKS AND THE SPEC MEANS THE SLOWER ONE. `revocationMs` is how
 * long the eviction loop ran; `latencyMs` is how long it was between the person
 * changing their mind — the moment their write COMMITTED — and the last
 * derivative going away. An operator optimising the first is optimising the
 * wrong thing, so both ride on the sample and `latencyMs` is the one that
 * carries §24's name.
 *
 * `complete` IS LOAD-BEARING AND IS NOT A CONVENIENCE FLAG. §24 asks for the
 * time until ALL public derivatives are removed, so a duration is only that
 * metric when the removal was total. It is false in three different ways, each
 * of which is a real thing that happens here:
 *   1. an applicable destination was not removed (seven of §21's eight do not
 *      exist as destinations at all — H192);
 *   2. the invalidator failed, which is recorded as a failure class rather than
 *      swallowed;
 *   3. the LOSING AUDIENCE WAS NOT ENUMERABLE. A Memory that was `public` has a
 *      losing audience of everyone, and this repository evicts a bounded proxy
 *      for it (H189). A latency to a proxy is not a latency to "all", and a
 *      metric that said otherwise would make the one unsolved half of H189 look
 *      solved.
 *
 * NOTHING AGGREGATES THIS. There is no metrics backend in this repository: the
 * sample is a structured log line, which is the same surface §24's operational
 * log fields land on and the same one `MemoryDomainService.auditCommand` uses.
 * A dashboard, an alert and a percentile are an operator's to build, and
 * `resurfacing_suppression_violations` ("must be zero") would need one.
 */

/** §24's own name for the metric. Never spell it twice. */
export const PRIVACY_REVOCATION_LATENCY = "privacy_revocation_latency" as const;

/** Bumped on any change to how the two durations are derived (§28.13). */
export const PRIVACY_METRICS_ENGINE_VERSION = "memory-privacy-metrics@1";

/** The revocation surfaces that emit this metric. A closed set, on purpose. */
export type PrivacyRevocationSurface = "memory_audience" | "highlight_lifecycle";

export interface PrivacyRevocationSampleInput {
  surface: PrivacyRevocationSurface;
  /** The Memory or Highlight whose derivatives were revoked. An id, never content. */
  subjectId: string;
  /** Why the revocation ran, in the surface's own vocabulary. */
  reason: string;
  /** `Date.now()` at the moment the privacy-changing write COMMITTED. */
  requestedAt?: number | undefined;
  /** `Date.now()` at the moment the revocation began. */
  startedAt: number;
  /** `Date.now()` at the moment the last destination reached a terminal state. */
  finishedAt: number;
  /** Destinations that could have been removed. */
  destinationsTotal: number;
  /** Destinations actually removed. */
  destinationsRemoved: number;
  /** Set when the losing audience had no enumerable membership — today, `public`. */
  unboundedAudience: string | null;
  /** A named class, never a message: §24's eighth operational log field. */
  failureClass: string | null;
}

export interface PrivacyRevocationSample {
  readonly metric: typeof PRIVACY_REVOCATION_LATENCY;
  readonly surface: PrivacyRevocationSurface;
  readonly subjectId: string;
  readonly reason: string;
  /** §24's figure: the privacy decision to the last derivative going away. */
  readonly latencyMs: number;
  /** The eviction loop alone. Never greater than `latencyMs`. */
  readonly revocationMs: number;
  readonly complete: boolean;
  readonly destinationsTotal: number;
  readonly destinationsRemoved: number;
  readonly unboundedAudience: string | null;
  readonly failureClass: string | null;
  readonly engineVersion: string;
}

/** Never negative: a backwards clock is a zero, not a headline. */
function elapsed(from: number, to: number): number {
  const d = to - from;
  return Number.isFinite(d) && d > 0 ? Math.round(d) : 0;
}

/** Pure. Same input, same sample — so a test can assert on the arithmetic. */
export function buildPrivacyRevocationSample(
  input: PrivacyRevocationSampleInput,
): PrivacyRevocationSample {
  const revocationMs = elapsed(input.startedAt, input.finishedAt);
  const latencyMs = Math.max(
    revocationMs,
    elapsed(input.requestedAt ?? input.startedAt, input.finishedAt),
  );
  const removedEverything =
    input.destinationsTotal > 0 && input.destinationsRemoved >= input.destinationsTotal;
  return {
    metric: PRIVACY_REVOCATION_LATENCY,
    surface: input.surface,
    subjectId: input.subjectId,
    reason: input.reason,
    latencyMs,
    revocationMs,
    complete: removedEverything && input.unboundedAudience === null && input.failureClass === null,
    destinationsTotal: input.destinationsTotal,
    destinationsRemoved: input.destinationsRemoved,
    unboundedAudience: input.unboundedAudience,
    failureClass: input.failureClass,
    engineVersion: PRIVACY_METRICS_ENGINE_VERSION,
  };
}

export interface MetricLogger {
  info?: (obj: unknown, msg: string) => void;
}

/**
 * Emit the sample. A revocation must never fail because nobody was listening,
 * so a missing or partial logger is a no-op rather than a throw.
 */
export function recordPrivacyRevocationLatency(
  log: MetricLogger | undefined,
  sample: PrivacyRevocationSample,
): void {
  if (!log || typeof log.info !== "function") return;
  log.info(
    sample,
    sample.complete
      ? "metrics: privacy_revocation_latency — every reachable derivative removed"
      : "metrics: privacy_revocation_latency — INCOMPLETE removal; this duration is not 'time until all derivatives were removed'",
  );
}
