/**
 * Layover hard-return deadline — monotonicity & self-consistency properties.
 *
 * node:test + node:assert (NOT vitest). No DB, no network.
 *
 * The defect these tests pin down: `timeOfDayExtra` used to be a raw step
 * function of the airport-local hour (>=22 or <6 → 20, >=20 or <8 → 10, else
 * 0), while the deadline is `cutoff − totalBuffer`. A cutoff of 20:00 local
 * therefore carried a 10-minute-larger buffer than 19:59, so a departure ONE
 * MINUTE EARLIER moved the "you must head back now" deadline NINE MINUTES
 * LATER — the engine handed the traveller nine extra minutes in the city for
 * making their flight sooner. Same at the 22:00 boundary, and worse (ten
 * minutes) once a boarding time pinned the cutoff.
 *
 * The invariant, stated once: the hard return deadline must be monotonically
 * non-decreasing in the flight cutoff. A property sweep over every minute of a
 * multi-day window is the test that actually holds that down; the two named
 * pairs below exist so a regression reports a readable pair of times.
 *
 * Run: node --import tsx/esm --test src/test/layoverDeadlineMonotonicity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assess,
  computeBuffer,
  computeWindow,
  computeReturnDeadline,
  layoverCutoffMs,
} from "../services/airport/LayoverSafetyEngine.js";
import { localHour, wallTimeToUtc } from "../services/airport/AirportTime.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

function airportIn(timezone: string): AirportProfile {
  return {
    id: "airport-1", iataCode: "TPE", name: "Taoyuan International", city: "Taipei",
    country: "Taiwan", countryCode: "TW", timezone, lat: 25.0777, lng: 121.2328,
    domesticBufferMin: 60, domesticBufferMax: 90,
    internationalBufferMin: 120, internationalBufferMax: 180,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    verified: true,
  };
}

function sessionAt(
  departureMs: number,
  boardingMs: number | null = null,
  over: Partial<LayoverSession> = {},
): LayoverSession {
  return {
    id: "session-1", userId: "user-1", airportId: "airport-1", tripId: null,
    arrivalTime: new Date(departureMs - 10 * 3_600_000).toISOString(),
    departureTime: new Date(departureMs).toISOString(),
    boardingTime: boardingMs === null ? null : new Date(boardingMs).toISOString(),
    layoverMinutes: 600, flightType: "domestic", immigrationRequired: false,
    checkedBags: false, loungeAccess: false, wantsToLeave: true,
    comfortLevel: "moderate", vibeChips: [], manualAirportName: null,
    manualCity: null, manualCountry: null, manualIata: null, canonicalCityId: null,
    shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    ...over,
  };
}

const CANDIDATE = { title: "City walk", travelTimeMin: 20, activityTimeMin: 60, insideAirport: false };

// ── The named regression pairs ───────────────────────────────────────────────

describe("layover hard-return deadline — named regression pairs", () => {
  const TZ = "Asia/Taipei";
  const airport = airportIn(TZ);

  // The two airport-local boundaries where the raw step function jumped up.
  for (const [earlier, later] of [["19:59", "20:00"], ["21:59", "22:00"]] as const) {
    it(`a departure at ${earlier} local does not get a LATER deadline than one at ${later}`, () => {
      const dEarlier = wallTimeToUtc(TZ, `2026-06-15T${earlier}`)!;
      const dLater   = wallTimeToUtc(TZ, `2026-06-15T${later}`)!;
      assert.equal(dLater.getTime() - dEarlier.getTime(), 60_000, "the pair must be one minute apart");

      const rEarlier = computeReturnDeadline(airport, sessionAt(dEarlier.getTime()));
      const rLater   = computeReturnDeadline(airport, sessionAt(dLater.getTime()));

      assert.ok(
        rLater.hardReturnTime.getTime() >= rEarlier.hardReturnTime.getTime(),
        `flying one minute later moved the deadline EARLIER by ` +
        `${(rEarlier.hardReturnTime.getTime() - rLater.hardReturnTime.getTime()) / 60000} min ` +
        `(${earlier} → ${rEarlier.hardReturnTime.toISOString()}, ${later} → ${rLater.hardReturnTime.toISOString()})`,
      );
    });
  }

  it("the same pair through assess() with a pinned boarding time", () => {
    // Boarding pins the cutoff, so ONLY the buffer moves — the pre-fix gap here
    // was a full ten minutes rather than nine.
    const boarding = wallTimeToUtc(TZ, "2026-06-15T23:00")!.getTime();
    const dEarlier = wallTimeToUtc(TZ, "2026-06-15T19:59")!.getTime();
    const dLater   = wallTimeToUtc(TZ, "2026-06-15T20:00")!.getTime();
    const now      = wallTimeToUtc(TZ, "2026-06-15T09:00")!.getTime();

    const aEarlier = assess(airport, sessionAt(dEarlier, boarding), CANDIDATE, now);
    const aLater   = assess(airport, sessionAt(dLater, boarding), CANDIDATE, now);

    assert.ok(
      aLater.hardReturnTime.getTime() >= aEarlier.hardReturnTime.getTime(),
      `assess() deadline moved backwards: ${aEarlier.hardReturnTime.toISOString()} → ${aLater.hardReturnTime.toISOString()}`,
    );
    assert.ok(
      aLater.usableMinutes <= aEarlier.usableMinutes + 1,
      "a later departure must not shrink usable time by more than the minute it moved",
    );
  });
});

// ── The property: swept, not hand-picked ─────────────────────────────────────

describe("layover hard-return deadline — swept properties", () => {
  // Zones chosen for awkwardness: half-hour and 45-minute offsets, southern
  // and northern DST, and Lord Howe's 30-minute DST shift. Dates straddle real
  // transitions in those zones.
  const ZONES = ["UTC", "Asia/Taipei", "America/New_York", "Australia/Lord_Howe", "Asia/Kathmandu"];
  const DATES = ["2026-03-08", "2026-06-15", "2026-10-25"];
  const VARIANTS: Array<Partial<LayoverSession>> = [
    {},
    { flightType: "international", immigrationRequired: true, checkedBags: true },
  ];
  const SWEEP_MINUTES = 36 * 60;

  it("hardReturnTime is monotonically non-decreasing in the departure instant", () => {
    let checked = 0;
    for (const tz of ZONES) {
      const airport = airportIn(tz);
      for (const date of DATES) {
        const base = Date.parse(`${date}T00:00:00Z`);
        for (const variant of VARIANTS) {
          let prev = -Infinity;
          let prevDep = 0;
          for (let i = 0; i < SWEEP_MINUTES; i++) {
            const dep = base + i * 60_000;
            const at = computeReturnDeadline(airport, sessionAt(dep, null, variant)).hardReturnTime.getTime();
            assert.ok(
              at >= prev,
              `${tz}: departure ${new Date(prevDep).toISOString()} → ${new Date(dep).toISOString()} ` +
              `moved the deadline BACKWARD by ${(prev - at) / 60000} min`,
            );
            prev = at;
            prevDep = dep;
            checked++;
          }
        }
      }
    }
    // 5 zones x 3 dates x 2 variants x 36h = 64,800 minute-by-minute comparisons.
    assert.equal(checked, ZONES.length * DATES.length * VARIANTS.length * SWEEP_MINUTES);
    assert.ok(checked > 60_000, `sweep should be broad, only checked ${checked}`);
  });

  it("hardReturnTime is monotonically non-decreasing in the boarding instant", () => {
    const airport = airportIn("Asia/Taipei");
    const dep = Date.parse("2026-06-17T12:00:00Z");
    let prev = -Infinity;
    for (let i = 0; i < 24 * 60; i++) {
      const boarding = Date.parse("2026-06-16T12:00:00Z") + i * 60_000;
      const at = computeReturnDeadline(airport, sessionAt(dep, boarding)).hardReturnTime.getTime();
      assert.ok(at >= prev, `boarding ${new Date(boarding).toISOString()} moved the deadline backward`);
      prev = at;
    }
  });

  it("hardReturnTime always equals cutoff minus the published totalBuffer", () => {
    for (const tz of ZONES) {
      const airport = airportIn(tz);
      const base = Date.parse("2026-10-25T00:00:00Z");
      for (let i = 0; i < 30 * 60; i += 3) {
        const dep = base + i * 60_000;
        for (const boarding of [null, dep - 40 * 60_000]) {
          const s = sessionAt(dep, boarding);
          const r = computeReturnDeadline(airport, s);
          assert.equal(r.cutoffMs, layoverCutoffMs(s));
          assert.equal(
            r.hardReturnTime.getTime(),
            r.cutoffMs - r.breakdown.totalBuffer * 60_000,
            `${tz}: deadline and totalBuffer disagree at ${new Date(dep).toISOString()}`,
          );
        }
      }
    }
  });

  it("the ramped time-of-day extra is never LESS than the raw hour band it replaced", () => {
    // The ramp may only ever make the buffer bigger (deadline earlier). If it
    // ever came in under the old step, the fix would have traded a
    // monotonicity bug for a less-safe deadline.
    const rawBand = (h: number) => (h >= 22 || h < 6 ? 20 : h >= 20 || h < 8 ? 10 : 0);
    for (const tz of ZONES) {
      const airport = airportIn(tz);
      const base = Date.parse("2026-06-15T00:00:00Z");
      for (let i = 0; i < 30 * 60; i++) {
        const dep = base + i * 60_000;
        const b = computeBuffer(airport, sessionAt(dep), new Date(dep), tz);
        assert.ok(
          b.timeOfDayExtra >= rawBand(localHour(tz, new Date(dep))),
          `${tz}: ramped extra ${b.timeOfDayExtra} is below the raw band at ${new Date(dep).toISOString()}`,
        );
        assert.ok(b.timeOfDayExtra <= 20, "the extra must stay within its declared range");
      }
    }
  });
});

// ── One response, one buffer ─────────────────────────────────────────────────

describe("layover safety response is self-consistent", () => {
  // GET /airport/sessions/:id/safety publishes `returnBufferMin` from assess()
  // alongside `hardReturnTime` from computeWindow(). Those used to be computed
  // at different instants (departure vs. boarding cutoff), so with a boarding
  // time in a different hour band the endpoint published a buffer that did not
  // match the deadline printed beside it.
  it("assess() and computeWindow() agree on both buffer and deadline", () => {
    for (const tz of ["Asia/Taipei", "America/New_York", "Pacific/Auckland"]) {
      const airport = airportIn(tz);
      const base = Date.parse("2026-06-15T00:00:00Z");
      for (let i = 0; i < 36 * 60; i += 5) {
        const dep = base + i * 60_000;
        for (const boarding of [null, dep - 45 * 60_000, dep - 200 * 60_000]) {
          const s = sessionAt(dep, boarding);
          const a = assess(airport, s, CANDIDATE, base);
          const w = computeWindow(airport, s, base);
          assert.equal(a.returnBufferMin, w.returnBufferMin,
            `${tz}: buffer disagreement at ${new Date(dep).toISOString()} (boarding ${boarding})`);
          assert.equal(a.hardReturnTime.getTime(), w.hardReturnTime.getTime(),
            `${tz}: deadline disagreement at ${new Date(dep).toISOString()} (boarding ${boarding})`);
        }
      }
    }
  });

  it("the deadline is anchored to boarding time when one is set", () => {
    const TZ = "Asia/Taipei";
    const airport = airportIn(TZ);
    const dep = wallTimeToUtc(TZ, "2026-06-15T20:30")!.getTime();
    const boarding = wallTimeToUtc(TZ, "2026-06-15T19:30")!.getTime();
    const r = computeReturnDeadline(airport, sessionAt(dep, boarding));
    assert.equal(r.cutoffMs, boarding);
    assert.ok(r.hardReturnTime.getTime() < boarding, "the deadline must precede boarding");
  });
});
