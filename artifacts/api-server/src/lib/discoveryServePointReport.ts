/**
 * discoveryServePointReport — the tally behind report:discovery-serve-points.
 *
 * WHY THIS IS A MODULE AND NOT A LOOP INSIDE THE SCRIPT
 * ====================================================
 * The defect this file exists to remove:
 *
 * `reportDiscoveryServePoints.ts` bounded `features.servePoint` to 1..6 and
 * bucketed everything else as *"row(s) carry no servePoint marker — these
 * predate Stage 0"*. Stage 0b then added FEED=7, SEARCH=8 and SUGGEST=9
 * (`discoveryServeLog.ts`, ruling D4=C) and nothing told the reader.
 *
 * The consequence is not a cosmetic mislabel. Run read-only against production
 * on 2026-08-15 over a window holding five real `surface='discovery'` rows, all
 * at serve point 9, the script printed:
 *
 *     ── 1. rows by serve point ──
 *       (no marked rows in this window)
 *       5 row(s) carry no servePoint marker — these predate Stage 0.
 *     ── VERDICT: NOT ESTABLISHED ──
 *       Zero marked rows. This means the instrumentation was not enabled
 *       during this window — NOT that no serves occurred.
 *
 * Every clause of that is false. The rows were marked, they postdate Stage 0b,
 * and the flag was demonstrably on — those rows exist only because it was.
 *
 * **The instrument turned present evidence into "we were not observing".** That
 * is the governing invariant of this workstream — *absence of evidence must
 * never silently become evidence of absence* — violated inside the ruler rather
 * than in the thing being measured, and it is the worst place for it: a broken
 * ruler does not get to declare a surface broken, and this ruler renders the
 * Phase B verdict.
 *
 * So the tally lives here, as a pure function over rows, where it can be tested
 * against inputs whose right answer is known. The script keeps only I/O.
 *
 * THE TWO RULES THAT KEEP IT FROM DRIFTING AGAIN
 * =============================================
 * 1. The labels are keyed off `DiscoveryServePoint` itself, and
 *    `assertLabelsCoverEnum()` fails if a member has no label. Adding serve
 *    point 10 without touching this file is a loud error, not a silent
 *    misreport. The old map was a hand-written 1..6 literal that could not
 *    notice the enum growing past it — which is exactly what happened.
 *
 * 2. "No marker" and "a marker I do not recognise" are DIFFERENT FINDINGS and
 *    are counted separately. The first is a pre-Stage-0 row. The second is a
 *    defect in this reader, and the reader must say so rather than quietly
 *    folding it into the first — folding them is how the original bug reported
 *    Stage 0b rows as pre-Stage-0 ones.
 */

import { DiscoveryServePoint } from "./discoveryServeLog.js";

/** Human label per serve point. Keyed off the enum so it cannot silently drift. */
export const SERVE_POINT_LABEL: Readonly<Record<number, string>> = {
  [DiscoveryServePoint.CACHE_A_L1]:             "Cache A — L1 hit",
  [DiscoveryServePoint.CACHE_A_L2_FRESH]:       "Cache A — L2 fresh",
  [DiscoveryServePoint.CACHE_A_L2_STALE]:       "Cache A — L2 stale (SWR)",
  [DiscoveryServePoint.CACHE_B_HIT]:            "Cache B hit (Compass replay)",
  [DiscoveryServePoint.COMPASS_FRESH_RANK]:     "Compass fresh rank",
  [DiscoveryServePoint.COLD_FETCH_LEGACY_RANK]: "Cold fetch — legacy rank",
  [DiscoveryServePoint.FEED]:                   "Feed (GET /discovery/feed)",
  [DiscoveryServePoint.SEARCH]:                 "Search (GET /discovery/search)",
  [DiscoveryServePoint.SUGGEST]:                "Suggest (GET /discovery/suggest)",
};

/** Every serve point the writer can emit, ascending. */
export const ALL_SERVE_POINTS: readonly number[] = Object.values(DiscoveryServePoint)
  .map(Number)
  .sort((a, b) => a - b);

/**
 * THE `GET /discovery` POPULATION — serve points 1-6, and only those.
 *
 * This distinction is load-bearing and is the reason widening the report did
 * NOT widen the D5 arithmetic. The D5 revisit clause asks what fraction of
 * discovery serves reached a ranker, and the packet's claim it tests is about
 * `GET /discovery` specifically: cache A's 2-hour TTL starving the ranker.
 *
 * Serve points 7-9 are feed, search and suggest. They contain no ranker call at
 * all — not "a ranker that rarely runs", none — so a row from them is not a
 * serve that could have been ranked and lost. Counting them in the denominator
 * would push the ranked share DOWN with rows that were never candidates, and
 * make the "cache A absorbs the traffic" conclusion look better supported the
 * more search traffic the app gets.
 *
 * That would be a second measurement error introduced while fixing the first,
 * and a self-confirming one. The two populations are reported side by side and
 * never summed into one ratio.
 */
export const DISCOVERY_ENDPOINT_POINTS: ReadonlySet<number> = new Set([
  DiscoveryServePoint.CACHE_A_L1,
  DiscoveryServePoint.CACHE_A_L2_FRESH,
  DiscoveryServePoint.CACHE_A_L2_STALE,
  DiscoveryServePoint.CACHE_B_HIT,
  DiscoveryServePoint.COMPASS_FRESH_RANK,
  DiscoveryServePoint.COLD_FETCH_LEGACY_RANK,
]);

/** Serve points on which a ranker ran during the request itself. */
export const RANKED_POINTS: ReadonlySet<number> = new Set([
  DiscoveryServePoint.COMPASS_FRESH_RANK,
  DiscoveryServePoint.COLD_FETCH_LEGACY_RANK,
]);

/** Serve points served out of cache A specifically. */
export const CACHE_A_POINTS: ReadonlySet<number> = new Set([
  DiscoveryServePoint.CACHE_A_L1,
  DiscoveryServePoint.CACHE_A_L2_FRESH,
  DiscoveryServePoint.CACHE_A_L2_STALE,
]);

/** Minimal shape this module needs from a `rank_events` row. */
export interface ServeRow {
  features?: { servePoint?: unknown; engineMode?: unknown; modeReason?: unknown } | null;
  session_id?: string | null;
  served_at?: string | null;
}

export interface ServePointTally {
  /** Rows examined. */
  total: number;
  /** Rows carrying a servePoint this build recognises. */
  marked: number;
  /** servePoint → row count. Only recognised points appear. */
  byPoint: Map<number, number>;
  /** servePoint → distinct session ids. */
  sessionsByPoint: Map<number, Set<string>>;
  /**
   * Rows with NO `servePoint` key at all. These genuinely predate Stage 0 —
   * nothing wrote the key then.
   */
  noMarker: number;
  /**
   * Rows carrying a servePoint value this build does not recognise, and the
   * distinct values seen.
   *
   * THIS IS A DEFECT IN THE READER, NOT A FACT ABOUT THE DATA. A writer emitting
   * a serve point this build has never heard of means the report is stale, and
   * it must be surfaced, never folded into `noMarker`. Folding them is the
   * original bug.
   */
  unknownMarker: number;
  unknownValues: Set<string>;
}

/**
 * Fail loudly if the enum has grown past the label map.
 *
 * Called at module load by the report script. A missing label would otherwise
 * degrade to `undefined` in the output — readable enough to ignore, which is how
 * the last drift survived.
 */
export function assertLabelsCoverEnum(): void {
  const missing = ALL_SERVE_POINTS.filter((sp) => !SERVE_POINT_LABEL[sp]);
  if (missing.length > 0) {
    throw new Error(
      `discoveryServePointReport: DiscoveryServePoint has member(s) ${missing.join(", ")} ` +
        `with no label. Add them to SERVE_POINT_LABEL, and decide whether each belongs ` +
        `in DISCOVERY_ENDPOINT_POINTS / RANKED_POINTS before quoting any number.`,
    );
  }
}

/** Tally rows by serve point, keeping the three "not counted" reasons distinct. */
export function tallyServePoints(rows: readonly ServeRow[]): ServePointTally {
  const byPoint = new Map<number, number>();
  const sessionsByPoint = new Map<number, Set<string>>();
  const unknownValues = new Set<string>();
  let noMarker = 0;
  let unknownMarker = 0;

  const known = new Set(ALL_SERVE_POINTS);

  for (const r of rows) {
    const raw = r?.features?.servePoint;

    // Absent key ⇒ written before Stage 0 existed.
    if (raw === undefined || raw === null) {
      noMarker += 1;
      continue;
    }

    const sp = Number(raw);
    if (!Number.isFinite(sp) || !known.has(sp)) {
      unknownMarker += 1;
      unknownValues.add(String(raw));
      continue;
    }

    byPoint.set(sp, (byPoint.get(sp) ?? 0) + 1);
    if (r.session_id) {
      if (!sessionsByPoint.has(sp)) sessionsByPoint.set(sp, new Set());
      sessionsByPoint.get(sp)!.add(r.session_id);
    }
  }

  const marked = [...byPoint.values()].reduce((a, b) => a + b, 0);
  return {
    total: rows.length,
    marked,
    byPoint,
    sessionsByPoint,
    noMarker,
    unknownMarker,
    unknownValues,
  };
}

/** Sum the rows falling on a given set of serve points. */
export function countOn(tally: ServePointTally, points: ReadonlySet<number>): number {
  let n = 0;
  for (const sp of points) n += tally.byPoint.get(sp) ?? 0;
  return n;
}

/** Distinct serve points that actually produced rows, ascending. */
export function observedPoints(tally: ServePointTally): number[] {
  return [...tally.byPoint.entries()]
    .filter(([, n]) => n > 0)
    .map(([sp]) => sp)
    .sort((a, b) => a - b);
}

/** Recognised serve points that produced NO rows in the window. */
export function unexercisedPoints(tally: ServePointTally): number[] {
  const seen = new Set(observedPoints(tally));
  return ALL_SERVE_POINTS.filter((sp) => !seen.has(sp));
}
