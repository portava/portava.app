/**
 * §33 "Pan responsiveness ~60 fps" — the capture half (census-map M255), and
 * the frame-cost half of §34 (census-map M258).
 *
 * ## What this is
 *
 * A parser and a verdict function for Android's
 * `adb shell dumpsys gfxinfo <pkg> framestats`. It is the half of M255 that can
 * exist without a handset; the handset is still required to PRODUCE the input,
 * and nothing here may be quoted as a measurement. See
 * `docs/map/device-measurement-protocol.md` §M255.
 *
 * ## The format, and the three things that are easy to get wrong
 *
 * `framestats` prints a CSV block between two `---PROFILEDATA---` markers: a
 * header naming the columns, then one row of nanosecond timestamps per frame.
 *
 * 1. COLUMNS ARE READ BY NAME, NEVER BY INDEX. The column set has changed
 *    across API levels (`GpuCompleted` arrived in API 28; `DequeueBufferDuration`
 *    and `QueueBufferDuration` are absent on some OEM builds). An index-based
 *    parser silently reads the wrong column and reports a plausible wrong
 *    number, which is worse than failing.
 *
 * 2. THE FRAME TIME IS `FrameCompleted - IntendedVsync`, not
 *    `FrameCompleted - Vsync`. `IntendedVsync` is when the frame SHOULD have
 *    started; `Vsync` is when it did. Measuring from `Vsync` hides exactly the
 *    jank the 16.7 ms budget is about — a frame that started 30 ms late and then
 *    rendered in 8 ms is a dropped frame, and measuring from `Vsync` scores it
 *    as 8 ms.
 *
 * 3. ROWS WITH A NON-ZERO `Flags` ARE EXCLUDED. Android sets a flag on frames
 *    that are not comparable — the first frame after a window layout, and
 *    frames where `FrameCompleted` is missing (printed as a large sentinel).
 *    Google's own `systrace`/`JankStats` guidance drops them, and including
 *    them puts a 300 ms first-draw in a p99 that is supposed to describe
 *    steady-state panning.
 *
 * ## The 120-frame buffer, which is why `mergeFrameStats` exists
 *
 * `framestats` reports only the most recent ~120 frames. M255's scripted pan is
 * THREE SECONDS, which at 60 fps is ~180 frames — more than the buffer holds.
 * A single read taken after the pan therefore misses the first third of it,
 * including the beginning of the gesture, where the jank usually is. The
 * protocol reads repeatedly DURING the pan and merges; `mergeFrameStats`
 * deduplicates by `IntendedVsync`, which is unique per frame.
 */
import { describe as describeSamples, percentile, type Distribution } from './statistics.ts';

/** 60 fps. The census states the budget as this exact number. */
export const FRAME_BUDGET_MS = 16.7;

/** The percentile the census names for the budget. */
export const FRAME_PERCENTILE = 0.99;

/**
 * The fewest usable frames a p99 may be reported from.
 *
 * At 100 frames the nearest-rank p99 is the single worst frame, which is
 * already a weak estimate; below it the statistic stops meaning anything and a
 * short capture would quietly produce a pass. M255's 3-second pan yields ~180,
 * so this floor is only ever hit by a capture that went wrong.
 */
export const MIN_FRAMES_FOR_P99 = 100;

const PROFILEDATA_MARKER = '---PROFILEDATA---';
const NS_PER_MS = 1e6;

export interface FrameRow {
  /** Raw column values, keyed by the header's own names. */
  columns: Readonly<Record<string, number>>;
  /** Unique per frame — the dedup key when merging several reads. */
  intendedVsync: number;
  /** `FrameCompleted - IntendedVsync`, in milliseconds. */
  totalMs: number;
  flags: number;
}

export interface ParsedFrameStats {
  /** Every well-formed row, including flagged ones. */
  rows: FrameRow[];
  /** Rows Android flagged as not comparable. */
  excludedFlagged: number;
  /** Lines that did not parse — a malformed capture is reported, not ignored. */
  malformed: number;
  /** The column names the device actually printed. */
  header: string[];
}

const EMPTY: ParsedFrameStats = { rows: [], excludedFlagged: 0, malformed: 0, header: [] };

/**
 * Parse one `dumpsys gfxinfo <pkg> framestats` capture.
 *
 * Returns an empty result — never throws — for output that carries no
 * PROFILEDATA block at all, which is what a wrong package name, a
 * profiling-disabled build or an `adb` error produces. The caller checks
 * `rows.length`; a silent exception would be indistinguishable from a fast app.
 */
export function parseFrameStats(output: string): ParsedFrameStats {
  if (typeof output !== 'string' || !output.includes(PROFILEDATA_MARKER)) return { ...EMPTY };

  const blocks: string[] = [];
  const parts = output.split(PROFILEDATA_MARKER);
  // Blocks are the ODD-indexed parts: text, [block], text, [block], text…
  for (let i = 1; i < parts.length; i += 2) blocks.push(parts[i]);

  const rows: FrameRow[] = [];
  let excludedFlagged = 0;
  let malformed = 0;
  let header: string[] = [];

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    const names = lines[0].split(',').map((s) => s.trim());
    // A header is the line naming the columns; every device prints these two.
    if (!names.includes('Flags') || !names.includes('IntendedVsync')) {
      malformed += lines.length;
      continue;
    }
    header = names;

    for (const line of lines.slice(1)) {
      const cells = line.split(',').map((s) => s.trim());
      if (cells.length !== names.length) {
        malformed += 1;
        continue;
      }
      const columns: Record<string, number> = {};
      let bad = false;
      for (let i = 0; i < names.length; i += 1) {
        const v = Number(cells[i]);
        if (!Number.isFinite(v)) {
          bad = true;
          break;
        }
        columns[names[i]] = v;
      }
      if (bad) {
        malformed += 1;
        continue;
      }

      const flags = columns.Flags;
      const intendedVsync = columns.IntendedVsync;
      const frameCompleted = columns.FrameCompleted;
      if (!Number.isFinite(frameCompleted) || frameCompleted <= intendedVsync) {
        // A frame that "completed" before it was intended to start did not
        // complete; Android prints a sentinel for it.
        malformed += 1;
        continue;
      }
      if (flags !== 0) {
        excludedFlagged += 1;
        continue;
      }
      rows.push({
        columns,
        intendedVsync,
        flags,
        totalMs: (frameCompleted - intendedVsync) / NS_PER_MS,
      });
    }
  }

  return { rows, excludedFlagged, malformed, header };
}

/**
 * Merge several captures taken during one pan, deduplicating by
 * `IntendedVsync`.
 *
 * Reads overlap by design — the protocol samples faster than the buffer turns
 * over so that no frame is lost between reads — so without the dedup the same
 * frame would be counted two or three times and a single bad frame would
 * dominate the tail.
 */
export function mergeFrameStats(captures: readonly ParsedFrameStats[]): ParsedFrameStats {
  const byVsync = new Map<number, FrameRow>();
  let excludedFlagged = 0;
  let malformed = 0;
  let header: string[] = [];
  for (const c of captures) {
    for (const r of c.rows) if (!byVsync.has(r.intendedVsync)) byVsync.set(r.intendedVsync, r);
    excludedFlagged += c.excludedFlagged;
    malformed += c.malformed;
    if (c.header.length > header.length) header = c.header;
  }
  const rows = [...byVsync.values()].sort((a, b) => a.intendedVsync - b.intendedVsync);
  return { rows, excludedFlagged, malformed, header };
}

export interface PanReport {
  frames: number;
  excludedFlagged: number;
  malformed: number;
  distribution: Distribution;
  p99Ms: number | null;
  budgetMs: number;
  /** Frames that exceeded the budget — the human-readable form of the tail. */
  overBudget: number;
  hasEnoughFrames: boolean;
  /**
   * The verdict. `false`, never `true`, when the capture is too short: a
   * harness that measured nothing must not report a pass. This is §42.7's
   * mutation B5 applied to a frame trace.
   */
  meetsBudget: boolean;
}

export function reportPan(stats: ParsedFrameStats): PanReport {
  const samples = stats.rows.map((r) => r.totalMs);
  const distribution = describeSamples(samples);
  const p99Ms = percentile(samples, FRAME_PERCENTILE);
  const hasEnoughFrames = samples.length >= MIN_FRAMES_FOR_P99;
  return {
    frames: samples.length,
    excludedFlagged: stats.excludedFlagged,
    malformed: stats.malformed,
    distribution,
    p99Ms,
    budgetMs: FRAME_BUDGET_MS,
    overBudget: samples.filter((v) => v > FRAME_BUDGET_MS).length,
    hasEnoughFrames,
    meetsBudget: hasEnoughFrames && p99Ms != null && p99Ms <= FRAME_BUDGET_MS,
  };
}

/** A one-line ledger entry for `docs/map/device-measurement-protocol.md`. */
export function formatPanReport(report: PanReport): string {
  const num = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)} ms`);
  const verdict = !report.hasEnoughFrames
    ? `NOT RUN (${report.frames}/${MIN_FRAMES_FOR_P99} usable frames)`
    : report.meetsBudget
      ? `PASS (p99 <= ${FRAME_BUDGET_MS} ms)`
      : `FAIL (p99 > ${FRAME_BUDGET_MS} ms)`;
  const d = report.distribution;
  return (
    `frames=${report.frames} flagged=${report.excludedFlagged} malformed=${report.malformed} ` +
    `median=${num(d.median)} p95=${num(d.p95)} p99=${num(report.p99Ms)} max=${num(d.max)} ` +
    `over-budget=${report.overBudget} — ${verdict}`
  );
}
