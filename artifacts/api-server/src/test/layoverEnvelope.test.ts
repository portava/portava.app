/**
 * §8 — the safe envelope's OUTER edge, and the block it makes possible.
 *
 * node:test + node:assert. Fake table-backed DB, no network, no clock.
 *
 * ── THE TWO ROWS THIS FILE IS ABOUT ──────────────────────────────────────────
 * L50 ("block unsafe recommendations") read NOT-BUILT with the right
 * observation: *"Every landside card is now `not_recommended`, which is a
 * RATING and not a block: the cards are still generated, still persisted and
 * still served."* L61 ("time-based isochrone/envelope geometry, not a fixed
 * radius") read NOT-BUILT with a second one that has aged: *"`fetchDiscoveryPlaces`
 * matches with `ilike("city", "%" + city + "%")` … so a place in another city
 * whose name contains the string is a candidate."* The `ilike` is still there —
 * this does not change the query — and the candidate it admits is now measured
 * and, when it cannot possibly fit, removed.
 *
 * ── WHY A LOWER BOUND IS ENOUGH FOR A BLOCK AND NEVER ENOUGH FOR A PASS ─────
 * A great-circle distance is the shortest any route can be, so if the round
 * trip exceeds the certified window AT THAT BOUND it exceeds it at every real
 * speed. That asymmetry is `TravelTimeProvider`'s own and `TripFeasibilityEngine`
 * is built on it. Every case below that asserts a block asserts it against a
 * distance no vehicle could beat; no case asserts that anything is SAFE,
 * because nothing here can certify that and the band vocabulary refuses to.
 *
 * ── MUTATIONS RUN, each against PRODUCTION code, reverted and `cmp`-verified —
 * recorded in §18.4 of docs/architecture/census-layover.md.
 *
 * Run: node --import tsx/esm --test src/test/layoverEnvelope.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import {
  ENVELOPE_BANDS,
  ENVELOPE_BAND_CERTIFIES_FIT,
  bandCandidate,
  bandCandidates,
  safeEnvelope,
} from "../services/airport/LayoverEnvelope.js";
import {
  estimateTravel,
  haversineMeters,
  straightLineTravelTimeProvider,
  type GeoPoint,
} from "../domain/trips/contracts/TravelTimeProvider.js";
import { generateRecommendations } from "../services/airport/LayoverRecommendationService.js";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const TPE: GeoPoint = { lat: 25.0777, lng: 121.2328 };
const AT = new Date("2026-09-13T02:00:00.000Z");

/** Move `metres` due north of `from`. Latitude degrees are ~111.32 km. */
function north(from: GeoPoint, metres: number): GeoPoint {
  return { lat: from.lat + metres / 111_320, lng: from.lng };
}

// ── The disc is the inverse of the provider's own bound ──────────────────────

describe("§8 safe envelope — the radius IS the provider's bound, inverted", () => {
  it("a point just inside the radius is admitted and a point just outside is blocked, across a range of windows", async () => {
    let checkedBlocks = 0;
    let checkedAdmits = 0;
    for (const usableMinutes of [10, 20, 45, 90, 120, 240, 480]) {
      const env = safeEnvelope(usableMinutes, TPE)!;
      assert.ok(env, "a coordinate and a positive window must produce an envelope");

      // Just inside: the provider's own round-trip bound must fit the window.
      const inside = north(TPE, Math.max(0, env.radiusMetres - 200));
      const vIn = await bandCandidate(env, inside, AT);
      const rIn = await estimateTravel(
        straightLineTravelTimeProvider, { from: TPE, to: inside, departAt: AT }, AT,
      );
      assert.equal(rIn.kind, "estimate");
      assert.ok(
        rIn.kind === "estimate" && rIn.estimate.minutes * 2 <= usableMinutes,
        `radius admits a point the provider says needs ${rIn.kind === "estimate" ? rIn.estimate.minutes * 2 : "?"} min ` +
          `against a ${usableMinutes} min window`,
      );
      assert.equal(vIn.band, "UNCERTIFIED", "inside the disc is NOT a certification of fit");
      checkedAdmits += 1;

      // Just outside: blocked, and the provider agrees it cannot fit.
      const outside = north(TPE, env.radiusMetres + 2_000);
      const vOut = await bandCandidate(env, outside, AT);
      assert.equal(vOut.band, "BLOCKED", `a point beyond the radius must be blocked (${usableMinutes} min)`);
      assert.ok(vOut.lowerBoundOneWayMin! * 2 > usableMinutes);
      assert.ok(vOut.reason && vOut.reason.includes("km from the airport"));
      assert.equal(vOut.distanceMetres, Math.round(haversineMeters(TPE, outside)));
      checkedBlocks += 1;
    }
    assert.equal(checkedAdmits, 7);
    assert.equal(checkedBlocks, 7);
  });

  it("the radius CONTRACTS as the window shrinks — it is time-based, not a fixed distance", () => {
    const radii = [480, 240, 120, 90, 45, 20, 10, 0].map(
      (m) => safeEnvelope(m, TPE)!.radiusMetres,
    );
    for (let i = 1; i < radii.length; i += 1) {
      assert.ok(
        radii[i]! < radii[i - 1]!,
        `radius did not contract: ${radii[i - 1]} → ${radii[i]}`,
      );
    }
    assert.equal(radii[radii.length - 1], 0, "a window with no usable time reaches nowhere");
  });

  it("no coordinate means NO envelope — never a default one centred on the ocean", () => {
    assert.equal(safeEnvelope(240, null), null);
  });

  it("nothing is blocked without an envelope, a point, or a bound", async () => {
    const env = safeEnvelope(240, TPE)!;
    assert.equal((await bandCandidate(null, north(TPE, 500_000), AT)).band, "UNCERTIFIED");
    assert.equal((await bandCandidate(env, null, AT)).band, "UNCERTIFIED");
    // A provider that refuses, and one that throws: both fail OPEN.
    const refuses = { id: "refuses", routed: false, async estimate() { return { kind: "unknown" as const, reason: "NO_COORDINATES" as const }; } };
    const throws = { id: "throws", routed: false, async estimate(): Promise<never> { throw new Error("boom"); } };
    const far = north(TPE, 500_000);
    assert.equal((await bandCandidate(env, far, AT, refuses)).band, "UNCERTIFIED");
    assert.equal((await bandCandidate(env, far, AT, throws)).band, "UNCERTIFIED");
  });

  it("declares the spec's three bands and produces neither certification", async () => {
    assert.deepEqual([...ENVELOPE_BANDS], ["SAFE", "TIGHT", "BLOCKED", "UNCERTIFIED"]);
    assert.equal(ENVELOPE_BAND_CERTIFIES_FIT.SAFE, true);
    assert.equal(ENVELOPE_BAND_CERTIFIES_FIT.TIGHT, true);
    assert.equal(ENVELOPE_BAND_CERTIFIES_FIT.BLOCKED, false);
    assert.equal(ENVELOPE_BAND_CERTIFIES_FIT.UNCERTIFIED, false);

    // Sweep a wide range of distances and windows: no input this tree can
    // supply may ever produce a band that certifies a fit.
    const env = safeEnvelope(600, TPE)!;
    for (let km = 0; km <= 400; km += 7) {
      const v = await bandCandidate(env, north(TPE, km * 1000), AT);
      assert.equal(
        ENVELOPE_BAND_CERTIFIES_FIT[v.band], false,
        `a straight-line bound certified a fit at ${km} km — it cannot`,
      );
    }
  });

  it("bandCandidates keys by the caller's own identity and returns nothing without an envelope", async () => {
    const env = safeEnvelope(120, TPE)!;
    const got = await bandCandidates(env, [
      { key: "near", point: north(TPE, 1_000) },
      { key: "far", point: north(TPE, 400_000) },
      { key: "nowhere", point: null },
    ], AT);
    assert.equal(got.get("near")!.band, "UNCERTIFIED");
    assert.equal(got.get("far")!.band, "BLOCKED");
    assert.equal(got.get("nowhere")!.band, "UNCERTIFIED");
    assert.equal((await bandCandidates(null, [{ key: "far", point: north(TPE, 400_000) }], AT)).size, 0);
  });
});

// ── L50: the block reaches the cards a traveller is served ───────────────────

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: TPE.lat, lng: TPE.lng,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

const NOW = Date.parse("2026-09-13T02:00:00.000Z"); // 10:00 Asia/Taipei

function session(over: Partial<LayoverSession> = {}): LayoverSession {
  return {
    id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + 9 * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: 540,
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

/**
 * Two places the `ilike("city", "%Taoyuan%")` query returns together: one in
 * the airport's own city, and one 220 km away whose row says "Taoyuan" too.
 * That second row is L61's complaint made concrete.
 */
function tables() {
  const far = north(TPE, 220_000);
  return {
    discovery_places: [
      { id: "place-near", name: "Riverside Cafe", place_type: "cafe", category: "food", neighborhood: null, blurb: "Coffee", verified: true, city: "Taoyuan", status: "active", lat: TPE.lat + 0.02, lng: TPE.lng + 0.02, canonical_location_id: null },
      { id: "place-far", name: "Far Night Market", place_type: "attraction", category: "food", neighborhood: null, blurb: "Snacks", verified: true, city: "Taoyuan", status: "active", lat: far.lat, lng: far.lng, canonical_location_id: null },
      { id: "place-nocoords", name: "Unlocated Diner", place_type: "restaurant", category: "food", neighborhood: null, blurb: "Food", verified: false, city: "Taoyuan", status: "active", lat: null, lng: null, canonical_location_id: null },
    ],
    layover_recommendations: [] as any[],
    layover_plan_stops: [] as any[],
    layover_events: [] as any[],
  };
}

function cards(r: { ok: true; recommendations: any[] } | { ok: false; message: string }) {
  if (!r.ok) assert.fail(`expected recommendations, got a refusal: ${r.message}`);
  return r.recommendations;
}

describe("L50 — a certainly-unreachable place is BLOCKED, not rated and served", () => {
  it("is not in the cards, is not in the database, and the reachable ones still are", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    const s = session();
    const usable = certifySessionFeasibility(AIRPORT, s, { nowMs: NOW }).envelope.usableMinutes;
    const radius = safeEnvelope(usable, TPE)!.radiusMetres;
    assert.ok(radius < 220_000, `the fixture must sit outside the envelope (radius ${radius} m)`);

    const got = cards(await generateRecommendations(db as any, AIRPORT, s, NOW));
    const titles = got.map((r: any) => r.title);
    assert.ok(!titles.includes("Far Night Market"), "a place that cannot fit at any speed was served");
    assert.ok(titles.includes("Riverside Cafe"), "a reachable place must survive the envelope");
    // The absence is a BLOCK, not a hidden card: nothing was written for it.
    assert.equal(
      t.layover_recommendations.filter((r: any) => r.title === "Far Night Market").length, 0,
      "a blocked candidate must not be persisted either — census L50's whole point",
    );
    assert.ok(t.layover_recommendations.some((r: any) => r.title === "Riverside Cafe"));
  });

  it("a place with no coordinate is NOT blocked — no proof, no refusal", async () => {
    const got = cards(await generateRecommendations(makeLayoverDb(tables()) as any, AIRPORT, session(), NOW));
    assert.ok(
      got.map((r: any) => r.title).includes("Unlocated Diner"),
      "an unlocated place must survive: the envelope proves nothing about it",
    );
  });

  it("an airport with no coordinate blocks NOTHING — the fallback (0,0) must not empty the list", async () => {
    const nowhere: AirportProfile = { ...AIRPORT, id: null, lat: 0, lng: 0 };
    const got = cards(await generateRecommendations(makeLayoverDb(tables()) as any, nowhere, session(), NOW));
    const titles = got.map((r: any) => r.title);
    assert.ok(titles.includes("Far Night Market"), "no airport coordinate means no envelope and no block");
    assert.ok(titles.includes("Riverside Cafe"));
  });

  it("the same place survives when the window is long enough to reach it", async () => {
    // 30 hours: the envelope's radius passes 220 km well before that.
    const s = session({ departureTime: new Date(NOW + 30 * 3_600_000).toISOString() });
    const usable = certifySessionFeasibility(AIRPORT, s, { nowMs: NOW }).envelope.usableMinutes;
    assert.ok(safeEnvelope(usable, TPE)!.radiusMetres > 220_000, "fixture assumption");
    const got = cards(await generateRecommendations(makeLayoverDb(tables()) as any, AIRPORT, s, NOW));
    assert.ok(
      got.map((r: any) => r.title).includes("Far Night Market"),
      "the block is the WINDOW's, not the place's — a longer layover must reach it",
    );
  });
});
