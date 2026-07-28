/**
 * Unit tests for buildPlaceAffinities + place-engagement boost end-to-end.
 *
 * Runtime: node:test  (no vitest)
 * Run via: pnpm --filter @workspace/api-server test (api-test workflow)
 *
 * Covers:
 *   A. Two rows for the same place → count 2
 *   B. Rows from different places are counted independently
 *   C. Empty result set → empty object
 *   D. Null DB client → empty object (non-fatal)
 *   E. DB error response → empty object (non-fatal)
 *   F. Thrown exception from DB → empty object (non-fatal)
 *   G. Custom nowMs accepted without throwing (injectable for tests)
 *
 *   H. (end-to-end) candidate with placeId + affinity ≥ threshold scores higher
 *   I. (end-to-end) candidate with placeId but affinity below threshold gets no boost
 *   J. (end-to-end) candidate without placeId is unaffected even when placeAffinities populated
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPlaceAffinities } from "../MediaFeedRankingService.js";
import {
  scoreCandidate,
  PLACE_ENGAGEMENT_BOOST,
  PLACE_ENGAGEMENT_BOOST_THRESHOLD,
  type RankCandidate,
  type ViewerContext,
} from "../../../lib/portavaRank.js";

// ── Fake Supabase client builder ───────────────────────────────────────────────

function fakeClient(
  rows: { item_id: string }[] | null,
  opts: { throws?: boolean } = {},
): any {
  if (opts.throws) {
    return { from: () => { throw new Error("db connection failed"); } };
  }

  const terminal = {
    data:  rows,
    error: rows === null ? { message: "db error" } : null,
  };

  function chainable(): any {
    return {
      select: () => chainable(),
      eq:     () => chainable(),
      gte:    () => chainable(),
      then(
        resolve?: (v: typeof terminal) => unknown,
        reject?: (e: unknown) => unknown,
      ) {
        return Promise.resolve(terminal).then(resolve, reject);
      },
    };
  }

  return { from: (_table: string) => chainable() };
}

// ── A. Two rows for the same place → count 2 ─────────────────────────────────

describe("buildPlaceAffinities — basic counting", () => {
  it("A: two rows with the same item_id produce count 2", async () => {
    const sc = fakeClient([
      { item_id: "place-abc" },
      { item_id: "place-abc" },
    ]);

    const result = await buildPlaceAffinities(sc, "user-1");

    assert.equal(result["place-abc"], 2, "expected count 2 for place-abc");
  });
});

// ── B. Multiple places counted independently ──────────────────────────────────

describe("buildPlaceAffinities — multiple places", () => {
  it("B: three rows across two places produce independent counts", async () => {
    const sc = fakeClient([
      { item_id: "place-x" },
      { item_id: "place-y" },
      { item_id: "place-x" },
    ]);

    const result = await buildPlaceAffinities(sc, "user-1");

    assert.equal(result["place-x"], 2, "place-x should have count 2");
    assert.equal(result["place-y"], 1, "place-y should have count 1");
  });

  it("B2: single row produces count 1", async () => {
    const sc = fakeClient([{ item_id: "place-solo" }]);
    const result = await buildPlaceAffinities(sc, "user-1");
    assert.equal(result["place-solo"], 1);
  });
});

// ── C. Empty result set ───────────────────────────────────────────────────────

describe("buildPlaceAffinities — empty result", () => {
  it("C: no matching rows returns empty object", async () => {
    const sc = fakeClient([]);
    const result = await buildPlaceAffinities(sc, "user-1");
    assert.deepEqual(result, {});
  });
});

// ── D. Null client → empty object ─────────────────────────────────────────────

describe("buildPlaceAffinities — null client", () => {
  it("D: null Supabase client returns empty object without throwing", async () => {
    const result = await buildPlaceAffinities(null, "user-1");
    assert.deepEqual(result, {});
  });
});

// ── E–F. Error handling ───────────────────────────────────────────────────────

describe("buildPlaceAffinities — DB error handling", () => {
  it("E: DB error response (data: null) returns empty object", async () => {
    const sc = fakeClient(null);
    const result = await buildPlaceAffinities(sc, "user-1");
    assert.deepEqual(result, {});
  });

  it("F: thrown exception from DB client returns empty object", async () => {
    const sc = fakeClient(null, { throws: true });
    const result = await buildPlaceAffinities(sc, "user-1");
    assert.deepEqual(result, {});
  });
});

// ── G. nowMs injection ────────────────────────────────────────────────────────

describe("buildPlaceAffinities — nowMs injection", () => {
  it("G: accepts a custom nowMs without throwing (injectable for tests)", async () => {
    const sc = fakeClient([{ item_id: "place-time" }]);
    const fixedNow = new Date("2026-01-15T00:00:00Z").getTime();
    const result = await buildPlaceAffinities(sc, "user-1", fixedNow);
    assert.equal(result["place-time"], 1);
  });
});

// ── H–J. End-to-end: boost fires (or doesn't) in scoreCandidate ───────────────

const BASE_VIEWER: ViewerContext = {
  userId: "viewer-1",
  nowMs:  1_000_000_000_000,
};

/** Candidate with a placeId and a non-zero base score (recent + followed author). */
function makeCandidate(placeId: string | null): RankCandidate {
  return {
    id:        "item-1",
    kind:      "post",
    placeId,
    // Give a recent createdAt so recency score is non-zero (boost is multiplicative —
    // a zero base score would produce a zero boost delta, making the test vacuous).
    createdAt: new Date(BASE_VIEWER.nowMs! - 3_600_000).toISOString(), // 1h ago
    authorId:  "author-followed",
  };
}

/** Viewer that follows the candidate's author so base score is firmly > 0. */
const VIEWER_WITH_FOLLOWS: ViewerContext = {
  ...BASE_VIEWER,
  followedIds: new Set(["author-followed"]),
};

describe("scoreCandidate — place-engagement boost end-to-end", () => {
  it("H: placeId + affinity ≥ threshold multiplies score by PLACE_ENGAGEMENT_BOOST", () => {
    const affinities: Record<string, number> = {
      "place-boost": PLACE_ENGAGEMENT_BOOST_THRESHOLD, // exactly at threshold
    };

    const withBoost    = scoreCandidate(makeCandidate("place-boost"), { ...VIEWER_WITH_FOLLOWS, placeAffinities: affinities });
    const withoutBoost = scoreCandidate(makeCandidate("place-boost"), VIEWER_WITH_FOLLOWS);

    // features.placeEngagement must be present and positive when boost fires.
    assert.ok(
      (withBoost.features.placeEngagement ?? 0) > 0,
      "features.placeEngagement should be positive when affinity meets threshold",
    );

    // Score with boost should be exactly PLACE_ENGAGEMENT_BOOST × score without boost.
    const expected = withoutBoost.score * PLACE_ENGAGEMENT_BOOST;
    assert.ok(
      Math.abs(withBoost.score - expected) < 1e-10,
      `score with boost (${withBoost.score}) should equal ${expected} (base × ${PLACE_ENGAGEMENT_BOOST})`,
    );
  });

  it("I: placeId + affinity below threshold produces no boost", () => {
    const affinities: Record<string, number> = {
      "place-low": PLACE_ENGAGEMENT_BOOST_THRESHOLD - 1, // one below threshold
    };

    const result = scoreCandidate(makeCandidate("place-low"), { ...VIEWER_WITH_FOLLOWS, placeAffinities: affinities });

    assert.equal(
      result.features.placeEngagement ?? 0,
      0,
      "features.placeEngagement should be absent/zero below threshold",
    );
  });

  it("J: candidate without placeId is unaffected even when placeAffinities is populated", () => {
    const affinities: Record<string, number> = {
      "place-other": PLACE_ENGAGEMENT_BOOST_THRESHOLD + 5,
    };

    const withAffinities = scoreCandidate(makeCandidate(null), { ...VIEWER_WITH_FOLLOWS, placeAffinities: affinities });
    const plain          = scoreCandidate(makeCandidate(null), VIEWER_WITH_FOLLOWS);

    assert.equal(withAffinities.score, plain.score, "score should be identical when placeId is null");
    assert.equal(withAffinities.features.placeEngagement ?? 0, 0, "no placeEngagement feature when placeId absent");
  });
});
