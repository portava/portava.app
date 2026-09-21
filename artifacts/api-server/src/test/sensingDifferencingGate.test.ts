/**
 * sensingDifferencingGate — §3 "anti-differencing controls"; census S24 found
 * none. Two publications of one cohort differing by fewer than a whole
 * independent party leak the difference.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDifferencing } from "../lib/sensingDifferencingGate.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import type { SensingCohortAggregate } from "../lib/sensingCoverageAggregate.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_TS = readFileSync(join(SRC, "lib", "sensingDifferencingGate.ts"), "utf8");

const agg = (distinctActors: number, over: Partial<SensingCohortAggregate> = {}): SensingCohortAggregate => ({
  publishable: true,
  reason: null,
  distinctActors,
  distinctGroups: 6,
  maxGroupShare: 0.17,
  contributions: distinctActors,
  observedAt: "2026-09-07T21:40:00.000Z",
  medianSignalBucket: 2,
  ...over,
});

const K = PRIVACY_THRESHOLD_V1.minIndependentGroups;

describe("a change smaller than one independent party is not published", () => {
  it("17 → 18 is suppressed and the previous value stands", () => {
    const d = evaluateDifferencing(agg(17), agg(18));
    assert.equal(d.publish, false);
    assert.equal(d.reason, "delta_below_minimum");
    assert.equal(d.serve?.distinctActors, 17);
  });
  it("a drop of one after a revocation is suppressed the same way", () => {
    const d = evaluateDifferencing(agg(30), agg(29));
    assert.deepEqual([d.publish, d.reason, d.serve?.distinctActors], [false, "delta_below_minimum", 30]);
  });
  it("the default minimum is the privacy threshold's independent-group floor, and exactly that delta publishes", () => {
    assert.equal(evaluateDifferencing(agg(20), agg(20 + K - 1)).publish, false);
    const d = evaluateDifferencing(agg(20), agg(20 + K));
    assert.deepEqual([d.publish, d.reason, d.serve?.distinctActors], [true, "delta_at_least_minimum", 20 + K]);
  });
});

describe("what does publish", () => {
  it("the first publication", () => {
    const d = evaluateDifferencing(null, agg(20));
    assert.deepEqual([d.publish, d.reason], [true, "no_previous"]);
  });
  it("an unchanged count (re-serving leaks nothing new)", () => {
    const d = evaluateDifferencing(agg(20), agg(20, { medianSignalBucket: 3 }));
    assert.deepEqual([d.publish, d.reason, d.serve?.medianSignalBucket], [true, "unchanged", 3]);
  });
  it("a previous that was itself unpublishable counts as no previous", () => {
    const d = evaluateDifferencing(agg(3, { publishable: false, reason: "below_actor_threshold" }), agg(20));
    assert.equal(d.reason, "no_previous");
  });
});

describe("the privacy gate speaks first", () => {
  it("an unpublishable current is never served, and the previous value is NOT served in its place", () => {
    const d = evaluateDifferencing(agg(30), agg(12, { publishable: false, reason: "below_actor_threshold" }));
    assert.deepEqual([d.publish, d.reason, d.serve], [false, "not_publishable", null]);
  });
  it("a minDelta below 1 is refused; the module keeps no token and reads no clock", () => {
    assert.throws(() => evaluateDifferencing(agg(1), agg(2), { minDelta: 0 }));
    assert.doesNotMatch(MODULE_TS, /contributor_token|group_token|Set<|Date\.now|supabase/);
  });
});
