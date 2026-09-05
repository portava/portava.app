/**
 * A tiny, dependency-free timing harness for in-repo performance guards
 * (Wall spec §33 / TABLE 4).
 *
 * WHAT A NUMBER FROM THIS MEANS — AND WHAT IT DOES NOT
 * ====================================================
 * It measures the time OUR code spends producing a response on the machine
 * running the test. It does not measure network, real database latency, TLS,
 * cold starts, or anything about a device. TABLE 4's "< 500 ms backend
 * excluding network" is the production target; a CI box is slower and noisier
 * than production, so a benchmark built on this must assert a GENEROUS ceiling
 * — one a healthy tree clears by a wide margin, so a failure means somebody
 * added real work (an N+1, an unbounded scan, a synchronous loop over the whole
 * feed), not that the runner was busy.
 *
 * Percentiles are the nearest-rank kind (p95 of 20 samples is the 19th
 * smallest), which is the honest reading for the small sample counts a test can
 * afford — no interpolation between two samples that were never observed.
 */

/** One measured run: every sample in milliseconds, plus its distribution. */
export interface BenchmarkResult {
  label: string;
  /** Every measured iteration, in call order (milliseconds). */
  samples: number[];
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export interface BenchmarkOptions {
  /** Unmeasured runs first, so JIT warm-up is not counted. Default 5. */
  warmup?: number;
  /** Measured runs. Default 20. */
  iterations?: number;
}

/**
 * Nearest-rank percentile of an UNSORTED sample set, in the sample's own unit.
 * `p` is a fraction in (0, 1]. Throws on an empty set rather than inventing a
 * number — a percentile of nothing is not zero.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new Error("percentile: no samples");
  if (!(p > 0 && p <= 1)) throw new Error(`percentile: p must be in (0,1], got ${p}`);
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * Run `fn` `warmup` times unmeasured, then `iterations` times measured.
 * Sequential on purpose: concurrent runs would measure contention, not cost.
 */
export async function benchmark(
  label: string,
  fn: () => Promise<unknown>,
  opts: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const warmup = opts.warmup ?? 5;
  const iterations = opts.iterations ?? 20;
  if (iterations < 1) throw new Error("benchmark: iterations must be >= 1");

  for (let i = 0; i < warmup; i++) await fn();

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }

  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    label,
    samples,
    min: Math.min(...samples),
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: Math.max(...samples),
    mean: sum / samples.length,
  };
}

/** One line, fixed columns, safe to leave in CI output. */
export function formatBenchmark(r: BenchmarkResult): string {
  const ms = (n: number) => `${n.toFixed(1)}ms`;
  return (
    `[bench] ${r.label}: n=${r.samples.length} ` +
    `min=${ms(r.min)} p50=${ms(r.p50)} p95=${ms(r.p95)} max=${ms(r.max)} mean=${ms(r.mean)}`
  );
}

/**
 * A deterministic 32-bit PRNG (mulberry32). A benchmark's fixture set must be
 * the SAME every run — a random corpus would make the timing incomparable and
 * a failure unreproducible.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
