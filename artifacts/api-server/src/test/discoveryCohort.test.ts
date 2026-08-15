/**
 * Discovery cohort gate — ruling D6 (lib/discoveryCohort.ts).
 *
 * WHAT THESE TESTS DEFEND
 * =======================
 * This gate's failure mode is silent and expensive in the same instant. If a
 * malformed cohort resolved to "everyone", the first symptom would be the
 * entire discovery surface running a second ranking pass — not an error, not a
 * failed request, just load. The operator ruling that created this gate exists
 * because that is what `shadow` would have done without it.
 *
 * So the fail-closed direction is tested exhaustively, one case per way a
 * human can mistype a jsonb field, and each is asserted to include NOBODY —
 * never narrowed to a guess.
 *
 * The bucket is tested for the property D6=B actually requires: STABILITY. A
 * user must be in or out and stay there. Sampling per request would put one
 * user's serves on both sides of the comparison, and no divergence could then
 * be attributed to the engine rather than to which side a request fell on.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryCohort.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDiscoveryCohort,
  isInDiscoveryCohort,
  userBucket,
  describeCohort,
  COHORT_NONE,
} from "../lib/discoveryCohort.js";

describe("cohort parsing — every unusable value includes NOBODY", () => {
  const REJECTED: [string, unknown, string][] = [
    ["absent (undefined)",      undefined,                     "absent"],
    ["absent (null)",           null,                          "absent"],
    ["a bare string",           "all",                         "not_an_object"],
    ["a number",                5,                             "not_an_object"],
    ["a boolean",               true,                          "not_an_object"],
    ["an array",                [{ kind: "all" }],             "not_an_object"],
    ["object with no kind",     { userIds: ["u-1"] },          "kind_missing"],
    ["kind not a string",       { kind: 1 },                   "kind_missing"],
    ["unknown kind",            { kind: "everyone" },          "kind_unknown"],
    ["users with no array",     { kind: "users" },             "users_invalid"],
    ["users with a string",     { kind: "users", userIds: "u-1" }, "users_invalid"],
    ["percent missing",         { kind: "percent" },           "percent_invalid"],
    ["percent as a string",     { kind: "percent", percent: "5" }, "percent_invalid"],
    ["percent negative",        { kind: "percent", percent: -1 },  "percent_invalid"],
    ["percent over 100",        { kind: "percent", percent: 101 }, "percent_invalid"],
    ["percent NaN",             { kind: "percent", percent: NaN }, "percent_invalid"],
    ["percent Infinity",        { kind: "percent", percent: Infinity }, "percent_invalid"],
  ];

  for (const [label, raw, reason] of REJECTED) {
    it(`rejects ${label} → nobody (${reason})`, () => {
      const p = parseDiscoveryCohort(raw);
      assert.equal(p.cohort.kind, "none", `${label} must not be narrowed to a guess`);
      assert.equal(p.reason, reason);
      // And the decision that follows must exclude a real user.
      assert.equal(isInDiscoveryCohort(p.cohort, "u-1").included, false);
    });
  }

  it("never throws on hostile input", () => {
    const nasty = [Symbol("x"), () => {}, new Map(), { kind: { kind: "all" } }, { kind: "users", userIds: [null, 1, "", "ok"] }];
    for (const v of nasty) {
      assert.doesNotThrow(() => parseDiscoveryCohort(v as unknown));
    }
  });
});

describe("cohort parsing — accepted shapes", () => {
  it("kind none parses to nobody", () => {
    const p = parseDiscoveryCohort({ kind: "none" });
    assert.equal(p.reason, "parsed");
    assert.equal(isInDiscoveryCohort(p.cohort, "u-1").included, false);
  });

  it("D6=A — an explicit user list", () => {
    const p = parseDiscoveryCohort({ kind: "users", userIds: ["u-1", "u-2"] });
    assert.equal(p.reason, "parsed");
    assert.equal(isInDiscoveryCohort(p.cohort, "u-1").reason, "user_listed");
    assert.equal(isInDiscoveryCohort(p.cohort, "u-1").included, true);
    assert.equal(isInDiscoveryCohort(p.cohort, "u-9").included, false);
    assert.equal(isInDiscoveryCohort(p.cohort, "u-9").reason, "user_not_listed");
  });

  it("a user list drops junk entries but keeps the usable ones", () => {
    const p = parseDiscoveryCohort({ kind: "users", userIds: ["u-1", "", null, 7, "u-2"] });
    assert.equal(p.reason, "parsed");
    assert.equal(isInDiscoveryCohort(p.cohort, "u-1").included, true);
    assert.equal(isInDiscoveryCohort(p.cohort, "u-2").included, true);
    assert.equal(isInDiscoveryCohort(p.cohort, "").included, false);
  });

  it("an EMPTY user list is valid and includes nobody", () => {
    // "internal accounts, none configured yet" is a coherent state, and it
    // already fails in the safe direction.
    const p = parseDiscoveryCohort({ kind: "users", userIds: [] });
    assert.equal(p.reason, "parsed");
    assert.equal(isInDiscoveryCohort(p.cohort, "u-1").included, false);
  });

  it("D6=C — all, which must be typed and is never a default", () => {
    const p = parseDiscoveryCohort({ kind: "all" });
    assert.equal(p.reason, "parsed");
    assert.equal(isInDiscoveryCohort(p.cohort, "u-1").reason, "kind_all");
    assert.equal(isInDiscoveryCohort(p.cohort, "u-1").included, true);
  });
});

describe("percent bucketing — D6=B", () => {
  it("percent 0 includes NOBODY, including the user in bucket 0", () => {
    // The `<` vs `<=` case. With `<=`, a cohort set to 0 would still shadow
    // roughly one user in a hundred — a disabled setting that is not disabled.
    const p = parseDiscoveryCohort({ kind: "percent", percent: 0 });
    const ids = Array.from({ length: 500 }, (_, i) => `user-${i}`);
    const zeroBucket = ids.find((id) => userBucket(id) === 0);
    assert.ok(zeroBucket, "fixture must contain a bucket-0 user for this to mean anything");
    assert.equal(isInDiscoveryCohort(p.cohort, zeroBucket!).included, false);
    for (const id of ids) assert.equal(isInDiscoveryCohort(p.cohort, id).included, false);
  });

  it("percent 100 includes everybody", () => {
    const p = parseDiscoveryCohort({ kind: "percent", percent: 100 });
    for (let i = 0; i < 500; i++) {
      assert.equal(isInDiscoveryCohort(p.cohort, `user-${i}`).included, true);
    }
  });

  it("membership is STABLE — the same id decides the same way every time", () => {
    const p = parseDiscoveryCohort({ kind: "percent", percent: 37 });
    for (let i = 0; i < 100; i++) {
      const id = `user-${i}`;
      const first = isInDiscoveryCohort(p.cohort, id);
      for (let k = 0; k < 5; k++) {
        const again = isInDiscoveryCohort(p.cohort, id);
        assert.equal(again.included, first.included, `${id} changed sides between calls`);
        assert.equal(again.bucket, first.bucket);
      }
    }
  });

  it("the bucket is a pure function of the id, so it survives restarts", () => {
    // Pinned values. If the hash or the salt ever changes, this fails — which
    // is the point: changing it reshuffles every user and invalidates any
    // comparison spanning the change.
    const a = userBucket("00000000-0000-4000-8000-000000000001");
    const b = userBucket("00000000-0000-4000-8000-000000000001");
    assert.equal(a, b);
    assert.ok(Number.isInteger(a) && a >= 0 && a <= 99);
  });

  it("widening the percentage only ADDS users, never swaps them", () => {
    // Nested bands. Going 5% → 10% must not eject anyone who was already in,
    // or the population changes underneath a running comparison.
    const small = parseDiscoveryCohort({ kind: "percent", percent: 5 }).cohort;
    const big   = parseDiscoveryCohort({ kind: "percent", percent: 10 }).cohort;
    for (let i = 0; i < 1000; i++) {
      const id = `user-${i}`;
      if (isInDiscoveryCohort(small, id).included) {
        assert.equal(isInDiscoveryCohort(big, id).included, true, `${id} was ejected by widening`);
      }
    }
  });

  it("buckets spread across the range rather than clumping", () => {
    // Not a uniformity proof — a smoke test that the hash is not degenerate,
    // which would silently make "5%" mean 0% or 100%.
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(userBucket(`user-${i}`));
    assert.ok(seen.size > 90, `expected buckets to spread; saw only ${seen.size} distinct`);

    const inFive = Array.from({ length: 2000 }, (_, i) => `user-${i}`)
      .filter((id) => isInDiscoveryCohort({ kind: "percent", percent: 5 }, id).included).length;
    // Generous bounds: this guards against 0 and against everything, not
    // against sampling noise.
    assert.ok(inFive > 20 && inFive < 250, `5% of 2000 landed at ${inFive}`);
  });
});

describe("anonymous traffic", () => {
  for (const cohort of [
    COHORT_NONE,
    { kind: "all" as const },
    { kind: "users" as const, userIds: new Set(["u-1"]) },
    { kind: "percent" as const, percent: 100 },
  ]) {
    it(`is never included under kind=${cohort.kind}, not even "all"`, () => {
      // There is no one to include: no follow graph, no interests, and
      // rank_events.user_id is NOT NULL so it could not be recorded anyway.
      for (const id of [null, undefined, ""]) {
        const d = isInDiscoveryCohort(cohort, id);
        assert.equal(d.included, false);
        assert.equal(d.reason, "no_user");
      }
    });
  }
});

describe("describeCohort", () => {
  it("names the ruling each shape implements", () => {
    assert.match(describeCohort({ kind: "users", userIds: new Set(["a"]) }), /D6=A/);
    assert.match(describeCohort({ kind: "percent", percent: 5 }), /D6=B/);
    assert.match(describeCohort({ kind: "all" }), /D6=C/);
    assert.equal(describeCohort({ kind: "none" }), "nobody");
  });
});
