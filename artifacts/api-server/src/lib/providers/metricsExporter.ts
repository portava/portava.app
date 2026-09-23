/**
 * The METRICS EXPORTER — census-layover L210, L211, L213, L215, L216, L217.
 *
 * ── WHAT WAS ACTUALLY MISSING ────────────────────────────────────────────────
 * These six rows are all "metric X". The census's own §23 note on L215 is the
 * clearest statement of where they stand:
 *
 *   > The metric IS defined and computed
 *   > (`services/airport/layoverObservability.ts#LAYOVER_METRICS`) … And there
 *   > is no metrics exporter in this repository to emit it to.
 *
 * That is two separate blockers and only one of them is this lane's. The inputs
 * (`layover_certified_computations` has no writer) belong to the layover lanes.
 * THE EXPORTER — the platform capability that takes computed metric values and
 * makes them visible to something outside this process — did not exist
 * anywhere, for any surface, and that is what this file is.
 *
 * It is deliberately NOT layover-specific. `layoverObservability.ts` produces
 * `LayoverMetricValue[]`; this module accepts that shape STRUCTURALLY (see
 * `MetricValue` below) without importing from `services/`, so the same exporter
 * serves any other surface that grows metrics later, and so a lib module does
 * not acquire a dependency on a service module.
 *
 * ── THE ONE RULE THIS EXPORTER EXISTS TO ENFORCE ─────────────────────────────
 * AN UNPRODUCIBLE METRIC IS NEVER EXPORTED AS A NUMBER.
 *
 * `layoverObservability.ts` already refuses to compute 0/0, and its own comment
 * says why better than this one could:
 *
 *   > 0/0 IS NOT 0. A rate with no denominator is the most dangerous number on
 *   > a dashboard: it is indistinguishable from a healthy one and it moves the
 *   > moment a single sample arrives.
 *
 * An exporter is precisely where that care gets thrown away, because the wire
 * formats all want a float. Emitting `critical_unknown_rate 0` for a metric
 * whose denominator is empty would put a green number on a dashboard for a
 * pipeline that has never produced a single decision — and L216 and L217 have
 * TARGET 0, so a fabricated zero would read as the target being MET.
 *
 * So an UNPRODUCIBLE metric contributes no value series at all. What it
 * contributes instead is `<name>_unproducible 1`, with the blocker as a label,
 * so the absence is a thing a monitoring system can see, alert on and count —
 * rather than a gap that looks like a metric nobody scrapes yet.
 *
 * ── AND THE SAMPLE SIZE TRAVELS WITH THE RATE ────────────────────────────────
 * A rate of 1.0 over one decision and a rate of 1.0 over ten thousand are the
 * same float and are not the same fact. `<name>_samples` is exported beside
 * every rate so the denominator is never lost on the wire.
 *
 * ── NO DEPENDENCY, BY CONSTRUCTION ───────────────────────────────────────────
 * This file adds no package. The Prometheus text exposition format is a
 * documented, stable, line-oriented format, and rendering it by hand is a few
 * dozen lines — much less than the cost of a new dependency in a tree whose
 * build already runs a Sentry/OpenTelemetry version-drift guard
 * (`check:sentry-otel-deps`) that a new telemetry package could break. The
 * renderer is pure: text in, text out, no clock, no I/O.
 *
 * ── SINKS ────────────────────────────────────────────────────────────────────
 * Rendering and DELIVERY are separate. `renderPrometheusText` is pure; a sink
 * decides where the text goes. Two are provided: a log sink that works
 * everywhere with no configuration, and a push sink for a Pushgateway-style
 * endpoint that refuses by name when unconfigured — the same discipline as
 * every other provider in this directory. Nothing is bound by default.
 */
import { logger } from "../logger.js";
import { answer, credentialRefusal, refuse, type ProviderResult } from "./providerRefusal.js";

/**
 * The metric shape this exporter accepts.
 *
 * STRUCTURAL, not imported. `services/airport/layoverObservability.ts`'s
 * `LayoverMetricValue` satisfies it exactly, so a caller passes one straight
 * in, and `lib/` gains no dependency on `services/`. Widening this type is how
 * a second surface joins — not by editing the producer.
 */
export interface MetricValue {
  name: string;
  kind: "counter" | "rate";
  target: number | null;
  status: "OK" | "UNPRODUCIBLE";
  /** The measurement. `null` whenever `status` is UNPRODUCIBLE. */
  value: number | null;
  /** The exact artifact whose absence blocks this metric. `null` when OK. */
  blockedBy: string | null;
  /** Denominator actually used, so a rate can be read with its sample size. */
  sampleSize: number;
}

export interface ExportOptions {
  /**
   * Prefixed onto every series name. A metric called `replan_rate` is
   * meaningless in a shared monitoring system; `portava_layover_replan_rate` is
   * not. Defaults to nothing so the renderer stays pure about its input.
   */
  prefix?: string;
  /** Labels applied to every series, e.g. the deployment. Values are escaped. */
  labels?: Record<string, string>;
}

/**
 * Prometheus label values escape backslash, double quote and newline, and
 * nothing else. Applied to every value, including `blockedBy`, which is prose
 * written by a human and WILL contain quotes and backticks.
 */
export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * A metric or label NAME must match `[a-zA-Z_][a-zA-Z0-9_]*`. A name that does
 * not is SKIPPED rather than coerced: silently rewriting `foo.bar` to `foo_bar`
 * creates a series under a name nobody searches for, which is a metric that
 * exists and cannot be found — worse than one that is visibly missing.
 */
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isExportableName(n: string): boolean {
  return NAME_RE.test(n);
}

function labelBlock(labels: Record<string, string>): string {
  const parts = Object.entries(labels)
    .filter(([k]) => isExportableName(k))
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return parts.length === 0 ? "" : `{${parts.join(",")}}`;
}

/**
 * Prometheus rejects a non-finite sample. NaN and ±Inf can only arrive here
 * from a producer bug, and exporting one would either break the scrape or, in
 * some backends, land as a real value. Treated as unproducible — a number this
 * code cannot vouch for is not a measurement.
 */
function exportableNumber(v: number | null): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export interface RenderedExport {
  text: string;
  /** Series actually written, for a caller that wants to log what it sent. */
  seriesCount: number;
  /** Metrics that contributed no value series, and why. */
  withheld: Array<{ name: string; reason: string }>;
}

/**
 * Render metric values as Prometheus text exposition format.
 *
 * PURE. No clock, no I/O, no environment. The same input renders the same text
 * forever, which is what makes this testable without a fixed date anywhere.
 */
export function renderPrometheusText(
  metrics: readonly MetricValue[],
  opts: ExportOptions = {},
): RenderedExport {
  const prefix = opts.prefix ?? "";
  const base = opts.labels ?? {};
  const lines: string[] = [];
  const withheld: Array<{ name: string; reason: string }> = [];
  let seriesCount = 0;

  const emit = (name: string, labels: Record<string, string>, value: number, help: string, type: string) => {
    lines.push(`# HELP ${name} ${help.replace(/\n/g, " ")}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name}${labelBlock(labels)} ${value}`);
    seriesCount += 1;
  };

  for (const m of metrics) {
    const name = `${prefix}${m.name}`;
    if (!isExportableName(name)) {
      withheld.push({ name: m.name, reason: "name is not a valid Prometheus metric name" });
      continue;
    }

    if (m.status === "UNPRODUCIBLE" || !exportableNumber(m.value)) {
      // THE RULE. No value series at all — see the header. Instead, a series
      // that says the metric could not be produced, carrying the blocker so an
      // operator reading the dashboard learns what to fix without opening the
      // repository.
      const reason =
        m.status === "UNPRODUCIBLE"
          ? (m.blockedBy ?? "no reason recorded")
          : `status OK but the value is ${String(m.value)} — not a finite number`;
      emit(
        `${name}_unproducible`,
        { ...base, blocked_by: reason },
        1,
        `1 when ${m.name} could not be produced. Its value series is deliberately absent rather than zero: ` +
          `a rate with no denominator is indistinguishable from a healthy one.`,
        "gauge",
      );
      withheld.push({ name: m.name, reason });
      continue;
    }

    emit(
      name,
      base,
      m.value,
      `${m.kind === "rate" ? "Rate" : "Count"} for ${m.name}.`,
      // A rate is a gauge: it goes down as well as up, and declaring it a
      // counter would make every rate() query over it nonsense.
      m.kind === "rate" ? "gauge" : "counter",
    );

    // The denominator travels with the rate. 1.0 over one sample and 1.0 over
    // ten thousand are the same float and not the same fact.
    if (m.kind === "rate") {
      emit(
        `${name}_samples`,
        base,
        m.sampleSize,
        `Denominator behind ${m.name}. A rate read without it is not a measurement.`,
        "gauge",
      );
    }

    // A target is a promise the metric is measured against (L216 and L217 both
    // target 0). Exported so an alert can be written against the target rather
    // than against a number copied into a dashboard and left to rot.
    if (m.target !== null && Number.isFinite(m.target)) {
      emit(
        `${name}_target`,
        base,
        m.target,
        `Declared target for ${m.name}.`,
        "gauge",
      );
    }
  }

  // Prometheus requires a trailing newline on the final line.
  return { text: lines.length === 0 ? "" : `${lines.join("\n")}\n`, seriesCount, withheld };
}

/** Where a rendered export goes. */
export interface MetricsSink {
  readonly id: string;
  publish(rendered: RenderedExport): Promise<ProviderResult<{ delivered: number }>>;
}

/**
 * The sink every deployment can use with no configuration.
 *
 * It logs a SUMMARY, not the exposition text: a scrape body is hundreds of
 * lines and a log is not a time-series database. What it does carry is the
 * count of series and — importantly — every withheld metric with its blocker,
 * because a deployment with no monitoring system still benefits from a line
 * saying which six metrics cannot be produced and why.
 */
export const LOG_METRICS_SINK: MetricsSink = {
  id: "log-sink",
  async publish(rendered) {
    logger.info(
      {
        series: rendered.seriesCount,
        withheld: rendered.withheld.length,
        // Names and blockers only. Never the values — a metrics value in a log
        // is a number nobody can query and everybody can misread.
        blocked: rendered.withheld.map((w) => w.name),
      },
      "metrics export rendered",
    );
    for (const w of rendered.withheld) {
      logger.warn({ metric: w.name, blockedBy: w.reason }, "metric is unproducible — no value was exported");
    }
    return answer({ delivered: rendered.seriesCount });
  },
};

export const PUSHGATEWAY_URL_ENV = "METRICS_PUSHGATEWAY_URL";

/**
 * A push sink for a Pushgateway-style endpoint.
 *
 * Unconfigured is the normal state and is a NAMED REFUSAL, not a silent no-op:
 * a metrics pipeline that quietly does nothing is exactly the failure this
 * whole directory is written against, and it is the one failure a metrics
 * system cannot report about itself.
 *
 * The URL is read through `credentialRefusal` even though it is not a secret,
 * because the absent/set-but-empty distinction matters here for the same reason
 * it matters for a key: an operator who has just added `METRICS_PUSHGATEWAY_URL`
 * and set it to nothing needs to be told that, not told it is unset.
 */
export function createPushgatewaySink(
  opts: {
    fetchImpl?: typeof fetch;
    readEnv?: (n: string) => string | undefined;
    job?: string;
    timeoutMs?: number;
  } = {},
): MetricsSink {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const readEnv = opts.readEnv ?? ((n: string) => process.env[n]);
  const job = opts.job ?? "portava_api";
  const timeout = opts.timeoutMs ?? 5_000;
  const id = "pushgateway-sink";

  return {
    id,
    async publish(rendered) {
      const missing = credentialRefusal(id, PUSHGATEWAY_URL_ENV, readEnv);
      if (missing) return missing;
      const base = (readEnv(PUSHGATEWAY_URL_ENV) as string).replace(/\/+$/, "");

      if (rendered.text === "") {
        // Nothing to send is not a failure and not a success worth claiming.
        // Pushing an empty body to a Pushgateway DELETES the job's series,
        // which would turn "we had nothing to export this tick" into "every
        // metric for this job disappeared".
        return refuse(
          id,
          "REQUEST_INCOMPLETE",
          "the render produced no series; an empty push would clear this job's existing metrics",
        );
      }

      if (typeof doFetch !== "function") {
        return refuse(id, "PROVIDER_UNAVAILABLE", "no fetch implementation is available");
      }

      let res: Response;
      try {
        res = await doFetch(`${base}/metrics/job/${encodeURIComponent(job)}`, {
          method: "POST",
          headers: { "Content-Type": "text/plain; version=0.0.4" },
          body: rendered.text,
          signal: AbortSignal.timeout(timeout),
        });
      } catch (e) {
        return refuse(
          id,
          "PROVIDER_UNAVAILABLE",
          e instanceof Error ? `${e.name}: ${e.message}` : "push failed",
        );
      }
      if (!res.ok) return refuse(id, "PROVIDER_UNAVAILABLE", `HTTP ${res.status}`);
      return answer({ delivered: rendered.seriesCount });
    },
  };
}

/**
 * Render and publish in one call.
 *
 * Returns the sink's result unchanged, refusal included. A caller that ignores
 * it has a metrics pipeline that cannot report its own failure, which is the
 * condition this module exists to end.
 */
export async function exportMetrics(
  metrics: readonly MetricValue[],
  sink: MetricsSink,
  opts: ExportOptions = {},
): Promise<ProviderResult<{ delivered: number }>> {
  return sink.publish(renderPrometheusText(metrics, opts));
}
