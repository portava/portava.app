/**
 * IG-07 Compass rhythm gate — a time-sliced destination-rhythm line may publish
 * only when the gate flag is on AND the slice clears k-anonymity on DISTINCT
 * contributors. Everything else suppresses (closing the k=1 leak).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mayPublishRhythm, COMPASS_RHYTHM_K } from "../lib/compassRhythmGate.js";

describe("IG-07 — mayPublishRhythm", () => {
  it("suppresses whenever the gate flag is off, regardless of contributor count", () => {
    assert.equal(mayPublishRhythm(1000, false), false);
    assert.equal(mayPublishRhythm(COMPASS_RHYTHM_K, false), false);
  });

  it("with the flag on, requires >= COMPASS_RHYTHM_K distinct contributors", () => {
    assert.equal(mayPublishRhythm(COMPASS_RHYTHM_K - 1, true), false, "k=4 with K=5 is still a leak");
    assert.equal(mayPublishRhythm(COMPASS_RHYTHM_K, true), true);
    assert.equal(mayPublishRhythm(COMPASS_RHYTHM_K + 10, true), true);
  });

  it("treats a k=1 or absent contributor count as suppressed", () => {
    assert.equal(mayPublishRhythm(1, true), false, "one contributor is the exact leak this closes");
    assert.equal(mayPublishRhythm(0, true), false);
  });

  it("honors a caller-supplied k (kAnonymity never invents one)", () => {
    assert.equal(mayPublishRhythm(3, true, 3), true);
    assert.equal(mayPublishRhythm(3, true, 4), false);
    assert.equal(COMPASS_RHYTHM_K, 5);
  });
});
