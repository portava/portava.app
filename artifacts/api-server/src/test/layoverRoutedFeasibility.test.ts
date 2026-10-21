/**
 * LAYOVER 165, lane B1-R1 — §8 with ROUTED terms, in the spec's own words.
 *
 *   L60  "bidirectional reachability: airport → candidate and candidate →
 *        airport under future return-time conditions"
 *   L65  "candidate_feasible iff outbound_arrival + minimum_experience_duration
 *        + conservative_return_duration <= hard_return_by"
 *   L63  "Envelope edges must contract as confidence drops or return risk rises"
 *   L66  "SafeEnvelope = union(points satisfying feasibility constraint)"
 *   L61  "time-based isochrone/envelope geometry, not a fixed radius"
 *   L68  "Multiple independent return routes → increase robustness / candidate preference"
 *   L69  "Single fragile corridor → increase risk penalty"
 *   L70  "Non-interruptible transport/activity → increase risk penalty"
 *   L71  "Transfer count → increase plan complexity / uncertainty"
 *   L282 RETURN_ROUTE_UNRELIABLE "Return route reliability below configured threshold"
 *   L260 "Candidate explosion — pre-filter by envelope/time/category before expensive ranking"
 *
 * The record is the REAL certified record (`certifySessionFeasibility`); the
 * corridors come from a corridor double whose every answer is a well-formed
 * `RouteCorridor` (the contract fixtures pin the Google parse separately, in
 * layoverRoutedProviderContract.test.ts), plus one section (P) that routes
 * through the REAL Google adapter over the documented fixtures to count billed
 * requests.
 *
 * Run: node --import tsx/esm --test src/test/layoverRoutedFeasibility.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { certifySessionFeasibility, type LayoverFeasibilityRecord } from "../services/airport/LayoverFeasibility.js";
import { safeEnvelope } from "../services/airport/LayoverEnvelope.js";
import {
  LAYOVER_ROUTED_POLICY,
  conservativeReturnMinutes,
  judgeRoutedCandidate,
  robustnessOf,
  routeLayoverCandidates,
  routedEnvelopeVerdict,
  routedPreference,
  type RoutedCandidate,
} from "../services/airport/LayoverRoutedFeasibility.js";
import {
  independentRouteCount,
  measured,
  unmeasured,
  type CorridorQuery,
  type CorridorResult,
  type RouteCorridor,
  type RouteCorridorProvider,
  type RouteLeg,
  type RouteOption,
} from "../lib/providers/routeCorridorProvider.js";
import { refuse } from "../lib/providers/providerRefusal.js";
import { bothDirections } from "../lib/providers/routeCorridorProvider.js";
import { createGoogleRoutesCorridorProvider, CREDENTIAL_ENV, ENABLEMENT_ENV } from "../lib/providers/googleRoutesCorridorProvider.js";
import { withRoutesRequestBudget } from "../domain/trips/contracts/RoutesRequestBudget.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";
import type { RoutedLegs } from "../services/airport/LayoverReturnCorridor.js";
import type { TravelConfidence } from "../lib/travelEstimate.js";

const MIN = 60_000;
const NOW = Date.parse("2026-10-18T06:00:00.000Z");
const AIRPORT_POINT = { lat: 25.0797, lng: 121.2342 };
const north = (km: number) => ({ lat: AIRPORT_POINT.lat + km / 111.32, lng: AIRPORT_POINT.lng });
const east = (km: number) => ({ lat: AIRPORT_POINT.lat, lng: AIRPORT_POINT.lng + km / (111.32 * Math.cos((AIRPORT_POINT.lat * Math.PI) / 180)) });
const PERMITTED = { state: "permitted" as const, corridor: { passportCountry: "US", destinationCountry: "TW" }, status: "visa_free" };

function airport(verified: boolean): AirportProfile {
  return {
    id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan", country: "Taiwan", countryCode: "TW",
    timezone: "Asia/Taipei", lat: AIRPORT_POINT.lat, lng: AIRPORT_POINT.lng,
    domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified,
  } as AirportProfile;
}
function session(): LayoverSession {
  return {
    id: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(NOW - 60 * MIN).toISOString(), departureTime: new Date(NOW + 9 * 60 * MIN).toISOString(),
    boardingTime: null, layoverMinutes: 600, flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: [], manualAirportName: null, manualCity: null,
    manualCountry: null, manualIata: null, canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
  } as LayoverSession;
}
/** The certified record: unverified airport → LOW (every production session today); verified → MEDIUM. */
const record = (verified = false): LayoverFeasibilityRecord => certifySessionFeasibility(airport(verified), session(), { nowMs: NOW, entry: PERMITTED });
const windowMinutes = (r: LayoverFeasibilityRecord) => (r.deadline.hardReturnTime.getTime() - Math.max(NOW, r.envelope.earliestOutTime.getTime())) / MIN;

// ── corridor doubles ─────────────────────────────────────────────────────────
interface Spec { minutes: number; freeFlow?: number; routes?: number; sharedPoint?: boolean; leg?: RouteLeg["interruptibility"]; transfers?: number; sourceClass?: RouteCorridor["sourceClass"]; confidence?: TravelConfidence; fallback?: boolean; expiresInMin?: number }
function corridorOf(q: CorridorQuery, s: Spec): RouteCorridor {
  const n = s.routes ?? 3;
  const routes: RouteOption[] = [];
  for (let i = 0; i < n; i++) {
    const rides = (s.transfers ?? 0) + 1;
    const legs: RouteLeg[] = [];
    for (let k = 0; k < rides; k++) {
      legs.push({ mode: (s.transfers ?? 0) > 0 ? "transit" : (q.mode ?? "drive"), minutes: Math.max(1, Math.floor((s.freeFlow ?? s.minutes) / rides)), distanceMeters: 1000, interruptibility: k === 0 ? (s.leg ?? "interruptible") : "interruptible", transferPointId: (s.transfers ?? 0) > 0 && k < rides - 1 ? (s.sharedPoint ? "Shared Interchange" : `X-${i}-${k}`) : null });
    }
    routes.push({ legs, totalMinutes: s.minutes + i * 2, transferCount: Math.max(0, rides - 1) });
  }
  if (s.sharedPoint && (s.transfers ?? 0) === 0) for (const r of routes) r.legs[0]!.transferPointId = "Shared Interchange";
  return {
    from: q.from!, to: q.to!, departAt: q.departAt.toISOString(), routes,
    independentRouteCount: independentRouteCount(routes),
    reliability: measured({ spreadMinutes: (n - 1) * 2, optionCount: n }, "LIVE", "MEDIUM", ["double"]),
    queueFriction: unmeasured("no feed"), weather: unmeasured("no feed"), airportReentryMinutes: unmeasured("no feed"),
    observedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + (s.expiresInMin ?? 5) * MIN).toISOString(),
    sourceClass: s.sourceClass ?? (q.mode === "walk" ? "HISTORICAL" : "LIVE"), confidence: s.confidence ?? "MEDIUM",
    sourceRefs: ["double", ...(s.fallback ? ["google:routes.v2:fallback:FALLBACK_TRAFFIC_UNAWARE:LATENCY_EXCEEDED"] : [])],
  };
}
function provider(out: Spec | ((q: CorridorQuery) => Spec), back: Spec | ((q: CorridorQuery) => Spec)) {
  const asked: CorridorQuery[] = [];
  const p: RouteCorridorProvider & { asked: CorridorQuery[] } = {
    id: "double", routed: true, asked,
    async corridor(q): Promise<CorridorResult> {
      asked.push(q);
      const toAirport = isAirport(q.to);
      const s = toAirport ? (typeof back === "function" ? back(q) : back) : (typeof out === "function" ? out(q) : out);
      return { ok: true, value: corridorOf(q, s) };
    },
    async bidirectional(q) { return bothDirections(p, q); },
  };
  return p;
}
const evaluate = (r: LayoverFeasibilityRecord, p: RouteCorridorProvider, candidates: Array<{ key: string; point: { lat: number; lng: number } | null; minExperienceMin: number | null; insideAirport?: boolean; categoryAllowed?: boolean }>) =>
  routeLayoverCandidates({ record: r, airport: AIRPORT_POINT, landsideAllowed: true, outerBound: safeEnvelope(r.envelope.usableMinutes, AIRPORT_POINT, r.confidence), corridorProvider: p, candidates });
const one = async (r: LayoverFeasibilityRecord, p: RouteCorridorProvider, minExp: number | null, point = east(12)): Promise<RoutedCandidate> =>
  (await evaluate(r, p, [{ key: "c", point, minExperienceMin: minExp }])).byKey.get("c")!;
const BAND_RANK: Record<string, number> = { SAFE: 3, TIGHT: 2, UNCERTIFIED: 1, BLOCKED: 0 };
const isAirport = (p: { lat: number; lng: number } | null) => !!p && p.lat === AIRPORT_POINT.lat && p.lng === AIRPORT_POINT.lng;
/** The production record is LOW today (timeOfDayExtra is a STATIC_DEFAULT everywhere); a test that sweeps the band sets it. */
const withConfidence = (r: LayoverFeasibilityRecord, c: LayoverFeasibilityRecord["confidence"]): LayoverFeasibilityRecord => ({ ...r, confidence: c });

describe("L65 — candidate_feasible iff outbound_arrival + minimum_experience_duration + conservative_return_duration <= hard_return_by", () => {
  it("F1. the boundary is exact: the largest dwell that fits is feasible, one minute more is BLOCKED", async () => {
    const r = record(false);
    const W = windowMinutes(r);
    assert.ok(Number.isInteger(W) && W > 200, `positive control: a whole-minute window with room (${W})`);
    const p = provider({ minutes: 20 }, { minutes: 30 });
    const probe = await one(r, p, 30);
    const cr = probe.terms!.conservativeReturnMinutes;
    assert.equal(cr, Math.ceil(30 * 1.25), "LOW confidence: the return held back by ENVELOPE_UNCERTAINTY_BUDGET.LOW (25%), no robustness margin");
    const fit = W - 20 - cr;
    const at = await one(r, p, fit);
    assert.equal(at.state, "FEASIBLE", `dwell ${fit}: 20 + ${fit} + ${cr} = ${W}`);
    assert.equal(at.terms!.slackMinutes, 0);
    assert.equal(at.terms!.expectedAirportReturnAt, r.deadline.hardReturnTime.toISOString(), "back exactly at hard_return_by");
    const over = await one(r, p, fit + 1);
    assert.equal(over.state, "INFEASIBLE");
    assert.equal(over.band, "BLOCKED");
    assert.match(over.reason!, /past your/);
  });

  it("F2. every term is the ROUTED one: outbound from the router, the return from the router at its own instant — not a constant, not the outbound doubled", async () => {
    const r = record(false);
    const p = provider({ minutes: 20 }, { minutes: 45 });
    const c = await one(r, p, 60);
    assert.equal(c.terms!.outboundMinutes, 20);
    assert.equal(c.terms!.returnMinutes, 45, "the way back is its own measurement (45), not 2 × 20");
    assert.equal(c.terms!.conservativeReturnMinutes, Math.ceil(45 * 1.25));
    assert.equal(c.terms!.minExperienceMin, 60);
    assert.equal(c.terms!.experienceBasis, "stated");
  });

  it("F3. no stated dwell → UNMEASURED (never certified), unless even the journey alone overflows → BLOCKED", async () => {
    const r = record(false);
    const W = windowMinutes(r);
    const unstated = await one(r, provider({ minutes: 20 }, { minutes: 30 }), null);
    assert.equal(unstated.state, "UNMEASURED");
    assert.equal(unstated.absence?.reason, "experience_unstated");
    assert.equal(unstated.terms!.outboundMinutes, 20, "the routed legs are still published");
    const tooFar = await one(r, provider({ minutes: Math.ceil(W / 2) }, { minutes: Math.ceil(W / 2) }), null);
    assert.equal(tooFar.state, "INFEASIBLE");
  });
});

describe("L60 — both directions, the return under its own future instant", () => {
  it("F4. the way out is asked for the window's start; the way back for arrival + dwell; two different instants", async () => {
    const r = record(false);
    const p = provider({ minutes: 20 }, { minutes: 30 });
    await one(r, p, 45);
    const start = Math.max(NOW, r.envelope.earliestOutTime.getTime());
    const outs = p.asked.filter((q) => isAirport(q.from));
    const backs = p.asked.filter((q) => isAirport(q.to));
    assert.ok(outs.length >= 1 && backs.length === 2); assert.ok(backs.some(q => q.mode === 'transit'), 'one additional future transit return follows the primary');
    assert.equal(outs[0]!.departAt.getTime(), start);
    assert.equal(backs[0]!.departAt.getTime(), start + (20 + 45) * MIN, "the return is priced when the traveller would set off back");
    assert.notEqual(backs[0]!.departAt.getTime(), outs[0]!.departAt.getTime());
  });
  it("F5. a DRIVE way back that is not a forecast (Google's traffic-unaware fallback) certifies nothing; it may still refuse", async () => {
    const r = record(false);
    const fb = await one(r, provider({ minutes: 20 }, { minutes: 30, sourceClass: "HISTORICAL", confidence: "LOW", fallback: true }), 45);
    assert.equal(fb.state, "UNMEASURED");
    assert.equal(fb.absence?.reason, "return_forecast_unavailable");
    assert.equal(fb.terms, null, "no conservative term is built on a free-flow figure");
    const W = windowMinutes(r);
    const refused = await one(r, provider({ minutes: 20, freeFlow: 20 }, { minutes: W, freeFlow: W, sourceClass: "HISTORICAL", fallback: true }), 30);
    assert.equal(refused.state, "INFEASIBLE", "even free-flowing traffic overflows the window: a refusal is safe");
  });
  it("F6. a stale pair of legs certifies nothing", async () => {
    const r = record(false);
    const stale = await one(r, provider({ minutes: 20, expiresInMin: -1 }, { minutes: 30, expiresInMin: -1 }), 45);
    assert.equal(stale.state, "UNMEASURED");
  });
});

describe("L68–L71 — the §8.1 signals change the verdict monotonically: worse → contract", () => {
  it("F7. L69 a single fragile corridor adds a risk margin and can never be SAFE; L68 three independent routes are preferred", async () => {
    const r = record(true);
    const robust = await one(r, provider({ minutes: 20 }, { minutes: 30, routes: 3 }), 30);
    const single = await one(r, provider({ minutes: 20 }, { minutes: 30, routes: 1 }), 30);
    const shared = await one(r, provider({ minutes: 20 }, { minutes: 30, routes: 3, sharedPoint: true }), 30);
    assert.equal(robust.band, "SAFE");
    assert.equal(robust.terms!.robustness.fragileMinutes, 0);
    for (const fragile of [single, shared]) {
      assert.equal(fragile.terms!.robustness.fragileCorridor, true);
      assert.equal(fragile.terms!.robustness.fragileMinutes, Math.max(10, Math.ceil(30 * 0.25)));
      assert.ok(fragile.terms!.conservativeReturnMinutes > robust.terms!.conservativeReturnMinutes);
      assert.equal(fragile.band, "TIGHT");
      assert.ok(fragile.preference < robust.preference, "L68: more independent ways back are preferred");
    }
    assert.equal(shared.terms!.robustness.independentReturnRoutes, 1, "three routes through one interchange are ONE way back");
  });
  it("F8. L70 a non-interruptible way back (and an unknown one) adds a margin and is not SAFE", async () => {
    const r = record(true);
    for (const leg of ["committed", "unknown"] as const) {
      const c = await one(r, provider({ minutes: 20 }, { minutes: 30, routes: 3, leg }), 30);
      assert.equal(c.terms!.robustness.nonInterruptible, true, leg);
      assert.equal(c.terms!.robustness.nonInterruptibleMinutes, Math.max(5, Math.ceil(30 * 0.15)));
      assert.equal(c.band, "TIGHT", leg);
    }
  });
  it("F9. L71 every transfer adds minutes, and two or more lower the candidate's confidence to LOW", async () => {
    const r = withConfidence(record(true), "MEDIUM");
    const zero = await one(r, provider({ minutes: 20 }, { minutes: 30, transfers: 0 }), 30);
    const two = await one(r, provider({ minutes: 20 }, { minutes: 30, transfers: 2 }), 30);
    assert.equal(two.terms!.robustness.transferMinutes, 2 * LAYOVER_ROUTED_POLICY.perTransferMinutes);
    assert.equal(two.terms!.confidence, "LOW");
    assert.equal(zero.terms!.confidence, "MEDIUM");
    assert.ok(two.terms!.conservativeReturnMinutes > zero.terms!.conservativeReturnMinutes);
  });
  it("F10. the sweep: over every combination, a worse signal never shortens the conservative return and never raises the band", () => {
    const r = record(true);
    const combos: Array<{ indep: number; leg: "interruptible" | "unknown" | "committed"; transfers: number; conf: TravelConfidence; minutes: number }> = [];
    for (const indep of [1, 2, 3]) for (const leg of ["interruptible", "unknown", "committed"] as const) for (const transfers of [0, 1, 2, 3])
      for (const conf of ["HIGH", "MEDIUM", "LOW"] as TravelConfidence[]) for (const minutes of [15, 30, 60]) combos.push({ indep, leg, transfers, conf, minutes });
    const legOrder = { interruptible: 0, unknown: 1, committed: 1 };
    const confOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    const judged = combos.map((k) => {
      const legs: RoutedLegs = {
        mode: "drive",
        outbound: { departAt: new Date(NOW).toISOString(), minutes: 20, freeFlowMinutes: 18, forecast: true, confidence: "HIGH", offeredRoutes: 3, independentRoutes: 3, transferCount: 0, interruptibility: "interruptible", conveyances: [] },
        returnLeg: { departAt: new Date(NOW + 80 * MIN).toISOString(), minutes: k.minutes, freeFlowMinutes: k.minutes, forecast: true, confidence: k.conf, offeredRoutes: 3, independentRoutes: k.indep, transferCount: k.transfers, interruptibility: k.leg, conveyances: [] },
        expiresAt: new Date(NOW + 5 * MIN).toISOString(), sourceRefs: [],
      };
      return { k, c: judgeRoutedCandidate({ key: "x", record: { ...r, confidence: "HIGH" }, legs, risk: null, minExperienceMin: 60, straightLine: null }) };
    });
    let pairs = 0;
    for (const a of judged) for (const b of judged) {
      const worse = b.k.indep <= a.k.indep && legOrder[b.k.leg] >= legOrder[a.k.leg] && b.k.transfers >= a.k.transfers
        && confOrder[b.k.conf]! >= confOrder[a.k.conf]! && b.k.minutes >= a.k.minutes;
      if (!worse) continue;
      pairs++;
      assert.ok(b.c.terms!.conservativeReturnMinutes >= a.c.terms!.conservativeReturnMinutes, `${JSON.stringify(b.k)} returned faster than ${JSON.stringify(a.k)}`);
      assert.ok(BAND_RANK[b.c.band]! <= BAND_RANK[a.c.band]!, `${JSON.stringify(b.k)} banded ${b.c.band} above ${JSON.stringify(a.k)} ${a.c.band}`);
      assert.ok(b.c.preference <= a.c.preference, "preference never rises as a signal worsens");
    }
    assert.ok(pairs > 2000, `the sweep compared ${pairs} ordered pairs`);
  });
  it("F11. the margins are the policy table's, not hidden constants", () => {
    const legs = { returnLeg: { minutes: 40, independentRoutes: 1, interruptibility: "committed", transferCount: 2, offeredRoutes: 1 } } as unknown as RoutedLegs;
    const rb = robustnessOf(legs);
    assert.equal(rb.totalMarginMinutes, Math.max(10, Math.ceil(40 * 0.25)) + Math.max(5, Math.ceil(40 * 0.15)) + 2 * 5);
    assert.equal(routedPreference(rb), 1 - 1 - 1 - 2);
    assert.equal(conservativeReturnMinutes(40, "INSUFFICIENT", rb), null, "a way back nobody can size is not made 'conservative', it is not certified");
  });
});

describe("L282 — RETURN_ROUTE_UNRELIABLE from the real routed signals", () => {
  it("F12. one way back AND non-interruptible: the assessment fires, the candidate carries the code and cannot be SAFE", async () => {
    const r = record(true);
    const c = await one(r, provider({ minutes: 20 }, { minutes: 30, routes: 1, leg: "committed" }), 30);
    assert.equal(c.risk?.returnRouteUnreliable, true);
    assert.deepEqual(c.reasonCodes, ["RETURN_ROUTE_UNRELIABLE"]);
    assert.notEqual(c.band, "SAFE");
    const ok = await one(r, provider({ minutes: 20 }, { minutes: 30, routes: 3 }), 30);
    assert.equal(ok.risk?.returnRouteUnreliable, false);
    assert.deepEqual(ok.reasonCodes, []);
  });
});

describe("L260 — pre-filter by envelope / time / category BEFORE the expensive evaluation", () => {
  it("F13. airside, no position, proved unreachable, an activity longer than the window, a dropped category and the cap are never routed", async () => {
    const r = record(false);
    const p = provider({ minutes: 20 }, { minutes: 30 });
    const near = Array.from({ length: 8 }, (_, i) => ({ key: `near-${i}`, point: east(3 + i), minExperienceMin: 30 }));
    const ev = await evaluate(r, p, [
      { key: "airside", point: null, minExperienceMin: 30, insideAirport: true },
      { key: "nowhere", point: null, minExperienceMin: 30 },
      { key: "far", point: north(400), minExperienceMin: 30 },
      { key: "long", point: east(2), minExperienceMin: r.envelope.usableMinutes },
      { key: "nightlife-at-noon", point: east(2.5), minExperienceMin: 30, categoryAllowed: false },
      ...near,
    ]);
    const pre = (k: string) => ev.byKey.get(k)!.prefilter;
    assert.equal(pre("airside"), "airside");
    assert.equal(pre("nowhere"), "no_position");
    assert.equal(pre("far"), "outside_envelope");
    assert.equal(ev.byKey.get("far")!.band, "BLOCKED");
    assert.equal(pre("long"), "experience_exceeds_window");
    assert.equal(pre("nightlife-at-noon"), "category");
    assert.deepEqual(near.map((n) => pre(n.key)), [null, null, null, null, null, null, "candidate_cap", "candidate_cap"]);
    const askedAbout = new Set(p.asked.map((q) => { const other = isAirport(q.to) ? q.from! : q.to!; return `${other.lat},${other.lng}`; }));
    assert.equal(askedAbout.size, LAYOVER_ROUTED_POLICY.candidatesPerRead, "the router was asked about exactly the six survivors");
    assert.equal(ev.summary.routed, 6);
    assert.deepEqual(ev.summary.prefiltered, { airside: 1, no_position: 1, outside_envelope: 1, experience_exceeds_window: 1, category: 1, candidate_cap: 2 });
  });
  it("F14. a closed landside gate routes nothing", async () => {
    const r = record(false);
    const p = provider({ minutes: 20 }, { minutes: 30 });
    const ev = await routeLayoverCandidates({ record: r, airport: AIRPORT_POINT, landsideAllowed: false, outerBound: null, corridorProvider: p, candidates: [{ key: "a", point: east(3), minExperienceMin: 30 }] });
    assert.equal(ev.byKey.get("a")!.prefilter, "landside_closed");
    assert.equal(p.asked.length, 0);
  });
});

describe("fail closed — every refusal is a named absence on the candidate it concerns", () => {
  for (const reason of ["CREDENTIAL_ABSENT", "PROVIDER_NOT_ENABLED", "PROVIDER_REJECTED", "PROVIDER_UNAVAILABLE", "PROVIDER_MALFORMED"] as const) {
    it(`F15. ${reason} → UNMEASURED, the reason carried, no term, the pin's straight-line verdict untouched`, async () => {
      const r = record(false);
      const p: RouteCorridorProvider = { id: "refusing", routed: true, async corridor() { return refuse("refusing", reason, `the ${reason} case`); }, async bidirectional() { return refuse("refusing", reason, "x"); } };
      const c = await one(r, p, 30);
      assert.equal(c.state, "UNMEASURED");
      assert.equal(c.absence?.reason, reason);
      assert.equal(c.terms, null);
      assert.deepEqual(routedEnvelopeVerdict(c), c.straightLine, "nothing measured → the pin keeps the bound it had");
    });
  }
});

describe("L66 / L61 / L63 — the routed union, its isochrone, and its contraction", () => {
  const ring = (km: number) => [east(km), north(km), east(-km), north(-km), { lat: AIRPORT_POINT.lat + km / 157, lng: AIRPORT_POINT.lng + km / 157 }];
  const candidates = [4, 9, 16, 30].flatMap((km, i) => ring(km).map((pt, j) => ({ key: `k${i}-${j}`, point: pt, minExperienceMin: 45 })));
  // Minutes grow with distance, so the union is a real time-based edge, different by direction.
  const byDistance = (q: CorridorQuery): Spec => {
    const other = q.from!.lat === AIRPORT_POINT.lat && q.from!.lng === AIRPORT_POINT.lng ? q.to! : q.from!;
    const km = Math.hypot((other.lat - AIRPORT_POINT.lat) * 111.32, (other.lng - AIRPORT_POINT.lng) * 101);
    return { minutes: Math.round(6 + km * (other.lng > AIRPORT_POINT.lng ? 2.2 : 3.6)) };
  };
  const run = async (verified: boolean, back: (q: CorridorQuery) => Spec) => {
    const r = record(verified);
    const ev = await routeLayoverCandidates({ record: r, airport: AIRPORT_POINT, landsideAllowed: true, outerBound: safeEnvelope(r.envelope.usableMinutes, AIRPORT_POINT, r.confidence), corridorProvider: provider(byDistance, back), candidates: candidates.slice(0, 6) });
    return { r, ev };
  };
  it("F16. SafeEnvelope = union(points satisfying the constraint): every member is FEASIBLE at its dwell, every routed non-member is not", async () => {
    const { r, ev } = await run(true, byDistance);
    const env = ev.envelope!;
    assert.equal(env.basis, "routed_union");
    assert.equal(env.certifiedInward, true);
    assert.equal(env.certifiedOutward, false);
    assert.equal(env.polygonInteriorCertified, false);
    for (const m of env.members) {
      const c = ev.byKey.get(m.key)!;
      assert.equal(c.state, "FEASIBLE", m.key);
      const t = c.terms!;
      assert.ok(Date.parse(t.outboundArrivalAt) + (t.minExperienceMin! + t.conservativeReturnMinutes) * MIN <= r.deadline.hardReturnTime.getTime(), `${m.key} is in the union`);
    }
    for (const c of ev.candidates.filter((c) => c.legs && !env.members.some((m) => m.key === c.key))) assert.notEqual(c.state, "FEASIBLE", c.key);
    assert.ok(env.members.length > 0, "positive control: something is reachable");
  });
  it("F17. the isochrone is per direction (a sector reach differs east vs west at the same distance), with unmeasured sectors null, never zero", async () => {
    const r = record(true);
    const pts = [{ key: "e", point: east(20), minExperienceMin: 45 }, { key: "w", point: east(-20), minExperienceMin: 45 }];
    const ev = await routeLayoverCandidates({ record: r, airport: AIRPORT_POINT, landsideAllowed: true, outerBound: safeEnvelope(r.envelope.usableMinutes, AIRPORT_POINT, r.confidence), corridorProvider: provider(byDistance, byDistance), candidates: pts });
    const e = ev.byKey.get("e")!, w = ev.byKey.get("w")!;
    assert.ok(e.terms!.outboundMinutes < w.terms!.outboundMinutes, "east is faster than west at the same distance — no radius can say that");
    const env = ev.envelope!;
    assert.equal(env.sectors.length, 8);
    for (const s of env.sectors) if (!s.measured) assert.equal(s.reachMetres, null);
    assert.equal(env.polygon.length, env.sectors.filter((s) => s.measured).length);
  });
  it("F18. L63: as confidence drops (HIGH → MEDIUM → LOW) the union shrinks or holds and every sector's reach with it; as return risk rises (a slower way back) likewise", async () => {
    const W = windowMinutes(record(true));
    // Google's corridors are MEDIUM, so the return is held back at least 10% (the candidate's confidence is the weakest of the record's
    // and the legs'). `edge` fits under that 10% and not under LOW's 25%.
    const edge = Math.floor((W - 46) / 2.1);
    const minutes = [20, 60, Math.floor(edge * 0.8), edge - 4, edge, edge + 30];
    const line = minutes.map((m, i) => ({ key: `e${i}`, point: east(5 + i * 8), minExperienceMin: 45, m }));
    const minutesAt = (q: CorridorQuery) => { const o = isAirport(q.from) ? q.to! : q.from!; return line.find((c) => c.point.lng === o.lng)!.m; };
    const at = async (conf: LayoverFeasibilityRecord["confidence"], scale = 1) => {
      const r = withConfidence(record(true), conf);
      return (await routeLayoverCandidates({ record: r, airport: AIRPORT_POINT, landsideAllowed: true, outerBound: safeEnvelope(r.envelope.usableMinutes, AIRPORT_POINT, r.confidence),
        corridorProvider: provider((q) => ({ minutes: minutesAt(q) }), (q) => ({ minutes: Math.round(minutesAt(q) * scale) })), candidates: line })).envelope!;
    };
    const high = await at("HIGH"), med = await at("MEDIUM"), low = await at("LOW"), slow = await at("HIGH", 1.3);
    const keys = (e: typeof high) => new Set(e.members.map((m) => m.key));
    const subset = (a: Set<string>, b: Set<string>) => [...a].every((k) => b.has(k));
    assert.ok(subset(keys(med), keys(high)) && subset(keys(low), keys(med)), "a member appeared as confidence dropped");
    assert.ok(subset(keys(slow), keys(high)), "a member appeared as the way back slowed");
    assert.ok(keys(med).has("e4") && !keys(low).has("e4"), `confidence contracts the edge: ${[...keys(med)]} → ${[...keys(low)]}`);
    assert.ok(!keys(slow).has("e4"), "a slower way back contracts it too");
    assert.ok(!keys(high).has("e5"), "positive control: something lies outside even at HIGH");
    for (let i = 0; i < 8; i++) {
      const h = high.sectors[i]!.reachMetres ?? 0;
      assert.ok((med.sectors[i]!.reachMetres ?? 0) <= h && (low.sectors[i]!.reachMetres ?? 0) <= (med.sectors[i]!.reachMetres ?? 0), `sector ${i} grew as confidence dropped`);
      assert.ok((slow.sectors[i]!.reachMetres ?? 0) <= h, `sector ${i} grew as the way back slowed`);
    }
    const reachEast = (e: typeof high) => Math.max(0, ...e.sectors.map((x) => x.reachMetres ?? 0)); // every point lies due east, so one sector holds them
    assert.ok((reachEast(low) ?? 0) < (reachEast(med) ?? 0), "the drawn edge itself moves in, not only the member list");
  });
});

describe("L66 — membership uses the CONSERVATIVE return; the isochrone vertex is the farthest member", () => {
  it("F19. a point with no stated dwell is in the union only if out + the floor dwell + the conservative return fits — not on the raw return", async () => {
    const r = withConfidence(record(true), "LOW");
    const W = windowMinutes(r);
    const floor = LAYOVER_ROUTED_POLICY.envelopeDwellFloorMinutes;
    // The journey alone fits even held back (so it is not refused), the floor dwell + the RAW return fits, and the floor dwell +
    // the return held back 25% (LOW) does not: only the conservative reading keeps it out of the union.
    const raw = Math.floor((W - floor) / 2.25) + 1;
    assert.ok(raw + Math.ceil(raw * 1.25) <= W && 2 * raw + floor <= W && raw + floor + Math.ceil(raw * 1.25) > W, `positive control on the window (${W}, ${raw})`);
    const c = await one(r, provider({ minutes: raw }, { minutes: raw }), null);
    assert.equal(c.state, "UNMEASURED", "no stated dwell: never certified");
    assert.equal(c.inEnvelope, false, "the raw return would have put it in the union");
    const near = await one(r, provider({ minutes: 20 }, { minutes: 20 }), null);
    assert.equal(near.inEnvelope, true, "positive control: a near point with no stated dwell IS a point of the union");
  });
  it("F20. two members in one sector: the sector's reach and its vertex are the FARTHER one", async () => {
    const r = withConfidence(record(true), "MEDIUM");
    const pts = [{ key: "near", point: east(4), minExperienceMin: 30 }, { key: "far", point: east(9), minExperienceMin: 30 }];
    const ev = await routeLayoverCandidates({ record: r, airport: AIRPORT_POINT, landsideAllowed: true, outerBound: safeEnvelope(r.envelope.usableMinutes, AIRPORT_POINT, r.confidence), corridorProvider: provider({ minutes: 20 }, { minutes: 25 }), candidates: pts });
    const env = ev.envelope!;
    assert.deepEqual(env.members.map((m) => m.key).sort(), ["far", "near"]);
    const sector = env.sectors.find((s) => s.measured)!;
    assert.equal(sector.vertexKey, "far");
    assert.ok(sector.reachMetres! > 8_000);
  });
});

describe("P. through the REAL Google adapter: two billed requests per routed candidate, identical legs once", () => {
  it("P1. six candidates → twelve requests to Google (the outbound asked first is not billed twice)", async () => {
    const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/googleRoutes/${n}`, import.meta.url), "utf8"));
    let fetches = 0;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      fetches++;
      const body = JSON.parse(String(init.body));
      const toAirport = body.destination.location.latLng.latitude === AIRPORT_POINT.lat;
      return { ok: true, status: 200, json: async () => fixture(toAirport ? "drive-alternatives-return.json" : "drive-alternatives-outbound.json") } as unknown as Response;
    }) as unknown as typeof fetch;
    const spent: unknown[] = [];
    const google = createGoogleRoutesCorridorProvider({
      fetchImpl, now: () => new Date(), memo: true,
      readEnv: (n) => (n === CREDENTIAL_ENV ? "k" : n === ENABLEMENT_ENV ? "true" : undefined),
      layoverSpendGate: { async decide(s) { spent.push(s); return "granted"; } },
    });
    const r = record(false);
    const cands = Array.from({ length: 6 }, (_, i) => ({ key: `c${i}`, point: east(4 + i * 2), minExperienceMin: 45 }));
    const ev = await withRoutesRequestBudget({ userId: "u", layoverSessionId: "s" }, () => evaluate(r, google, cands));
    assert.equal(fetches, 12);
    assert.equal(spent.length, 12);
    assert.ok(ev.candidates.every((c) => c.legs !== null), "every candidate answered");
    assert.ok(ev.candidates.every((c) => c.terms!.mode === "drive"));
  });
});
