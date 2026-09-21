/**
 * §8 L60 — bidirectional reachability: airport→candidate AND candidate→airport,
 * the second under the conditions of the hour the traveller actually comes back.
 *
 * census-layover L60 reads NOT-BUILT. Its evidence has been rewritten once
 * already: the original *"return is modelled as outbound × 2, explicitly
 * symmetric and time-independent"* became §18.7's *"the round trip is
 * `(statedTravel ?? 0) * 2` over a leg that is `null` for every landside
 * candidate — the return is not modelled at all"*. The envelope's own header
 * says the same thing about ITSELF: *"The bound is symmetric (`back >= out`),
 * so §8.1's 'use a future-time estimate, not outbound time' is NOT satisfied by
 * it."*
 *
 * There is exactly one place on this tree where a return journey is measured at
 * all, and it is the envelope: `bandCandidate` asks the travel-time port for a
 * bound, and it asked ONCE — from the airport to the place, at the moment the
 * traveller leaves — and doubled the answer.
 *
 * ── WHAT THIS FILE PINS ─────────────────────────────────────────────────────
 *  1. THE PORT IS ASKED TWICE, IN OPPOSITE DIRECTIONS. A spy provider records
 *     every query; the case fails if the return leg is the outbound leg's
 *     answer reused, which is what `× 2` was.
 *  2. THE RETURN LEG IS ASKED AT A LATER INSTANT, and that instant is the
 *     latest departure the window allows, not the moment the traveller left.
 *  3. THE BLOCK IS THE SUM, NOT TWICE THE OUTBOUND. Against an ASYMMETRIC
 *     provider — one that answers differently by direction, which is what a
 *     real road network does — a candidate that `2 × outbound` admits is
 *     refused when the way back is longer. Under `× 2` this case cannot fail.
 *  4. IT STAYS A PROOF. The block uses the SMALLER of the two return answers,
 *     so a provider whose forecast is worse at the later hour may FLAG a
 *     candidate and may never BLOCK one on that forecast alone. "No proof, no
 *     block" is this module's whole discipline and a time-varying forecast is
 *     not a proof about every instant in the window.
 *  5. IT FAILS OPEN. A return leg the port cannot answer leaves the card
 *     standing, exactly as an unanswerable outbound leg already does.
 *  6. IT REACHES A TRAVELLER. `generateRecommendations` — the live producer of
 *     every landside card — goes through the same two-leg rule, and the
 *     existing block survives it.
 *
 * Run: node --import tsx --test src/test/layoverEnvelopeBidirectional.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeEnvelope, bandCandidate, bandCandidates } from "../services/airport/LayoverEnvelope.js";
import {
  haversineMeters,
  straightLineTravelTimeProvider,
  type GeoPoint,
  type TravelTimeProvider,
  type TravelTimeQuery,
  type TravelTimeResult,
} from "../domain/trips/contracts/TravelTimeProvider.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { generateRecommendations } from "../services/airport/LayoverRecommendationService.js";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const TPE: GeoPoint = { lat: 25.0777, lng: 121.2328 };
const AT = new Date("2026-09-13T02:00:00.000Z");

function north(from: GeoPoint, metres: number): GeoPoint {
  return { lat: from.lat + metres / 111_320, lng: from.lng };
}

const same = (a: GeoPoint | null, b: GeoPoint) =>
  !!a && Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;

interface Asked { fromAirport: boolean; departAtMs: number }

/**
 * A provider that answers a fixed number of minutes per DIRECTION and records
 * every query. Nothing about it is a road network — it exists so that "the two
 * legs are the same number" stops being indistinguishable from "the second leg
 * was never asked for".
 */
function spy(outMin: number, backMin: number, backLaterMin = backMin) {
  const asked: Asked[] = [];
  const provider: TravelTimeProvider = {
    id: "spy",
    routed: false,
    async estimate(q: TravelTimeQuery): Promise<TravelTimeResult> {
      const fromAirport = same(q.from, TPE);
      asked.push({ fromAirport, departAtMs: q.departAt.getTime() });
      const minutes = fromAirport
        ? outMin
        : q.departAt.getTime() > AT.getTime() ? backLaterMin : backMin;
      return {
        kind: "estimate",
        estimate: {
          minutes,
          p50: minutes, p75: minutes, p90: minutes,
          sourceClass: "STATIC_DEFAULT",
          confidence: "LOW",
          observedAt: null,
          expiresAt: null,
          fallbackLevel: 3,
          sourceRefs: ["spy"],
        } as any,
      };
    },
  };
  return { provider, asked };
}

// ── 1 & 2. Both directions, two instants ────────────────────────────────────

describe("L60 — the port is asked for BOTH legs, and the return one is asked later", () => {
  it("one query leaves the airport and at least one arrives at it", async () => {
    const env = safeEnvelope(120, TPE)!;
    const { provider, asked } = spy(20, 20);
    await bandCandidate(env, north(TPE, 10_000), AT, provider);

    const out = asked.filter((a) => a.fromAirport);
    const back = asked.filter((a) => !a.fromAirport);
    assert.ok(out.length >= 1, "the outbound leg was never asked for");
    assert.ok(
      back.length >= 1,
      "the return leg was never asked for — it is still the outbound answer doubled",
    );
  });

  it("the return leg is asked at the LATEST departure the window allows", async () => {
    const env = safeEnvelope(120, TPE)!;
    const { provider, asked } = spy(20, 20);
    const v = await bandCandidate(env, north(TPE, 10_000), AT, provider);

    assert.equal(v.outboundLowerBoundMin, 20);
    assert.equal(v.returnLowerBoundMin, 20);
    // 120 usable, 20 out → the traveller may stay until minute 100 and still be
    // asked about the ride home from there.
    const expected = AT.getTime() + 100 * 60_000;
    assert.equal(
      v.returnDepartsAt, new Date(expected).toISOString(),
      "the published return instant is not the latest the window allows",
    );
    assert.ok(
      asked.some((a) => !a.fromAirport && a.departAtMs === expected),
      `no return query at ${new Date(expected).toISOString()}; asked: ` +
        JSON.stringify(asked.map((a) => ({ ...a, at: new Date(a.departAtMs).toISOString() }))),
    );
  });

  it("a shorter window moves the return instant earlier — it is derived, not a constant", async () => {
    const a = await bandCandidate(safeEnvelope(120, TPE)!, north(TPE, 10_000), AT, spy(20, 20).provider);
    const b = await bandCandidate(safeEnvelope(60, TPE)!, north(TPE, 10_000), AT, spy(20, 20).provider);
    assert.ok(
      Date.parse(String(b.returnDepartsAt)) < Date.parse(String(a.returnDepartsAt)),
      "the return instant did not move with the window",
    );
  });
});

// ── 3 & 4. The block is the sum, and it is still a proof ────────────────────

describe("L60 — the refusal is out + back, not 2 × out", () => {
  it("an asymmetric return blocks a candidate that twice-the-outbound admits", async () => {
    const env = safeEnvelope(100, TPE)!;
    // 2 × 40 = 80 ≤ 100 — admitted under the old rule. 40 + 70 = 110 > 100.
    const { provider } = spy(40, 70);
    const v = await bandCandidate(env, north(TPE, 10_000), AT, provider);
    assert.equal(v.band, "BLOCKED", "the round trip was still charged as twice the outbound");
    assert.equal(v.roundTripLowerBoundMin, 110);
    assert.match(String(v.reason), /110 min/);
  });

  it("a FASTER way back rescues a candidate that twice-the-outbound refuses", async () => {
    const env = safeEnvelope(100, TPE)!;
    // 2 × 60 = 120 > 100 — blocked under the old rule. 60 + 30 = 90 ≤ 100.
    const { provider } = spy(60, 30);
    const v = await bandCandidate(env, north(TPE, 10_000), AT, provider);
    assert.equal(v.band, "UNCERTIFIED", "the asymmetry was ignored in the traveller's favour only");
    assert.equal(v.roundTripLowerBoundMin, 90);
  });

  it("a WORSE forecast at the later hour flags the candidate and never blocks it", async () => {
    const env = safeEnvelope(100, TPE, "HIGH")!;
    // Same instant: 40 + 40 = 80, inside the window. At the return hour the
    // forecast is 70, which would push the round trip to 110.
    const { provider } = spy(40, 40, 70);
    const v = await bandCandidate(env, north(TPE, 10_000), AT, provider);
    assert.equal(
      v.band, "UNCERTIFIED",
      "a forecast about ONE later instant is not a proof about the window, and must not block",
    );
    assert.equal(v.returnLowerBoundMin, 40, "the proof must use the smaller return answer");
    assert.equal(v.returnForecastLowerBoundMin, 70);
    assert.equal(v.withinPlannedEdge, false, "the planning edge must use the worse answer");
    assert.match(String(v.plannedEdgeReason), /return/i);
  });
});

// ── 5. Fail open ────────────────────────────────────────────────────────────

describe("L60 — an unanswerable leg leaves the card standing", () => {
  const unknownBack: TravelTimeProvider = {
    id: "out-only",
    routed: false,
    async estimate(q: TravelTimeQuery): Promise<TravelTimeResult> {
      if (!same(q.from, TPE)) return { kind: "unknown", reason: "NO_ROUTED_PROVIDER" };
      return {
        kind: "estimate",
        estimate: {
          minutes: 500, p50: 500, p75: 500, p90: 500,
          sourceClass: "STATIC_DEFAULT", confidence: "LOW",
          observedAt: null, expiresAt: null, fallbackLevel: 3, sourceRefs: ["x"],
        } as any,
      };
    },
  };

  it("a return leg the port cannot answer is UNCERTIFIED, never BLOCKED", async () => {
    const v = await bandCandidate(safeEnvelope(60, TPE)!, north(TPE, 10_000), AT, unknownBack);
    assert.equal(v.band, "UNCERTIFIED");
    assert.equal(v.returnLowerBoundMin, null);
    assert.equal(v.roundTripLowerBoundMin, null);
  });

  it("a provider that throws on the way back is UNCERTIFIED too", async () => {
    const thrower: TravelTimeProvider = {
      id: "throws-back",
      routed: false,
      async estimate(q: TravelTimeQuery): Promise<TravelTimeResult> {
        if (!same(q.from, TPE)) throw new Error("boom");
        return straightLineTravelTimeProvider.estimate(q);
      },
    };
    const v = await bandCandidate(safeEnvelope(60, TPE)!, north(TPE, 400_000), AT, thrower);
    assert.equal(v.band, "UNCERTIFIED", "a refusal needs a proof, and a throw is not one");
  });
});

// ── 6. The straight line is symmetric, so nothing a traveller sees moves ────

describe("the configured provider is symmetric — the existing block is unchanged", () => {
  it("both legs agree at every distance, so the disc and the rule still coincide", async () => {
    for (const usable of [20, 45, 90, 240]) {
      const env = safeEnvelope(usable, TPE)!;
      for (const m of [1_000, 20_000, 120_000, 400_000]) {
        const p = north(TPE, m);
        const v = await bandCandidate(env, p, AT);
        if (v.outboundLowerBoundMin === null) continue;
        assert.equal(
          v.returnLowerBoundMin, v.outboundLowerBoundMin,
          "the straight-line bound must be direction-independent",
        );
        assert.equal(v.roundTripLowerBoundMin, v.outboundLowerBoundMin * 2);
        assert.equal(v.distanceMetres, Math.round(haversineMeters(TPE, p)));
        assert.equal(v.band, v.outboundLowerBoundMin * 2 > usable ? "BLOCKED" : "UNCERTIFIED");
      }
    }
  });

  it("bandCandidates carries the two legs through to every key", async () => {
    const env = safeEnvelope(120, TPE)!;
    const got = await bandCandidates(env, [
      { key: "near", point: north(TPE, 5_000) },
      { key: "far", point: north(TPE, 400_000) },
      { key: "nowhere", point: null },
    ], AT);
    assert.equal(got.get("far")!.band, "BLOCKED");
    assert.ok(got.get("far")!.returnLowerBoundMin! > 0);
    assert.equal(got.get("near")!.band, "UNCERTIFIED");
    assert.equal(got.get("nowhere")!.returnLowerBoundMin, null);
  });
});

// ── 7. The live producer goes through the same rule ─────────────────────────

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei",
  lat: TPE.lat, lng: TPE.lng,
  domesticBufferMin: 60, domesticBufferMax: 90,
  internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
  verified: false,
} as AirportProfile;

const NOW = Date.parse("2026-09-13T02:00:00.000Z");

function session(over: Partial<LayoverSession> = {}): LayoverSession {
  return {
    id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(NOW - 20 * 60_000).toISOString(),
    departureTime: new Date(NOW + 9 * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: 560,
    flightType: "international", immigrationRequired: true, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate",
    vibeChips: ["food"], status: "active",
    ...over,
  } as unknown as LayoverSession;
}

function tables() {
  return {
    feature_flags: [{ flag: "layover_safety_engine_enabled", enabled: true }],
    discovery_places: [
      { id: "p-near", name: "Riverside Cafe", place_type: "cafe", category: "food",
        neighborhood: "Dayuan", blurb: null, verified: true, canonical_location_id: null,
        city: "Taoyuan", status: "active", lat: north(TPE, 6_000).lat, lng: TPE.lng },
      { id: "p-far", name: "Far Night Market", place_type: "market", category: "food",
        neighborhood: null, blurb: null, verified: true, canonical_location_id: null,
        city: "Taoyuan", status: "active", lat: north(TPE, 400_000).lat, lng: TPE.lng },
    ],
    layover_recommendations: [] as any[],
    layover_sessions: [] as any[],
    layover_events: [] as any[],
  };
}

describe("the live producer of landside cards uses the two-leg rule", () => {
  it("a place no round trip can reach is still blocked through generateRecommendations", async () => {
    const s = session();
    const usable = certifySessionFeasibility(AIRPORT, s, { nowMs: NOW }).envelope.usableMinutes;
    const env = safeEnvelope(usable, TPE)!;
    assert.ok(env.radiusMetres < 400_000, `the fixture must sit outside the envelope (${env.radiusMetres} m)`);

    const out: any = await generateRecommendations(
      makeLayoverDb(tables()) as any, AIRPORT, s, NOW,
    );
    const titles = (out?.recommendations ?? out ?? []).map((r: any) => r.title);
    assert.ok(!titles.includes("Far Night Market"), "a place no round trip can reach was served");
    assert.ok(titles.includes("Riverside Cafe"), "a reachable place must survive the two-leg rule");
  });
});
