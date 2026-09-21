/**
 * §33 "Initial usable map under 2 s on a normal connection" — the capture half
 * (census-map M254).
 *
 * ## What this is, and what it is NOT
 *
 * This is the INSTRUMENT and the VERDICT function. It is not the measurement.
 * The measurement requires a physical mid-tier Android handset running an EAS
 * `preview` build over a shaped 1.6 Mbit/s, 300 ms RTT link, and no such device
 * exists in the environment this was written in — see
 * `docs/map/device-measurement-protocol.md` §M254 for the runnable protocol and
 * the ledger the operator fills in. Nothing here may be quoted as a result.
 *
 * ## The two marks, and why they are these two
 *
 * The census fixes both ends of the interval, and they are not the obvious
 * ones:
 *
 *   START — "the `/map` route's NAVIGATION COMMIT". Not the tap, not the
 *     component's first render. The tap includes the outgoing screen's exit
 *     animation, which is not the map's cost; the first render happens after
 *     the router has already done its work, which hides part of it.
 *
 *   END — "MapLibre's FIRST FULLY-RENDERED FRAME". Not `onDidFinishLoadingMap`
 *     (the style is parsed but tiles may not be painted) and not the first
 *     `onDidFinishRenderingFrame` (which fires for a partial frame). The SDK's
 *     `onDidFinishRenderingFrameFully` is the one that means "there is a map
 *     on the screen".
 *
 * Between them, "usable" is what §33 promises and what a user would call it.
 *
 * ## The two arms are reported separately, and that is a requirement
 *
 * §33's cache arm is a different claim from the cold-start claim. A warm cache
 * can serve a map in a few hundred ms and says nothing about a traveller
 * opening the app for the first time in a new city, which is the case §33 is
 * written for. `COLD_START_BUDGET_MS` applies to the NO-CACHE arm only; the
 * cached arm is recorded and reported and has no pass/fail here.
 */
import { describe as describeSamples, type Distribution } from './statistics.ts';

/** §33's budget, for the NO-CACHE arm. */
export const COLD_START_BUDGET_MS = 2000;

/** The census's sample size: "median over 10 COLD starts". */
export const REQUIRED_COLD_STARTS = 10;

/** Which of §33's two arms a sample belongs to. */
export type CacheArm = 'cold' | 'cached';

/**
 * One run's marks. Times are milliseconds from any monotonic clock, as long as
 * it is the SAME clock for both marks — a wall clock that steps (NTP, a
 * timezone change mid-run) can produce a negative interval, which is why
 * `coldStartMs` refuses one rather than reporting it as a very fast start.
 */
export interface ColdStartTrace {
  /** Navigation commit for the `/map` route. */
  navigationCommittedAt: number | null;
  /** MapLibre's `onDidFinishRenderingFrameFully`. */
  firstFullFrameAt: number | null;
  arm: CacheArm;
  /** Free-form note for the ledger — build id, device, network shaping. */
  note?: string;
}

export function createTrace(arm: CacheArm, note?: string): ColdStartTrace {
  return { navigationCommittedAt: null, firstFullFrameAt: null, arm, note };
}

/** Record the navigation commit. Idempotent: the FIRST commit is the start. */
export function markNavigationCommitted(trace: ColdStartTrace, at: number): ColdStartTrace {
  if (trace.navigationCommittedAt != null) return trace;
  return { ...trace, navigationCommittedAt: at };
}

/**
 * Record the first fully-rendered frame. Idempotent for the same reason, and it
 * matters more here: `onDidFinishRenderingFrameFully` fires on EVERY fully
 * rendered frame, so without this the "first" frame would become the last one
 * before the assertion ran, and the interval would grow with every pan.
 */
export function markFirstFullFrame(trace: ColdStartTrace, at: number): ColdStartTrace {
  if (trace.firstFullFrameAt != null) return trace;
  return { ...trace, firstFullFrameAt: at };
}

/**
 * The interval, or null when the run did not produce one.
 *
 * Null is returned — never 0, never a negative number — for a missing mark or a
 * clock that went backwards. A run that did not complete is not a fast run.
 */
export function coldStartMs(trace: ColdStartTrace): number | null {
  const { navigationCommittedAt: start, firstFullFrameAt: end } = trace;
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  if (typeof end !== 'number' || !Number.isFinite(end)) return null;
  const elapsed = end - start;
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return elapsed;
}

export interface ColdStartReport {
  arm: CacheArm;
  /** Runs that produced a usable interval. */
  samples: number[];
  /** Runs that were started but produced no interval. */
  incomplete: number;
  distribution: Distribution;
  /** Did enough runs complete for the census's stated sample size? */
  hasRequiredRuns: boolean;
  /**
   * The verdict, for the COLD arm only. `null` on the cached arm — §33 sets no
   * budget for it, and inventing one would turn a separate claim into a pass.
   */
  meetsBudget: boolean | null;
  budgetMs: number;
}

/**
 * Summarise one arm's runs.
 *
 * ## Anti-vacuity — the property this function exists to have
 *
 * An empty or short run REFUSES. `meetsBudget` is `false`, not `true`, when
 * fewer than `REQUIRED_COLD_STARTS` runs completed, because the alternative is
 * the exact failure the census warns about elsewhere: a harness that measured
 * nothing reporting a pass. "No frame took longer than 2 s" is trivially true
 * of zero frames.
 */
export function reportColdStarts(
  traces: readonly ColdStartTrace[],
  arm: CacheArm,
): ColdStartReport {
  const forArm = traces.filter((t) => t.arm === arm);
  const samples: number[] = [];
  let incomplete = 0;
  for (const t of forArm) {
    const ms = coldStartMs(t);
    if (ms == null) incomplete += 1;
    else samples.push(ms);
  }
  const distribution = describeSamples(samples);
  const hasRequiredRuns = samples.length >= REQUIRED_COLD_STARTS;
  const meetsBudget =
    arm === 'cached'
      ? null
      : hasRequiredRuns && distribution.median != null && distribution.median < COLD_START_BUDGET_MS;
  return {
    arm,
    samples,
    incomplete,
    distribution,
    hasRequiredRuns,
    meetsBudget,
    budgetMs: COLD_START_BUDGET_MS,
  };
}

/** Both arms, reported separately — never combined into one number. */
export interface ColdStartResult {
  cold: ColdStartReport;
  cached: ColdStartReport;
}

export function reportBothArms(traces: readonly ColdStartTrace[]): ColdStartResult {
  return {
    cold: reportColdStarts(traces, 'cold'),
    cached: reportColdStarts(traces, 'cached'),
  };
}

/** A one-line ledger entry for `docs/map/device-measurement-protocol.md`. */
export function formatReport(report: ColdStartReport): string {
  const d = report.distribution;
  const verdict =
    report.meetsBudget == null
      ? 'no budget (reported separately, per §33)'
      : report.meetsBudget
        ? `PASS (< ${report.budgetMs} ms)`
        : report.hasRequiredRuns
          ? `FAIL (>= ${report.budgetMs} ms)`
          : `NOT RUN (${report.samples.length}/${REQUIRED_COLD_STARTS} completed runs)`;
  const num = (v: number | null) => (v == null ? '—' : `${Math.round(v)} ms`);
  return (
    `${report.arm}: n=${d.n} incomplete=${report.incomplete} ` +
    `median=${num(d.median)} p95=${num(d.p95)} max=${num(d.max)} — ${verdict}`
  );
}
