/**
 * Pure state + formatting helpers for the four §24 / Table-32 intel dashboards
 * (Truth health, Calibration, Decision, Economy).
 *
 * Mirrors the featureFlags / schemaDrift machine pattern: fetch-result → screen
 * state and value → display string stay pure and testable outside React.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ====================================
 * The server marks every metric with its instrumentation status, because Table
 * 32 asks for numbers this system does not yet measure (expiry latency,
 * calibration accuracy, reroute recovery, fraud, API margin). Rendering one of
 * those as `0` would read as "measured, and it is zero" — the single most
 * misleading thing an observability screen can do.
 *
 * So formatting is centralised here and is total over the status:
 *   UNINSTRUMENTED → the words "Not instrumented". There is no branch that can
 *                    print a figure for one, even if the payload carried a
 *                    number: applyObservabilityLoadResult NULLS the value of any
 *                    uninstrumented metric on the way in, so a server-side
 *                    regression cannot leak a zero onto the screen either.
 *   UPPER_BOUND    → the figure, flagged, because it over-counts the truth.
 *   MEASURED       → the figure.
 */

export type InstrumentationStatus = 'MEASURED' | 'UPPER_BOUND' | 'UNINSTRUMENTED';

export type ObservabilitySectionKey = 'truth_health' | 'calibration' | 'decision' | 'economy';

export const OBSERVABILITY_SECTION_KEYS: readonly ObservabilitySectionKey[] = [
  'truth_health',
  'calibration',
  'decision',
  'economy',
];

export interface ObservabilityMetric {
  key: string;
  label: string;
  status: InstrumentationStatus;
  /** Always null when status is UNINSTRUMENTED — enforced on load, not trusted. */
  value: number | null;
  denominator: number | null;
  unit: 'count' | 'ratio';
  note: string | null;
}

export interface DistributionBucket {
  key: string;
  count: number;
}

export interface ObservabilityDistribution {
  key: string;
  label: string;
  status: InstrumentationStatus;
  /** Always null when status is UNINSTRUMENTED. */
  buckets: DistributionBucket[] | null;
  /** Enum values the writer emitted that this build does not know — a reader defect. */
  unknownValues: string[];
  note: string | null;
}

export interface ObservabilitySection {
  key: ObservabilitySectionKey;
  title: string;
  /** The Table-32 line this section implements, quoted by the server. */
  requiredMetrics: string;
  metrics: ObservabilityMetric[];
  distributions: ObservabilityDistribution[];
}

export interface DensityGate {
  met: boolean;
  certifiable: boolean;
  failures: string[];
  uninstrumented: string[];
  upperBound: string[];
}

export interface ObservabilityReport {
  schemaVersion: number;
  generatedAt: string;
  windowDays: number;
  sections: ObservabilitySection[];
  densityGate: DensityGate;
}

export interface ObservabilityLoadResult {
  report: ObservabilityReport | null;
  error: string | null;
}

/** The one string an uninstrumented figure may ever render as. */
export const NOT_INSTRUMENTED_LABEL = 'Not instrumented';

const SECTION_KEY_SET = new Set<string>(OBSERVABILITY_SECTION_KEYS);

function asStatus(v: unknown): InstrumentationStatus | null {
  return v === 'MEASURED' || v === 'UPPER_BOUND' || v === 'UNINSTRUMENTED' ? v : null;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normalizeMetric(raw: unknown): ObservabilityMetric | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const status = asStatus(m.status);
  if (typeof m.key !== 'string' || typeof m.label !== 'string' || !status) return null;
  const uninstrumented = status === 'UNINSTRUMENTED';
  return {
    key: m.key,
    label: m.label,
    status,
    // Belt and braces: an uninstrumented metric has NO value here, whatever the
    // payload said. A server-side regression can then still not paint a zero.
    value: uninstrumented ? null : finiteOrNull(m.value),
    denominator: uninstrumented ? null : finiteOrNull(m.denominator),
    unit: m.unit === 'ratio' ? 'ratio' : 'count',
    note: typeof m.note === 'string' && m.note.length > 0 ? m.note : null,
  };
}

function normalizeDistribution(raw: unknown): ObservabilityDistribution | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const status = asStatus(d.status);
  if (typeof d.key !== 'string' || typeof d.label !== 'string' || !status) return null;
  let buckets: DistributionBucket[] | null = null;
  if (status !== 'UNINSTRUMENTED' && Array.isArray(d.buckets)) {
    buckets = (d.buckets as unknown[])
      .map((b) => {
        if (!b || typeof b !== 'object') return null;
        const bb = b as Record<string, unknown>;
        if (typeof bb.key !== 'string') return null;
        return { key: bb.key, count: finiteOrNull(bb.count) ?? 0 };
      })
      .filter((b): b is DistributionBucket => b !== null);
  }
  return {
    key: d.key,
    label: d.label,
    status,
    buckets,
    unknownValues: Array.isArray(d.unknownValues) ? (d.unknownValues as unknown[]).filter((v): v is string => typeof v === 'string') : [],
    note: typeof d.note === 'string' && d.note.length > 0 ? d.note : null,
  };
}

function normalizeSection(raw: unknown): ObservabilitySection | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.key !== 'string' || !SECTION_KEY_SET.has(s.key)) return null;
  if (!Array.isArray(s.metrics) || !Array.isArray(s.distributions)) return null;
  return {
    key: s.key as ObservabilitySectionKey,
    title: typeof s.title === 'string' ? s.title : s.key,
    requiredMetrics: typeof s.requiredMetrics === 'string' ? s.requiredMetrics : '',
    metrics: (s.metrics as unknown[]).map(normalizeMetric).filter((m): m is ObservabilityMetric => m !== null),
    distributions: (s.distributions as unknown[]).map(normalizeDistribution).filter((d): d is ObservabilityDistribution => d !== null),
  };
}

function normalizeGate(raw: unknown): DensityGate {
  const g = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  return {
    met: g.met === true,
    // Fail-closed: anything other than an explicit true is "not certifiable".
    certifiable: g.certifiable === true,
    failures: strings(g.failures),
    uninstrumented: strings(g.uninstrumented),
    upperBound: strings(g.upperBound),
  };
}

/**
 * Map an adminGet-style result into screen state. An unexpected shape is an
 * ERROR, never a partially-rendered dashboard: a dashboard that silently drops
 * the half it could not parse is exactly the failure this whole surface exists
 * to prevent.
 */
export function applyObservabilityLoadResult(res: {
  ok: boolean;
  data?: unknown;
  error?: string;
}): ObservabilityLoadResult {
  if (!res.ok) {
    return { report: null, error: res.error ?? 'Failed to load intel observability' };
  }
  const d = res.data as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object' || !Array.isArray(d.sections)) {
    return { report: null, error: 'Unexpected response from server' };
  }
  const sections = (d.sections as unknown[]).map(normalizeSection).filter((s): s is ObservabilitySection => s !== null);
  if (sections.length !== (d.sections as unknown[]).length) {
    return { report: null, error: 'Unexpected response from server' };
  }
  return {
    report: {
      schemaVersion: finiteOrNull(d.schemaVersion) ?? 0,
      generatedAt: typeof d.generatedAt === 'string' ? d.generatedAt : '',
      windowDays: finiteOrNull(d.windowDays) ?? 0,
      sections,
      densityGate: normalizeGate(d.densityGate),
    },
    error: null,
  };
}

/** The section a given dashboard screen renders, or null when absent. */
export function sectionOf(
  report: ObservabilityReport | null,
  key: ObservabilitySectionKey,
): ObservabilitySection | null {
  return report?.sections.find((s) => s.key === key) ?? null;
}

/**
 * The display string for a metric. TOTAL over the status, and the only path by
 * which a metric reaches the screen.
 *
 *   UNINSTRUMENTED → "Not instrumented"  (never "0")
 *   ratio          → "42.0%"
 *   count + denom  → "3 of 10"
 *   count          → "3"
 */
export function formatMetricValue(metric: ObservabilityMetric): string {
  if (metric.status === 'UNINSTRUMENTED' || metric.value === null) return NOT_INSTRUMENTED_LABEL;
  if (metric.unit === 'ratio') return `${(metric.value * 100).toFixed(1)}%`;
  const value = formatNumber(metric.value);
  if (metric.denominator === null) return value;
  return `${value} of ${formatNumber(metric.denominator)}`;
}

/** The share a "n of m" metric represents, or null when there is no denominator. */
export function metricShareLabel(metric: ObservabilityMetric): string | null {
  if (metric.status === 'UNINSTRUMENTED' || metric.value === null) return null;
  if (metric.unit === 'ratio') return null;
  if (metric.denominator === null) return null;
  // 0 of 0 is honest silence, not 0% and not 100% — there was nothing to measure.
  if (metric.denominator === 0) return 'no rows in window';
  return `${((metric.value / metric.denominator) * 100).toFixed(1)}%`;
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

/** Human label for a status badge. */
export function statusLabel(status: InstrumentationStatus): string {
  if (status === 'MEASURED') return 'Measured';
  if (status === 'UPPER_BOUND') return 'Upper bound';
  return NOT_INSTRUMENTED_LABEL;
}

/**
 * One line summarising the §26 density gate. `certifiable` is deliberately
 * separate from `met`: the gate's arithmetic can pass while inputs remain
 * uninstrumented or unproven, and in that state the gate is NOT a green light.
 */
export function densityGateSummary(gate: DensityGate): string {
  if (gate.certifiable) return 'Density gate: certifiable';
  if (gate.met) {
    return `Density gate: thresholds met but NOT certifiable — ${gate.uninstrumented.length + gate.upperBound.length} input(s) unmeasured or unproven`;
  }
  const n = gate.failures.length;
  return `Density gate: not met — ${n} threshold${n === 1 ? '' : 's'} outstanding`;
}

/** How many of a section's figures are not measured at all. */
export function uninstrumentedCount(section: ObservabilitySection | null): number {
  if (!section) return 0;
  return section.metrics.filter((m) => m.status === 'UNINSTRUMENTED').length
    + section.distributions.filter((d) => d.status === 'UNINSTRUMENTED').length;
}
