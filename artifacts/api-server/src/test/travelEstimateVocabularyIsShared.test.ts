/**
 * One travel-estimate vocabulary, two consumers, and the tie that keeps them
 * from becoming two vocabularies.
 *
 * `lib/travelEstimate.ts` (Trips §7) and `services/airport/LayoverFeasibility.ts`
 * (§6.2) each declare source classes, confidences and fallback levels. They are
 * the same concept. Two sets of strings for one concept is how two surfaces come
 * to disagree about what LOW means — one shows a warning at LOW and the other
 * treats it as good enough, and nobody notices until a traveller misses a
 * flight.
 *
 * Trips DECLARES rather than re-exports, so it does not become a compile-time
 * dependent of a 545-line safety-critical module for three string arrays. This
 * file is the price of that choice: it fails the moment either side gains,
 * loses or reorders a value.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TRAVEL_SOURCE_CLASSES, TRAVEL_CONFIDENCES, isRoutedSourceClass,
  worstTravelConfidence, travelMinutesAt, pointTravelEstimate,
  FEASIBILITY_PERCENTILE,
} from "../lib/travelEstimate.js";
import {
  ESTIMATE_SOURCE_CLASSES, ESTIMATE_CONFIDENCES, SAFETY_CRITICAL_PERCENTILE,
} from "../services/airport/LayoverFeasibility.js";

describe("the two vocabularies are the same vocabulary", () => {
  it("source classes match exactly, including order", () => {
    assert.deepEqual([...TRAVEL_SOURCE_CLASSES], [...ESTIMATE_SOURCE_CLASSES],
      "Trips §7 and Layover §6.2 no longer agree on where a number can come from");
  });

  it("confidences match exactly, including order", () => {
    // Order matters: both sides fold with "weakest first" and take an index.
    assert.deepEqual([...TRAVEL_CONFIDENCES], [...ESTIMATE_CONFIDENCES],
      "the weakest-first ordering has diverged, so the two folds disagree");
  });

  it("both use the same conservative percentile for a safety-critical answer", () => {
    assert.equal(FEASIBILITY_PERCENTILE, SAFETY_CRITICAL_PERCENTILE);
  });
});

describe("the routed classification is fail-closed", () => {
  it("only LIVE and HISTORICAL are routes", () => {
    const routed = TRAVEL_SOURCE_CLASSES.filter((c) => isRoutedSourceClass(c));
    assert.deepEqual([...routed].sort(), ["HISTORICAL", "LIVE"],
      "the set of source classes that count as an actual route has changed");
  });

  it("anything unknown is NOT a route", () => {
    // The default must be "not measured". A new source class added without
    // thinking must not silently start producing FEASIBLE verdicts.
    for (const junk of ["", "ROUTED", "live", "GUESS", "MEASURED", null, undefined, 0, {}]) {
      assert.equal(isRoutedSourceClass(junk as never), false,
        `${String(junk)} was classified as a route`);
    }
  });
});

describe("the estimate helpers behave the way the two folds assume", () => {
  it("worst-confidence really takes the weaker", () => {
    assert.equal(worstTravelConfidence("HIGH", "LOW"), "LOW");
    assert.equal(worstTravelConfidence("LOW", "HIGH"), "LOW");
    assert.equal(worstTravelConfidence("INSUFFICIENT", "MEDIUM"), "INSUFFICIENT");
    assert.equal(worstTravelConfidence("MEDIUM", "MEDIUM"), "MEDIUM");
  });

  it("a percentile is never below the point value", () => {
    // The distributions are degenerate today, so this is a no-op on the
    // numbers — and it is the guard that keeps a future non-degenerate p50
    // from making a safety-critical answer LESS conservative than the point.
    const e = { ...pointTravelEstimate(30, "LIVE", "HIGH", 0, []), p50Minutes: 10 };
    assert.equal(travelMinutesAt(e, "p50"), 30);
  });

  it("a point estimate is flat across every percentile, and says nothing else", () => {
    const e = pointTravelEstimate(42, "STATIC_DEFAULT", "LOW", 3, ["ref"]);
    assert.equal(e.p50Minutes, 42);
    assert.equal(e.p75Minutes, 42);
    assert.equal(e.p90Minutes, 42);
    assert.equal(e.observedAt, null, "a constant must not claim to have been observed");
    assert.equal(e.expiresAt, null, "a constant does not expire");
  });

  it("negative minutes are clamped rather than propagated", () => {
    assert.equal(pointTravelEstimate(-5, "LIVE", "HIGH", 0, []).minutes, 0);
  });
});
