/**
 * Trips spec §21.1 — an in-process metrics registry for the trip domain.
 *
 * WHY THIS EXISTS
 * ===============
 * lib/tripKernel.ts keeps `trip_command_rejected_total` by reason as a private
 * counter with a reader. The second §21.1 metric this codebase records,
 * `projection_lag_seconds` ("Read-model freshness"), needed the same thing —
 * and `temporal_conflict_total` (§7.2 conflicts, recorded where they are
 * detected) is the third —
 * and a second private counter would have been a second registry. This is the
 * one place a trip metric is written and read; the kernel's counter predates
 * it and is left where it is, with its own reader, so the kernel stays
 * untouched.
 *
 * WHO RECORDS projection_lag_seconds, AND WHY IT IS NOT THE ROUTE
 * ===============================================================
 * Lag is a fact about CONSUMPTION: the time between a projection's
 * `generatedAt` and the moment a consumer accepts it. A projection route that
 * observed its own lag would always read zero and would be measuring nothing.
 * So the observation is made by acceptTripProjection
 * (services/trips/TripProjectionEnvelope.ts) — the §19.1 consumer rule — at
 * the moment a consumer decides to use a projection. Today every consumer
 * that runs in this process sees a projection generated in the same request,
 * so the observed lag is ~0 seconds; that is the true state of a system with
 * no projection workers (§19.4, census-trips TR379), and the metric says so
 * rather than being absent.
 *
 * No exporter. Readers are tests and, one day, whatever metrics endpoint the
 * platform grows; readTripMetric() is that endpoint's input.
 */

export type TripMetricLabels = Readonly<Record<string, string>>;

export interface TripMetricSeries {
  labels: TripMetricLabels;
  count: number;
  sum: number;
  max: number;
  last: number;
}

const series = new Map<string, Map<string, TripMetricSeries>>();

function labelKey(labels: TripMetricLabels): string {
  return Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(",");
}

/** Record one observation of a value-carrying metric (a histogram, in spirit). */
export function observeTripMetric(name: string, labels: TripMetricLabels, value: number): void {
  if (!Number.isFinite(value)) return; // a NaN observation is not a measurement
  let byLabel = series.get(name);
  if (!byLabel) { byLabel = new Map(); series.set(name, byLabel); }
  const key = labelKey(labels);
  const s = byLabel.get(key);
  if (s) {
    s.count += 1; s.sum += value; s.max = Math.max(s.max, value); s.last = value;
  } else {
    byLabel.set(key, { labels: { ...labels }, count: 1, sum: value, max: value, last: value });
  }
}

/** A counter: one observation of 1. `count` is the total. */
export function incrementTripMetric(name: string, labels: TripMetricLabels): void {
  observeTripMetric(name, labels, 1);
}

/** Every series recorded under `name`, copied. Empty when nothing was recorded. */
export function readTripMetric(name: string): readonly TripMetricSeries[] {
  return [...(series.get(name)?.values() ?? [])].map((s) => ({ ...s, labels: { ...s.labels } }));
}

/** Test hook. */
export function _resetTripMetrics(): void {
  series.clear();
}
