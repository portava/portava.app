/**
 * The metrics exporter — census-layover L210, L211, L213, L215, L216, L217.
 *
 * ONE PROPERTY CARRIES THIS FILE: an UNPRODUCIBLE metric must never leave this
 * process as a number. `layoverObservability.ts` is careful about 0/0 and says
 * why — "a rate with no denominator is the most dangerous number on a
 * dashboard: it is indistinguishable from a healthy one" — and an exporter is
 * exactly where that care is thrown away, because every wire format wants a
 * float. L216 and L217 both have TARGET 0, so a fabricated zero would not just
 * be wrong, it would read as the target being MET.
 *
 * The suite therefore asserts on the ABSENCE of series as much as on their
 * presence, and the real metric names from the census are used rather than
 * invented ones, so a rename on either side shows up here.
 *
 * The renderer is pure, so nothing in this file needs a clock and nothing in it
 * can rot on a date.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOG_METRICS_SINK,
  PUSHGATEWAY_URL_ENV,
  createPushgatewaySink,
  escapeLabelValue,
  exportMetrics,
  isExportableName,
  renderPrometheusText,
  type MetricValue,
} from "../lib/providers/metricsExporter.js";

function ok(name: string, value: number, kind: MetricValue["kind"] = "rate", sampleSize = 100, target: number | null = null): MetricValue {
  return { name, kind, target, status: "OK", value, blockedBy: null, sampleSize };
}

function blocked(name: string, blockedBy: string, kind: MetricValue["kind"] = "rate", target: number | null = null): MetricValue {
  return { name, kind, target, status: "UNPRODUCIBLE", value: null, blockedBy, sampleSize: 0 };
}

/** The six census rows this exporter is for, in their real spellings. */
const CENSUS_METRICS: MetricValue[] = [
  blocked("critical_unknown_rate", "no critical-unknown concept (L22)"),
  blocked("landside_eligible_rate", "no eligibility decision is recorded"),
  blocked("return_warning_rate", "RETURN_SOON/RETURN_NOW do not exist"),
  blocked("stale_fallback_rate", "`layover_certified_computations` has no writer"),
  blocked("recommendation_contract_violation", "no contract to violate (L76)", "counter", 0),
  blocked("decision_replay_mismatch", "no replay (L191)", "counter", 0),
];

describe("an UNPRODUCIBLE metric never leaves this process as a number", () => {
  it("emits no value series for a blocked metric", () => {
    const { text } = renderPrometheusText([blocked("stale_fallback_rate", "no writer")]);
    assert.equal(
      /^stale_fallback_rate[ {]/m.test(text),
      false,
      "an unproducible metric must have no value series at all",
    );
    assert.equal(text.includes("stale_fallback_rate 0"), false, "0 would read as a healthy rate");
  });

  it("emits an _unproducible series instead, carrying the blocker", () => {
    const { text } = renderPrometheusText([blocked("stale_fallback_rate", "the table has no writer")]);
    assert.match(text, /^stale_fallback_rate_unproducible\{blocked_by="the table has no writer"\} 1$/m);
  });

  it("does NOT emit a target for a blocked metric whose target is 0", () => {
    // L216/L217 target 0. Emitting `..._target 0` beside no value is harmless;
    // emitting the VALUE as 0 would read as the target being met. This asserts
    // the value is the thing that is absent.
    const { text } = renderPrometheusText([blocked("decision_replay_mismatch", "no replay", "counter", 0)]);
    assert.equal(/^decision_replay_mismatch\{?[^_]/m.test(text), false);
    assert.equal(text.includes("decision_replay_mismatch 0"), false, "a zero here reads as 'target met'");
  });

  it("withholds every one of the six census metrics and names each blocker", () => {
    const r = renderPrometheusText(CENSUS_METRICS);
    assert.equal(r.seriesCount, 6, "six _unproducible series and nothing else");
    assert.equal(r.withheld.length, 6);
    assert.deepEqual(
      r.withheld.map((w) => w.name).sort(),
      [
        "critical_unknown_rate",
        "decision_replay_mismatch",
        "landside_eligible_rate",
        "recommendation_contract_violation",
        "return_warning_rate",
        "stale_fallback_rate",
      ],
    );
    for (const w of r.withheld) assert.ok(w.reason.length > 5, `${w.name} must name its blocker`);
  });

  it("a status of OK with a non-finite value is treated as unproducible, not exported", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const m = { ...ok("critical_unknown_rate", 0), value: bad as number | null };
      const r = renderPrometheusText([m]);
      assert.equal(r.withheld.length, 1, `${String(bad)} must not be exported as a sample`);
      assert.match(r.text, /_unproducible/);
      // The blocker PROSE may name the offending value ("the value is NaN"),
      // and should. What must not exist is a SAMPLE whose value is non-finite:
      // Prometheus rejects the line, and some backends store it.
      for (const line of r.text.split("\n")) {
        if (line.startsWith("#") || line === "") continue;
        const sample = line.slice(line.lastIndexOf(" ") + 1);
        assert.ok(
          Number.isFinite(Number(sample)),
          `exported a non-finite sample: ${line}`,
        );
      }
    }
  });
});

describe("a producible metric is exported with its denominator and its target", () => {
  it("exports the value", () => {
    const { text } = renderPrometheusText([ok("replan_rate", 0.25)]);
    assert.match(text, /^replan_rate 0\.25$/m);
  });

  it("exports the sample size beside a rate — 1.0 over 1 is not 1.0 over 10,000", () => {
    const { text } = renderPrometheusText([ok("replan_rate", 1, "rate", 1)]);
    assert.match(text, /^replan_rate 1$/m);
    assert.match(text, /^replan_rate_samples 1$/m);
  });

  it("does not invent a sample series for a counter", () => {
    const { text } = renderPrometheusText([ok("layover_sessions_detected", 42, "counter", 42)]);
    assert.equal(/_samples/.test(text), false);
  });

  it("exports a declared target so an alert can be written against it", () => {
    const { text } = renderPrometheusText([ok("decision_replay_mismatch", 0, "counter", 10, 0)]);
    assert.match(text, /^decision_replay_mismatch_target 0$/m);
  });

  it("declares a rate as a gauge, not a counter — a rate goes down", () => {
    const { text } = renderPrometheusText([ok("replan_rate", 0.5)]);
    assert.match(text, /^# TYPE replan_rate gauge$/m);
    const counter = renderPrometheusText([ok("layover_sessions_detected", 3, "counter")]);
    assert.match(counter.text, /^# TYPE layover_sessions_detected counter$/m);
  });

  it("applies the prefix and the shared labels to every series", () => {
    const { text } = renderPrometheusText([ok("replan_rate", 0.5)], {
      prefix: "portava_layover_",
      labels: { deployment: "prod" },
    });
    assert.match(text, /^portava_layover_replan_rate\{deployment="prod"\} 0\.5$/m);
    assert.match(text, /^portava_layover_replan_rate_samples\{deployment="prod"\} 100$/m);
  });
});

describe("the wire format is respected rather than approximated", () => {
  it("escapes backslash, quote and newline in a label value", () => {
    assert.equal(escapeLabelValue('a "b" \\c\nd'), 'a \\"b\\" \\\\c\\nd');
  });

  it("escapes a blocker containing quotes — they are prose and WILL contain them", () => {
    const { text } = renderPrometheusText([blocked("m", 'the "certified" table has no writer')]);
    assert.match(text, /blocked_by="the \\"certified\\" table has no writer"/);
    // Unescaped, this would have closed the label early and produced a line
    // the scrape rejects, silently losing the metric.
    assert.equal(text.includes('blocked_by="the "certified"'), false);
  });

  it("puts HELP on one line even when the help text would wrap", () => {
    const { text } = renderPrometheusText([blocked("m", "line one\nline two")]);
    for (const line of text.split("\n")) {
      if (line.startsWith("# HELP")) assert.equal(line.includes("\n"), false);
    }
    assert.equal(text.includes("blocked_by=\"line one\\nline two\""), true);
  });

  it("SKIPS a name that is not a legal metric name rather than rewriting it", () => {
    // Rewriting `foo.bar` to `foo_bar` creates a series under a name nobody
    // searches for: a metric that exists and cannot be found.
    assert.equal(isExportableName("foo.bar"), false);
    assert.equal(isExportableName("9lives"), false);
    assert.equal(isExportableName("_ok"), true);
    assert.equal(isExportableName("a_b9"), true);
    const r = renderPrometheusText([ok("foo.bar", 1)]);
    assert.equal(r.seriesCount, 0);
    assert.equal(r.withheld[0]!.name, "foo.bar");
    assert.equal(r.text.includes("foo_bar"), false);
  });

  it("treats the prefix as part of the name when validating", () => {
    const r = renderPrometheusText([ok("replan_rate", 1)], { prefix: "9-" });
    assert.equal(r.seriesCount, 0);
  });

  it("drops an illegal LABEL key rather than emitting a broken line", () => {
    const { text } = renderPrometheusText([ok("replan_rate", 1)], { labels: { "bad-key": "x", good: "y" } });
    assert.equal(text.includes("bad-key"), false);
    assert.match(text, /\{good="y"\}/);
  });

  it("renders empty text for no metrics, and ends with a newline otherwise", () => {
    assert.equal(renderPrometheusText([]).text, "");
    assert.match(renderPrometheusText([ok("replan_rate", 1)]).text, /\n$/);
  });

  it("is pure — the same input renders identical text every time", () => {
    const a = renderPrometheusText(CENSUS_METRICS, { prefix: "p_", labels: { d: "x" } });
    const b = renderPrometheusText(CENSUS_METRICS, { prefix: "p_", labels: { d: "x" } });
    assert.equal(a.text, b.text);
  });
});

describe("sinks", () => {
  it("the log sink reports how many series it had and what was withheld", async () => {
    const r = await exportMetrics(CENSUS_METRICS, LOG_METRICS_SINK);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.delivered, 6);
  });

  it("the pushgateway sink REFUSES when unconfigured — it does not silently no-op", async () => {
    const sink = createPushgatewaySink({
      readEnv: () => undefined,
      fetchImpl: (async () => {
        assert.fail("pushed with no configured endpoint");
      }) as unknown as typeof fetch,
    });
    const r = await sink.publish(renderPrometheusText([ok("replan_rate", 1)]));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "CREDENTIAL_ABSENT");
    assert.equal(r.envVar, PUSHGATEWAY_URL_ENV);
  });

  it("distinguishes an endpoint set to an empty string", async () => {
    const sink = createPushgatewaySink({ readEnv: () => "", fetchImpl: (async () => {
      assert.fail("pushed to an empty endpoint");
    }) as unknown as typeof fetch });
    const r = await sink.publish(renderPrometheusText([ok("replan_rate", 1)]));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "CREDENTIAL_EMPTY");
  });

  it("REFUSES to push an empty body — that would DELETE the job's existing series", async () => {
    const sink = createPushgatewaySink({
      readEnv: () => "https://push.invalid",
      fetchImpl: (async () => {
        assert.fail("an empty push would clear every metric for this job");
      }) as unknown as typeof fetch,
    });
    const r = await sink.publish(renderPrometheusText([]));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "REQUEST_INCOMPLETE");
  });

  it("posts the exposition text to the job endpoint when configured", async () => {
    const seen: Array<{ url: string; body: string; ct: string }> = [];
    const sink = createPushgatewaySink({
      readEnv: () => "https://push.invalid/",
      job: "api one",
      fetchImpl: (async (url: any, init: any) => {
        seen.push({ url: String(url), body: init.body, ct: init.headers["Content-Type"] });
        return { ok: true, status: 200 } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const r = await sink.publish(renderPrometheusText([ok("replan_rate", 0.5)]));
    assert.equal(r.ok, true);
    assert.equal(seen[0]!.url, "https://push.invalid/metrics/job/api%20one", "the trailing slash is not doubled");
    assert.match(seen[0]!.body, /replan_rate 0\.5/);
    assert.match(seen[0]!.ct, /text\/plain/);
  });

  it("a failed push is a refusal, never a quiet success", async () => {
    const sink = createPushgatewaySink({
      readEnv: () => "https://push.invalid",
      fetchImpl: (async () => ({ ok: false, status: 503 }) as unknown as Response) as unknown as typeof fetch,
    });
    const r = await sink.publish(renderPrometheusText([ok("replan_rate", 1)]));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_UNAVAILABLE");
    assert.match(r.detail, /503/);
  });

  it("a thrown push is a refusal too", async () => {
    const sink = createPushgatewaySink({
      readEnv: () => "https://push.invalid",
      fetchImpl: (async () => {
        throw new TypeError("ENOTFOUND");
      }) as unknown as typeof fetch,
    });
    const r = await sink.publish(renderPrometheusText([ok("replan_rate", 1)]));
    assert.equal(r.ok, false);
  });
});
