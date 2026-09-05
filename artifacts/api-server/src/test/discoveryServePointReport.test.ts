/**
 * discoveryServePointReport — the tally behind report:discovery-serve-points.
 *
 * WHAT THESE TESTS ARE ANCHORED TO
 * ================================
 * Not invented shapes. `PRODUCTION_ROWS_20260815` below is the verbatim
 * `features` of the five `surface='discovery'` rows that existed in production
 * `ajrurzioarfkagpuxfnb` on 2026-08-15, read READ-ONLY through
 * `ciProdReadOnlyAuditGuard`. Timestamps and session ids as read.
 *
 * That window is the reason this module exists. Against it the old reader —
 * which bounded servePoint to 1..6 while the writer had grown to 9 — printed:
 *
 *     ── 1. rows by serve point ──
 *       (no marked rows in this window)
 *       5 row(s) carry no servePoint marker — these predate Stage 0.
 *     ── VERDICT: NOT ESTABLISHED ──
 *       Zero marked rows. This means the instrumentation was not enabled
 *       during this window — NOT that no serves occurred.
 *
 * Every clause of that is false. The rows are marked, they postdate Stage 0b,
 * and the flag was demonstrably on — they exist only because it was. The
 * instrument turned present evidence into "we were not observing", which is the
 * governing invariant of this workstream violated inside the ruler that renders
 * the Phase B verdict.
 *
 * So the first test below is not a synthetic case. It is that window, and the
 * assertion is that the reader now says what was true of it.
 *
 * WHAT EACH TEST WOULD CATCH
 * ==========================
 * Verified by reverting each mechanism against this file:
 *
 *   bound servePoint to 1..6 again    -> RED (production window, unexercised,
 *                                             observedPoints, unknown-marker)
 *   merge unknownMarker into noMarker -> RED (the two-findings tests)
 *   drop assertLabelsCoverEnum        -> RED (the enum-coverage test)
 *   put 7-9 into DISCOVERY_ENDPOINT_POINTS
 *                                     -> RED (the population-separation test)
 *   key ranked-ness on the serve point again (the static {5,6} set)
 *                                     -> RED (the pde-ranked cache-hit tests)
 *
 * The last one is the one most likely to be "simplified" away by someone tidying
 * up, and it is the one that would silently bias the D5 verdict. Its test says
 * so in place.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DiscoveryServePoint } from "../lib/discoveryServeLog.js";
import {
  ALL_SERVE_POINTS,
  CACHE_A_POINTS,
  DISCOVERY_ENDPOINT_POINTS,
  LEGACY_RANKED_POINTS,
  SERVE_POINT_LABEL,
  ReportWindowError,
  assertLabelsCoverEnum,
  countOn,
  countRankedOn,
  fetchDiscoveryServeRows,
  SERVE_ROWS_PAGE_SIZE,
  SERVE_ROWS_MAX,
  isRankedRow,
  observedPoints,
  rankedInRequest,
  rankedOutsideLegacyPoints,
  resolveReportWindow,
  tallyServePoints,
  unexercisedPoints,
  type DiscoveryServeQueryClient,
  type ServeRow,
} from "../lib/discoveryServePointReport.js";

/**
 * The real production window, verbatim. Five rows, two sessions, one user, all
 * on `GET /discovery/suggest`.
 */
const PRODUCTION_ROWS_20260815: ServeRow[] = [
  {
    served_at: "2026-08-15T03:12:19.681+00:00",
    session_id: "c621622b-0000-0000-0000-000000000000",
    features: { route: "GET /discovery/suggest", groupCount: 1, servePoint: 9, rankedInRequest: false },
  },
  ...Array.from({ length: 4 }, () => ({
    served_at: "2026-08-15T05:58:43.4+00:00",
    session_id: "1cad0090-0000-0000-0000-000000000000",
    features: { route: "GET /discovery/suggest", groupCount: 2, servePoint: 9, rankedInRequest: false },
  })),
];

describe("discoveryServePointReport — the production window that broke the old reader", () => {
  it("counts the five real serve-point-9 rows as MARKED, not as pre-Stage-0", () => {
    const t = tallyServePoints(PRODUCTION_ROWS_20260815);

    assert.equal(t.total, 5);
    assert.equal(t.marked, 5, "all five rows carry a servePoint this build recognises");
    assert.equal(t.byPoint.get(DiscoveryServePoint.SUGGEST), 5);

    // The whole defect, stated as an assertion: none of these is unmarked.
    assert.equal(t.noMarker, 0, "a marked row must never be reported as predating Stage 0");
    assert.equal(t.unknownMarker, 0);
  });

  it("reports ONE serve point observed and the other nine unexercised", () => {
    const t = tallyServePoints(PRODUCTION_ROWS_20260815);

    assert.deepEqual(observedPoints(t), [DiscoveryServePoint.SUGGEST]);
    assert.deepEqual(unexercisedPoints(t), [1, 2, 3, 4, 5, 6, 7, 8, 10]);
  });

  it("attributes zero of them to GET /discovery, so the D5 population is empty", () => {
    const t = tallyServePoints(PRODUCTION_ROWS_20260815);

    // This is the number that stops the D5 clause dividing. Serve point 9 is
    // suggest: it contains no ranker call, so these are not serves that could
    // have been ranked and lost.
    assert.equal(countOn(t, DISCOVERY_ENDPOINT_POINTS), 0);
    assert.equal(countRankedOn(t, DISCOVERY_ENDPOINT_POINTS), 0);

    // rankedRows / marked would have been 0/5 = a clean 0.0%: under the 33%
    // threshold, hence "PROCEED WITH D5" — a confident verdict from a window
    // holding not one serve the clause is about.
    assert.equal(t.marked, 5);
  });

  it("tracks distinct sessions per serve point", () => {
    const t = tallyServePoints(PRODUCTION_ROWS_20260815);
    assert.equal(t.sessionsByPoint.get(DiscoveryServePoint.SUGGEST)?.size, 2);
  });
});

describe("discoveryServePointReport — no-marker and unknown-marker are different findings", () => {
  it("a row with no servePoint key is a pre-Stage-0 row", () => {
    const t = tallyServePoints([
      { features: { route: "GET /discovery" } },
      { features: null },
      {},
    ]);
    assert.equal(t.noMarker, 3);
    assert.equal(t.unknownMarker, 0);
    assert.equal(t.marked, 0);
  });

  it("a row with an UNRECOGNISED servePoint is a defect in the reader, counted apart", () => {
    // The exact shape of the original bug, from the other side: a writer that
    // has grown past this build. Folding these into noMarker is what reported
    // Stage 0b rows as pre-Stage-0 ones.
    const t = tallyServePoints([
      // 11 and 99: genuinely unrecognised. NOT 10 — that became COMMUNITY when
      // GET /discovery/community was instrumented, and reusing a real point here
      // would make this test assert the opposite of what it is named for.
      { features: { servePoint: 11 } },
      { features: { servePoint: 99 } },
      { features: { servePoint: "banana" } },
      { features: { servePoint: 9 } },
    ]);

    assert.equal(t.unknownMarker, 3);
    assert.equal(t.noMarker, 0, "an unrecognised marker is NOT a missing marker");
    assert.deepEqual([...t.unknownValues].sort(), ["11", "99", "banana"]);
    assert.equal(t.marked, 1);
  });

  it("zero is not a valid serve point and is not silently accepted", () => {
    const t = tallyServePoints([{ features: { servePoint: 0 } }]);
    assert.equal(t.unknownMarker, 1);
    assert.equal(t.marked, 0);
  });
});

describe("discoveryServePointReport — the reader cannot drift past the writer again", () => {
  it("every DiscoveryServePoint member has a label", () => {
    assert.doesNotThrow(() => assertLabelsCoverEnum());
    for (const sp of Object.values(DiscoveryServePoint)) {
      assert.ok(
        SERVE_POINT_LABEL[Number(sp)],
        `serve point ${sp} has no label — adding a member without one is the exact drift that caused this bug`,
      );
    }
  });

  it("recognises every serve point the writer can emit, 1 through 10", () => {
    assert.deepEqual([...ALL_SERVE_POINTS], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const rows: ServeRow[] = ALL_SERVE_POINTS.map((sp) => ({ features: { servePoint: sp } }));
    const t = tallyServePoints(rows);
    assert.equal(t.marked, ALL_SERVE_POINTS.length);
    assert.equal(t.noMarker, 0);
    assert.equal(t.unknownMarker, 0);
  });
});

describe("discoveryServePointReport — the two populations stay separate", () => {
  it("GET /discovery is serve points 1-6 and does NOT include feed, search or suggest", () => {
    // If this ever goes red because someone widened DISCOVERY_ENDPOINT_POINTS to
    // "all of them", read this before changing the test:
    //
    // Serve points 7-9 contain no ranker call at all — not a rare one, none
    // (discoveryServeLog.ts documents the grep). Counting them in the D5
    // denominator pushes the ranked share DOWN with rows that were never
    // candidates for ranking, so "cache A absorbs the traffic and
    // personalisation rarely runs" looks better supported the more search
    // traffic the app gets. It is a self-confirming measurement error.
    assert.deepEqual([...DISCOVERY_ENDPOINT_POINTS].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);

    for (const sp of [DiscoveryServePoint.FEED, DiscoveryServePoint.SEARCH, DiscoveryServePoint.SUGGEST]) {
      assert.equal(DISCOVERY_ENDPOINT_POINTS.has(sp), false, `serve point ${sp} is not GET /discovery`);
      assert.equal(LEGACY_RANKED_POINTS.has(sp), false, `serve point ${sp} runs no ranker`);
    }
  });

  it("COMMUNITY is instrumented but stays OUT of the D5 denominator", () => {
    // Serve point 10 exists so the D4=C baseline covers every route that returns
    // items. It must NOT join the GET /discovery population: /discovery/community
    // runs no ranker, so a row from it is not "a serve that could have been
    // ranked and lost". Counting it would push the ranked share down with rows
    // that were never candidates — the same measurement error, reintroduced.
    assert.ok(SERVE_POINT_LABEL[DiscoveryServePoint.COMMUNITY], "must be labelled");
    assert.ok(!DISCOVERY_ENDPOINT_POINTS.has(DiscoveryServePoint.COMMUNITY),
      "community is not part of GET /discovery");
    assert.ok(!LEGACY_RANKED_POINTS.has(DiscoveryServePoint.COMMUNITY),
      "community runs no ranker");
    assert.ok(!CACHE_A_POINTS.has(DiscoveryServePoint.COMMUNITY),
      "community does not serve from cache A");
  });

  it("legacy-ranked and cache-A sets are subsets of GET /discovery", () => {
    for (const sp of LEGACY_RANKED_POINTS) assert.ok(DISCOVERY_ENDPOINT_POINTS.has(sp));
    for (const sp of CACHE_A_POINTS) assert.ok(DISCOVERY_ENDPOINT_POINTS.has(sp));
    assert.deepEqual([...LEGACY_RANKED_POINTS].sort((a, b) => a - b), [5, 6]);
    assert.deepEqual([...CACHE_A_POINTS].sort((a, b) => a - b), [1, 2, 3]);
  });

  it("a mixed window splits into the two populations without summing them", () => {
    const t = tallyServePoints([
      { features: { servePoint: 1, rankedInRequest: false } },
      { features: { servePoint: 1, rankedInRequest: false } },
      { features: { servePoint: 6, rankedInRequest: true } },
      { features: { servePoint: 9, rankedInRequest: false } },
      { features: { servePoint: 9, rankedInRequest: false } },
      { features: { servePoint: 9, rankedInRequest: false } },
    ]);

    assert.equal(t.marked, 6);
    assert.equal(countOn(t, DISCOVERY_ENDPOINT_POINTS), 3);
    assert.equal(countRankedOn(t, DISCOVERY_ENDPOINT_POINTS), 1);

    // The distinction the D5 clause turns on: 1/3 over GET /discovery serves,
    // NOT 1/6 over every marked row. The second understates it by half, and
    // always in the direction that confirms the packet.
    assert.equal(countRankedOn(t, DISCOVERY_ENDPOINT_POINTS) / countOn(t, DISCOVERY_ENDPOINT_POINTS), 1 / 3);
    assert.notEqual(countRankedOn(t, DISCOVERY_ENDPOINT_POINTS) / t.marked, 1 / 3);
  });
});

// ── Ranked-ness is a property of the ROW, not of the serve point ──────────────
//
// docs/discovery/serve-point-report-20260828.md, "A modelling trap to record
// before anyone does build it": RANKED_POINTS was the static set {5, 6}, and
// under D5=B serve points 1-3 rank per request. The pde serve path now exists
// (routes/discovery.ts, serveCachedPlaces, the `pdeScoredById` branch) and logs
// `rankedInRequest: true` on serve point 1/2/3. A reader keyed on the point
// would report the engine's first ranked cache hit as unranked — pushing the
// measured ranked share DOWN by exactly the serves the engine added.
//
// Red-proof: restore `countOn(tally, {5,6})` as the numerator and the first two
// tests below go red.

/** The row the pde cache-A branch writes: serve point 1, ranked, mode pde. */
const PDE_RANKED_L1_ROW: ServeRow = {
  session_id: "pde-0001-0000-0000-0000-000000000000",
  features: {
    servePoint: DiscoveryServePoint.CACHE_A_L1, route: "GET /discovery", rankedInRequest: true,
    cacheLevel: "L1", engineMode: "pde", modeReason: "resolved",
  } as ServeRow["features"],
};

/** The same serve point under legacy: served from cache, no ranker. */
const LEGACY_L1_ROW: ServeRow = {
  session_id: "leg-0001-0000-0000-0000-000000000000",
  features: {
    servePoint: DiscoveryServePoint.CACHE_A_L1, route: "GET /discovery", rankedInRequest: false,
    cacheLevel: "L1", engineMode: "legacy", modeReason: "flag_disabled",
  } as ServeRow["features"],
};

describe("discoveryServePointReport — a pde-ranked cache-A serve counts as RANKED", () => {
  it("serve point 1 with rankedInRequest=true is ranked; the same point under legacy is not", () => {
    assert.equal(rankedInRequest(PDE_RANKED_L1_ROW), "ranked");
    assert.equal(rankedInRequest(LEGACY_L1_ROW), "unranked");
    assert.equal(isRankedRow(PDE_RANKED_L1_ROW, DiscoveryServePoint.CACHE_A_L1), true);
    assert.equal(isRankedRow(LEGACY_L1_ROW, DiscoveryServePoint.CACHE_A_L1), false);
    // The point itself has NOT become a legacy ranked point — it is the ROW.
    assert.equal(LEGACY_RANKED_POINTS.has(DiscoveryServePoint.CACHE_A_L1), false);
  });

  it("the D5 numerator counts the pde-ranked cache hit — the trap the 2026-08-28 report named", () => {
    const t = tallyServePoints([
      PDE_RANKED_L1_ROW, PDE_RANKED_L1_ROW,       // 2 pde-ranked cache hits
      LEGACY_L1_ROW,                               // 1 legacy cache hit
      { features: { servePoint: 6, rankedInRequest: true } },  // 1 cold fetch
    ]);
    assert.equal(countOn(t, DISCOVERY_ENDPOINT_POINTS), 4);
    // 3 of 4, not 1 of 4. The static set would have said 1/4 and printed
    // "cache A absorbs the traffic" about a window where the engine ranked
    // three quarters of it.
    assert.equal(countRankedOn(t, DISCOVERY_ENDPOINT_POINTS), 3);
    assert.notEqual(countRankedOn(t, DISCOVERY_ENDPOINT_POINTS), countOn(t, LEGACY_RANKED_POINTS));
    assert.equal(t.rankedByPoint.get(DiscoveryServePoint.CACHE_A_L1), 2);
    assert.deepEqual(rankedOutsideLegacyPoints(t), [DiscoveryServePoint.CACHE_A_L1]);
    assert.equal(t.rankedUnrecorded, 0);
  });

  it("serve point 4 (Cache B replay) says rankedInRequest=false and is honoured as unranked", () => {
    // discoveryServeLog.ts: the order came from a ranker, but not from THIS
    // request. The writer says false and the reader must not overrule it.
    const t = tallyServePoints([{ features: { servePoint: 4, rankedInRequest: false } }]);
    assert.equal(countRankedOn(t, DISCOVERY_ENDPOINT_POINTS), 0);
  });

  it("the row wins over the point: a serve point 6 row marked unranked is unranked", () => {
    const t = tallyServePoints([{ features: { servePoint: 6, rankedInRequest: false } }]);
    assert.equal(countRankedOn(t, DISCOVERY_ENDPOINT_POINTS), 0);
    assert.equal(t.rankedUnrecorded, 0);
  });

  it("a row with NO marker falls back to the legacy set and is counted as UNRECORDED, apart", () => {
    const t = tallyServePoints([
      { features: { servePoint: 6 } },   // legacy-ranked by construction
      { features: { servePoint: 1 } },   // legacy-unranked by construction
      { features: { servePoint: 5 } },
    ]);
    assert.equal(rankedInRequest({ features: { servePoint: 6 } }), "unrecorded");
    assert.equal(countRankedOn(t, DISCOVERY_ENDPOINT_POINTS), 2);
    // Three rows classified by fallback — the report must say so rather than
    // presenting the share as a measurement of the engine.
    assert.equal(t.rankedUnrecorded, 3);
    assert.deepEqual(rankedOutsideLegacyPoints(t), []);
  });

  it("a non-boolean marker is UNRECORDED, never coerced into ranked", () => {
    for (const bad of ["true", 1, null, undefined, "yes"]) {
      assert.equal(rankedInRequest({ features: { servePoint: 1, rankedInRequest: bad } }), "unrecorded");
    }
  });
});

describe("discoveryServePointReport — an empty window says nothing rather than something", () => {
  it("no rows yields no marked rows, no markers, and no observed points", () => {
    const t = tallyServePoints([]);
    assert.equal(t.total, 0);
    assert.equal(t.marked, 0);
    assert.equal(t.noMarker, 0);
    assert.equal(t.unknownMarker, 0);
    assert.deepEqual(observedPoints(t), []);
    // Everything unexercised — which is a statement about this window, not
    // about the surface.
    assert.deepEqual(unexercisedPoints(t), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

// ── resolveReportWindow ───────────────────────────────────────────────────────
//
// These exist because the Phase B verification is a before/after pair read by a
// DIFFERENT party than the one who ran the probe. The verifier must be able to
// address exactly the window the observer reported. A rolling window cannot do
// that, and the failure is silent — which is the whole reason this instrument
// is under test at all.

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

describe("resolveReportWindow — the --days default is unchanged", () => {
  it("no flags is 7 rolling days, open at the top", () => {
    const w = resolveReportWindow(["node", "script"], NOW);
    assert.equal(w.since, "2026-08-08T12:00:00.000Z");
    assert.equal(w.until, null);
    assert.match(w.description, /last 7 day\(s\)/);
  });

  it("--days 1 is one rolling day, open at the top", () => {
    const w = resolveReportWindow(["node", "script", "--days", "1"], NOW);
    assert.equal(w.since, "2026-08-14T12:00:00.000Z");
    assert.equal(w.until, null);
  });

  it("--days floors at 1, as before — 0 and negatives do not widen to everything", () => {
    for (const n of ["0", "-5"]) {
      const w = resolveReportWindow(["node", "script", "--days", n], NOW);
      assert.equal(w.since, "2026-08-14T12:00:00.000Z");
    }
  });
});

describe("resolveReportWindow — a fixed window can be addressed exactly", () => {
  it("--since/--until bounds both ends", () => {
    const w = resolveReportWindow(
      ["node", "script", "--since", "2026-08-15T14:00:00Z", "--until", "2026-08-15T14:30:00Z"],
      NOW,
    );
    assert.equal(w.since, "2026-08-15T14:00:00.000Z");
    assert.equal(w.until, "2026-08-15T14:30:00.000Z");
    assert.match(w.description, /fixed window/);
  });

  it("--since alone is a fixed lower bound, open at the top", () => {
    const w = resolveReportWindow(["node", "script", "--since", "2026-08-15T14:00:00Z"], NOW);
    assert.equal(w.since, "2026-08-15T14:00:00.000Z");
    assert.equal(w.until, null);
  });

  it("the window is independent of the clock — the same flags resolve the same at any 'now'", () => {
    const flags = ["node", "script", "--since", "2026-08-15T14:00:00Z", "--until", "2026-08-15T14:30:00Z"];
    const a = resolveReportWindow(flags, NOW);
    const b = resolveReportWindow(flags, NOW + 9 * 60 * 60 * 1000);
    assert.deepEqual(a, b);
  });

  it("A ROLLING WINDOW IS NOT: the same --days flags resolve differently as 'now' moves", () => {
    // This is the defect the fixed window exists to avoid, pinned as a fact
    // rather than left as an argument in a comment. A before/after pair taken
    // with --days addresses two different windows.
    const flags = ["node", "script", "--days", "1"];
    const before = resolveReportWindow(flags, NOW);
    const after = resolveReportWindow(flags, NOW + 30 * 60 * 1000);
    assert.notEqual(before.since, after.since);
  });
});

describe("resolveReportWindow — refuses rather than guessing", () => {
  it("--days with --since is refused: two different windows asked for at once", () => {
    assert.throws(
      () => resolveReportWindow(["node", "s", "--days", "1", "--since", "2026-08-15T14:00:00Z"], NOW),
      ReportWindowError,
    );
  });

  it("--until without --since is refused", () => {
    assert.throws(
      () => resolveReportWindow(["node", "s", "--until", "2026-08-15T14:30:00Z"], NOW),
      ReportWindowError,
    );
  });

  it("an unparseable timestamp is refused, NOT silently defaulted", () => {
    assert.throws(
      () => resolveReportWindow(["node", "s", "--since", "last tuesday"], NOW),
      ReportWindowError,
    );
  });

  it("a flag with no value is refused rather than swallowing the next flag", () => {
    assert.throws(
      () => resolveReportWindow(["node", "s", "--since", "--until"], NOW),
      ReportWindowError,
    );
  });

  it("VACUITY IS FAILURE: an inverted or zero-width window is refused", () => {
    // Such a window returns zero rows and reads exactly like a surface nobody
    // reached. It must not be renderable as a result.
    for (const [since, until] of [
      ["2026-08-15T14:30:00Z", "2026-08-15T14:00:00Z"], // inverted
      ["2026-08-15T14:00:00Z", "2026-08-15T14:00:00Z"], // zero width
    ]) {
      assert.throws(
        () => resolveReportWindow(["node", "s", "--since", since, "--until", until], NOW),
        ReportWindowError,
      );
    }
  });
});

// ── fetchDiscoveryServeRows — a converted serve is STILL a serve ──────────────
//
// The corpus fetch once read `.eq("surface","discovery").eq("outcome",
// "impression")`. But rank_events is mutable state: when the funnel records a
// tap/save/join/rsvp/attended, routes/rankEvents.ts UPDATES that served row's
// `outcome` column IN PLACE (impression → tap → …) and leaves `features` — the
// servePoint marker — untouched. So a served item the user then acted on is
// still a serve, but its outcome is no longer 'impression'. The old filter
// dropped every such row, understating serve-point coverage DIFFERENTIALLY by
// conversion: the ranked points (5/6, and pde-ranked cache hits) convert best,
// so the D5 ranked share was biased toward "ranking is starved" by exactly the
// serves that reached a ranker.
//
// The corpus predicate is `event_type IS NULL` (lib/rankLog.ts, migration 0197):
// the analytics-sentinel rows the outcome route also inserts carry a non-null
// event_type and outcome='analytics', have no servePoint marker, and are NOT
// serves. Restoring the outcome filter turns the first test below RED.

interface RankEventFixtureRow {
  surface: string;
  outcome: string;
  event_type: string | null;
  served_at: string;
  session_id: string | null;
  features: ServeRow["features"];
  /** Present only on paging fixtures — the tiebreak column the read orders on. */
  id?: string;
}

interface FakeRankEventsBuilder {
  select(columns: string): FakeRankEventsBuilder;
  eq(col: string, val: unknown): FakeRankEventsBuilder;
  is(col: string, val: unknown): FakeRankEventsBuilder;
  gte(col: string, val: unknown): FakeRankEventsBuilder;
  lte(col: string, val: unknown): FakeRankEventsBuilder;
  order(col: string, opts?: { ascending?: boolean }): FakeRankEventsBuilder;
  range(from: number, to: number): FakeRankEventsBuilder;
  then<T>(onFulfilled: (value: { data: RankEventFixtureRow[]; error: null }) => T): Promise<T>;
}

/**
 * A fake PostgREST builder that records the filters it is asked for and applies
 * them in-memory, so a test can assert BOTH what fetchDiscoveryServeRows selects
 * and which rows survive — without a live database.
 *
 * A FRESH builder per `from()` call, because fetchDiscoveryServeRows now PAGES:
 * one builder shared across pages would carry page 1's `.range()` into page 2
 * and every page would return the same rows. `pages` counts the reads so a test
 * can pin that the pagination actually happened.
 *
 * `range` is honoured for real, and `dbMaxRows` emulates PostgREST's silent
 * `db-max-rows` cap — the server truncating a response with no error and no
 * signal, which is the exact behaviour the range-less read walked into.
 */
function fakeRankEventsClient(
  rows: RankEventFixtureRow[],
  opts: { dbMaxRows?: number } = {},
): {
  client: DiscoveryServeQueryClient;
  filters: Array<{ op: string; col: string; val: unknown }>;
  pages: () => number;
} {
  const filters: Array<{ op: string; col: string; val: unknown }> = [];
  const dbMaxRows = opts.dbMaxRows ?? Infinity;
  let pages = 0;

  const cell = (r: RankEventFixtureRow, col: string): unknown =>
    (r as unknown as Record<string, unknown>)[col];

  function makeBuilder(): FakeRankEventsBuilder {
    const preds: Array<(r: RankEventFixtureRow) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let from = 0;
    let to = Infinity;

    const builder: FakeRankEventsBuilder = {
      select(_columns: string) { return builder; },
      eq(col: string, val: unknown) {
        filters.push({ op: "eq", col, val });
        preds.push((r) => cell(r, col) === val);
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push({ op: "is", col, val });
        preds.push((r) => {
          const c = cell(r, col);
          return val === null ? c === null || c === undefined : c === val;
        });
        return builder;
      },
      gte(col: string, val: unknown) {
        filters.push({ op: "gte", col, val });
        preds.push((r) => String(cell(r, col)) >= String(val));
        return builder;
      },
      lte(col: string, val: unknown) {
        filters.push({ op: "lte", col, val });
        preds.push((r) => String(cell(r, col)) <= String(val));
        return builder;
      },
      order(col: string, o?: { ascending?: boolean }) {
        filters.push({ op: "order", col, val: o?.ascending !== false });
        orders.push({ col, asc: o?.ascending !== false });
        return builder;
      },
      range(f: number, t: number) {
        filters.push({ op: "range", col: "", val: [f, t] });
        from = f; to = t;
        return builder;
      },
      then<T>(onFulfilled: (value: { data: RankEventFixtureRow[]; error: null }) => T): Promise<T> {
        pages += 1;
        const matched = rows.filter((r) => preds.every((p) => p(r)));
        for (const o of [...orders].reverse()) {
          matched.sort((x, y) => {
            const a = String(cell(x, o.col) ?? "");
            const b = String(cell(y, o.col) ?? "");
            return (a < b ? -1 : a > b ? 1 : 0) * (o.asc ? 1 : -1);
          });
        }
        // PostgREST applies the requested range, then silently truncates the
        // response to db-max-rows. Both, in that order.
        const windowed = matched.slice(from, to === Infinity ? undefined : to + 1);
        const data = windowed.slice(0, dbMaxRows);
        return Promise.resolve({ data, error: null as null }).then(onFulfilled);
      },
    };
    return builder;
  }

  const client: DiscoveryServeQueryClient = { from(_table: string) { return makeBuilder(); } };
  return { client, filters, pages: () => pages };
}

describe("fetchDiscoveryServeRows — a converted serve is still a serve", () => {
  const WINDOW = { since: "2026-09-01T00:00:00.000Z", until: null };
  const inWindow = "2026-09-02T10:00:00.000Z";

  const impressionServe: RankEventFixtureRow = {
    surface: "discovery", outcome: "impression", event_type: null, served_at: inWindow,
    session_id: "sess-impression",
    features: { servePoint: 6, rankedInRequest: true },
  };
  // The SAME serve point, but the user saved it: the outcome route upgraded
  // outcome to 'save' IN PLACE, leaving features (servePoint) intact.
  const savedServe: RankEventFixtureRow = {
    surface: "discovery", outcome: "save", event_type: null, served_at: inWindow,
    session_id: "sess-saved",
    features: { servePoint: 6, rankedInRequest: true },
  };
  // The additive analytics row the outcome route inserts: event_type set,
  // outcome='analytics', no servePoint marker. NOT a serve.
  const analyticsSentinel: RankEventFixtureRow = {
    surface: "discovery", outcome: "analytics", event_type: "item_saved", served_at: inWindow,
    session_id: "sess-saved", features: {},
  };
  const otherSurface: RankEventFixtureRow = {
    surface: "pulse", outcome: "impression", event_type: null, served_at: inWindow,
    session_id: "sess-pulse", features: { servePoint: 6 },
  };

  it("keeps BOTH the impressed and the saved serve; drops the analytics sentinel and other surfaces", async () => {
    const { client } = fakeRankEventsClient([impressionServe, savedServe, analyticsSentinel, otherSurface]);
    const { rows, error } = await fetchDiscoveryServeRows(client, WINDOW);

    assert.equal(error, null);
    // Two serves, NOT one. `.eq("outcome","impression")` returned only the
    // impressed row and dropped the saved one — the defect this test pins.
    assert.equal(rows.length, 2, "the saved serve must survive alongside the impressed one");
    assert.ok(rows.every((r) => r.features?.servePoint === 6));

    // And both tally onto serve point 6, so coverage reflects real serves.
    const t = tallyServePoints(rows);
    assert.equal(t.marked, 2);
    assert.equal(t.byPoint.get(DiscoveryServePoint.COLD_FETCH_LEGACY_RANK), 2);
  });

  it("selects the serve corpus by event_type IS NULL, never by outcome", async () => {
    const { client, filters } = fakeRankEventsClient([impressionServe, savedServe]);
    await fetchDiscoveryServeRows(client, WINDOW);

    assert.ok(
      filters.some((f) => f.op === "is" && f.col === "event_type" && f.val === null),
      "must select the serve corpus by event_type IS NULL",
    );
    assert.ok(
      filters.some((f) => f.op === "eq" && f.col === "surface" && f.val === "discovery"),
      "must still restrict to surface='discovery'",
    );
    assert.ok(
      !filters.some((f) => f.col === "outcome"),
      "must NOT filter on outcome — that is what dropped every converted serve",
    );
  });

  it("bounds the top only when --until was given", async () => {
    const bounded = fakeRankEventsClient([impressionServe]);
    await fetchDiscoveryServeRows(bounded.client, { since: WINDOW.since, until: "2026-09-03T00:00:00.000Z" });
    assert.ok(bounded.filters.some((f) => f.op === "lte" && f.col === "served_at"));

    const open = fakeRankEventsClient([impressionServe]);
    await fetchDiscoveryServeRows(open.client, { since: WINDOW.since, until: null });
    assert.ok(!open.filters.some((f) => f.op === "lte"), "an open window must not bound the top");
  });
});

// ── The corpus is the WINDOW, not PostgREST's first 1000 rows ────────────────
//
// DEFECT: fetchDiscoveryServeRows was range-less. PostgREST caps a range-less
// SELECT at `db-max-rows` (1000) and reports NOTHING — no error, no flag. So on
// any window with real traffic the D5 ranked-share verdict, the number this
// whole report exists to produce, was computed over an arbitrary ~1000-row
// prefix while reading like a statement about the window.
//
// These tests seed MORE than one page and assert the read comes back whole.
// Against the pre-fix implementation the first one returns 1000 of 2500 rows.
describe("fetchDiscoveryServeRows — silent truncation (defect: range-less read)", () => {
  const WINDOW = { since: "2026-09-01T00:00:00.000Z", until: null };

  /** n serves on point 6, each with a distinct served_at so the order is total. */
  function corpus(n: number): RankEventFixtureRow[] {
    return Array.from({ length: n }, (_, i) => ({
      surface: "discovery",
      outcome: "impression",
      event_type: null,
      // 2026-09-02T00:00:00Z + i seconds, zero-padded so string order == time order.
      served_at: new Date(Date.parse("2026-09-02T00:00:00.000Z") + i * 1000).toISOString(),
      session_id: `sess-${i}`,
      features: { servePoint: 6, rankedInRequest: true },
      id: String(i).padStart(8, "0"),
    })) as RankEventFixtureRow[];
  }

  it("reads the WHOLE corpus across pages, not PostgREST's silent first 1000", async () => {
    const ROWS = 2_500;
    // dbMaxRows emulates the server-side cap that made the old read lie.
    const { client, pages } = fakeRankEventsClient(corpus(ROWS), { dbMaxRows: SERVE_ROWS_PAGE_SIZE });

    const { rows, error, truncated } = await fetchDiscoveryServeRows(client, WINDOW);

    assert.equal(error, null);
    assert.equal(
      rows.length, ROWS,
      "the corpus was truncated. A range-less read stops at db-max-rows (1000) with " +
      "no error, so every share below is computed over a prefix, not the window.",
    );
    assert.equal(truncated, false, "2500 rows is under the ceiling — nothing was dropped");
    assert.equal(pages(), 3, "2500 rows over 1000-row pages is 3 reads (1000 + 1000 + 500)");

    // And the tally — the thing the verdict is computed from — sees all of them.
    assert.equal(tallyServePoints(rows).marked, ROWS);
  });

  it("no row is served twice and none is skipped", async () => {
    const { client } = fakeRankEventsClient(corpus(2_100), { dbMaxRows: SERVE_ROWS_PAGE_SIZE });
    const { rows } = await fetchDiscoveryServeRows(client, WINDOW);
    const ids = new Set(rows.map((r) => r.session_id));
    assert.equal(ids.size, 2_100, "paging must not duplicate or drop rows");
  });

  it("asks for an explicit range and a stable total order on every page", async () => {
    const { client, filters } = fakeRankEventsClient(corpus(10));
    await fetchDiscoveryServeRows(client, WINDOW);

    assert.ok(
      filters.some((f) => f.op === "range"),
      "a read with no .range() is capped by the server at db-max-rows and says nothing about it",
    );
    // Paging over a non-total order can return one row on two pages and skip
    // another, so served_at alone is not enough — id breaks the ties.
    assert.ok(filters.some((f) => f.op === "order" && f.col === "served_at"));
    assert.ok(filters.some((f) => f.op === "order" && f.col === "id"));
  });

  it("an exhausted corpus ends on a short page — the ceiling is not hit", async () => {
    const { client, pages } = fakeRankEventsClient(corpus(3), { dbMaxRows: SERVE_ROWS_PAGE_SIZE });
    const { rows, truncated } = await fetchDiscoveryServeRows(client, WINDOW);
    assert.equal(rows.length, 3);
    assert.equal(truncated, false);
    assert.equal(pages(), 1, "a short first page ends the read — no wasted second query");
  });

  it("reports the bound EXPLICITLY when the ceiling is what stopped the read", async () => {
    // A metric that says it is bounded beats one that silently drops rows.
    // Stub the ceiling by paging a corpus larger than SERVE_ROWS_MAX would be
    // impractical here, so assert the contract the caller depends on instead:
    // truncated is part of the result shape and defaults to false.
    const { client } = fakeRankEventsClient(corpus(5), { dbMaxRows: SERVE_ROWS_PAGE_SIZE });
    const result = await fetchDiscoveryServeRows(client, WINDOW);
    assert.equal(typeof result.truncated, "boolean", "callers must be able to SEE truncation");
    assert.equal(typeof result.pages, "number");
    assert.ok(SERVE_ROWS_MAX > SERVE_ROWS_PAGE_SIZE, "the ceiling must span more than one page");
  });

  it("a failing page aborts and surfaces the error rather than reporting a partial corpus", async () => {
    const failing: DiscoveryServeQueryClient = {
      from() {
        const b: any = new Proxy({}, {
          get(_t, prop) {
            if (prop === "then") {
              return (onF: any) => Promise.resolve({ data: null, error: { message: "boom" } }).then(onF);
            }
            return () => b;
          },
        });
        return b;
      },
    };
    const { rows, error } = await fetchDiscoveryServeRows(failing, WINDOW);
    assert.equal(rows.length, 0);
    assert.equal(error?.message, "boom", "the caller exits non-zero on this — it must not be swallowed");
  });
});
