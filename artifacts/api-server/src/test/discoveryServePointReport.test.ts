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
  RANKED_POINTS,
  SERVE_POINT_LABEL,
  assertLabelsCoverEnum,
  countOn,
  observedPoints,
  tallyServePoints,
  unexercisedPoints,
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

  it("reports ONE serve point observed and the other eight unexercised", () => {
    const t = tallyServePoints(PRODUCTION_ROWS_20260815);

    assert.deepEqual(observedPoints(t), [DiscoveryServePoint.SUGGEST]);
    assert.deepEqual(unexercisedPoints(t), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("attributes zero of them to GET /discovery, so the D5 population is empty", () => {
    const t = tallyServePoints(PRODUCTION_ROWS_20260815);

    // This is the number that stops the D5 clause dividing. Serve point 9 is
    // suggest: it contains no ranker call, so these are not serves that could
    // have been ranked and lost.
    assert.equal(countOn(t, DISCOVERY_ENDPOINT_POINTS), 0);
    assert.equal(countOn(t, RANKED_POINTS), 0);

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
      { features: { servePoint: 10 } },
      { features: { servePoint: 99 } },
      { features: { servePoint: "banana" } },
      { features: { servePoint: 9 } },
    ]);

    assert.equal(t.unknownMarker, 3);
    assert.equal(t.noMarker, 0, "an unrecognised marker is NOT a missing marker");
    assert.deepEqual([...t.unknownValues].sort(), ["10", "99", "banana"]);
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

  it("recognises every serve point the writer can emit, 1 through 9", () => {
    assert.deepEqual([...ALL_SERVE_POINTS], [1, 2, 3, 4, 5, 6, 7, 8, 9]);

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
      assert.equal(RANKED_POINTS.has(sp), false, `serve point ${sp} runs no ranker`);
    }
  });

  it("ranked and cache-A sets are subsets of GET /discovery", () => {
    for (const sp of RANKED_POINTS) assert.ok(DISCOVERY_ENDPOINT_POINTS.has(sp));
    for (const sp of CACHE_A_POINTS) assert.ok(DISCOVERY_ENDPOINT_POINTS.has(sp));
    assert.deepEqual([...RANKED_POINTS].sort((a, b) => a - b), [5, 6]);
    assert.deepEqual([...CACHE_A_POINTS].sort((a, b) => a - b), [1, 2, 3]);
  });

  it("a mixed window splits into the two populations without summing them", () => {
    const t = tallyServePoints([
      { features: { servePoint: 1 } },
      { features: { servePoint: 1 } },
      { features: { servePoint: 6 } },
      { features: { servePoint: 9 } },
      { features: { servePoint: 9 } },
      { features: { servePoint: 9 } },
    ]);

    assert.equal(t.marked, 6);
    assert.equal(countOn(t, DISCOVERY_ENDPOINT_POINTS), 3);
    assert.equal(countOn(t, RANKED_POINTS), 1);

    // The distinction the D5 clause turns on: 1/3 over GET /discovery serves,
    // NOT 1/6 over every marked row. The second understates it by half, and
    // always in the direction that confirms the packet.
    assert.equal(countOn(t, RANKED_POINTS) / countOn(t, DISCOVERY_ENDPOINT_POINTS), 1 / 3);
    assert.notEqual(countOn(t, RANKED_POINTS) / t.marked, 1 / 3);
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
    assert.deepEqual(unexercisedPoints(t), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
