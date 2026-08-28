/**
 * Discovery — the learned-preference input the ranker was never handed.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST (2026-08-28)
 * ----------------------------------------------
 * portavaRank computes
 *
 *     const affinity = c.category ? ctx.categoryAffinities?.[c.category] ?? 0 : 0;
 *     f.categoryAffinity = w.categoryAffinity * Math.min(1, Math.max(0, affinity));
 *
 * with `categoryAffinity: 0.4` in DEFAULT_WEIGHTS. But the ViewerContext built in
 * discoveryPde never set `categoryAffinities`, so the optional chain yielded
 * undefined and the term was a constant 0 on every Discovery request. The signal
 * exists in `compass_user_preferences.category_weights` and was simply not read.
 *
 * THE TRAP, which is the actual reason this file exists
 * ----------------------------------------------------
 * category_weights holds RAW OBSERVATION COUNTS — production holds
 * {"food": 4, "post": 1, "places": 10}. Because portavaRank CLAMPS with
 * Math.min(1, ...), passing raw counts straight through sends every category
 * with a count >= 1 to exactly 1.0. Every candidate then gets the identical
 * categoryAffinity term, which is a constant added to every score and therefore
 * changes NO ordering whatsoever — the same defect as before, now wearing the
 * appearance of a working feature. A test that only asserted "affinities are
 * populated" would pass on that broken version, so these tests assert
 * DISCRIMINATION: different categories must receive different values.
 *
 * Pure and offline — no database, no network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normaliseCategoryAffinities } from "../lib/discoveryPde.js";
import { rankCandidates, DEFAULT_WEIGHTS } from "../lib/portavaRank.js";

describe("normaliseCategoryAffinities", () => {
  it("maps the production shape onto 0..1 while PRESERVING the ordering the counts express", () => {
    // the exact row shape observed in production
    const a = normaliseCategoryAffinities({ food: 4, post: 1, places: 10 });
    assert.ok(a, "a viewer with 15 observations has a preference");
    assert.equal(a!.places, 1);      // the most-chosen category anchors the scale
    assert.equal(a!.food, 0.4);
    assert.equal(a!.post, 0.1);
    assert.ok(a!.places > a!.food && a!.food > a!.post, "relative ordering must survive");
  });

  it("does NOT hand back raw counts — the clamp would flatten them to a constant", () => {
    const a = normaliseCategoryAffinities({ food: 4, post: 1, places: 10 })!;
    for (const [k, v] of Object.entries(a)) {
      assert.ok(v >= 0 && v <= 1, `${k} = ${v} is outside the documented 0..1 range`);
    }
    // The specific regression: if this ever returns counts, min(1,·) makes every
    // category identical and the feature silently stops affecting order.
    assert.notEqual(a.places, a.food, "distinct counts must stay distinct after normalisation");
  });

  it("drops the map entirely below the observation floor — one tap is not a preference", () => {
    assert.equal(normaliseCategoryAffinities({ food: 1 }), undefined);
    assert.equal(normaliseCategoryAffinities({ food: 1, post: 1 }), undefined);
    // at the floor it engages
    assert.ok(normaliseCategoryAffinities({ food: 2, post: 1 }));
  });

  it("ignores junk without throwing, and treats an all-junk row as no signal", () => {
    assert.equal(normaliseCategoryAffinities(null), undefined);
    assert.equal(normaliseCategoryAffinities(undefined), undefined);
    assert.equal(normaliseCategoryAffinities("nope"), undefined);
    assert.equal(normaliseCategoryAffinities([1, 2, 3]), undefined);
    assert.equal(normaliseCategoryAffinities({ food: 0, bar: -5, baz: "x" }), undefined);
    // numeric strings are still counts
    const a = normaliseCategoryAffinities({ food: "4", places: "10" });
    assert.equal(a?.places, 1);
    assert.equal(a?.food, 0.4);
  });

  it("is case-tolerant, because the lookup uses the candidate's own casing", () => {
    const a = normaliseCategoryAffinities({ Food: 10, Places: 5 })!;
    assert.equal(a["Food"], 1, "original casing must resolve");
    assert.equal(a["food"], 1, "lowercased casing must resolve to the same value");
  });
});

describe("categoryAffinity actually changes Discovery ordering", () => {
  const candidate = (id: string, category: string) => ({
    id, kind: "place" as const, category, city: "lisbon",
  });

  it("re-orders candidates toward the viewer's preferred category", () => {
    const candidates = [candidate("p-post", "post"), candidate("p-places", "places")];
    const ctx = {
      userId: "u1",
      city: "lisbon",
      categoryAffinities: normaliseCategoryAffinities({ food: 4, post: 1, places: 10 }),
    };

    const scored = rankCandidates(candidates as any, ctx as any);
    const byId = new Map(scored.map((s: any) => [s.candidate.id, s]));
    const places = byId.get("p-places")!;
    const post = byId.get("p-post")!;

    assert.ok(
      places.features.categoryAffinity > post.features.categoryAffinity,
      "the preferred category must score higher",
    );
    // 0.4 weight × (1.0 − 0.1) = 0.36 of separation created by this feature alone
    assert.ok(
      Math.abs((places.features.categoryAffinity - post.features.categoryAffinity)
               - DEFAULT_WEIGHTS.categoryAffinity * 0.9) < 1e-9,
      "separation must equal weight × affinity delta",
    );
    assert.equal(scored[0].candidate.id, "p-places", "and it must win the ordering");
  });

  it("contributes exactly nothing when the viewer has no learned preference", () => {
    const candidates = [candidate("a", "post"), candidate("b", "places")];
    const scored = rankCandidates(candidates as any, { userId: "u1", city: "lisbon" } as any);
    for (const s of scored as any[]) {
      assert.equal(s.features.categoryAffinity, 0,
        "no signal must mean no contribution, not a guess");
    }
  });
});
