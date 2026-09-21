/**
 * The M255 / M258 frame-capture harness, tested (census-map M255, M258).
 *
 * This proves the PARSER and the VERDICT function against recorded
 * `dumpsys gfxinfo … framestats` output. It does not prove anything about pan
 * responsiveness: no handset was available (plan blocker B4), so no pan has
 * been measured. See docs/map/device-measurement-protocol.md §M255.
 *
 * The fixtures below are the real format — header names and nanosecond
 * timestamps — written by hand, not captured from a device. What they prove is
 * that a real capture would be READ correctly, which is the half that can be
 * got wrong silently.
 *
 * Run: npm test  (in travel-buddy-standalone)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAME_BUDGET_MS,
  MIN_FRAMES_FOR_P99,
  formatPanReport,
  mergeFrameStats,
  parseFrameStats,
  reportPan,
} from '../frameStats.ts';

const HEADER =
  'Flags,IntendedVsync,Vsync,OldestInputEvent,NewestInputEvent,HandleInputStart,' +
  'AnimationStart,PerformTraversalsStart,DrawStart,SyncQueued,SyncStart,' +
  'IssueDrawCommandsStart,SwapBuffers,FrameCompleted';

const NS = 1e6; // ns per ms

/** One CSV row: `flags`, a vsync in ns, and a total frame time in ms. */
function row(flags: number, vsyncNs: number, totalMs: number): string {
  const completed = vsyncNs + totalMs * NS;
  const mid = vsyncNs + (totalMs * NS) / 2;
  return [
    flags,
    vsyncNs,
    vsyncNs,
    0,
    0,
    vsyncNs,
    vsyncNs,
    vsyncNs,
    mid,
    mid,
    mid,
    mid,
    mid,
    completed,
  ].join(',');
}

/**
 * A frame that STARTED LATE: intended at `vsyncNs`, actually begun `lateMs`
 * later, then rendered in `renderMs`.
 *
 * Added after mutation H2 survived. Every other fixture here sets
 * `Vsync === IntendedVsync`, so measuring from the wrong column produced the
 * same answer and the distinction could be deleted with the suite still green.
 * That distinction is the entire point of the column choice: a frame that began
 * 30 ms late and then rendered in 8 ms is a dropped frame the user saw, and
 * measuring from `Vsync` scores it as a comfortable 8 ms.
 */
function lateRow(flags: number, vsyncNs: number, lateMs: number, renderMs: number): string {
  const started = vsyncNs + lateMs * NS;
  const completed = started + renderMs * NS;
  const mid = started + (renderMs * NS) / 2;
  return [
    flags, vsyncNs, started, 0, 0, started, started, started,
    mid, mid, mid, mid, mid, completed,
  ].join(',');
}

function capture(rows: string[]): string {
  return [
    'Applications Graphics Acceleration Info:',
    'Uptime: 123456 Realtime: 123456',
    '---PROFILEDATA---',
    HEADER,
    ...rows,
    '---PROFILEDATA---',
    '',
  ].join('\n');
}

/** `n` frames starting at `startVsync`, each `totalMs` long, 60 fps apart. */
function steadyFrames(n: number, totalMs: number, startVsync = 1e12): string[] {
  return Array.from({ length: n }, (_, i) => row(0, startVsync + i * 16.6 * NS, totalMs));
}

describe('parsing a framestats capture', () => {
  it('reads the frame time as FrameCompleted - IntendedVsync', () => {
    const parsed = parseFrameStats(capture([row(0, 1e12, 12.5)]));
    assert.equal(parsed.rows.length, 1);
    assert.ok(Math.abs(parsed.rows[0].totalMs - 12.5) < 1e-6);
  });

  it('counts the time a frame spent waiting to start, not just its render time', () => {
    // Intended at T, began 30 ms late, rendered in 8 ms. The user saw a frame
    // 38 ms after the one before it — nearly three dropped frames. Measuring
    // from `Vsync` would report 8 ms and call this a comfortable pan.
    const parsed = parseFrameStats(capture([lateRow(0, 1e12, 30, 8)]));
    assert.equal(parsed.rows.length, 1);
    assert.ok(
      Math.abs(parsed.rows[0].totalMs - 38) < 1e-6,
      `expected 38 ms (IntendedVsync -> FrameCompleted), got ${parsed.rows[0].totalMs}`,
    );
  });

  it('fails a pan whose frames render fast but all start late', () => {
    // The whole-harness form of the assertion above: 180 frames that each
    // render in 6 ms but begin 25 ms late is a visibly stuttering pan, and a
    // harness reading `Vsync` would pass it with a 6 ms p99.
    const frames = Array.from({ length: 180 }, (_, i) =>
      lateRow(0, 1e12 + i * 16.6 * NS, 25, 6),
    );
    const report = reportPan(parseFrameStats(capture(frames)));
    assert.equal(report.frames, 180);
    assert.equal(report.meetsBudget, false);
    assert.equal(report.overBudget, 180);
  });

  it('reads columns BY NAME, so a device with a different column set still parses', () => {
    // GpuCompleted arrived in API 28; some OEM builds omit the buffer-duration
    // columns. An index-based parser reads the wrong column and reports a
    // plausible wrong number, which is worse than failing.
    const shortHeader = 'Flags,IntendedVsync,Vsync,FrameCompleted';
    const out = [
      '---PROFILEDATA---',
      shortHeader,
      `0,${1e12},${1e12},${1e12 + 9 * NS}`,
      '---PROFILEDATA---',
    ].join('\n');
    const parsed = parseFrameStats(out);
    assert.equal(parsed.rows.length, 1);
    assert.ok(Math.abs(parsed.rows[0].totalMs - 9) < 1e-6);
  });

  it('excludes rows Android flagged as not comparable', () => {
    const parsed = parseFrameStats(
      capture([row(1, 1e12, 300), row(0, 1e12 + 16 * NS, 11), row(0, 1e12 + 32 * NS, 12)]),
    );
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.excludedFlagged, 1);
    // The 300 ms first-draw would otherwise BE the p99 of a 180-frame pan.
    assert.ok(parsed.rows.every((r) => r.totalMs < 20));
  });

  it('reports malformed rows rather than silently dropping them', () => {
    const out = capture([row(0, 1e12, 11), '0,not-a-number,1,2', '0,1']);
    const parsed = parseFrameStats(out);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.malformed, 2);
  });

  it('rejects a frame that completed before it was intended to start', () => {
    const out = ['---PROFILEDATA---', 'Flags,IntendedVsync,Vsync,FrameCompleted',
      `0,${1e12},${1e12},${1e12 - 5 * NS}`, '---PROFILEDATA---'].join('\n');
    const parsed = parseFrameStats(out);
    assert.equal(parsed.rows.length, 0);
    assert.equal(parsed.malformed, 1);
  });

  it('returns an empty capture for output with no PROFILEDATA block', () => {
    // A wrong package name, a profiling-disabled build or an adb error all land
    // here. It must not throw: an exception is indistinguishable from a fast
    // app once someone wraps the call in a try/catch.
    for (const bad of ['', 'error: device not found', 'Applications Graphics Acceleration Info:']) {
      const parsed = parseFrameStats(bad);
      assert.equal(parsed.rows.length, 0);
    }
    assert.equal(parseFrameStats(undefined as never).rows.length, 0);
  });
});

describe('merging the reads taken during one pan', () => {
  it('deduplicates by IntendedVsync, because the reads deliberately overlap', () => {
    // framestats holds ~120 frames and the pan is ~180, so the protocol reads
    // faster than the buffer turns over. Without the dedup the overlap is
    // counted twice and one bad frame dominates the tail.
    const a = parseFrameStats(capture(steadyFrames(80, 10)));
    const b = parseFrameStats(capture(steadyFrames(80, 10).slice(40)));
    const merged = mergeFrameStats([a, b]);
    assert.equal(merged.rows.length, 80);
  });

  it('keeps frames the other read did not have', () => {
    const a = parseFrameStats(capture(steadyFrames(60, 10, 1e12)));
    const b = parseFrameStats(capture(steadyFrames(60, 10, 1e12 + 60 * 16.6 * NS)));
    assert.equal(mergeFrameStats([a, b]).rows.length, 120);
  });

  it('returns them in vsync order', () => {
    const later = parseFrameStats(capture(steadyFrames(10, 10, 1e12 + 1e9)));
    const earlier = parseFrameStats(capture(steadyFrames(10, 10, 1e12)));
    const merged = mergeFrameStats([later, earlier]);
    for (let i = 1; i < merged.rows.length; i += 1) {
      assert.ok(merged.rows[i].intendedVsync > merged.rows[i - 1].intendedVsync);
    }
  });
});

describe('the p99 verdict', () => {
  it('passes a pan whose worst frames are inside the budget', () => {
    const report = reportPan(parseFrameStats(capture(steadyFrames(180, 11))));
    assert.equal(report.frames, 180);
    assert.ok(report.p99Ms != null && report.p99Ms <= FRAME_BUDGET_MS);
    assert.equal(report.meetsBudget, true);
  });

  it('fails a pan with a janky tail, even though the median is fine', () => {
    // This is the whole point of a p99: 178 good frames and 2 dropped ones is
    // a visible stutter, and a median would call it a 10 ms pan.
    const frames = [...steadyFrames(178, 10), row(0, 2e12, 48), row(0, 2e12 + 1e9, 52)];
    const report = reportPan(parseFrameStats(capture(frames)));
    assert.ok(report.distribution.median != null && report.distribution.median <= FRAME_BUDGET_MS);
    assert.equal(report.meetsBudget, false);
    assert.equal(report.overBudget, 2);
  });

  it('fails on an empty capture', () => {
    const report = reportPan(parseFrameStats(''));
    assert.equal(report.frames, 0);
    assert.equal(report.p99Ms, null);
    assert.equal(
      report.meetsBudget,
      false,
      'ANTI-VACUITY: "no frame exceeded 16.7 ms" is trivially true of zero frames',
    );
  });

  it('fails a capture too short to carry a p99', () => {
    const report = reportPan(parseFrameStats(capture(steadyFrames(MIN_FRAMES_FOR_P99 - 1, 8))));
    assert.equal(report.hasEnoughFrames, false);
    assert.equal(report.meetsBudget, false);
    assert.match(formatPanReport(report), /NOT RUN/);
  });

  it('distinguishes NOT RUN from FAIL in the ledger line', () => {
    const janky = [...steadyFrames(178, 10), row(0, 2e12, 48), row(0, 2e12 + 1e9, 52)];
    assert.match(formatPanReport(reportPan(parseFrameStats(capture(janky)))), /FAIL/);
    assert.match(formatPanReport(reportPan(parseFrameStats(capture(steadyFrames(180, 10))))), /PASS/);
  });

  it('uses nearest-rank, so every reported number is a frame that happened', () => {
    const frames = [...steadyFrames(99, 10), row(0, 2e12, 40)];
    const report = reportPan(parseFrameStats(capture(frames)));
    // 100 frames, p99 -> rank ceil(0.99 * 100) = 99 -> the 99th sorted value.
    assert.ok(report.p99Ms != null);
    assert.ok(
      report.p99Ms === 10 || report.p99Ms === 40,
      'the p99 must be an observed frame time, never interpolated between two',
    );
  });
});
