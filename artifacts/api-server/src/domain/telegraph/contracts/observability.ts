/**
 * Telegraph §28 and §30A.17 — the observability contract.
 *
 * §28 is a nine-row table of "Metric → Target / intent". §30A.17 asks for ten
 * measurements and eight SLOs, "safety/privacy operations receive the strictest
 * requirements". The census found none of it: "No metric is emitted for
 * messaging and no target constant exists… Telegraph has no telemetry sink at
 * all."
 *
 * WHAT A TARGET IS HERE, AND WHY IT IS A UNION
 * -------------------------------------------
 * The spec's nine targets are not the same KIND of statement. "0 under the
 * idempotency contract" is a count that must stay at zero; "high availability"
 * is a ratio; "bounded, alert on material stale shared context" is a latency;
 * and "primary product outcome metric" names no number at all. Flattening them
 * into one shape would have meant inventing four numbers the spec does not give
 * and then measuring against them, which is worse than measuring nothing —
 * a fabricated threshold produces confident alerts about a line nobody drew.
 * So `unbounded` is a first-class target that carries the spec's own words, and
 * the guard requires it to say why rather than allowing it as a default.
 *
 * WHAT `status` MEANS, and it is not a grade
 * -----------------------------------------
 *   measured            an emitter in non-test code records this metric on
 *                       every deployment of this tree.
 *   partially_measured  something real is counted, and it is a PROXY for what
 *                       the spec asked for. The note must say what the gap is.
 *   unmeasurable        the thing to be measured does not exist yet. Recorded
 *                       with a target so that building it does not also require
 *                       remembering to define one.
 *
 * THE CEILING, STATED ONCE HERE RATHER THAN IN EVERY ROW
 * -----------------------------------------------------
 * These counters are IN-PROCESS. They are per-instance and they reset on
 * restart. That is enough to make a regression visible to an operator who looks
 * — which is strictly more than the nothing that was here — and it is NOT
 * enough to page anyone, to survive a deploy, or to aggregate across instances.
 * A durable sink would need a migration, and no database has one; alerting is an
 * operator decision. Neither is a code change this tree can make, so neither is
 * claimed.
 */

/** Which spec clause asks for this metric. */
export type SloSpecSection = "28" | "30A.17";

/**
 * Severity, which decides the strictness ordering §30A.17 requires.
 * `safety` and `privacy` are the two the spec singles out.
 */
export type SloSeverity = "safety" | "privacy" | "delivery" | "product";

export type SloTarget =
  /** A ratio that must stay AT OR ABOVE `min` (0–1). */
  | { readonly kind: "ratio"; readonly min: number }
  /** A count of violations that must stay AT OR BELOW `max`. */
  | { readonly kind: "count"; readonly max: number }
  /** A latency percentile that must stay AT OR BELOW `maxMs`. */
  | { readonly kind: "latency"; readonly percentile: number; readonly maxMs: number }
  /** The spec states an intent and no number. Its words go in `intent`. */
  | { readonly kind: "unbounded"; readonly intent: string };

export type SloStatus = "measured" | "partially_measured" | "unmeasurable";

export interface TelegraphSlo {
  /** Stable id. The guard and the diagnostics surface both key on it. */
  readonly id: string;
  /** The census row this answers, or null for an SLO the census did not row. */
  readonly censusRow: string | null;
  readonly specSection: SloSpecSection;
  /** The metric key an emitter records under. Must be unique. */
  readonly metric: string;
  /** The spec's own wording for the target, quoted. */
  readonly requirement: string;
  readonly target: SloTarget;
  readonly severity: SloSeverity;
  readonly status: SloStatus;
  /**
   * Repo-relative modules that record this metric. Checked to exist AND to
   * contain the metric key, so a declaration cannot point at a file that
   * records something else.
   */
  readonly emitters: readonly string[];
  /** What is counted, what it is a proxy for, and what would close the gap. */
  readonly note: string;
}

/** One metric's running state. Counts only — never a message body, never a name. */
export interface MetricState {
  readonly metric: string;
  /** Events that satisfied the metric's success condition. */
  ok: number;
  /** Events that violated it. For a `count` target this is the number to compare. */
  violations: number;
  /** Events where the outcome could not be determined. Never folded into either. */
  unknown: number;
  /** Latency samples, in milliseconds, for metrics that carry one. */
  latenciesMs: number[];
}
