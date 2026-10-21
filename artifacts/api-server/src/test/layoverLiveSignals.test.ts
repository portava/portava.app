/**
 * LAYOVER 165, lane B2-LIVE — the live-signal producer, its validation window,
 * its distribution and percentile policy, its conflict / staleness / fail-closed
 * rules, the feed adapter's contract and the traffic arithmetic. Pure: no I/O,
 * no clock (every function takes `nowMs`), no network.
 *
 * Rows: L54 (Estimate p50/p75/p90 not degenerate), L55 (configurable
 * conservative percentile by maturity/consequence; never a single average),
 * L81 (fast live reaches the buffer), L180 (stored observations validated
 * before a safety calculation), L227 (security spike → monotone contraction),
 * L228 (traffic spike → earlier deadline), L281 SECURITY_WAIT_HIGH, L285
 * DATA_STALE, L286 SOURCE_CONFLICT, L287 TRAFFIC_DEGRADED. The real-schema,
 * real-route half is src/test/db/layoverLiveSignals.db.test.ts.
 *
 * Every rule has a mutant recorded in the lane handback
 * (scratchpad/l165-b2-live-handback.txt) that turns its test red.
 *
 * Run: node --import tsx/esm --test src/test/layoverLiveSignals.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getTruth,
  validateObservationWindow,
  MIN_REPORTER_TRUST,
  type AirportObservation,
} from "../services/airport/LayoverAirportTruth.js";
import {
  LIVE_PERCENTILE_POLICY,
  MIN_DISTRIBUTION_READINGS,
  STALE_HOLD_MIN,
  assembleLiveConditions,
  evaluateDisruption,
  evaluateLiveTerm,
  interpolatedPercentile,
  selectLivePercentile,
  waitDistribution,
} from "../services/airport/layoverLiveSignals.js";
import { UNCONFIGURED_LIVE_FEED, configuredLiveFeed, httpLiveFeedAdapter, parseLiveFeedPayload } from "../services/airport/layoverLiveFeed.js";
import { trafficSignalFromLeg } from "../services/airport/layoverLiveTraffic.js";
import {
  certifySessionFeasibility,
  conservativeBufferMinutes,
  type FeasibilityAirport,
  type FeasibilitySession,
} from "../services/airport/LayoverFeasibility.js";
import { computeWindow } from "../services/airport/LayoverSafetyEngine.js";

const MIN = 60_000;
const NOW = Date.parse("2030-06-14T21:00:00.000Z");
const REF = "SIN";
const ago = (m: number) => new Date(NOW - m * MIN).toISOString();

let seq = 0;
function obs(over: Partial<AirportObservation> & Pick<AirportObservation, "value">): AirportObservation {
  seq += 1;
  return {
    observationId: `o${seq}`,
    airportRef: REF,
    factType: "queue_report_minutes",
    observerKind: "community",
    observerId: `tv1-${seq}`,
    observedAt: ago(2),
    sourceRef: `portava:layover/traveller-report#${seq}`,
    ...over,
  };
}
/** n distinct travellers each reporting one value (queue_report_minutes). */
const crowd = (...values: number[]) => values.map((value) => obs({ value }));
const official = (value: number, over: Partial<AirportObservation> = {}) =>
  obs({ value, factType: "security_wait_minutes", observerKind: "official", observerId: "feed:sin-official", sourceRef: `feed:sin-official/${value}`, ...over });

function airport(over: Partial<FeasibilityAirport> = {}): FeasibilityAirport {
  return {
    id: "airport-sin", iataCode: REF, timezone: "Asia/Singapore", verified: false,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    ...over,
  };
}
function session(over: Partial<FeasibilitySession> = {}): FeasibilitySession {
  return {
    id: "session-live", arrivalTime: "2030-06-14T20:00:00.000Z", departureTime: "2030-06-15T06:00:00.000Z",
    boardingTime: null, flightType: "international", immigrationRequired: true, checkedBags: false, wantsToLeave: true,
    ...over,
  };
}
const term = (corpus: AirportObservation[], key: "securityWait" | "immigrationWait" | "taxiQueue" = "securityWait", extra = {}) =>
  evaluateLiveTerm(corpus, key, { nowMs: NOW, airportRef: REF, ...extra });
const liveOf = (corpus: AirportObservation[], extra: Parameters<typeof assembleLiveConditions>[0] extends infer T ? Partial<T> : never = {}) =>
  assembleLiveConditions({ nowMs: NOW, terms: { securityWait: term(corpus) }, ...extra });

// ═══════════════════════════════════════════════════════════════════════════
// L180 — the validation window
// ═══════════════════════════════════════════════════════════════════════════

describe("L180 — stored observations are validated before they can reach a safety calculation", () => {
  it("V1 trust floor: a reporter the trust engine scored below MIN_REPORTER_TRUST does not count", () => {
    const low = obs({ value: 60, observerTrust: MIN_REPORTER_TRUST - 0.05 });
    const ok = obs({ value: 60, observerTrust: MIN_REPORTER_TRUST });
    const w = validateObservationWindow([low, ok, obs({ value: 55 })], { nowMs: NOW, factType: "queue_report_minutes", airportRef: REF });
    assert.deepEqual(w.rejections, [{ observationId: low.observationId, reason: "untrusted_reporter" }]);
    assert.equal(w.communityReporters, 2);
  });

  it("V2 one reading per reporter: the newest stands, the older is superseded", () => {
    const old = obs({ value: 90, observerId: "tv1-same", observedAt: ago(20) });
    const newer = obs({ value: 25, observerId: "tv1-same", observedAt: ago(3) });
    const w = validateObservationWindow([old, newer, obs({ value: 30 })], { nowMs: NOW, factType: "queue_report_minutes", airportRef: REF });
    assert.deepEqual(w.rejections, [{ observationId: old.observationId, reason: "superseded_by_reporter" }]);
    assert.deepEqual(w.accepted.map((s) => s.observation.value).sort((a, b) => a - b), [25, 30]);
  });

  it("V3 MAD outliers among >= 3 community reporters are rejected — and an OFFICIAL reading is never tested", () => {
    const liar = obs({ value: 90 });
    const w = validateObservationWindow([...crowd(15, 15, 20), liar], { nowMs: NOW, factType: "queue_report_minutes", airportRef: REF });
    assert.deepEqual(w.rejections, [{ observationId: liar.observationId, reason: "outlier" }]);
    assert.equal(w.outlierTest.applied, true);
    assert.equal(w.outlierTest.median, 17.5);
    // the same long queue from an OFFICIAL source survives three short traveller readings
    const off = official(90);
    const w2 = validateObservationWindow([...crowd(15, 15, 20).map((o) => ({ ...o, factType: "security_wait_minutes" as const })), off], { nowMs: NOW, factType: "security_wait_minutes", airportRef: REF });
    assert.ok(w2.accepted.some((s) => s.observation.observationId === off.observationId), "a crowd voted an official reading away");
    // a spread that is a distribution, not a liar, is kept
    const w3 = validateObservationWindow(crowd(10, 20, 30, 40), { nowMs: NOW, factType: "queue_report_minutes", airportRef: REF });
    assert.equal(w3.rejections.length, 0);
  });

  it("V4 below three reporters there is no population: no dispersion test", () => {
    const w = validateObservationWindow(crowd(15, 90), { nowMs: NOW, factType: "queue_report_minutes", airportRef: REF });
    assert.equal(w.outlierTest.applied, false);
    assert.equal(w.accepted.length, 2);
  });

  it("V5 ONE stranger cannot move a deadline even beside an official reading (independent reporters)", () => {
    const stranger = obs({ value: 60, factType: "security_wait_minutes" });
    const w = validateObservationWindow([official(20), stranger], { nowMs: NOW, factType: "security_wait_minutes", airportRef: REF });
    assert.deepEqual(w.rejections, [{ observationId: stranger.observationId, reason: "uncorroborated" }]);
    // and the spec's getTruth reads the validated window
    assert.equal(getTruth(REF, "security_wait_minutes", NOW, [official(20), obs({ value: 60, factType: "security_wait_minutes" })])?.value, 20);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L54 / L55 — the distribution and the percentile policy
// ═══════════════════════════════════════════════════════════════════════════

describe("L54/L55 — p50/p75/p90 from evidence; the configured conservative percentile by maturity and consequence", () => {
  it("D1 interpolated percentiles; THIN evidence's p90 is its maximum; ESTABLISHED evidence's is interpolated", () => {
    assert.equal(interpolatedPercentile([10, 20, 30, 40, 50], 50), 30);
    assert.equal(interpolatedPercentile([10, 20, 30, 40, 50], 90), 46);
    const thin = waitDistribution([{ value: 20, kind: "community" }, { value: 60, kind: "community" }])!;
    assert.equal(thin.maturity, "thin");
    assert.deepEqual([thin.p50, thin.p75, thin.p90], [40, 50, 60]);
    const est = waitDistribution([10, 20, 30, 40, 50].map((value) => ({ value, kind: "community" as const })))!;
    assert.equal(MIN_DISTRIBUTION_READINGS, 5);
    assert.equal(est.maturity, "established");
    assert.deepEqual([est.p50, est.p75, est.p90], [30, 40, 46]);
  });

  it("D2 every percentile is floored at the longest AUTHORITATIVE reading — travellers never shorten a wait", () => {
    const d = waitDistribution([{ value: 50, kind: "official" }, { value: 10, kind: "community" }, { value: 12, kind: "community" }])!;
    assert.deepEqual([d.p50, d.p75, d.p90], [50, 50, 50]);
    const t = term([official(50), ...crowd(10, 12)])!;
    assert.equal(t.truth.value, 50);
  });

  it("P1 the policy is a table: flight reads p90 at every maturity; other consequences relax with maturity", () => {
    assert.equal(selectLivePercentile("flight", "thin"), "p90");
    assert.equal(selectLivePercentile("flight", "established"), "p90");
    assert.equal(selectLivePercentile("activity", "established"), "p75");
    assert.equal(selectLivePercentile("advisory", "established"), "p50");
    assert.notEqual(LIVE_PERCENTILE_POLICY.activity.thin, LIVE_PERCENTILE_POLICY.activity.established, "maturity must move some consequence's percentile");
  });

  it("P2 the CERTIFIED deadline is taken at the selected percentile — not the median, not an average — and configuring it changes the answer", () => {
    const readings = crowd(25, 35, 45, 55, 95).map((o) => ({ ...o, value: o.value }));
    const p90Live = liveOf(readings)!;
    const p50Live = assembleLiveConditions({ nowMs: NOW, terms: { securityWait: evaluateLiveTerm(readings, "securityWait", { nowMs: NOW, airportRef: REF, policy: { ...LIVE_PERCENTILE_POLICY, flight: { thin: "p50", established: "p50" } } }) } })!;
    const a = airport(); const s = session();
    const r90 = certifySessionFeasibility(a, s, { nowMs: NOW, liveConditions: p90Live });
    const r50 = certifySessionFeasibility(a, s, { nowMs: NOW, liveConditions: p50Live });
    const none = certifySessionFeasibility(a, s, { nowMs: NOW, liveConditions: null });
    // 95 is a MAD outlier (median 45, MAD 10, threshold 44.5; it is 50 away) → [25,35,45,55], thin: p90 = 55, p50 = 40
    assert.equal(p90Live.securityWaitExtraMin, 35);
    assert.equal(p50Live.securityWaitExtraMin, 20);
    assert.equal(p90Live.estimate!.percentile, "p90");
    assert.ok(r90.deadline.hardReturnTime < r50.deadline.hardReturnTime, "the p90 deadline must be EARLIER than the median's");
    assert.ok(r50.deadline.hardReturnTime < none.deadline.hardReturnTime, "the median's still earlier than no live term (all above baseline)");
    // the record publishes the spread and its selection is the deadline's buffer
    const le = r90.estimates.liveExtra;
    assert.equal(le.sourceClass, "LIVE");
    assert.ok(le.p50Minutes < le.p90Minutes, `degenerate: p50 ${le.p50Minutes} p90 ${le.p90Minutes}`);
    assert.equal(r90.bufferMinutesAtPercentile, r90.deadline.breakdown.totalBuffer, "the configured percentile IS the deadline's buffer");
    assert.ok(conservativeBufferMinutes(r90.estimates, "p50") < r90.deadline.breakdown.totalBuffer, "p50 must be visibly smaller — not collapsed");
  });

  it("P3 thin vs established: the same top reading is the p90 when thin, and not when established (maturity moves the flight figure)", () => {
    const thin = term(crowd(30, 50))!;
    assert.equal(thin.distribution.maturity, "thin");
    assert.equal(thin.truth.value, 50);
    const est = term(crowd(30, 34, 38, 42, 50))!;
    assert.equal(est.distribution.maturity, "established");
    assert.ok(est.truth.value < 50 && est.truth.value > 42, `established p90 ${est.truth.value}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L81 / L281 / L286 / L285 — fast live reaches the buffer, with its codes
// ═══════════════════════════════════════════════════════════════════════════

describe("fast live → the buffer, SECURITY_WAIT_HIGH, SOURCE_CONFLICT, DATA_STALE", () => {
  it("L81/L281 a corroborated long security queue adds its excess over the baseline and emits SECURITY_WAIT_HIGH", () => {
    const live = liveOf(crowd(50, 60))!;
    assert.equal(live.securityWaitExtraMin, 40, "p90 (thin: the max) 60 − baseline 20");
    assert.ok(live.reasonCodes.includes("SECURITY_WAIT_HIGH"));
    assert.equal(live.estimate!.p50ExtraMin, 35);
    assert.equal(live.estimate!.confidence, "LOW", "traveller evidence never above LOW");
    const r = certifySessionFeasibility(airport(), session(), { nowMs: NOW, liveConditions: live });
    assert.ok(r.reasonCodes.includes("SECURITY_WAIT_HIGH"), "the code must reach the certified advice");
    assert.equal(r.deadline.breakdown.liveExtra, 40);
  });

  it("L81 immigration and taxi feeds fold into their own terms", () => {
    const imm = obs({ value: 65, factType: "immigration_wait_minutes", observerKind: "operator_feed", observerId: "feed:x" });
    const taxi = obs({ value: 40, factType: "taxi_queue_minutes", observerKind: "operator_feed", observerId: "feed:x" });
    const live = assembleLiveConditions({ nowMs: NOW, terms: { immigrationWait: term([imm], "immigrationWait"), taxiQueue: term([taxi], "taxiQueue") } })!;
    assert.equal(live.immigrationWaitExtraMin, 45);
    assert.equal(live.groundTransportExtraMin, 30);
    assert.ok(live.reasonCodes.includes("TRAFFIC_DEGRADED"), "a 40-minute taxi queue is degraded return travel");
  });

  it("L286 credible sources disagreeing beyond tolerance: SOURCE_CONFLICT, the conservative value, confidence down", () => {
    const t = term([official(15), ...crowd(55, 60)])!;
    assert.equal(t.truth.conflict, true);
    assert.equal(t.truth.value, 60);
    const agree = term([official(50), ...crowd(52, 55)])!;
    assert.equal(agree.truth.conflict, false);
    assert.equal(agree.truth.confidence, "HIGH", "a fresh official reading the crowd agrees with");
    assert.equal(t.truth.confidence, "MEDIUM", "the same official reading, contradicted: one step down");
    const offOnly = term([official(15), obs({ value: 50, factType: "security_wait_minutes", observerKind: "operator_feed", observerId: "feed:lic" })])!;
    assert.equal(offOnly.truth.conflict, true);
    assert.equal(offOnly.truth.confidence, "MEDIUM", "HIGH stepped down by the contradiction");
    const live = liveOf([official(15), ...crowd(55, 60)])!;
    assert.ok(live.reasonCodes.includes("SOURCE_CONFLICT"));
  });

  it("L285 evidence past its TTL but inside the hold is HELD (never a silent widening) and named DATA_STALE; beyond the hold it is gone", () => {
    // traveller TTL is 45 min: observed 50 min ago is 5 min past it
    const stale = crowd(55, 60).map((o) => ({ ...o, observedAt: ago(50) }));
    const t = term(stale)!;
    assert.equal(t.stale, true);
    assert.equal(t.truth.value, 60, "held at its conservative value");
    assert.equal(t.truth.fallbackLevel, 1);
    const live = liveOf(stale)!;
    assert.ok(live.reasonCodes.includes("DATA_STALE"));
    assert.equal(live.securityWaitExtraMin, 40);
    assert.equal(live.estimate!.fallbackLevel, 1);
    const gone = crowd(55, 60).map((o) => ({ ...o, observedAt: ago(45 + STALE_HOLD_MIN + 1) }));
    assert.equal(term(gone), null);
  });

  it("L285 a fresh crowd retires a stale crowd; a stale AUTHORITATIVE reading is still held under fresh traveller readings", () => {
    const staleCrowd = crowd(70, 75).map((o) => ({ ...o, observedAt: ago(50) }));
    const freshCrowd = crowd(25, 30);
    assert.equal(term([...staleCrowd, ...freshCrowd])!.truth.value, 30);
    const staleOfficial = official(70, { observedAt: ago(25) }); // FAST_LIVE TTL 20
    const held = term([staleOfficial, ...freshCrowd])!;
    assert.equal(held.truth.value, 70, "travellers retired an official figure");
    assert.equal(held.stale, true);
  });

  it("a store / feed / plan that cannot be read is DATA_STALE with LOW confidence and no invented minutes", () => {
    const live = assembleLiveConditions({ nowMs: NOW, terms: {}, degraded: ["store_unreadable"] })!;
    assert.deepEqual([live.securityWaitExtraMin, live.immigrationWaitExtraMin, live.groundTransportExtraMin], [0, 0, 0]);
    assert.deepEqual(live.reasonCodes, ["DATA_STALE"]);
    assert.equal(live.estimate!.confidence, "LOW");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Traveller evidence is supporting evidence, never proof of safety
// ═══════════════════════════════════════════════════════════════════════════

describe("traveller reports may only make the answer MORE conservative", () => {
  it("T1 a traveller-only reading at or under the baseline is not folded at all", () => {
    assert.equal(term(crowd(5, 10)), null);
    assert.equal(liveOf(crowd(5, 10)), null);
  });
  it("T2 traveller confidence is capped at LOW whatever their standing", () => {
    const t = term(crowd(40, 45).map((o) => ({ ...o, observerTrust: 1 })))!;
    assert.equal(t.truth.confidence, "LOW");
  });
  it("T3 a traveller-only set can never lower the record's confidence below what it was AND never raise it", () => {
    const a = airport({ verified: true });
    const base = certifySessionFeasibility(a, session(), { nowMs: NOW, liveConditions: null });
    const withCrowd = certifySessionFeasibility(a, session(), { nowMs: NOW, liveConditions: liveOf(crowd(50, 60)) });
    const idx = (c: string) => ["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"].indexOf(c);
    assert.ok(idx(withCrowd.confidence) <= idx(base.confidence));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L227 — security spike → envelope contracts monotonically
// ═══════════════════════════════════════════════════════════════════════════

describe("L227 — a security spike contracts the envelope MONOTONICALLY", () => {
  it("M1 swept over the plausible range: usable minutes never increase as the observed queue grows, and do shrink", () => {
    const a = airport(); const s = session();
    let prev = Infinity; const seen: number[] = [];
    for (let v = 0; v <= 240; v += 5) {
      const live = liveOf(crowd(v, v));
      const w = computeWindow(a, s, NOW, live);
      assert.ok(w.usableMinutes <= prev, `queue ${v}: usable ${w.usableMinutes} > ${prev}`);
      prev = w.usableMinutes; seen.push(w.usableMinutes);
    }
    assert.ok(seen[0]! - seen[seen.length - 1]! >= 200, "the sweep never contracted — vacuous");
  });
  it("M2 the same spike does not re-widen while its evidence ages inside its TTL", () => {
    const a = airport(); const s = session();
    const at = (age: number) => computeWindow(a, s, NOW, liveOf(crowd(60, 60).map((o) => ({ ...o, observedAt: ago(age) })))).usableMinutes;
    const fresh = at(1);
    for (const age of [10, 20, 30, 40, 44, 50, 80]) assert.equal(at(age), fresh, `re-widened at age ${age}`);
    assert.ok(at(45 + STALE_HOLD_MIN + 5) > fresh, "beyond the hold the spike's evidence is gone");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L228 / L287 — traffic
// ═══════════════════════════════════════════════════════════════════════════

describe("L228/L287 — a traffic spike moves the return deadline earlier and emits TRAFFIC_DEGRADED", () => {
  const leg = (minutes: number, freeFlowMinutes: number | null, forecast = true) => ({ minutes, freeFlowMinutes, forecast, confidence: "MEDIUM" as const, departAt: ago(-300) });
  const meta = { nowMs: NOW, expiresAt: ago(-5), sourceRefs: ["google-routes:fixture"] };
  it("TR1 only the traffic ABOVE what the static buffer budgets is a live term; a free-flow figure is no traffic signal", () => {
    assert.equal(trafficSignalFromLeg(leg(30, 18, false), 25, meta), null, "a non-forecast says nothing about traffic");
    assert.equal(trafficSignalFromLeg(leg(30, null), 25, meta), null);
    assert.equal(trafficSignalFromLeg(leg(33, 18), 25, meta)!.excessMin, 0);
    assert.equal(trafficSignalFromLeg(leg(90, 18), 25, meta)!.excessMin, 47);
  });
  it("TR2 the excess reaches the deadline, monotonically, with TRAFFIC_DEGRADED", () => {
    const a = airport(); const s = session();
    let prev = Infinity;
    for (const traffic of [18, 40, 60, 90, 120]) {
      const sig = trafficSignalFromLeg(leg(traffic, 18), 25, meta)!;
      const live = assembleLiveConditions({ nowMs: NOW, terms: {}, traffic: sig })!;
      const r = certifySessionFeasibility(a, s, { nowMs: NOW, liveConditions: live });
      const t = r.deadline.hardReturnTime.getTime();
      assert.ok(t <= prev, `traffic ${traffic} moved the deadline LATER`);
      if (sig.excessMin > 0) assert.ok(r.reasonCodes.includes("TRAFFIC_DEGRADED"));
      prev = t;
    }
    const none = certifySessionFeasibility(a, s, { nowMs: NOW, liveConditions: null }).deadline.hardReturnTime.getTime();
    assert.equal(none - prev, (120 - 18 - 25) * MIN, "the deadline moved earlier by exactly the excess");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Disruption — fail closed when an authoritative source says severe and nobody says minutes
// ═══════════════════════════════════════════════════════════════════════════

describe("disruption fails CLOSED through confidence, never through a fabricated figure", () => {
  it("an official severe disruption makes the live estimate INSUFFICIENT; corroborated closures step it down", () => {
    const severe = obs({ value: 3, factType: "disruption_level", observerKind: "official", observerId: "feed:o" });
    const d = evaluateDisruption([severe], { nowMs: NOW, airportRef: REF })!;
    assert.equal(d.severe, true);
    const live = assembleLiveConditions({ nowMs: NOW, terms: {}, disruption: d })!;
    assert.equal(live.estimate!.confidence, "INSUFFICIENT");
    const r = certifySessionFeasibility(airport(), session(), { nowMs: NOW, liveConditions: live });
    assert.equal(r.confidence, "INSUFFICIENT", "the record must fold the fail-closed confidence");
    assert.equal(r.deadline.breakdown.liveExtra, 0, "no minutes were invented");
    // one traveller's closure report moves nothing; two corroborate
    assert.equal(evaluateDisruption([obs({ value: 1, factType: "closure_reported" })], { nowMs: NOW, airportRef: REF }), null);
    const two = evaluateDisruption([obs({ value: 1, factType: "closure_reported" }), obs({ value: 1, factType: "closure_reported" })], { nowMs: NOW, airportRef: REF })!;
    assert.equal(two.closureCorroborated, true);
    assert.equal(two.severe, false, "travellers can never declare a severe disruption");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The licensed / official feed adapter — contract fixtures, named absence
// ═══════════════════════════════════════════════════════════════════════════

describe("the feed adapter (no feed is purchased: a named absence; the contract is pinned by fixtures)", () => {
  const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/layoverLiveFeed/${n}`, import.meta.url), "utf8"));
  it("F1 unconfigured is a NAMED ABSENCE naming the two variables, never an empty reading list", async () => {
    const r = await UNCONFIGURED_LIVE_FEED.read(REF, NOW);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.reason === "feed_not_configured" && /LAYOVER_LIVE_FEED_URL/.test(r.detail) && /LAYOVER_LIVE_FEED_API_KEY/.test(r.detail));
    assert.equal(configuredLiveFeed(() => undefined), UNCONFIGURED_LIVE_FEED);
    assert.equal(configuredLiveFeed((n) => (n === "LAYOVER_LIVE_FEED_URL" ? "https://feed.example" : undefined)), UNCONFIGURED_LIVE_FEED, "a URL without a key is not a feed");
  });
  it("F2 the contract fixture parses to one observation per fact, the LONGEST checkpoint, as the authority it claims", () => {
    const p = parseLiveFeedPayload(fixture("sin-conditions.json"), REF, "lic");
    assert.ok(p.ok);
    const by = Object.fromEntries(p.observations.map((o) => [o.factType, o]));
    assert.equal(by["security_wait_minutes"]!.value, 35, "T1 20 / T3 35: the longest");
    assert.equal(by["security_wait_minutes"]!.observerKind, "operator_feed");
    assert.equal(by["immigration_wait_minutes"]!.value, 25);
    assert.equal(by["disruption_level"]!.value, 1);
    assert.match(by["security_wait_minutes"]!.sourceRef, /^feed:lic\/licensed\//);
  });
  it("F3 a payload that is not the contract, or is for another airport, is refused WHOLE", () => {
    assert.equal(parseLiveFeedPayload(fixture("malformed.json"), REF, "lic").ok, false);
    assert.equal(parseLiveFeedPayload(fixture("sin-conditions.json"), "BKK", "lic").ok, false);
  });
  it("F4 the HTTP adapter: bearer auth on the contract path; HTTP errors, throws and junk are named refusals", async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const ok = httpLiveFeedAdapter({ baseUrl: "https://feed.example/", apiKey: "k", id: "lic", fetchImpl: (async (url: string, init: any) => { calls.push({ url, auth: init.headers.authorization }); return { ok: true, status: 200, json: async () => fixture("sin-conditions.json") }; }) as any });
    const r = await ok.read(REF, NOW);
    assert.ok(r.ok && r.observations.length === 3);
    assert.deepEqual(calls, [{ url: "https://feed.example/v1/airports/SIN/conditions", auth: "Bearer k" }]);
    const down = httpLiveFeedAdapter({ baseUrl: "https://feed.example", apiKey: "k", fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as any });
    assert.deepEqual(((await down.read(REF, NOW)) as any).reason, "feed_unavailable");
    const throws = httpLiveFeedAdapter({ baseUrl: "https://feed.example", apiKey: "k", fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as any });
    assert.deepEqual(((await throws.read(REF, NOW)) as any).reason, "feed_unavailable");
    const junk = httpLiveFeedAdapter({ baseUrl: "https://feed.example", apiKey: "k", fetchImpl: (async () => ({ ok: true, status: 200, json: async () => fixture("malformed.json") })) as any });
    assert.deepEqual(((await junk.read(REF, NOW)) as any).reason, "feed_malformed");
  });
  it("F5 a feed reading is screened like every other: an implausible 900-minute queue never reaches the buffer", () => {
    const silly = obs({ value: 900, factType: "security_wait_minutes", observerKind: "operator_feed", observerId: "feed:lic" });
    assert.equal(term([silly]), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Safe Return's disruption counterfactual holds the WORLD fixed
// ═══════════════════════════════════════════════════════════════════════════

describe("a disruption recompute keeps the live conditions `before` was certified under", () => {
  it("SR1 the deadline moves by the schedule change alone — the live term does not silently vanish from `after`", async () => {
    const { recomputeForDisruption } = await import("../services/airport/LayoverSafeReturnService.js");
    const a = airport(); const s = session();
    const live = liveOf(crowd(50, 60))!;
    const before = certifySessionFeasibility(a, s, { nowMs: NOW, liveConditions: live });
    const later = new Date(Date.parse(s.departureTime) + 60 * MIN).toISOString();
    const r = recomputeForDisruption(a, s, { state: "DELAYED", newDepartureTime: later, nowMs: NOW, before });
    assert.deepEqual(r.after.inputs.liveConditions, before.inputs.liveConditions);
    assert.equal(r.after.deadline.hardReturnTime.getTime() - before.deadline.hardReturnTime.getTime(), 60 * MIN, "the diff must be the delay's, not the live term's disappearance");
  });
});

describe("the producer's terms read only SAFETY-CRITICAL facts (so rule 5 binds every one of them)", () => {
  it("G1 every fact a buffer term reads is in SAFETY_CRITICAL_FACTS", async () => {
    const { SAFETY_CRITICAL_FACTS } = await import("../services/airport/LayoverAirportTruth.js");
    const { LIVE_TERM_FACTS } = await import("../services/airport/layoverLiveSignals.js");
    for (const [t, facts] of Object.entries(LIVE_TERM_FACTS)) for (const f of facts) assert.ok(SAFETY_CRITICAL_FACTS.has(f), `${t} reads ${f}, which rule 5 does not bind`);
  });
  it("G2 one traveller reporting under two facts is still ONE witness: no live term", () => {
    const one = [obs({ value: 70, observerId: "tv1-solo" }), obs({ value: 75, observerId: "tv1-solo", factType: "checkpoint_timing_minutes" })];
    assert.equal(term(one), null);
  });
});

describe("only an AUTHORITATIVE source can declare a severe disruption", () => {
  it("D3 community disruption_level readings — however many, however high — never fail the estimate closed", () => {
    const crowdSevere = [obs({ value: 4, factType: "disruption_level" }), obs({ value: 4, factType: "disruption_level" }), obs({ value: 4, factType: "disruption_level" })];
    assert.equal(evaluateDisruption(crowdSevere, { nowMs: NOW, airportRef: REF }), null);
  });
});
