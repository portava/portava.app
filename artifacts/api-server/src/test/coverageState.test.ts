import test from "node:test";
import assert from "node:assert/strict";
import { coverageState } from "../lib/coverageScore.js";

test("coverage is independent from activity", () => {
  assert.equal(coverageState({ claimMissing: true, freshestAgeRatio: 0 }), "no_coverage");
  assert.equal(coverageState({ claimMissing: false, freshestAgeRatio: 0.2 }), "covered");
  assert.equal(coverageState({ claimMissing: false, freshestAgeRatio: null }), "unknown");
});

test("invalid coverage evidence is never represented as a quiet covered cell", () => {
  assert.equal(coverageState({ claimMissing: false, freshestAgeRatio: Number.NaN }), "unknown");
  assert.equal(coverageState({ claimMissing: false, freshestAgeRatio: 2 }), "no_coverage");
});