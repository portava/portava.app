/**
 * The M254 capture harness, tested (census-map M254).
 *
 * This proves the INSTRUMENT, not the performance. No handset was available, so
 * no cold start has been measured; see docs/map/device-measurement-protocol.md
 * §M254 and plan blocker B4.
 *
 * The property that matters most here is the REFUSAL one. A perf harness that
 * reports a pass when it measured nothing is worse than no harness, because it
 * closes a row with a number nobody took. Every "not enough data" path below is
 * asserted to be a FAIL, never a pass.
 *
 * Run: npm test  (in travel-buddy-standalone)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLD_START_BUDGET_MS,
  REQUIRED_COLD_STARTS,
  coldStartMs,
  createTrace,
  formatReport,
  markFirstFullFrame,
  markNavigationCommitted,
  reportBothArms,
  reportColdStarts,
  type CacheArm,
  type ColdStartTrace,
} from '../coldStart.ts';

function run(ms: number, arm: CacheArm = 'cold'): ColdStartTrace {
  let t = createTrace(arm);
  t = markNavigationCommitted(t, 1_000_000);
  t = markFirstFullFrame(t, 1_000_000 + ms);
  return t;
}

function runs(count: number, ms: number, arm: CacheArm = 'cold'): ColdStartTrace[] {
  return Array.from({ length: count }, () => run(ms, arm));
}

describe('the two marks', () => {
  it('measures navigation commit to first fully-rendered frame', () => {
    assert.equal(coldStartMs(run(1450)), 1450);
  });

  it('keeps the FIRST full frame, not the latest one', () => {
    // onDidFinishRenderingFrameFully fires on every fully rendered frame.
    // Without idempotence the interval would grow for as long as the user pans.
    let t = createTrace('cold');
    t = markNavigationCommitted(t, 0);
    t = markFirstFullFrame(t, 1200);
    t = markFirstFullFrame(t, 9900);
    assert.equal(coldStartMs(t), 1200);
  });

  it('keeps the FIRST navigation commit', () => {
    let t = createTrace('cold');
    t = markNavigationCommitted(t, 100);
    t = markNavigationCommitted(t, 800);
    t = markFirstFullFrame(t, 1100);
    assert.equal(coldStartMs(t), 1000);
  });

  it('refuses an incomplete run rather than calling it fast', () => {
    let t = createTrace('cold');
    t = markNavigationCommitted(t, 0);
    assert.equal(coldStartMs(t), null, 'a map that never rendered is not a 0 ms map');

    let u = createTrace('cold');
    u = markFirstFullFrame(u, 500);
    assert.equal(coldStartMs(u), null);
  });

  it('refuses a clock that went backwards', () => {
    let t = createTrace('cold');
    t = markNavigationCommitted(t, 5000);
    t = markFirstFullFrame(t, 4000);
    assert.equal(coldStartMs(t), null);
  });

  it('refuses a non-finite mark', () => {
    let t = createTrace('cold');
    t = markNavigationCommitted(t, Number.NaN);
    t = markFirstFullFrame(t, 1000);
    assert.equal(coldStartMs(t), null);
  });
});

describe('the verdict, on the no-cache arm', () => {
  it('passes when the median of ten cold starts is under the budget', () => {
    const report = reportColdStarts(runs(REQUIRED_COLD_STARTS, 1450), 'cold');
    assert.equal(report.hasRequiredRuns, true);
    assert.equal(report.distribution.median, 1450);
    assert.equal(report.meetsBudget, true);
  });

  it('fails when the median is at or over the budget', () => {
    const report = reportColdStarts(runs(REQUIRED_COLD_STARTS, COLD_START_BUDGET_MS), 'cold');
    assert.equal(report.meetsBudget, false, 'the budget is "under 2 s", not "at most 2 s"');
  });

  it('is decided by the MEDIAN, not the mean — one disastrous start does not fail it', () => {
    const samples = [...runs(9, 1400), run(30_000)];
    const report = reportColdStarts(samples, 'cold');
    assert.equal(report.distribution.median, 1400);
    assert.equal(report.meetsBudget, true);
    // …but the outlier is still reported, not hidden.
    assert.equal(report.distribution.max, 30_000);
  });

  it('is not rescued by the mean either — five fast starts do not carry five slow ones', () => {
    const report = reportColdStarts([...runs(5, 400), ...runs(5, 5000)], 'cold');
    assert.equal(report.distribution.median, 400);
    assert.equal(report.meetsBudget, true);
    assert.equal(report.distribution.p95, 5000, 'the slow half is reported');
  });
});

describe('the harness refuses to report a pass it did not measure', () => {
  it('fails on an empty run set', () => {
    const report = reportColdStarts([], 'cold');
    assert.equal(report.distribution.n, 0);
    assert.equal(report.distribution.median, null);
    assert.equal(
      report.meetsBudget,
      false,
      'ANTI-VACUITY: "no start took 2 s" is trivially true of zero starts',
    );
  });

  it('fails on fewer than the required number of completed runs', () => {
    const report = reportColdStarts(runs(REQUIRED_COLD_STARTS - 1, 100), 'cold');
    assert.equal(report.hasRequiredRuns, false);
    assert.equal(report.meetsBudget, false);
  });

  it('counts incomplete runs instead of quietly shrinking the sample', () => {
    const broken = createTrace('cold');
    const report = reportColdStarts([...runs(REQUIRED_COLD_STARTS, 100), broken], 'cold');
    assert.equal(report.incomplete, 1);
    assert.equal(report.samples.length, REQUIRED_COLD_STARTS);
  });

  it('says NOT RUN rather than FAIL when the sample is short', () => {
    // The two are different findings and must not be confused: one is a slow
    // map, the other is a measurement that did not happen.
    assert.match(formatReport(reportColdStarts(runs(3, 100), 'cold')), /NOT RUN/);
    assert.match(
      formatReport(reportColdStarts(runs(REQUIRED_COLD_STARTS, 9000), 'cold')),
      /FAIL/,
    );
  });
});

describe('§33 - the two arms are reported separately', () => {
  it('never mixes cached runs into the cold sample', () => {
    const traces = [...runs(REQUIRED_COLD_STARTS, 1800, 'cold'), ...runs(4, 120, 'cached')];
    const { cold, cached } = reportBothArms(traces);
    assert.equal(cold.distribution.n, REQUIRED_COLD_STARTS);
    assert.equal(cold.distribution.median, 1800);
    assert.equal(cached.distribution.n, 4);
    assert.equal(cached.distribution.median, 120);
  });

  it('applies no budget to the cached arm', () => {
    // §33's cache arm is a different claim. Giving it the cold budget would let
    // a warm cache close a row that is about a traveller's first open in a new
    // city.
    const { cached } = reportBothArms(runs(4, 120, 'cached'));
    assert.equal(cached.meetsBudget, null);
    assert.match(formatReport(cached), /reported separately/);
  });

  it('a fast cached arm cannot rescue a slow cold arm', () => {
    const traces = [
      ...runs(REQUIRED_COLD_STARTS, 4500, 'cold'),
      ...runs(REQUIRED_COLD_STARTS, 90, 'cached'),
    ];
    const { cold } = reportBothArms(traces);
    assert.equal(cold.meetsBudget, false);
  });
});
