/**
 * The statistics the §33/§34 device measurements are reported in.
 *
 * Kept in one leaf module, with the METHOD written down, because "the p99" is
 * not a single number: nearest-rank and linear interpolation disagree by a
 * whole frame on a 180-sample pan, and a budget of 16.7 ms is close enough to
 * the truth that the disagreement decides the verdict. A measurement whose
 * method is not stated is not a measurement.
 *
 * NEAREST-RANK is the method used here, in both directions:
 *
 *     rank = ceil(p * n),  1 <= rank <= n,  value = sorted[rank - 1]
 *
 * Its properties are the ones that matter for a pass/fail gate:
 *   - every reported value is a value that was actually observed, so "the p99
 *     was 18.2 ms" names a real frame that can be looked up in the trace;
 *   - it never interpolates a number between two frames, which would let a
 *     budget be met by a frame that did not happen;
 *   - it is monotone and defined for every n >= 1.
 *
 * It is the CONSERVATIVE choice for a ceiling: nearest-rank p99 >= linear p99,
 * so a run that passes here passes under either method.
 */

/** Sort a copy ascending, dropping anything that is not a finite number. */
export function cleanSamples(samples: readonly number[]): number[] {
  return samples.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
}

/**
 * Nearest-rank percentile. `p` is a fraction in [0, 1].
 *
 * Returns null for an empty sample rather than 0 — a budget check against a
 * measurement that did not happen must not read as a pass, and 0 ms would.
 */
export function percentile(samples: readonly number[], p: number): number | null {
  const sorted = cleanSamples(samples);
  if (sorted.length === 0) return null;
  if (!Number.isFinite(p)) return null;
  const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
  const rank = Math.max(1, Math.min(sorted.length, Math.ceil(clamped * sorted.length)));
  return sorted[rank - 1];
}

/**
 * The median, as nearest-rank p50.
 *
 * Note this is the LOWER of the two middle values for an even sample, not their
 * mean. M254 asks for "the median over 10 cold starts"; with 10 samples the
 * mean of the 5th and 6th is a duration no start ever took, and if it lands on
 * the wrong side of 2000 ms the row turns on a number that was invented. The
 * 5th value is a real cold start.
 */
export function median(samples: readonly number[]): number | null {
  return percentile(samples, 0.5);
}

export interface Distribution {
  /** How many usable samples went in. */
  n: number;
  min: number | null;
  median: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function describe(samples: readonly number[]): Distribution {
  const sorted = cleanSamples(samples);
  return {
    n: sorted.length,
    min: sorted.length ? sorted[0] : null,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}
