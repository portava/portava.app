/**
 * Layover §15 return-state ladder and Appendix A reason codes — properties.
 *
 * node:test + node:assert (NOT vitest). No DB, no network.
 *
 * What is pinned here:
 *   1. `computeReturnState` is monotone in time: as the clock advances the state
 *      never steps back (NORMAL → RETURN_SOON → RETURN_NOW → CONNECTION_AT_RISK).
 *   2. It is monotone in the flight cutoff: at the same instant, a flight that
 *      stops waiting EARLIER never yields a calmer state. This rides on the
 *      deadline monotonicity proved in layoverDeadlineMonotonicity.test.ts.
 *   3. `computeWindow` wires the state consistently with its own numbers:
 *      RETURN_NOW or worse ⇒ usableMinutes is 0; NORMAL ⇒ more than
 *      RETURN_SOON_LEAD_MIN minutes remain before the hard deadline.
 *   4. `adviseLeaving` emits only codes from the declared Appendix A
 *      vocabulary, and each emitted code corresponds to a fact the engine holds.
 *   5. Every certified output carries the engine version.
 *
 * Swept rather than hand-picked, across three timezones including a DST
 * transition, because that is how the last deadline defect was found.
 *
 * Run: node --import tsx/esm --test src/test/layoverReturnState.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  adviseLeaving,
  computeReturnDeadline,
  computeReturnState,
  computeWindow,
  LAYOVER_ENGINE_VERSION,
  LAYOVER_REASON_CODES,
  RETURN_SOON_LEAD_MIN,
  type LayoverReturnState,
} from "../services/airport/LayoverSafetyEngine.js";
import { wallTimeToUtc } from "../services/airport/AirportTime.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const ORDINAL: Record<LayoverReturnState, number> = {
  NORMAL: 0, RETURN_SOON: 1, RETURN_NOW: 2, CONNECTION_AT_RISK: 3,
};

function airportIn(timezone: string, verified = false): AirportProfile {
  return {
    id: "airport-1", iataCode: "TPE", name: "Taoyuan International", city: "Taipei",
    country: "Taiwan", countryCode: "TW", timezone, lat: 25.0777, lng: 121.2328,
    domesticBufferMin: 60, domesticBufferMax: 90,
    internationalBufferMin: 120, internationalBufferMax: 180,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    verified,
  };
}

function sessionWith(arrivalMs: number, departureMs: number, boardingMs: number | null, over: Partial<LayoverSession> = {}): LayoverSession {
  return {
    id: "session-1", userId: "user-1", airportId: "airport-1", tripId: null,
    arrivalTime: new Date(arrivalMs).toISOString(),
    departureTime: new Date(departureMs).toISOString(),
    boardingTime: boardingMs === null ? null : new Date(boardingMs).toISOString(),
    layoverMinutes: Math.round((departureMs - arrivalMs) / 60_000),
    flightType: "international", immigrationRequired: true, checkedBags: true,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: [],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    ...over,
  };
}

const MIN = 60_000;
// Three zones: fixed offset, US DST (falls back 2026-11-01), EU DST (2026-10-25).
const ZONES: Array<[string, string]> = [
  ["Asia/Taipei",      "2026-06-15T00:00"],
  ["America/New_York", "2026-10-31T00:00"],
  ["Europe/London",    "2026-10-24T00:00"],
];

describe("computeReturnState — monotone in time", () => {
  for (const [tz, start] of ZONES) {
    it(`${tz}: the state never steps back as the clock advances`, () => {
      const airport = airportIn(tz);
      const t0 = wallTimeToUtc(tz, start)!.getTime();
      let checked = 0;
      // cutoffs every 23 minutes over two days, with and without a boarding time
      for (let c = t0 + 6 * 60 * MIN; c < t0 + 54 * 60 * MIN; c += 23 * MIN) {
        for (const boarding of [null, c - 40 * MIN]) {
          const session = sessionWith(c - 9 * 60 * MIN, c, boarding);
          const { hardReturnTime, breakdown } = computeReturnDeadline(airport, session);
          const hr = hardReturnTime.getTime();
          let prev = -1;
          // clock every 2 minutes from 3h before the deadline to 4h after
          for (let now = hr - 180 * MIN; now <= hr + 240 * MIN; now += 2 * MIN) {
            const s = ORDINAL[computeReturnState(hr, breakdown, now)];
            assert.ok(s >= prev, `${tz} cutoff ${new Date(c).toISOString()} now ${new Date(now).toISOString()}: state went ${prev} → ${s}`);
            prev = s;
            checked++;
          }
        }
      }
      assert.ok(checked > 20_000, `sweep too small: ${checked}`);
    });
  }

  it("the four states appear in ladder order around the deadline", () => {
    const airport = airportIn("Asia/Taipei");
    const c = wallTimeToUtc("Asia/Taipei", "2026-06-15T14:00")!.getTime();
    const { hardReturnTime, breakdown } = computeReturnDeadline(airport, sessionWith(c - 8 * 60 * MIN, c, null));
    const hr = hardReturnTime.getTime();
    const contingency = (breakdown.trafficExtra + breakdown.timeOfDayExtra) * MIN;
    assert.equal(computeReturnState(hr, breakdown, hr - (RETURN_SOON_LEAD_MIN + 1) * MIN), "NORMAL");
    assert.equal(computeReturnState(hr, breakdown, hr - RETURN_SOON_LEAD_MIN * MIN), "RETURN_SOON");
    assert.equal(computeReturnState(hr, breakdown, hr - 1), "RETURN_SOON");
    assert.equal(computeReturnState(hr, breakdown, hr), "RETURN_NOW");
    assert.equal(computeReturnState(hr, breakdown, hr + contingency - 1), "RETURN_NOW");
    assert.equal(computeReturnState(hr, breakdown, hr + contingency), "CONNECTION_AT_RISK");
  });
});

describe("computeReturnState — monotone in the flight cutoff", () => {
  for (const [tz, start] of ZONES) {
    it(`${tz}: at one instant, an earlier cutoff is never a calmer state`, () => {
      const airport = airportIn(tz);
      const t0 = wallTimeToUtc(tz, start)!.getTime();
      const arrival = t0;
      let checked = 0;
      for (const boardingLead of [null, 40]) {
        // walk the cutoff forward one minute at a time across two days
        let prevState: number | null = null;
        for (const now of [t0 + 4 * 60 * MIN, t0 + 21 * 60 * MIN, t0 + 30 * 60 * MIN]) {
          prevState = null;
          for (let c = now - 120 * MIN; c <= now + 36 * 60 * MIN; c += MIN) {
            if (c <= arrival) continue;
            const boarding = boardingLead === null ? null : c - boardingLead * MIN;
            const session = sessionWith(arrival, c, boarding);
            const { hardReturnTime, breakdown } = computeReturnDeadline(airport, session);
            const s = ORDINAL[computeReturnState(hardReturnTime.getTime(), breakdown, now)];
            // later cutoff ⇒ state must be <= the previous (earlier) cutoff's state
            if (prevState !== null) {
              assert.ok(s <= prevState, `${tz} now ${new Date(now).toISOString()} cutoff ${new Date(c).toISOString()}: later cutoff got a WORSE state (${prevState} → ${s})`);
            }
            prevState = s;
            checked++;
          }
        }
      }
      assert.ok(checked > 10_000, `sweep too small: ${checked}`);
    });
  }
});

describe("computeWindow — the state agrees with the window's own numbers", () => {
  for (const [tz, start] of ZONES) {
    it(`${tz}: RETURN_NOW+ ⇒ usable 0; NORMAL ⇒ > ${RETURN_SOON_LEAD_MIN} min to the deadline`, () => {
      const airport = airportIn(tz);
      const t0 = wallTimeToUtc(tz, start)!.getTime();
      let checked = 0;
      for (let c = t0 + 6 * 60 * MIN; c < t0 + 54 * 60 * MIN; c += 97 * MIN) {
        const session = sessionWith(c - 9 * 60 * MIN, c, null);
        const { hardReturnTime } = computeReturnDeadline(airport, session);
        const hr = hardReturnTime.getTime();
        for (let now = hr - 200 * MIN; now <= hr + 200 * MIN; now += 7 * MIN) {
          const w = computeWindow(airport, session, now);
          assert.equal(w.engineVersion, LAYOVER_ENGINE_VERSION);
          assert.equal(w.hardReturnTime.getTime(), hr, "computeWindow must use the shared deadline anchor");
          if (ORDINAL[w.returnState] >= ORDINAL.RETURN_NOW) {
            assert.equal(w.usableMinutes, 0, `${w.returnState} with ${w.usableMinutes} usable minutes`);
          }
          if (w.returnState === "NORMAL") {
            assert.ok(hr - now > RETURN_SOON_LEAD_MIN * MIN, `NORMAL with only ${(hr - now) / MIN} min left`);
          }
          checked++;
        }
      }
      assert.ok(checked > 1_000, `sweep too small: ${checked}`);
    });
  }
});

describe("adviseLeaving — Appendix A reason codes", () => {
  const SPEC_APPENDIX_A = [
    "ENTRY_NOT_CONFIRMED", "BAGGAGE_STATUS_CRITICAL_UNKNOWN", "INSUFFICIENT_USABLE_TIME",
    "SECURITY_WAIT_HIGH", "RETURN_ROUTE_UNRELIABLE", "AIRPORT_CHANGE_REQUIRED",
    "SELF_TRANSFER_FRICTION", "DATA_STALE", "SOURCE_CONFLICT", "TRAFFIC_DEGRADED",
    "FLIGHT_MOVED_EARLIER", "FLIGHT_DELAY_CREATED_OPPORTUNITY", "RETURN_THRESHOLD_REACHED",
    "RECOMMENDATION_EXPIRED", "AIRPORT_MATURITY_LIMITED",
  ];

  it("declares exactly the fifteen codes of spec Appendix A, once each", () => {
    assert.deepEqual([...LAYOVER_REASON_CODES].sort(), [...SPEC_APPENDIX_A].sort());
    assert.equal(new Set(LAYOVER_REASON_CODES).size, 15);
  });

  const tz = "Asia/Taipei";
  const c = wallTimeToUtc(tz, "2026-06-15T14:00")!.getTime();

  it("entry is never confirmed on this tree, and the code says so on every verdict", () => {
    for (const wants of [true, false]) {
      const session = sessionWith(c - 8 * 60 * MIN, c, null, { wantsToLeave: wants });
      const w = computeWindow(airportIn(tz), session, c - 7 * 60 * MIN);
      const a = adviseLeaving(airportIn(tz), session, w);
      assert.ok(a.reasonCodes.includes("ENTRY_NOT_CONFIRMED"), `verdict ${a.verdict} lacks ENTRY_NOT_CONFIRMED`);
      assert.equal(a.engineVersion, LAYOVER_ENGINE_VERSION);
    }
  });

  it("an unverified airport (every production profile) carries AIRPORT_MATURITY_LIMITED; a verified one does not", () => {
    const session = sessionWith(c - 8 * 60 * MIN, c, null);
    const w = computeWindow(airportIn(tz), session, c - 7 * 60 * MIN);
    assert.ok(adviseLeaving(airportIn(tz, false), session, w).reasonCodes.includes("AIRPORT_MATURITY_LIMITED"));
    assert.ok(!adviseLeaving(airportIn(tz, true), session, w).reasonCodes.includes("AIRPORT_MATURITY_LIMITED"));
  });

  it("verdict 'no' carries INSUFFICIENT_USABLE_TIME; 'yes' does not", () => {
    const airport = airportIn(tz);
    const roomy = sessionWith(c - 9 * 60 * MIN, c, null);
    const wRoomy = computeWindow(airport, roomy, c - 8 * 60 * MIN);
    const aRoomy = adviseLeaving(airport, roomy, wRoomy);
    assert.equal(aRoomy.verdict, "yes");
    assert.ok(!aRoomy.reasonCodes.includes("INSUFFICIENT_USABLE_TIME"));

    const tight = sessionWith(c - 3 * 60 * MIN, c, null);
    const wTight = computeWindow(airport, tight, c - 2 * 60 * MIN);
    const aTight = adviseLeaving(airport, tight, wTight);
    assert.equal(aTight.verdict, "no");
    assert.ok(aTight.reasonCodes.includes("INSUFFICIENT_USABLE_TIME"));
  });

  it("past the deadline the advice carries RETURN_THRESHOLD_REACHED, and not before", () => {
    const airport = airportIn(tz);
    const session = sessionWith(c - 9 * 60 * MIN, c, null);
    const { hardReturnTime } = computeReturnDeadline(airport, session);
    const hr = hardReturnTime.getTime();
    const before = adviseLeaving(airport, session, computeWindow(airport, session, hr - 60 * MIN));
    const after  = adviseLeaving(airport, session, computeWindow(airport, session, hr + 1));
    assert.ok(!before.reasonCodes.includes("RETURN_THRESHOLD_REACHED"));
    assert.ok(after.reasonCodes.includes("RETURN_THRESHOLD_REACHED"));
  });

  it("only declared codes are ever emitted", () => {
    const airport = airportIn(tz);
    const declared = new Set<string>(LAYOVER_REASON_CODES);
    for (const wants of [true, false]) {
      for (const offset of [-8 * 60, -2 * 60, -30, 5, 90]) {
        const session = sessionWith(c - 9 * 60 * MIN, c, null, { wantsToLeave: wants });
        const a = adviseLeaving(airport, session, computeWindow(airport, session, c + offset * MIN));
        for (const code of a.reasonCodes) assert.ok(declared.has(code), `undeclared code ${code}`);
        assert.equal(new Set(a.reasonCodes).size, a.reasonCodes.length, "codes must not repeat");
      }
    }
  });
});
