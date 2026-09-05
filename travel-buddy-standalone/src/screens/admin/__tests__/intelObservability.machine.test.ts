import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyObservabilityLoadResult,
  densityGateSummary,
  formatMetricValue,
  metricShareLabel,
  NOT_INSTRUMENTED_LABEL,
  sectionOf,
  statusLabel,
  uninstrumentedCount,
  type ObservabilityMetric,
} from '../intelObservability.machine.ts';

/**
 * The property these tests protect: a figure the server did not measure reaches
 * the screen as the words "Not instrumented", never as a zero — including when
 * the payload itself is wrong about it.
 */

function metric(over: Partial<ObservabilityMetric> = {}): ObservabilityMetric {
  return {
    key: 'm', label: 'Metric', status: 'MEASURED', value: 3,
    denominator: null, unit: 'count', note: null, ...over,
  };
}

const payload = {
  schemaVersion: 1,
  generatedAt: '2026-09-05T12:00:00.000Z',
  windowDays: 7,
  sections: [
    {
      key: 'truth_health',
      title: 'Truth health',
      requiredMetrics: 'Fresh claim coverage, conflict rate, expiry latency, source diversity, correction propagation',
      metrics: [
        { key: 'servableLiveSnapshots', label: 'Fresh claim coverage', status: 'MEASURED', value: 2, denominator: 5, unit: 'count', note: null },
        { key: 'expiryLatencySeconds', label: 'Expiry latency', status: 'UNINSTRUMENTED', value: null, denominator: null, unit: 'count', note: 'No serve-time log.' },
      ],
      distributions: [
        { key: 'claimStatus', label: 'Claims by status', status: 'MEASURED', buckets: [{ key: 'active', count: 4 }, { key: 'expired', count: 1 }], unknownValues: [], note: null },
        { key: 'accuracyByCity', label: 'Accuracy by city', status: 'UNINSTRUMENTED', buckets: null, unknownValues: [], note: 'No accuracy figure exists.' },
      ],
    },
  ],
  densityGate: { met: false, certifiable: false, failures: ['weekly_observations'], uninstrumented: ['crowdCalibrationAccuracy'], upperBound: ['activeReliableContributorsCitywide'] },
};

// ── Load ─────────────────────────────────────────────────────────────────────

test('applyObservabilityLoadResult: a failed fetch surfaces the error, not an empty dashboard', () => {
  const r = applyObservabilityLoadResult({ ok: false, error: 'HTTP 500' });
  assert.equal(r.report, null);
  assert.equal(r.error, 'HTTP 500');
});

test('applyObservabilityLoadResult: a failed fetch without a message gets a fallback', () => {
  const r = applyObservabilityLoadResult({ ok: false });
  assert.equal(r.report, null);
  assert.equal(r.error, 'Failed to load intel observability');
});

test('applyObservabilityLoadResult: a shape without sections is an error, never a blank render', () => {
  for (const data of [undefined, null, {}, { sections: 'nope' }, 42]) {
    const r = applyObservabilityLoadResult({ ok: true, data });
    assert.equal(r.report, null);
    assert.equal(r.error, 'Unexpected response from server');
  }
});

test('applyObservabilityLoadResult: an unparseable SECTION fails the whole load rather than dropping it silently', () => {
  const r = applyObservabilityLoadResult({
    ok: true,
    data: { ...payload, sections: [payload.sections[0], { key: 'not_a_section', metrics: [], distributions: [] }] },
  });
  assert.equal(r.report, null);
  assert.equal(r.error, 'Unexpected response from server');
});

test('applyObservabilityLoadResult: parses a well-formed report', () => {
  const r = applyObservabilityLoadResult({ ok: true, data: payload });
  assert.equal(r.error, null);
  assert.ok(r.report);
  assert.equal(r.report.windowDays, 7);
  assert.equal(r.report.sections.length, 1);
  assert.equal(r.report.densityGate.certifiable, false);
});

test('applyObservabilityLoadResult: NULLS a value the server wrongly attached to an uninstrumented metric', () => {
  const bad = {
    ...payload,
    sections: [{
      ...payload.sections[0],
      metrics: [{ key: 'fraudSignals', label: 'Fraud', status: 'UNINSTRUMENTED', value: 0, denominator: 12, unit: 'count', note: 'No ledger.' }],
      distributions: [{ key: 'accuracyByZone', label: 'Accuracy by zone', status: 'UNINSTRUMENTED', buckets: [{ key: 'z1', count: 0 }], unknownValues: [], note: 'n/a' }],
    }],
  };
  const r = applyObservabilityLoadResult({ ok: true, data: bad });
  assert.ok(r.report);
  const m = r.report.sections[0].metrics[0];
  assert.equal(m.value, null, 'a zero must not survive onto an uninstrumented metric');
  assert.equal(m.denominator, null);
  assert.equal(formatMetricValue(m), NOT_INSTRUMENTED_LABEL);
  assert.equal(r.report.sections[0].distributions[0].buckets, null);
});

test('applyObservabilityLoadResult: a non-true certifiable is treated as NOT certifiable', () => {
  for (const certifiable of [undefined, null, 'true', 1]) {
    const r = applyObservabilityLoadResult({ ok: true, data: { ...payload, densityGate: { ...payload.densityGate, certifiable } } });
    assert.ok(r.report);
    assert.equal(r.report.densityGate.certifiable, false);
  }
});

// ── Formatting ───────────────────────────────────────────────────────────────

test('formatMetricValue: an uninstrumented metric renders as words, never as 0', () => {
  const out = formatMetricValue(metric({ status: 'UNINSTRUMENTED', value: null }));
  assert.equal(out, NOT_INSTRUMENTED_LABEL);
  assert.ok(!/\d/.test(out), 'no digit may appear');
});

test('formatMetricValue: a measured zero DOES render as 0 — that is a real measurement', () => {
  assert.equal(formatMetricValue(metric({ value: 0 })), '0');
  assert.equal(formatMetricValue(metric({ value: 0, denominator: 0 })), '0 of 0');
});

test('formatMetricValue: counts, shares and ratios', () => {
  assert.equal(formatMetricValue(metric({ value: 3 })), '3');
  assert.equal(formatMetricValue(metric({ value: 3, denominator: 10 })), '3 of 10');
  assert.equal(formatMetricValue(metric({ value: 0.4231, unit: 'ratio' })), '42.3%');
  assert.equal(formatMetricValue(metric({ value: 1.5 })), '1.5');
});

test('formatMetricValue: a missing value falls back to the words, never to 0', () => {
  assert.equal(formatMetricValue(metric({ status: 'MEASURED', value: null })), NOT_INSTRUMENTED_LABEL);
});

test('metricShareLabel: 0 of 0 says so instead of inventing 0% or 100%', () => {
  assert.equal(metricShareLabel(metric({ value: 0, denominator: 0 })), 'no rows in window');
  assert.equal(metricShareLabel(metric({ value: 3, denominator: 4 })), '75.0%');
  assert.equal(metricShareLabel(metric({ value: 3 })), null);
  assert.equal(metricShareLabel(metric({ status: 'UNINSTRUMENTED', value: null })), null);
});

test('statusLabel: an upper bound is never presented as a measurement', () => {
  assert.equal(statusLabel('MEASURED'), 'Measured');
  assert.equal(statusLabel('UPPER_BOUND'), 'Upper bound');
  assert.equal(statusLabel('UNINSTRUMENTED'), NOT_INSTRUMENTED_LABEL);
});

// ── Section + gate helpers ───────────────────────────────────────────────────

test('sectionOf: finds the requested section and returns null for an absent one', () => {
  const { report } = applyObservabilityLoadResult({ ok: true, data: payload });
  assert.ok(report);
  assert.equal(sectionOf(report, 'truth_health')?.key, 'truth_health');
  assert.equal(sectionOf(report, 'economy'), null);
  assert.equal(sectionOf(null, 'truth_health'), null);
});

test('uninstrumentedCount: counts metrics AND distributions that have no measurement', () => {
  const { report } = applyObservabilityLoadResult({ ok: true, data: payload });
  assert.ok(report);
  assert.equal(uninstrumentedCount(sectionOf(report, 'truth_health')), 2);
  assert.equal(uninstrumentedCount(null), 0);
});

test('densityGateSummary: "met" is never reported as a green light while inputs are unproven', () => {
  const base = { met: false, certifiable: false, failures: ['weekly_observations'], uninstrumented: [], upperBound: [] };
  assert.match(densityGateSummary(base), /not met — 1 threshold outstanding/);
  assert.match(
    densityGateSummary({ ...base, met: true, failures: [], uninstrumented: ['a'], upperBound: ['b'] }),
    /thresholds met but NOT certifiable — 2 input\(s\)/,
  );
  assert.equal(densityGateSummary({ ...base, met: true, certifiable: true, failures: [] }), 'Density gate: certifiable');
});
