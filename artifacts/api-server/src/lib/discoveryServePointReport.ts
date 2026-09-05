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
  [DiscoveryServePoint.COMMUNITY]:              "Community (GET /discovery/community)",
  [DiscoveryServePoint.HIDDEN_GEMS]:            "Hidden gems (GET /hidden-gems, /hidden-gems/nearby)",
  [DiscoveryServePoint.MAP_SEARCH]:             "Map discovery (GET /map/search)",
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

/**
 * Serve points on which a ranker runs UNDER LEGACY MODE, by construction.
 *
 * THIS SET IS A FALLBACK, NOT THE ARITHMETIC. Read the trap before using it.
 *
 * It used to be called RANKED_POINTS and it used to BE the arithmetic: the D5
 * ranked share was `countOn(tally, {5, 6}) / countOn(tally, 1-6)`. That was
 * correct for exactly as long as "which serve point" and "did a ranker run"
 * were the same question — and D5=B ended that. Under mode `pde` the cache-A
 * serve points 1/2/3 rank the cached candidates per request
 * (routes/discovery.ts, `serveCachedPlaces`, the `pdeScoredById` branch), and
 * they log those impressions with `rankedInRequest: true` on the SAME serve
 * point number they always had. A static set keyed on the point would have
 * reported the first pde-ranked cache hit as unranked, pushing the measured
 * ranked share DOWN by precisely the serves the new engine added — the report
 * would have looked most like "ranking is starved" at the moment ranking
 * started reaching traffic. docs/discovery/serve-point-report-20260828.md
 * named that trap in advance; `rankedInRequest()` below is what closes it.
 *
 * So ranked-ness is read from the ROW — `features.rankedInRequest`, which both
 * writers set (`discoveryServeLog.ts`, and the `logImpression` extra features
 * on serve point 6 and the pde cache-A branch). This set is consulted only for
 * a row that carries no such key at all, which means it was written by a
 * writer older than Stage 0's marker, and those rows are counted apart
 * (`rankedUnrecorded`) so the fallback can never silently become the measure.
 */
export const LEGACY_RANKED_POINTS: ReadonlySet<number> = new Set([
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
  features?: {
    servePoint?: unknown;
    engineMode?: unknown;
    modeReason?: unknown;
    /** Written by every serve-point writer since Stage 0. See `rankedInRequest()`. */
    rankedInRequest?: unknown;
  } | null;
  session_id?: string | null;
  served_at?: string | null;
}

/**
 * What a single row says about whether a ranker ran during its request.
 *
 *   ranked      the writer said so (`features.rankedInRequest === true`)
 *   unranked    the writer said not (`=== false`) — including serve point 4,
 *               which REPLAYS a stored Compass order and is deliberately false
 *   unrecorded  the row carries no such key; the writer predates the marker
 */
export type RankedVerdict = "ranked" | "unranked" | "unrecorded";

/**
 * Ranked-ness of one row, read from the row itself.
 *
 * The serve point is NOT consulted here. Under mode `pde`, serve points 1/2/3
 * rank per request and say so on the row; under `legacy` the same points say
 * false. Only the row knows which happened, and the row wins over any static
 * belief about its serve point — a writer that reports point 6 as unranked is
 * reporting a fact this reader has no standing to overrule.
 */
export function rankedInRequest(row: ServeRow): RankedVerdict {
  const raw = row?.features?.rankedInRequest;
  if (raw === true) return "ranked";
  if (raw === false) return "unranked";
  return "unrecorded";
}

/**
 * Whether a row counts as ranked for the D5 arithmetic.
 *
 * Row marker first; the legacy serve-point set ONLY for a row that carries no
 * marker at all. The second case is reported separately by the tally so a
 * window classified mostly by fallback is visibly a window the marker did not
 * cover, not a measurement of the engine.
 */
export function isRankedRow(row: ServeRow, servePoint: number): boolean {
  const verdict = rankedInRequest(row);
  if (verdict === "ranked") return true;
  if (verdict === "unranked") return false;
  return LEGACY_RANKED_POINTS.has(servePoint);
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
   * servePoint → rows on which a ranker ran during the request, judged per row
   * (`isRankedRow`). This is what the D5 ranked share is computed from. A
   * cache-A point with a non-zero entry here is a pde-ranked cache hit — the
   * exact row the old static set would have misreported as unranked.
   */
  rankedByPoint: Map<number, number>;
  /**
   * Marked rows that carried NO `rankedInRequest` key and were classified by
   * `LEGACY_RANKED_POINTS` instead. Reported apart so that a window classified
   * by fallback reads as "the marker did not cover this window", never as a
   * measurement of which engine ran.
   */
  rankedUnrecorded: number;
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
        `in DISCOVERY_ENDPOINT_POINTS / LEGACY_RANKED_POINTS before quoting any number.`,
    );
  }
}

/** Tally rows by serve point, keeping the three "not counted" reasons distinct. */
export function tallyServePoints(rows: readonly ServeRow[]): ServePointTally {
  const byPoint = new Map<number, number>();
  const sessionsByPoint = new Map<number, Set<string>>();
  const rankedByPoint = new Map<number, number>();
  const unknownValues = new Set<string>();
  let noMarker = 0;
  let unknownMarker = 0;
  let rankedUnrecorded = 0;

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

    // Ranked-ness is a property of the ROW, not of the serve point. See
    // LEGACY_RANKED_POINTS for why the static set is only a fallback.
    if (rankedInRequest(r) === "unrecorded") rankedUnrecorded += 1;
    if (isRankedRow(r, sp)) rankedByPoint.set(sp, (rankedByPoint.get(sp) ?? 0) + 1);
  }

  const marked = [...byPoint.values()].reduce((a, b) => a + b, 0);
  return {
    total: rows.length,
    marked,
    byPoint,
    sessionsByPoint,
    rankedByPoint,
    rankedUnrecorded,
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

/**
 * Sum the rows on a given set of serve points on which a ranker ran during the
 * request — judged per row. THIS, not `countOn(tally, LEGACY_RANKED_POINTS)`,
 * is the D5 numerator.
 */
export function countRankedOn(tally: ServePointTally, points: ReadonlySet<number>): number {
  let n = 0;
  for (const sp of points) n += tally.rankedByPoint.get(sp) ?? 0;
  return n;
}

/**
 * Serve points OUTSIDE the legacy ranked set that nevertheless produced ranked
 * rows in this window — i.e. pde-ranked cache hits. Ascending. Reported so a
 * reader can see the engine reaching traffic rather than inferring it from a
 * share moving.
 */
export function rankedOutsideLegacyPoints(tally: ServePointTally): number[] {
  return [...tally.rankedByPoint.entries()]
    .filter(([sp, n]) => n > 0 && !LEGACY_RANKED_POINTS.has(sp))
    .map(([sp]) => sp)
    .sort((a, b) => a - b);
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

// ── The reporting window ──────────────────────────────────────────────────────
//
// WHY AN EXPLICIT WINDOW EXISTS AT ALL.
//
// The report accepted only `--days N`, floored at 1, applied as a single
// `served_at >= now - N days` with NO upper bound. That is a ROLLING window, and
// it is adequate for "what has the surface been doing lately" and inadequate for
// the one question Phase B actually asks.
//
// Phase B's evidence is produced by a bounded probe run at a known time. The
// verification is a before/after pair. With a rolling lower bound and no upper
// bound, the "after" reading covers a window that has MOVED since the "before"
// reading: rows aged off the tail during the probe, and the delta cannot
// separate "rows the probe wrote" from "rows that rolled out from under the
// baseline". The difference understates the probe, and it does so silently.
//
// It matters more here than the arithmetic suggests, because of who reads it.
// The probe is run by one agent and verified by another against the reported
// window — observation and verification deliberately in different hands. A
// verifier who cannot address the same window as the observer is not
// independently checking the claim; they are producing a second, differently
// shaped claim and calling the pair agreement.
//
// So: `--since` / `--until` bound the window explicitly. `--days` is unchanged
// when the new flags are absent, down to the printed line.

/** A resolved reporting window. `until` of `null` means "open at the top". */
export interface ReportWindow {
  /** ISO-8601, inclusive lower bound. */
  since: string;
  /** ISO-8601, inclusive upper bound, or null for an open window. */
  until: string | null;
  /** The line the report prints, so the window is never inferred from flags. */
  description: string;
}

/** Thrown for a window that cannot be honoured. Never silently coerced. */
export class ReportWindowError extends Error {}

function readFlag(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function parseInstant(raw: string | undefined, flag: string): string {
  if (raw === undefined || raw.startsWith("--")) {
    throw new ReportWindowError(
      `${flag} requires an ISO-8601 timestamp, e.g. ${flag} 2026-08-15T14:00:00Z. ` +
        `A window flag with no value is a window nobody chose.`,
    );
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new ReportWindowError(
      `${flag} value ${JSON.stringify(raw)} is not a parseable ISO-8601 timestamp. ` +
        `Refusing rather than falling back to a default window: a report that ` +
        `silently measures a different window than the one you asked for is the ` +
        `failure this instrument already had once.`,
    );
  }
  return new Date(ms).toISOString();
}

/**
 * Resolve the reporting window from argv.
 *
 * `nowMs` is injected rather than read from the clock so this is testable and
 * so two callers in the same run cannot disagree about "now".
 *
 * Refuses, rather than guessing, on:
 *   - `--days` combined with `--since`/`--until` (two different windows asked
 *     for at once; picking either would be a coin toss the caller cannot see);
 *   - an unparseable or absent timestamp;
 *   - `until` at or before `since` — an empty window returns zero rows and reads
 *     exactly like a surface nobody reached. Vacuity is failure: a check that
 *     examines nothing must not pass.
 */
export function resolveReportWindow(argv: readonly string[], nowMs: number): ReportWindow {
  const hasDays = argv.includes("--days");
  const hasSince = argv.includes("--since");
  const hasUntil = argv.includes("--until");

  if (hasDays && (hasSince || hasUntil)) {
    throw new ReportWindowError(
      "--days cannot be combined with --since/--until. They describe different " +
        "windows and there is no sensible precedence: one is a rolling window " +
        "ending now, the other is a fixed window. Pass one or the other.",
    );
  }

  if (hasUntil && !hasSince) {
    throw new ReportWindowError(
      "--until requires --since. An upper bound with a default lower bound is a " +
        "window whose size depends on a flag you did not pass.",
    );
  }

  if (hasSince) {
    const since = parseInstant(readFlag(argv, "--since"), "--since");
    const until = hasUntil ? parseInstant(readFlag(argv, "--until"), "--until") : null;

    if (until !== null && Date.parse(until) <= Date.parse(since)) {
      throw new ReportWindowError(
        `Empty window: --until (${until}) is at or before --since (${since}). ` +
          `Such a window can only return zero rows, which is indistinguishable ` +
          `from a surface nobody reached. Refusing to render that as a result.`,
      );
    }

    return {
      since,
      until,
      description:
        until === null
          ? `fixed window, served_at >= ${since} (open at the top)`
          : `fixed window, ${since} <= served_at <= ${until}`,
    };
  }

  const raw = readFlag(argv, "--days");
  const days = hasDays ? Math.max(1, parseInt(raw ?? "7", 10)) : 7;
  const since = new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
  return {
    since,
    until: null,
    description: `last ${days} day(s), served_at >= ${since}`,
  };
}

// ── Fetching the serve corpus ─────────────────────────────────────────────────
//
// WHAT COUNTS AS A SERVE, AND WHY IT IS NOT `outcome = 'impression'`.
//
// This lived in the script as `.eq("surface","discovery").eq("outcome",
// "impression")`, and the second clause was wrong for the same reason the
// exposure denominator was wrong before it (00_STATUS defect 4): it confused a
// serve with an unconverted serve.
//
// A serve is written as an `impression` row — but `rank_events` is a
// mutable-state table. When the funnel records a tap/save/join/rsvp/attended,
// routes/rankEvents.ts UPDATES that same row's `outcome` column IN PLACE
// (impression → tap → …), leaving `features` — and therefore the `servePoint`
// marker — untouched. So a served item the user then acted on is STILL a serve,
// but its outcome is no longer 'impression'. Filtering on outcome='impression'
// silently dropped every converted serve, and it did so differentially: the
// ranked serve points (5/6, and pde-ranked cache hits) are the ones that convert
// best, so the D5 ranked share was biased DOWN by exactly the serves that reached
// a ranker — the report read most like "ranking is starved" precisely where
// ranking was working.
//
// The corpus predicate is `event_type IS NULL`. That is the documented ranked/
// impression corpus (lib/rankLog.ts, migration 0197): the analytics-sentinel
// rows the outcome route also inserts carry a non-null `event_type` and
// outcome='analytics', have no `servePoint` marker, and must NOT be counted as
// serves. `event_type IS NULL` keeps every serve regardless of how far down the
// funnel it later travelled, and keeps only serves.

/**
 * The minimal query surface {@link fetchDiscoveryServeRows} needs.
 *
 * Structural on purpose: the real `SupabaseClient` satisfies it, and a test can
 * pass a fake builder that records the filters it was asked for.
 */
export interface DiscoveryServeQueryClient {
  from(table: string): {
    select(columns: string): any;
  };
}

/**
 * Page size for the serve-corpus read. PostgREST's `db-max-rows` caps a
 * range-less SELECT at 1000 rows and reports NOTHING — no error, no flag, no
 * `Content-Range` the client inspects — so a read without `.range()` returns a
 * silently truncated corpus that looks complete. Ask for pages of exactly this
 * size and stop on the first short page.
 */
export const SERVE_ROWS_PAGE_SIZE = 1_000;

/**
 * Hard ceiling on rows accumulated across pages. Not a silent cap: hitting it
 * sets `truncated` on the result and the report says so in the output, next to
 * the number it affects. A metric that quietly drops rows is worse than one
 * that says it is bounded.
 */
export const SERVE_ROWS_MAX = 500_000;

/** The outcome of a paginated serve-corpus read. */
export interface DiscoveryServeRowsResult {
  rows: ServeRow[];
  error: { message: string } | null;
  /**
   * True when SERVE_ROWS_MAX stopped the read before the corpus ran out — the
   * rows here are a PREFIX of the window, not the window. Every share computed
   * from them is a share of that prefix. Callers MUST surface this rather than
   * printing the derived percentage as if it described the window.
   */
  truncated: boolean;
  /** Pages actually read. Diagnostic; also lets a test pin the pagination. */
  pages: number;
}

/**
 * Fetch the discovery SERVE rows for a window — every `surface='discovery'`
 * `rank_events` row with `event_type IS NULL`, regardless of its current outcome
 * rung. See the section header above for why this is not `outcome='impression'`.
 *
 * FULLY PAGINATED. This read used to be range-less, which meant PostgREST cut it
 * at `db-max-rows` (1000) without saying so, and the D5 ranked-share verdict —
 * the number the whole report exists to produce — was computed over whatever
 * arbitrary ~1000 rows came back rather than over the corpus. On any window with
 * real traffic that is not a rounding error; it is a different question being
 * answered under the same name.
 *
 * A page that errors aborts the read and returns the error with the rows read so
 * far. The caller (scripts/reportDiscoveryServePoints.ts) exits non-zero on a
 * non-null error rather than reporting a partial corpus as a verdict.
 *
 * Returns `{ rows, error, truncated, pages }`; `error` is the PostgREST error
 * (never thrown) so the caller can decide how to surface it.
 */
export async function fetchDiscoveryServeRows(
  sc: DiscoveryServeQueryClient,
  window: { since: string; until: string | null },
): Promise<DiscoveryServeRowsResult> {
  const rows: ServeRow[] = [];
  let pages = 0;

  for (let offset = 0; ; offset += SERVE_ROWS_PAGE_SIZE) {
    let query = sc
      .from("rank_events")
      .select("features, session_id, served_at")
      .eq("surface", "discovery")
      // NOT .eq("outcome","impression") — that drops every converted serve. See
      // the section header: a serve keeps its servePoint marker after the funnel
      // upgrades its outcome in place, and event_type IS NULL is the serve corpus.
      .is("event_type", null)
      .gte("served_at", window.since);

    // Only bound the top when one was asked for. An unconditional `.lte(now)`
    // would look harmless and would quietly exclude rows written between the
    // query being built and the query being served.
    if (window.until !== null) query = query.lte("served_at", window.until);

    // A stable total order is required for paging to mean anything: without it
    // Postgres may return the same physical row on two pages and skip another,
    // so the "complete" corpus would be neither complete nor deduplicated.
    // served_at alone is not unique, so `id` breaks the ties.
    query = query
      .order("served_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + SERVE_ROWS_PAGE_SIZE - 1);

    const { data, error } = await query;
    pages += 1;
    if (error) return { rows, error, truncated: false, pages };

    const page = (data as ServeRow[] | null) ?? [];
    rows.push(...page);

    // A short page is the end of the corpus. A full page is not proof of more
    // rows, but costs one extra empty read to confirm — cheap, and it is the
    // only way to know rather than guess.
    if (page.length < SERVE_ROWS_PAGE_SIZE) {
      return { rows, error: null, truncated: false, pages };
    }
    if (rows.length >= SERVE_ROWS_MAX) {
      return { rows, error: null, truncated: true, pages };
    }
  }
}
