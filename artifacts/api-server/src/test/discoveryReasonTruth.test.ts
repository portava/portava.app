/**
 * discoveryReasonTruth — census-discovery §68 (lane P21), A03's routed finding.
 *
 * THE FINDING (§57, A03)
 * ======================
 * `nearby_now`'s plain language was one fixed sentence, "Close to you and open
 * around now.", served whenever ANY signal mapped to the code fired. PDE's
 * `distance`, `cityMatch` and `neighborhoodMatch` map to it, and none of them
 * reads opening hours: so a place was told "open around now" because it was in
 * the right city. A reason must not claim a fact nothing observed.
 *
 * THE RULE THIS FILE PINS
 * =======================
 * The served sentence for `nearby_now` claims only what the signals that fired
 * support:
 *   - "open" only when `open_now` fired — Compass's factor, which fires only on
 *     an explicit `isOpenNow === true` (compass/CompassRecommendationEngine.ts);
 *   - "close to you" only when a location signal fired;
 *   - neither, when only a timing or capacity signal fired.
 * The CODE is unchanged in every case (the golden's G5), so the exposure record
 * and every reason-code reader see exactly what they saw before.
 *
 *   T1  distance alone does not say "open"                      (seen RED before §68)
 *   T2  each PDE location signal alone does not say "open"       (seen RED before §68)
 *   T3  every combination of nearby_now signals: "open" iff open_now fired,
 *       "close to you" iff a location signal fired              (seen RED before §68)
 *   T4  through the served projection, on a PDE-ranked row      (seen RED before §68)
 *   T5  every signal mapped to nearby_now belongs to exactly one family, so a
 *       new key cannot inherit a claim by default
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryReasonTruth.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as reasons from "../lib/discoveryReasonCodes.js";
import { projectDiscoveryCandidate } from "../lib/discoveryCandidate.js";
import type { ScoredCandidate, RankCandidate } from "../lib/portavaRank.js";

const { explainReasons, reasonCodeForSignal } = reasons;

/** Every key `lib/discoveryReasonCodes` maps to `nearby_now`, by family, as read from the rankers. */
const LOCATION = ["distance", "city_match", "cityMatch", "neighborhoodMatch"];
const OPEN     = ["open_now"];
const TIMING   = ["availability", "time_relevance", "actionability", "availabilityFit", "capacityOpen"];
const ALL      = [...LOCATION, ...OPEN, ...TIMING];

const nearbyText = (signals: readonly string[]) => explainReasons(signals).find((r) => r.code === "nearby_now")?.text ?? null;
const OPEN_WORD = /\bopen\b/i;

describe("§68 A03 — a nearby_now reason claims only what fired", () => {
  it("T1. distance alone: close, not open", () => {
    const t = nearbyText(["distance"]);
    assert.ok(t, "distance still grounds nearby_now");
    assert.doesNotMatch(t!, OPEN_WORD, `distance observed no opening hours, but the reason says: ${t}`);
  });

  it("T2. each location signal alone: no 'open'", () => {
    for (const k of LOCATION) {
      const t = nearbyText([k]);
      assert.ok(t, `${k} still grounds nearby_now`);
      assert.doesNotMatch(t!, OPEN_WORD, `${k}: ${t}`);
    }
  });

  it("T3. every combination: 'open' iff open_now fired; 'close to you' iff a location signal fired", () => {
    for (let mask = 1; mask < 1 << ALL.length; mask++) {
      const fired = ALL.filter((_, i) => mask & (1 << i));
      const t = nearbyText(fired);
      assert.ok(t, `${fired.join("+")}: a grounded code keeps a sentence`);
      assert.equal(OPEN_WORD.test(t!), fired.some((k) => OPEN.includes(k)), `open claim for ${fired.join("+")}: ${t}`);
      assert.equal(/close to you/i.test(t!), fired.some((k) => LOCATION.includes(k)), `proximity claim for ${fired.join("+")}: ${t}`);
    }
  });

  it("T4. the served projection: a PDE row whose only nearby signals are city and distance is not told it is open", () => {
    const scored: ScoredCandidate<RankCandidate> = {
      candidate: { id: "way/1", kind: "place" } as RankCandidate, score: 1,
      features: { cityMatch: 0.45, distance: 0.2, neighborhoodMatch: 0.2, categoryAffinity: 0.3 },
    };
    const c = projectDiscoveryCandidate({ id: "way/1" }, {
      cacheLevel: "miss", cachedAt: null, rankedBy: "pde", nowMs: 1_800_000_000_000,
      scoredById: new Map([["way/1", scored]]),
    });
    const nearby = c.reasons.find((r) => r.code === "nearby_now");
    assert.ok(nearby, "the code is still served");
    assert.doesNotMatch(nearby!.text, OPEN_WORD, `served: ${nearby!.text}`);
  });

  it("T5. every key that grounds nearby_now is in exactly one family, and the families are the module's own", () => {
    for (const k of ALL) assert.equal(reasonCodeForSignal(k), "nearby_now", `${k} maps to nearby_now`);
    const mod = reasons as unknown as { NEARBY_NOW_SIGNAL_FAMILY?: Readonly<Record<string, string>>; _nearbyNowKeysForTest?: () => string[] };
    assert.ok(mod.NEARBY_NOW_SIGNAL_FAMILY && mod._nearbyNowKeysForTest, "the family table is exported");
    assert.deepEqual([...mod._nearbyNowKeysForTest!()].sort(), [...ALL].sort(), "the module maps exactly these keys to nearby_now");
    for (const k of LOCATION) assert.equal(mod.NEARBY_NOW_SIGNAL_FAMILY![k], "location", k);
    for (const k of OPEN)     assert.equal(mod.NEARBY_NOW_SIGNAL_FAMILY![k], "open", k);
    for (const k of TIMING)   assert.equal(mod.NEARBY_NOW_SIGNAL_FAMILY![k], "timing", k);
  });
});
