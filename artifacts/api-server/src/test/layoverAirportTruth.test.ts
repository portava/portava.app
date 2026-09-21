/**
 * §10 Airport Intelligence and §10.1 truth reconciliation.
 *
 * node:test + node:assert/strict (NOT vitest). No DB, no network. The verdict
 * is the EXIT CODE.
 *
 * ── WHAT IS BEING ASSERTED, AND WHAT IS NOT ──────────────────────────────────
 * §10.1 is five prohibitions and rules about how contradictory operational
 * facts may be combined. This file asserts that the reconciler OBEYS all five
 * over synthesised observation sets. It does NOT assert that any observation
 * exists: nothing on this tree produces one, `airport_fact_observations` is
 * written and unapplied, and the census records every §10 fact class as having
 * a channel and no content. A rule with an empty input set is still a rule, and
 * the census scores it with that stated.
 *
 * Each rule gets a POSITIVE CONTROL — an input under which the rule must NOT
 * fire — because a refusal that refuses everything is not a policy.
 *
 * ── RED-FIRST RECORD ─────────────────────────────────────────────────────────
 * Every mutation was made to PRODUCTION code in
 * `src/services/airport/LayoverAirportTruth.ts`, measured, and reverted.
 *
 * GREEN, unmutated: 40 pass / 0 fail. M1-M8 were measured out of 37, before the
 * three §23 trust-weighting tests were added; M9-M11 out of 40.
 *
 * ── ONE MUTATION STAYED GREEN, AND THAT IS THE MOST USEFUL RESULT HERE ───────
 * M11 disabled the second half of §10.1 rule 5 — an explicit
 * `if (fresherContradiction && confidence === "HIGH") confidence = "MEDIUM"`
 * cap that the first version of `reconcile` carried. MEASURED: 40 pass / 0
 * fail, IDENTICAL to unmutated. Reading it back showed why it could never
 * fire: `fresherContradiction` requires two readings differing by more than
 * the tolerance, which is the definition of `conflict`, and the conflict
 * step-down five lines earlier has already taken HIGH to MEDIUM. The branch was
 * DEAD. It has been deleted rather than kept with a test written around it, the
 * reason is recorded where it was, and M3 was RE-MEASURED afterwards: with the
 * dead cap gone the step-down mutation fails 2 tests instead of 1, because the
 * cap had been silently covering for it.
 *
 *   M1  `reconcile` — take the MEAN of the credible readings instead of the
 *       max (`chosen = values.reduce((a,b)=>a+b,0)/values.length`), i.e. the
 *       silent merge §10.1's first line forbids.
 *       MEASURED: 30 pass / 6 fail.
 *
 *   M2  `reconcile` — disable the corroboration floor, so one stranger's queue
 *       report can move a deadline.
 *       MEASURED: 34 pass / 2 fail.
 *
 *   M3  `reconcile` — stop stepping confidence down on contradiction, so a
 *       disagreement is recorded and then ignored.
 *       MEASURED: 35 pass / 1 fail (out of 37, with the dead rule-5 cap still
 *       present). RE-MEASURED after deleting that cap: 38 pass / 2 fail (out
 *       of 40). The extra failure is "a fresher contradicting reading caps
 *       confidence below HIGH", which had been passing on the dead branch.
 *
 *   M4  `screenObservations` — accept future-dated observations, so a
 *       clock-skewed feed always looks freshest and outvotes every real
 *       reading.
 *       MEASURED: 35 pass / 1 fail.
 *
 *   M5  `liveConditionsFrom` — drop the `Math.max(0, …)` floor, so an observed
 *       queue SHORTER than the declared baseline discounts the safety buffer.
 *       MEASURED: 34 pass / 2 fail.
 *
 *   M6  `buildHistoricalModel` — publish bands below `MIN_SAMPLES_PER_BAND`,
 *       so a p90 over two samples acquires the authority of a distribution.
 *       MEASURED: 35 pass / 1 fail.
 *
 *   M7  `isImplausible` — return false for every finite value, disabling §23
 *       outlier detection, so a 900-minute security queue from an official feed
 *       becomes truth and adds fifteen hours of buffer.
 *       MEASURED: 36 pass / 1 fail.
 *
 *   M8  `screenObservations` — disable the §23 rate limit, so one observer can
 *       flood a fact with as many readings as it likes.
 *       MEASURED: 36 pass / 1 fail.
 *
 *   M9  `OBSERVER_KIND_TRUST` — set `community: 1.0`, so a stranger's report
 *       is believed exactly as much as the airport's own feed and §23's
 *       trust-weighting requirement is met in name only.
 *       MEASURED: 38 pass / 2 fail (out of 40).
 *
 *   M10 `decayFactor` — return 1 at and past the TTL instead of 0, so a reading
 *       never quite stops counting.
 *       MEASURED: 39 pass / 1 fail (out of 40).
 *
 *   M11 the dead rule-5 cap — see the note above. MEASURED: 40 pass / 0 fail.
 *
 * NOTE ON M1-M8 COUNTS. Five of the eight fail exactly one test. That is what a
 * file of INDEPENDENT rules looks like when each rule has one assertion and one
 * positive control: a broad blast radius here would mean the rules were
 * entangled, not that the tests were strong. The two mutations with a wide
 * radius (M1, the silent merge; M5, the negative floor) are the two that change
 * a VALUE rather than a gate, and a value is read by many assertions.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverAirportTruth.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AIRPORT_FACT_CLASSES,
  AIRPORT_FACT_TYPE_NAMES,
  CONFLICT_TOLERANCE_MIN,
  FACT_CLASS_TTL_MIN,
  MIN_COMMUNITY_CORROBORATION,
  MIN_SAMPLES_PER_BAND,
  OBSERVATION_RATE_LIMIT,
  OBSERVER_KINDS,
  PLAUSIBLE_RANGE,
  SECURITY_WAIT_BASELINE_MIN,
  SECURITY_WAIT_HIGH_MIN,
  TAXI_QUEUE_BASELINE_MIN,
  TAXI_QUEUE_DEGRADED_MIN,
  buildHistoricalModel,
  decayFactor,
  factClassOf,
  getTruth,
  isImplausible,
  liveConditionsFrom,
  measureCalibration,
  reconcile,
  screenObservations,
  type AirportObservation,
  type ObserverKind,
} from "../services/airport/LayoverAirportTruth.js";

const AIRPORT = "TPE";
const NOW = Date.parse("2030-06-15T10:00:00.000Z");
const MIN = 60_000;

let seq = 0;
function obs(over: Partial<AirportObservation> = {}): AirportObservation {
  seq += 1;
  return {
    observationId: `obs-${seq}`,
    airportRef: AIRPORT,
    factType: "security_wait_minutes",
    value: 30,
    observerKind: "official",
    observerId: `observer-${seq}`,
    observedAt: new Date(NOW - 5 * MIN).toISOString(),
    sourceRef: `feed://airport/${seq}`,
    ...over,
  };
}

const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();

// ═══════════════════════════════════════════════════════════════════════════
// 1. §10 — the five fact classes, and their freshness
// ═══════════════════════════════════════════════════════════════════════════

describe("§10 — the fact classes the spec's table names", () => {
  it("declares exactly the spec's five classes, in its order", () => {
    assert.deepEqual([...AIRPORT_FACT_CLASSES], [
      "STATIC_TOPOLOGY",
      "OPERATIONAL_SEMI_LIVE",
      "FAST_LIVE",
      "TRAVELER_OBSERVATION",
      "HISTORICAL_MODEL",
    ]);
  });

  it("freshness is ordered volatile-first: fast-live expires soonest, static latest", () => {
    assert.ok(FACT_CLASS_TTL_MIN.FAST_LIVE < FACT_CLASS_TTL_MIN.TRAVELER_OBSERVATION);
    assert.ok(FACT_CLASS_TTL_MIN.TRAVELER_OBSERVATION < FACT_CLASS_TTL_MIN.OPERATIONAL_SEMI_LIVE);
    assert.ok(FACT_CLASS_TTL_MIN.OPERATIONAL_SEMI_LIVE < FACT_CLASS_TTL_MIN.STATIC_TOPOLOGY);
    // "minutes", not hours.
    assert.ok(FACT_CLASS_TTL_MIN.FAST_LIVE <= 60);
  });

  it("every fact type is bound to exactly one class and has a plausible range and a tolerance", () => {
    assert.ok(AIRPORT_FACT_TYPE_NAMES.length >= 14);
    for (const t of AIRPORT_FACT_TYPE_NAMES) {
      assert.ok(AIRPORT_FACT_CLASSES.includes(factClassOf(t)), `${t} has no class`);
      assert.ok(PLAUSIBLE_RANGE[t] !== undefined, `${t} has no plausible range`);
      assert.ok(PLAUSIBLE_RANGE[t].max > PLAUSIBLE_RANGE[t].min, `${t} range is empty`);
      assert.ok(typeof CONFLICT_TOLERANCE_MIN[t] === "number", `${t} has no conflict tolerance`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Screening — plausibility, decay, rate limit, clock
// ═══════════════════════════════════════════════════════════════════════════

describe("§23 screening — what never counts, and why", () => {
  it("an implausible value is rejected outright, not merely down-weighted", () => {
    assert.equal(isImplausible("security_wait_minutes", 900), true);
    assert.equal(isImplausible("security_wait_minutes", 90), false);
    const out = reconcile([obs({ value: 900, observerKind: "official" })], {
      nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT,
    });
    assert.equal(out.truth, null, "a 900-minute queue from an official feed must not become truth");
    assert.deepEqual(out.rejections.map((r) => r.reason), ["implausible_value"]);
  });

  it("a future-dated observation is rejected — it is a clock fault, not fresh news", () => {
    const out = reconcile([obs({ observedAt: new Date(NOW + 60 * MIN).toISOString() })], {
      nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT,
    });
    assert.equal(out.truth, null);
    assert.deepEqual(out.rejections.map((r) => r.reason), ["future_dated"]);
  });

  it("an observation past its class TTL is expired", () => {
    const ttl = FACT_CLASS_TTL_MIN.FAST_LIVE;
    const fresh = reconcile([obs({ observedAt: at(ttl - 1) })], {
      nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT,
    });
    const stale = reconcile([obs({ observedAt: at(ttl + 1) })], {
      nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT,
    });
    assert.ok(fresh.truth !== null, "positive control: just inside the TTL must count");
    assert.equal(stale.truth, null);
    assert.deepEqual(stale.rejections.map((r) => r.reason), ["expired"]);
  });

  it("decay is monotone in age and reaches exactly zero at the TTL", () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let age = 0; age <= 30; age++) {
      const d = decayFactor(age, 20);
      assert.ok(d <= prev + 1e-12, `decay grew at age ${age}`);
      assert.ok(d >= 0 && d <= 1);
      prev = d;
    }
    assert.equal(decayFactor(20, 20), 0);
    assert.equal(decayFactor(0, 20), 1);
  });

  it("one observer cannot flood a fact — the rate limit trims, the first N count", () => {
    const flood = Array.from({ length: OBSERVATION_RATE_LIMIT.maxPerWindow + 4 }, (_, i) =>
      obs({ observerId: "loud", observerKind: "community", value: 30 + i, observedAt: at(1) }));
    const screened = screenObservations(flood, {
      nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT,
    });
    assert.equal(
      screened.filter((s) => s.rejected === null).length,
      OBSERVATION_RATE_LIMIT.maxPerWindow,
    );
    assert.equal(
      screened.filter((s) => s.rejected === "rate_limited").length,
      4,
    );
  });

  it("the same observationId twice is one observation", () => {
    const one = obs({ observationId: "dup", value: 30 });
    const screened = screenObservations([one, { ...one }], {
      nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT,
    });
    assert.equal(screened.filter((s) => s.rejected === null).length, 1);
    assert.equal(screened.filter((s) => s.rejected === "duplicate_id").length, 1);
  });

  it("observations for another airport or another fact are not this fact's evidence", () => {
    const screened = screenObservations(
      [obs({ airportRef: "HND" }), obs({ factType: "taxi_queue_minutes" }), obs()],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    );
    assert.equal(screened.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. §10.1 — the five contradiction rules
// ═══════════════════════════════════════════════════════════════════════════

describe("§10.1 rule 1+2 — contradictory facts are never silently merged", () => {
  it("two credible readings past tolerance set `conflict` and keep BOTH refs", () => {
    const out = reconcile(
      [
        obs({ value: 20, observerKind: "official", observerId: "airport-feed", sourceRef: "feed://a" }),
        obs({ value: 70, observerKind: "operator_feed", observerId: "airline", sourceRef: "feed://b" }),
      ],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    );
    assert.ok(out.truth);
    assert.equal(out.truth.conflict, true);
    assert.deepEqual(out.conflictBetween, { low: 20, high: 70 });
    assert.deepEqual(out.truth.sourceRefs.sort(), ["feed://a", "feed://b"]);
  });

  it("the value is never the mean — a merge is not a decision", () => {
    const out = reconcile(
      [
        obs({ value: 20, observerId: "a" }),
        obs({ value: 70, observerId: "b", observerKind: "operator_feed" }),
      ],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    );
    assert.equal(out.truth!.value, 70);
    assert.notEqual(out.truth!.value, 45, "45 is the mean, and the mean is the forbidden answer");
  });

  it("positive control — agreement inside tolerance is not a conflict", () => {
    const tol = CONFLICT_TOLERANCE_MIN.security_wait_minutes;
    const out = reconcile(
      [obs({ value: 30, observerId: "a" }), obs({ value: 30 + tol, observerId: "b" })],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    );
    assert.equal(out.truth!.conflict, false);
    assert.equal(out.conflictBetween, null);
  });

  it("§10 TruthValue carries all eight members, every one SET rather than placed", () => {
    const out = reconcile(
      [obs({ value: 25, observerId: "a", observedAt: at(2), sourceRef: "feed://a" })],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    );
    const t = out.truth!;
    // The spec's eight members, named one at a time so a dropped one is a
    // named failure and not a shape mismatch buried in a deepEqual.
    assert.equal(t.value, 25);
    assert.ok(["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"].includes(t.confidence));
    assert.equal(typeof t.conflict, "boolean");
    assert.equal(t.sourceClass, "LIVE");
    assert.deepEqual(t.sourceRefs, ["feed://a"]);
    assert.equal(t.observedAt, at(2));
    assert.equal(
      t.expiresAt,
      new Date(Date.parse(at(2)) + FACT_CLASS_TTL_MIN.FAST_LIVE * MIN).toISOString(),
      "expiresAt must be observedAt + the class TTL, not now + the TTL",
    );
    assert.equal(t.fallbackLevel, 0);
    assert.deepEqual(
      Object.keys(t).sort(),
      ["confidence", "conflict", "expiresAt", "fallbackLevel", "observedAt", "sourceClass", "sourceRefs", "value"],
      "the record must carry exactly the spec's eight members",
    );
  });

  it("provenance is always preserved, conflict or not", () => {
    const out = reconcile([obs({ sourceRef: "feed://only" })], {
      nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT,
    });
    assert.deepEqual(out.truth!.sourceRefs, ["feed://only"]);
    assert.equal(out.truth!.conflict, false);
    assert.ok(out.truth!.observedAt !== null);
    assert.ok(out.truth!.expiresAt !== null);
  });
});

describe("§10.1 rule 3 — the conservative reading wins", () => {
  it("the largest credible delay is chosen, whoever reported it", () => {
    for (const loudKind of OBSERVER_KINDS) {
      const out = reconcile(
        [
          obs({ value: 15, observerKind: "official", observerId: "quiet" }),
          obs({ value: 65, observerKind: loudKind, observerId: "loud-1" }),
          obs({ value: 62, observerKind: loudKind, observerId: "loud-2" }),
        ],
        { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
      );
      assert.equal(out.truth!.value, 65, `${loudKind} reading was discarded rather than believed`);
    }
  });

  it("a weakly-weighted reading still counts as evidence — weight decides confidence, not eligibility", () => {
    const ttl = FACT_CLASS_TTL_MIN.FAST_LIVE;
    const out = reconcile(
      [
        obs({ value: 20, observerKind: "official", observerId: "fresh", observedAt: at(1) }),
        // Nearly expired, weakly weighted, and worse news.
        obs({ value: 80, observerKind: "community", observerId: "old-1", observedAt: at(ttl - 1) }),
        obs({ value: 78, observerKind: "community", observerId: "old-2", observedAt: at(ttl - 1) }),
      ],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    );
    assert.equal(out.truth!.value, 80);
  });
});

describe("§10.1 rule 4 — community observations need corroboration", () => {
  it("one community reporter cannot move a safety-critical fact", () => {
    const out = reconcile([obs({ observerKind: "community", observerId: "solo", value: 90 })], {
      nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT,
    });
    assert.equal(out.truth, null);
    assert.equal(out.corroboration.community, 1);
    assert.ok(out.rulesApplied.some((r) => r.includes("corroboration floor")));
    // The observation is not hidden — a reader can still see it arrived.
    assert.equal(out.screened.filter((s) => s.rejected === null).length, 1);
  });

  it(`${MIN_COMMUNITY_CORROBORATION} distinct community reporters do`, () => {
    const out = reconcile(
      [
        obs({ observerKind: "community", observerId: "a", value: 90 }),
        obs({ observerKind: "community", observerId: "b", value: 88 }),
      ],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    );
    assert.ok(out.truth);
    assert.equal(out.truth.value, 90);
  });

  it("the same reporter twice is not corroboration", () => {
    const out = reconcile(
      [
        obs({ observerKind: "community", observerId: "same", value: 90 }),
        obs({ observerKind: "community", observerId: "same", value: 88 }),
      ],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    );
    assert.equal(out.truth, null);
    assert.equal(out.corroboration.community, 1);
  });

  it("a non-safety-critical fact does not need corroboration", () => {
    const out = reconcile([obs({ observerKind: "community", observerId: "solo", factType: "lounge_hours", value: 6 })], {
      nowMs: NOW, factType: "lounge_hours", airportRef: AIRPORT,
    });
    assert.ok(out.truth, "one report of a lounge's hours is worth publishing");
  });

  it("one community report ALONGSIDE an official one counts", () => {
    const out = reconcile(
      [
        obs({ observerKind: "official", observerId: "feed", value: 25 }),
        obs({ observerKind: "community", observerId: "solo", value: 95 }),
      ],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    );
    assert.ok(out.truth);
    assert.equal(out.truth.value, 95, "the floor gates community-ONLY facts, not community evidence");
  });
});

describe("§10.1 rule 5 — official data is not automatically truth", () => {
  it("a fresher contradicting reading caps confidence below HIGH", () => {
    const out = reconcile(
      [
        obs({ value: 15, observerKind: "official", observerId: "feed", observedAt: at(8) }),
        obs({ value: 75, observerKind: "operator_feed", observerId: "airline", observedAt: at(1) }),
      ],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    );
    assert.equal(out.truth!.value, 75, "the official's lower figure did not win");
    assert.notEqual(out.truth!.confidence, "HIGH");
  });

  it("contradiction always reduces confidence relative to the same evidence agreeing", () => {
    const agreeing = reconcile(
      [obs({ value: 30, observerId: "a", observedAt: at(1) }), obs({ value: 32, observerId: "b", observedAt: at(1) })],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    );
    const conflicting = reconcile(
      [obs({ value: 30, observerId: "a", observedAt: at(1) }), obs({ value: 95, observerId: "b", observedAt: at(1) })],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    );
    const order = ["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"];
    assert.ok(
      order.indexOf(conflicting.truth!.confidence) < order.indexOf(agreeing.truth!.confidence),
      "a disagreement must make a reader less sure, not equally sure",
    );
  });

  it("positive control — an uncontradicted fresh official reading can reach HIGH", () => {
    const out = reconcile([obs({ value: 30, observerKind: "official", observedAt: at(0) })], {
      nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT,
    });
    assert.equal(out.truth!.confidence, "HIGH");
  });
});

describe("§23 trust weighting — who is talking changes how sure the answer is", () => {
  const order = ["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"];

  it("the same reading, equally fresh, is believed less from strangers than from the airport", () => {
    const official = reconcile(
      [obs({ value: 40, observerKind: "official", observerId: "feed", observedAt: at(0) })],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    ).truth!;
    const community = reconcile(
      [
        obs({ value: 40, observerKind: "community", observerId: "a", observedAt: at(0) }),
        obs({ value: 40, observerKind: "community", observerId: "b", observedAt: at(0) }),
      ],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    ).truth!;
    assert.equal(official.value, community.value, "the VALUE must be the same — only the trust differs");
    assert.ok(
      order.indexOf(community.confidence) < order.indexOf(official.confidence),
      `community ${community.confidence} was believed as much as official ${official.confidence}`,
    );
  });

  it("an observer's own low standing score lowers it further", () => {
    const trusted = reconcile(
      [obs({ value: 40, observerKind: "operator_feed", observerId: "x", observedAt: at(0) })],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    ).truth!;
    const doubted = reconcile(
      [obs({ value: 40, observerKind: "operator_feed", observerId: "x", observerTrust: 0.2, observedAt: at(0) })],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    ).truth!;
    assert.ok(order.indexOf(doubted.confidence) < order.indexOf(trusted.confidence));
  });

  it("an out-of-range trust score is clamped, not obeyed", () => {
    const inflated = reconcile(
      [obs({ value: 40, observerKind: "community", observerId: "a", observerTrust: 99, observedAt: at(0) }),
       obs({ value: 40, observerKind: "community", observerId: "b", observerTrust: 99, observedAt: at(0) })],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    ).truth!;
    assert.notEqual(inflated.confidence, "HIGH", "a self-declared trust of 99 bought HIGH confidence");
  });
});

describe("absence is reported as absence", () => {
  it("no observation at all yields null, never a zero-minute truth", () => {
    const out = reconcile([], { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT });
    assert.equal(out.truth, null);
    assert.equal(getTruth(AIRPORT, "security_wait_minutes", NOW, []), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. §10 → the buffer: liveConditionsFrom
// ═══════════════════════════════════════════════════════════════════════════

describe("reconciled truth becomes LiveConditions", () => {
  const truthOf = (value: number, factType: AirportObservation["factType"], kind: ObserverKind = "official") =>
    reconcile([obs({ value, factType, observerKind: kind, observedAt: at(1) })], {
      nowMs: NOW, factType, airportRef: AIRPORT,
    }).truth;

  it("a queue at or below the declared baseline contributes nothing", () => {
    for (let v = 0; v <= SECURITY_WAIT_BASELINE_MIN; v++) {
      const c = liveConditionsFrom(
        { securityWait: truthOf(v, "security_wait_minutes"), immigrationWait: null, taxiQueue: null },
        { nowMs: NOW },
      );
      assert.equal(c.securityWaitExtraMin, 0, `observed ${v} min discounted the buffer`);
    }
  });

  it("above the baseline the extra is exactly the excess, and monotone", () => {
    let prev = -1;
    for (let v = 0; v <= 240; v++) {
      const c = liveConditionsFrom(
        { securityWait: truthOf(v, "security_wait_minutes"), immigrationWait: null, taxiQueue: null },
        { nowMs: NOW },
      );
      assert.equal(c.securityWaitExtraMin, Math.max(0, v - SECURITY_WAIT_BASELINE_MIN));
      assert.ok(c.securityWaitExtraMin >= prev, `not monotone at ${v}`);
      prev = c.securityWaitExtraMin;
    }
  });

  it("SECURITY_WAIT_HIGH fires at the threshold and not below it", () => {
    const below = liveConditionsFrom(
      { securityWait: truthOf(SECURITY_WAIT_HIGH_MIN - 1, "security_wait_minutes"), immigrationWait: null, taxiQueue: null },
      { nowMs: NOW },
    );
    const atThreshold = liveConditionsFrom(
      { securityWait: truthOf(SECURITY_WAIT_HIGH_MIN, "security_wait_minutes"), immigrationWait: null, taxiQueue: null },
      { nowMs: NOW },
    );
    assert.ok(!below.reasonCodes.includes("SECURITY_WAIT_HIGH"));
    assert.ok(atThreshold.reasonCodes.includes("SECURITY_WAIT_HIGH"));
  });

  it("TRAFFIC_DEGRADED fires on a degraded taxi queue", () => {
    const c = liveConditionsFrom(
      { securityWait: null, immigrationWait: null, taxiQueue: truthOf(TAXI_QUEUE_DEGRADED_MIN, "taxi_queue_minutes") },
      { nowMs: NOW },
    );
    assert.ok(c.reasonCodes.includes("TRAFFIC_DEGRADED"));
    assert.equal(c.groundTransportExtraMin, TAXI_QUEUE_DEGRADED_MIN - TAXI_QUEUE_BASELINE_MIN);
  });

  it("SOURCE_CONFLICT travels with a contradicted truth", () => {
    const contradicted = reconcile(
      [
        obs({ value: 25, observerId: "a", observedAt: at(1) }),
        obs({ value: 95, observerId: "b", observedAt: at(1) }),
      ],
      { nowMs: NOW, factType: "security_wait_minutes", airportRef: AIRPORT },
    ).truth;
    const c = liveConditionsFrom({ securityWait: contradicted, immigrationWait: null, taxiQueue: null }, { nowMs: NOW });
    assert.ok(c.reasonCodes.includes("SOURCE_CONFLICT"));
  });

  it("DATA_STALE fires when the caller asks later than the truth's own expiry", () => {
    const t = truthOf(60, "security_wait_minutes");
    const fresh = liveConditionsFrom({ securityWait: t, immigrationWait: null, taxiQueue: null }, { nowMs: NOW });
    const later = liveConditionsFrom(
      { securityWait: t, immigrationWait: null, taxiQueue: null },
      { nowMs: Date.parse(t!.expiresAt!) + 1 },
    );
    assert.ok(!fresh.reasonCodes.includes("DATA_STALE"));
    assert.ok(later.reasonCodes.includes("DATA_STALE"));
  });

  it("no truths at all is a clean zero with no codes and no timestamps", () => {
    const c = liveConditionsFrom({ securityWait: null, immigrationWait: null, taxiQueue: null }, { nowMs: NOW });
    assert.deepEqual(c, {
      securityWaitExtraMin: 0,
      immigrationWaitExtraMin: 0,
      groundTransportExtraMin: 0,
      reasonCodes: [],
      observedAt: null,
      expiresAt: null,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. §10 historical model, §22 L4 calibration
// ═══════════════════════════════════════════════════════════════════════════

describe("§10 historical model — time-of-day distributions", () => {
  const localHourOf = (iso: string) => new Date(iso).getUTCHours();

  function history(hour: number, values: number[]): AirportObservation[] {
    // Well inside the HISTORICAL_MODEL TTL, one observer id each so the rate
    // limit does not trim the sample.
    return values.map((v, i) =>
      obs({
        factType: "time_of_day_distribution",
        value: v,
        observerKind: "portava_sensor",
        observerId: `sensor-${hour}-${i}`,
        observedAt: new Date(Date.UTC(2030, 5, 10, hour, i)).toISOString(),
      }));
  }

  it("a band below the sample floor is not published", () => {
    const model = buildHistoricalModel(history(8, [10, 20]), {
      nowMs: NOW, factType: "time_of_day_distribution", airportRef: AIRPORT, localHourOf,
    });
    assert.equal(model.bands.length, 0);
    assert.equal(model.minSamplesPerBand, MIN_SAMPLES_PER_BAND);
  });

  it("a band at the floor is published with ordered percentiles", () => {
    const model = buildHistoricalModel(history(8, [10, 20, 30, 40, 100]), {
      nowMs: NOW, factType: "time_of_day_distribution", airportRef: AIRPORT, localHourOf,
    });
    assert.equal(model.bands.length, 1);
    const b = model.bands[0]!;
    assert.equal(b.hour, 8);
    assert.equal(b.samples, 5);
    assert.ok(b.p50 <= b.p75 && b.p75 <= b.p90);
    assert.equal(b.p90, 100);
  });

  it("bands are per local hour, not pooled", () => {
    const model = buildHistoricalModel(
      [...history(8, [10, 10, 10, 10, 10]), ...history(18, [90, 90, 90, 90, 90])],
      { nowMs: NOW, factType: "time_of_day_distribution", airportRef: AIRPORT, localHourOf },
    );
    assert.equal(model.bands.length, 2);
    assert.equal(model.bands.find((b) => b.hour === 8)!.p90, 10);
    assert.equal(model.bands.find((b) => b.hour === 18)!.p90, 90);
  });

  it("calibration measures error, and reports nothing when there is nothing to compare", () => {
    const model = buildHistoricalModel(history(8, [10, 20, 30, 40, 50]), {
      nowMs: NOW, factType: "time_of_day_distribution", airportRef: AIRPORT, localHourOf,
    });
    assert.deepEqual(measureCalibration(model, []), {
      comparedBands: 0, meanSignedErrorMin: 0, meanAbsoluteErrorMin: 0, p90CoverageRate: 0,
    });
    const c = measureCalibration(model, [
      { hour: 8, actualMinutes: 30 },
      { hour: 8, actualMinutes: 60 },
      { hour: 23, actualMinutes: 5 },
    ]);
    assert.equal(c.comparedBands, 1, "an outcome in an unmodelled hour is not a comparison");
    // p90 of [10,20,30,40,50] is 50; errors are +20 and -10.
    assert.equal(c.meanSignedErrorMin, 5);
    assert.equal(c.meanAbsoluteErrorMin, 15);
    assert.equal(c.p90CoverageRate, 0.5);
  });
});
