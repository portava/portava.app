/**
 * discoveryRankProvenance — census-discovery DC-17, the RANK half.
 *
 * THE ROW, AND THE ONE FIELD IT RECORDS AS MISSING
 * ================================================
 * `docs/specs/discovery-v1/10_Database_Architecture.md:115`:
 *
 *   "Derived features must retain: source event window · feature version ·
 *    model version · computation time"
 *
 * DC-17 grades the rank path 3 of 4. `DISCOVERY_MODEL_VERSION`,
 * `DISCOVERY_FEATURE_VERSION` and `rankedAt` are carried on every row of a
 * ranked page; the SOURCE EVENT WINDOW is not carried at all. A consumer
 * holding a `DiscoveryRankProvenance` — and one does hold it: the Sensing §8
 * `DiscoveryCandidate` projection stores the whole record on the served row
 * (lib/discoveryCandidate.ts) — can say which model ranked the page and when,
 * and cannot say which events could have reached that model.
 *
 * WHAT THE ANSWER ACTUALLY IS, AND WHY IT IS NOT A DURATION
 * =========================================================
 * The Compass discovery ranker's DB-derived inputs, all of them, are:
 *
 *   compass/CompassFeedBuilder.ts  preloadFairExposureData reads
 *                                  `compass_visibility_boosts.appearance_count`
 *                                  with NO time predicate — a running counter.
 *   services/ranking/FeedSlotAllocator.ts
 *                                  loadUnderexposedItemIds reads
 *                                  `content_distribution_stats` with NO time
 *                                  predicate — a standing status column.
 *   compass/CompassActiveUserRewardEngine.ts
 *                                  loadEvents bounds `compass_active_user_events`
 *                                  at 365 days — the ONLY bounded input.
 *
 * Two of the three are aggregates with no oldest contributing event, so the
 * page's window has a definite END (the clock the ranker returned on) and no
 * definite start. The honest record of that is "unbounded start", not a
 * fabricated 365-day span and not a zero: an epoch-0 start would claim the
 * corpus begins in 1970, which is a measurement nobody took.
 *
 * TWO ABSENCES MUST NOT READ ALIKE
 * ================================
 * Three different things are all "no window", and a consumer that cannot tell
 * them apart is the defect this row exists to catch:
 *
 *   no oldest event at all          kind "unbounded_start", startMs null
 *   a window that admitted nothing  kind "bounded", startMs === endMs
 *   no provenance record was built  the provenance field is null
 *
 * `windowSpanMs` is the accessor that keeps the first two apart in arithmetic:
 * null for unbounded, 0 for zero-width. `Number(null)` is 0, so a consumer that
 * skipped the discriminant and subtracted would read an unbounded corpus as a
 * zero-width one — the exact confusion the union exists to prevent, and the
 * reason the accessor exists rather than a bare pair of numbers.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryRankProvenance.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectDiscoveryCandidate } from "../lib/discoveryCandidate.js";
import {
  buildRankProvenance,
  candidateSourceMap,
  derivedStoreProvenance,
  rankSourceWindow,
  windowSpanMs,
  DISCOVERY_MODEL_VERSION,
  DISCOVERY_FEATURE_VERSION,
  type DerivedStoreWindow,
  type RankedPipelineRow,
} from "../lib/discoveryRankProvenance.js";

const RANKED_AT = Date.parse("2026-09-04T12:00:00Z");

const row = (id: string, factors: Array<[string, number]> = [["taste", 0.5]]): RankedPipelineRow => ({
  item: { id },
  finalScore: 1,
  compassMatch: 0.5,
  communityScore: 0.25,
  rankingFactors: factors.map(([key, weight]) => ({ key, weight })),
});

const PAGE: RankedPipelineRow[] = [row("db/a"), row("osm/b"), row("db/c")];
const SOURCES = candidateSourceMap(["db/a", "db/c"], ["osm/b"]);

// ── DC-17 field 4 of 4: the source event window ──────────────────────────────

describe("DC-17 — a ranked page records which events could have reached the ranker", () => {
  it("every row carries a source event window beside the two versions and the clock", () => {
    const out = buildRankProvenance(PAGE, SOURCES, RANKED_AT);
    assert.equal(out.size, 3, "fixture must produce rows or this asserts nothing");
    for (const [id, p] of out) {
      assert.equal(p.modelVersion,   DISCOVERY_MODEL_VERSION,   `${id}: model version`);
      assert.equal(p.featureVersion, DISCOVERY_FEATURE_VERSION, `${id}: feature version`);
      assert.equal(p.rankedAt,       RANKED_AT,                 `${id}: computation time`);
      assert.ok(p.sourceWindow, `${id}: DC-17 field 4 — source event window`);
    }
  });

  it("the window ENDS at the clock the ranker returned on — never at a read time", () => {
    const out = buildRankProvenance(PAGE, SOURCES, RANKED_AT);
    for (const [id, p] of out) {
      assert.equal(p.sourceWindow.endMs, p.rankedAt, `${id}: window end is the ranking timestamp`);
      assert.equal(p.sourceWindow.endMs, RANKED_AT, `${id}: and it is the clock the caller read once`);
    }
  });

  it("the window has NO oldest event, because two of the ranker's three inputs are running aggregates", () => {
    const p = buildRankProvenance(PAGE, SOURCES, RANKED_AT).get("db/a")!;
    assert.equal(p.sourceWindow.kind, "unbounded_start");
    assert.equal(p.sourceWindow.startMs, null, "an unbounded corpus has no start, not a start of zero");
  });

  it("an unbounded start is never reported as a plausible-looking default", () => {
    // The defect this whole row exists to catch. Epoch 0, the rank clock minus
    // some invented span, and any finite number at all are each a claim about a
    // corpus nobody measured.
    const w = buildRankProvenance(PAGE, SOURCES, RANKED_AT).get("db/a")!.sourceWindow;
    assert.notEqual(w.startMs, 0, "epoch 0 would claim the corpus begins in 1970");
    assert.equal(typeof w.startMs, "object", "the only honest start here is null");
    assert.equal(windowSpanMs(w), null, "an unbounded window has no span to report");
  });

  it("one page, one window object — shared by reference so N rows cannot drift apart", () => {
    const out = buildRankProvenance(PAGE, SOURCES, RANKED_AT);
    const [first, ...rest] = [...out.values()];
    for (const p of rest) {
      assert.equal(p.sourceWindow, first!.sourceWindow, "every row of one rank shares one window");
    }
  });

  it("the window is not a field the caller can mint — buildRankProvenance stamps it", () => {
    // Same rule as the version pair: a caller that could hand in its own window
    // could describe a corpus the ranker never read.
    const a = buildRankProvenance(PAGE, SOURCES, RANKED_AT).get("db/a")!.sourceWindow;
    const b = rankSourceWindow(RANKED_AT);
    assert.deepEqual({ ...a }, { ...b });
  });
});

// ── Requirement 4: three absences, three readings ────────────────────────────

describe("DC-17 — a missing window, an empty window and a missing record read differently", () => {
  const unbounded: DerivedStoreWindow = rankSourceWindow(RANKED_AT);
  const zeroWidth: DerivedStoreWindow = { kind: "bounded", startMs: RANKED_AT, endMs: RANKED_AT };
  const real:      DerivedStoreWindow = { kind: "bounded", startMs: RANKED_AT - 60_000, endMs: RANKED_AT };

  it("unbounded and zero-width are not the same value", () => {
    assert.notDeepEqual({ ...unbounded }, { ...zeroWidth });
    assert.notEqual(unbounded.kind, zeroWidth.kind);
  });

  it("windowSpanMs keeps them apart in arithmetic: null vs 0 vs a span", () => {
    assert.equal(windowSpanMs(unbounded), null, "no oldest event ⇒ no span");
    assert.equal(windowSpanMs(zeroWidth), 0,    "a window that admitted nothing ⇒ a span of zero");
    assert.equal(windowSpanMs(real),      60_000);
  });

  it("the naive subtraction a consumer would otherwise write is the confusion the union prevents", () => {
    // `Number(null)` is 0: without the discriminant, an unbounded corpus and a
    // zero-width one produce the same number. The accessor is the fix, and this
    // asserts the trap is real rather than hypothetical.
    assert.equal(unbounded.endMs - Number(unbounded.startMs), RANKED_AT);
    assert.notEqual(windowSpanMs(unbounded), windowSpanMs(zeroWidth));
  });

  it("a record that was never built is null — never a record with a blank window", () => {
    // lib/discoveryCandidate.ts:295 is the consumer that does this: no rank, no
    // record. A DiscoveryRankProvenance with a zeroed window would assert that a
    // rank happened over no events, which is a different and false claim.
    const noRank = buildRankProvenance([], SOURCES, RANKED_AT);
    assert.equal(noRank.get("db/a"), undefined, "no ranked row ⇒ no record, not an empty one");
  });
});

// ── One vocabulary for all three producers ───────────────────────────────────

describe("DC-17 — the rank window and the derived-store window are the same type", () => {
  it("a derived store still declares a BOUNDED window, and says so", () => {
    const p = derivedStoreProvenance({ kind: "bounded", startMs: RANKED_AT - 1_000, endMs: RANKED_AT }, RANKED_AT);
    assert.equal(p.window.kind, "bounded");
    assert.equal(p.window.startMs, RANKED_AT - 1_000);
    assert.equal(windowSpanMs(p.window), 1_000);
  });

  it("the versions a stamped record claims are the constants it read, not the caller's", () => {
    const p = derivedStoreProvenance({ kind: "bounded", startMs: 0, endMs: RANKED_AT }, RANKED_AT);
    assert.equal(p.modelVersion,   DISCOVERY_MODEL_VERSION);
    assert.equal(p.featureVersion, DISCOVERY_FEATURE_VERSION);
    const r = buildRankProvenance(PAGE, SOURCES, RANKED_AT).get("osm/b")!;
    assert.equal(r.modelVersion,   DISCOVERY_MODEL_VERSION);
    assert.equal(r.featureVersion, DISCOVERY_FEATURE_VERSION);
  });

  it("the window is copied, so a later mutation of the caller's bounds cannot rewrite history", () => {
    const mine = { kind: "bounded" as const, startMs: 10, endMs: 20 };
    const p = derivedStoreProvenance(mine, RANKED_AT);
    mine.startMs = 999;
    assert.equal(p.window.startMs, 10);
  });
});

// ── The consumer that actually holds the record ──────────────────────────────

describe("DC-17 — the window reaches the consumer that keeps the record", () => {
  it("the Sensing §8 candidate projection carries the whole stamped record, window included", () => {
    // lib/discoveryCandidate.ts:295 looks the record up and :318 stores it on
    // the served row. Nothing there had to change for the fourth field to
    // arrive — but "nothing had to change" is exactly the claim that needs a
    // test, because a provenance value nobody reads is not retained.
    const c = projectDiscoveryCandidate({ id: "db/a" }, {
      cacheLevel: "compass_fresh_rank", cachedAt: RANKED_AT - 1_000, scoredById: null,
      rankedBy: "compass", nowMs: RANKED_AT,
      provenanceById: buildRankProvenance(PAGE, SOURCES, RANKED_AT),
    });
    assert.ok(c.provenance, "the projection must hold a record or this asserts nothing");
    assert.equal(c.provenance!.sourceWindow!.kind, "unbounded_start");
    assert.equal(c.provenance!.sourceWindow!.endMs, RANKED_AT);
    assert.equal(windowSpanMs(c.provenance!.sourceWindow!), null);
  });

  it("no rank ⇒ the projection holds null, which is the third absence", () => {
    const c = projectDiscoveryCandidate({ id: "db/a" }, {
      cacheLevel: "L1", cachedAt: null, scoredById: null, rankedBy: "none", nowMs: RANKED_AT,
    });
    assert.equal(c.provenance, null, "no record at all — not a record with a blank window");
  });
});

// ── Nothing else on the record moved ─────────────────────────────────────────

describe("DC-17 — adding the fourth field changes no other field", () => {
  it("source, reasons, features and scores are what they were", () => {
    const p = buildRankProvenance([row("db/a", [["taste", 0.9], ["proximity", 0.1]])], SOURCES, RANKED_AT).get("db/a")!;
    assert.equal(p.candidateSource, "curated_db");
    assert.deepEqual(p.reasons, ["taste", "proximity"]);
    assert.deepEqual(p.features, { factor_taste: 0.9, factor_proximity: 0.1 });
    assert.deepEqual(p.scores, { finalScore: 1, compassMatch: 0.5, communityScore: 0.25 });
  });
});
