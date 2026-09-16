/**
 * §8.1 L72 / L60 — the ride back is not the ride out.
 *
 * census-layover L72 reads NOT-BUILT with one sentence: *"Return traffic
 * forecast → use future-time estimate, not outbound time."* Its evidence has
 * been rewritten twice and the finding has survived both rewrites — §18.7
 * restated it as *"the return is not modelled as outbound × 2; it is not
 * modelled at all"*. L60 asks the same thing of reachability: the journey back
 * happens LATER than the journey out, under the conditions of that later hour,
 * and nothing on this tree has ever read the return hour.
 *
 * Something on this tree already states future-time transport assumptions and
 * has since the Trips surface was built: `TripDepartureAssumptions` (Trips
 * §14.2, census-trips TR267) publishes a band table over the LOCAL departure
 * hour — PEAK / SHOULDER / OFF_PEAK / NIGHT — with a factor ≥ 1, a source
 * class and a confidence. It was never asked about a layover.
 *
 * So the airport's own ground-transport term stops being a constant and starts
 * being a forecast taken AT THE CERTIFIED RETURN INSTANT, in AIRPORT-LOCAL
 * time. Two identical sessions whose flights leave at different hours of the
 * same day now carry different buffers, different deadlines, different usable
 * windows and — because the §8 envelope is cut from that window — different
 * envelope radii.
 *
 * ── WHAT THIS FILE REFUSES TO LET THE BUILD GET AWAY WITH ────────────────────
 *  1. The term must come out of the AIRPORT'S OWN `traffic_extra_min`. An
 *     airport whose row says 0 must get 0: a forecast is a multiplier over a
 *     stated term, never a leg invented for a traveller who has none.
 *  2. `timeOfDayExtra` must not move. It is a published term with its own
 *     meaning (night caution) and its values are pinned elsewhere; a new term
 *     that silently re-scales it would be a second defect wearing a fix.
 *  3. §6.1 L53 — `hardReturnTime` must stay monotonically non-decreasing in
 *     the flight cutoff. A raw band step would move a traveller's deadline
 *     BACKWARDS as their flight moves later, which is the exact defect
 *     `9c26efba` closed for `timeOfDayBand`. The SUM of the two time-varying
 *     terms is swept minute by minute across every band edge in a local day.
 *  4. It must reach a traveller. The last two cases drive
 *     `GET /api/airport/sessions/:id/safety` over HTTP and read the published
 *     buffer, the published §6.2 estimate and the published safe envelope.
 *
 * Run: node --import tsx --test src/test/layoverReturnConditions.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEPARTURE_FACTORS,
  departureBand,
} from "../domain/trips/services/TripDepartureAssumptions.js";
import {
  RETURN_TABLE,
  MAX_RETURN_TRANSPORT_FACTOR,
  returnTransportFactor,
  rawReturnTransportExtraMinutes,
  returnTransportForecast,
} from "../services/airport/layoverRouting.js";
import {
  computeBuffer,
  computeReturnDeadline,
  type EngineAirport,
} from "../services/airport/LayoverSafetyEngine.js";
import {
  certifySessionFeasibility,
  conservativeBufferMinutes,
  SAFETY_CRITICAL_PERCENTILE,
} from "../services/airport/LayoverFeasibility.js";
import { wallTimeToUtc } from "../services/airport/AirportTime.js";
import { airportRowToProfile } from "../services/airport/AirportProfileService.js";
import { airportRow } from "./helpers/fakeLayoverDb.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const TZ = "Asia/Taipei";

/**
 * The next Monday at least a fortnight out, as `YYYY-MM-DD` in TZ's OWN
 * calendar.
 *
 * The airport's day is the one the traffic bands are read in, and it is not the
 * runner's — so the weekday is resolved in `TZ` rather than by the host's local
 * `Date`, and the result is fed straight back to `wallTimeToUtc(TZ, ...)`.
 * Fourteen through twenty-one days out is an eight-day span, which always
 * contains exactly one Monday.
 */
function mondayAhead(): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
  });
  for (let d = 14; d < 22; d++) {
    const parts = fmt.formatToParts(new Date(Date.now() + d * 24 * 60 * 60 * 1000));
    const part = (t: string) => parts.find((x) => x.type === t)!.value;
    if (part("weekday") === "Mon") return `${part("year")}-${part("month")}-${part("day")}`;
  }
  throw new Error("unreachable: an eight-day span always contains a Monday");
}

function airport(over: Partial<AirportProfile> = {}): AirportProfile {
  return {
    id: "airport-tpe",
    iataCode: "TPE",
    name: "Taiwan Taoyuan International Airport",
    city: "Taoyuan",
    country: "Taiwan",
    countryCode: "TW",
    timezone: TZ,
    lat: 25.0797,
    lng: 121.2342,
    domesticBufferMin: 60,
    domesticBufferMax: 90,
    internationalBufferMin: 120,
    internationalBufferMax: 180,
    immigrationExtraMin: 30,
    checkedBagsExtraMin: 15,
    trafficExtraMin: 20,
    verified: false,
    ...over,
  } as AirportProfile;
}

/** A session whose flight leaves at `wall` airport-local on 2026-09-14 (a Monday). */
function session(wall: string, over: Partial<LayoverSession> = {}): LayoverSession {
  const dep = wallTimeToUtc(TZ, wall)!;
  assert.ok(dep, `unparseable wall time ${wall}`);
  return {
    id: "session-1",
    userId: "user-1",
    airportId: "airport-tpe",
    tripId: null,
    arrivalTime: new Date(dep.getTime() - 8 * 3_600_000).toISOString(),
    departureTime: dep.toISOString(),
    boardingTime: null,
    layoverMinutes: 480,
    flightType: "international",
    immigrationRequired: true,
    checkedBags: false,
    loungeAccess: false,
    wantsToLeave: true,
    comfortLevel: "moderate",
    vibeChips: ["food"],
    status: "active",
    ...over,
  } as unknown as LayoverSession;
}

// ── 1. The forecast itself ───────────────────────────────────────────────────

describe("§8.1 — the return leg's conditions are forecast, not assumed equal to the outbound", () => {
  it("the band table is the repository's own, asked rather than re-spelled", () => {
    // Every band this module can produce must come from the existing Trips
    // assumption model. A second copy of the numbers is how two surfaces come
    // to disagree about the same hour.
    for (const hour of [0, 3, 6, 8, 12, 17, 19, 21, 23]) {
      for (const weekend of [false, true]) {
        assert.equal(
          returnTransportFactor(hour, weekend),
          DEPARTURE_FACTORS[RETURN_TABLE][departureBand(hour, weekend)],
          `hour ${hour} weekend=${weekend}`,
        );
      }
    }
  });

  it("the factor is never below 1 — a forecast may lengthen the ride back, never shorten it", () => {
    for (let hour = 0; hour < 24; hour++) {
      for (const weekend of [false, true]) {
        assert.ok(
          returnTransportFactor(hour, weekend) >= 1,
          `hour ${hour} weekend=${weekend} shortened the ride back`,
        );
        assert.ok(returnTransportFactor(hour, weekend) <= MAX_RETURN_TRANSPORT_FACTOR);
      }
    }
  });

  it("the extra is a multiplier over the AIRPORT'S OWN term — 0 in, 0 out", () => {
    for (let hour = 0; hour < 24; hour++) {
      assert.equal(
        rawReturnTransportExtraMinutes(0, hour, false), 0,
        `an airport with no stated ground-transport term must not acquire one at hour ${hour}`,
      );
    }
    // And a negative or non-finite column value is an absence, not a credit.
    assert.equal(rawReturnTransportExtraMinutes(-40, 17, false), 0);
    assert.equal(rawReturnTransportExtraMinutes(Number.NaN, 17, false), 0);
  });

  it("a peak return costs strictly more than an off-peak one at the same airport", () => {
    const offPeak = rawReturnTransportExtraMinutes(20, 12, false);
    const peak = rawReturnTransportExtraMinutes(20, 17, false);
    const night = rawReturnTransportExtraMinutes(20, 3, false);
    assert.ok(peak > offPeak, `peak ${peak} must exceed off-peak ${offPeak}`);
    assert.ok(offPeak > night, `off-peak ${offPeak} must exceed night ${night}`);
    assert.equal(night, 0, "free-flow at night is what the bound already assumes");
  });

  it("the extra is EXACT integer arithmetic — `20 × 30 %` is 6 minutes, not 7", () => {
    // Written against a measured defect, not a hypothetical. The obvious
    // spelling, `Math.ceil(base * (factor - 1))`, answers 7 here: `1.3 - 1` is
    // 0.30000000000000004 in IEEE-754 and 20 × that lands a hair above 6. Every
    // airport whose `traffic_extra_min` is a round number lost a whole extra
    // minute of a traveller's window to a rounding artifact, and the §21.1
    // scenario matrix is where it surfaced.
    assert.equal(rawReturnTransportExtraMinutes(20, 12, true), 6, "weekend SHOULDER, ×1.3");
    assert.equal(rawReturnTransportExtraMinutes(10, 12, true), 3);
    assert.equal(rawReturnTransportExtraMinutes(30, 12, true), 9);
    assert.equal(rawReturnTransportExtraMinutes(50, 12, true), 15);
    // A genuine fraction still rounds UP, which is the conservative direction.
    assert.equal(rawReturnTransportExtraMinutes(35, 12, true), 11, "35 × 0.3 = 10.5");
    assert.equal(rawReturnTransportExtraMinutes(20, 17, false), 12, "weekday PEAK, ×1.6");
    assert.equal(rawReturnTransportExtraMinutes(20, 10, false), 2, "weekday OFF_PEAK, ×1.1");
  });

  it("the forecast carries §6.2 provenance and names the instant it is FOR", () => {
    const at = wallTimeToUtc(TZ, "2026-09-14T17:30")!;
    const f = returnTransportForecast(20, at, TZ);
    assert.equal(f.forecastForMs, at.getTime());
    assert.equal(f.band, "PEAK");
    assert.equal(f.localHour, 17);
    assert.equal(f.timezone, TZ);
    assert.equal(f.timezoneAssumed, false);
    assert.equal(f.sourceClass, "STATIC_DEFAULT");
    assert.equal(f.confidence, "LOW");
    assert.ok(f.extraMinutes > 0);
    assert.ok(f.sourceRefs.length > 0);
    assert.match(f.detail, /peak/i);
  });

  it("an airport with no usable timezone is told the zone was assumed", () => {
    const f = returnTransportForecast(20, new Date("2026-09-14T09:30:00.000Z"), "Not/AZone");
    assert.equal(f.timezoneAssumed, true);
    assert.equal(f.timezone, "UTC");
  });
});

// ── 2. The term reaches the buffer, and does not disturb the terms beside it ─

describe("§6 — the return forecast is a named term in the subtraction ladder", () => {
  it("two identical sessions differing only in the RETURN HOUR carry different buffers", () => {
    const a = airport();
    const midday = computeReturnDeadline(a as unknown as EngineAirport, session("2026-09-14T12:00"));
    const rush = computeReturnDeadline(a as unknown as EngineAirport, session("2026-09-14T17:00"));

    // The confound this case exists to exclude: both hours sit in the same
    // night-caution band, so `timeOfDayExtra` is identical and the difference
    // can only be the new term.
    assert.equal(
      midday.breakdown.timeOfDayExtra, rush.breakdown.timeOfDayExtra,
      "the two hours must share a time-of-day band for this comparison to mean anything",
    );
    assert.ok(
      rush.breakdown.returnTransportExtra > midday.breakdown.returnTransportExtra,
      `a 17:00 return must cost more ground transport than a 12:00 one: ` +
        `${rush.breakdown.returnTransportExtra} vs ${midday.breakdown.returnTransportExtra}`,
    );
    assert.ok(rush.breakdown.totalBuffer > midday.breakdown.totalBuffer);
    assert.ok(
      rush.hardReturnTime.getTime() - rush.breakdown.totalBuffer * 0 <= rush.cutoffMs,
      "sanity",
    );
  });

  it("the breakdown's terms still sum to totalBuffer, with the new one counted", () => {
    for (const wall of ["2026-09-14T03:00", "2026-09-14T08:30", "2026-09-14T12:00", "2026-09-14T17:00", "2026-09-14T22:15"]) {
      const b = computeBuffer(airport(), session(wall), wallTimeToUtc(TZ, wall)!, TZ);
      assert.equal(
        b.baseBuffer + b.immigrationExtra + b.bagsExtra + b.trafficExtra +
          b.timeOfDayExtra + b.liveExtra + b.returnTransportExtra,
        b.totalBuffer,
        `every term in the breakdown must be accounted for at ${wall}`,
      );
    }
  });

  it("an airport with traffic_extra_min 0 gets no return-transport term at any hour", () => {
    for (const wall of ["2026-09-14T03:00", "2026-09-14T08:00", "2026-09-14T17:30", "2026-09-14T19:00"]) {
      const b = computeBuffer(airport({ trafficExtraMin: 0 }), session(wall), wallTimeToUtc(TZ, wall)!, TZ);
      assert.equal(b.returnTransportExtra, 0, `fabricated a ground-transport term at ${wall}`);
    }
  });
});

// ── 3. §6.1 L53 — the deadline must still never move backwards ───────────────

describe("§6.1 L53 — a later flight never buys a deadline that is earlier", () => {
  it("hardReturnTime is non-decreasing over every minute of a local day, at four airports", () => {
    const profiles = [
      airport({ trafficExtraMin: 20 }),
      airport({ trafficExtraMin: 0 }),
      airport({ trafficExtraMin: 45 }),
      airport({ trafficExtraMin: 7, verified: true }),
    ];
    let checked = 0;
    for (const a of profiles) {
      const start = wallTimeToUtc(TZ, "2026-09-14T00:00")!.getTime();
      let prev = -Infinity;
      for (let m = 0; m <= 24 * 60; m++) {
        const dep = new Date(start + m * 60_000);
        const d = computeReturnDeadline(
          a as unknown as EngineAirport,
          session("2026-09-14T00:00", { departureTime: dep.toISOString() }),
        );
        const t = d.hardReturnTime.getTime();
        assert.ok(
          t >= prev,
          `deadline moved backwards at +${m} min (traffic ${a.trafficExtraMin}): ${t} < ${prev}`,
        );
        // The published identity every consumer relies on.
        assert.equal(t, d.cutoffMs - d.breakdown.totalBuffer * 60_000);
        prev = t;
        checked++;
      }
    }
    assert.ok(checked > 5000, `swept only ${checked} cutoffs`);
  });

  it("the two time-varying terms are 1-Lipschitz TOGETHER, not merely one at a time", () => {
    // The pre-existing proof rested on `timeOfDayExtra` being the ONLY term that
    // varies with the cutoff. A second varying term can break the composition
    // even when each half is well behaved, so the SUM is what is swept.
    //
    // MEASURED, AND REPORTED RATHER THAN OVERSOLD: this case does NOT currently
    // distinguish the joint ramp from ramping each term on its own. Replacing
    // `returnTransportExtra`'s joint running maximum with a per-term one was run
    // as a mutation and stayed GREEN here and across the 1.5-million-case
    // `layoverDeadlineMonotonicity` sweep. The reason is a coincidence of the
    // two tables, not a property of the code: `timeOfDayBand` only ever RISES at
    // 20:00 and 22:00 local, and `departureBand`'s factor only FALLS at those
    // hours, so the two steps never go up in the same minute and the sum never
    // climbs faster than one minute per minute even when nothing makes it.
    //
    // The joint ramp stays, and this is why: `departureBand` belongs to the
    // Trips surface, and the L53 guarantee must not depend on where another
    // lane chooses to put its band edges. That is the same argument
    // `TOD_RAMP_MIN` makes about its own window. What this case CAN report is
    // that the property holds today; a mutation that makes it fail would have
    // to move a band edge, which is a change to someone else's table.
    const a = airport({ trafficExtraMin: 45 });
    const start = wallTimeToUtc(TZ, "2026-09-14T00:00")!.getTime();
    let prevSum: number | null = null;
    for (let m = 0; m <= 24 * 60; m++) {
      const at = new Date(start + m * 60_000);
      const b = computeBuffer(a, session("2026-09-14T00:00"), at, TZ);
      const sum = b.timeOfDayExtra + b.returnTransportExtra;
      if (prevSum !== null) {
        assert.ok(
          sum - prevSum <= 1,
          `the varying part of the buffer rose by ${sum - prevSum} in one minute at +${m}`,
        );
      }
      prevSum = sum;
    }
  });
});

// ── 4. §6.2 — the term is an estimate with provenance, on the record ─────────

describe("§6.2 — the return forecast is published as an estimate", () => {
  it("record.estimates carries it, and the conservative selection still equals the buffer", () => {
    const at = wallTimeToUtc(TZ, "2026-09-14T17:30")!;
    const rec = certifySessionFeasibility(airport(), session("2026-09-14T17:30"), {
      nowMs: at.getTime() - 5 * 3_600_000,
    });
    const e = rec.estimates.returnTransport;
    assert.ok(e, "no returnTransport estimate on the certified record");
    assert.equal(e.sourceClass, "STATIC_DEFAULT");
    assert.equal(e.confidence, "LOW");
    assert.equal(e.fallbackLevel, 3);
    assert.equal(e.valueMinutes, rec.deadline.breakdown.returnTransportExtra);
    assert.equal(
      conservativeBufferMinutes(rec.estimates, SAFETY_CRITICAL_PERCENTILE),
      rec.deadline.breakdown.totalBuffer,
      "the §6.2 selection and the published buffer must not disagree",
    );
    assert.equal(rec.bufferMinutesAtPercentile, rec.deadline.breakdown.totalBuffer);
  });
});

// ── 5. It reaches a traveller ───────────────────────────────────────────────

async function safetyBody(departureIso: string, trafficExtraMin: number) {
  const http = await import("node:http");
  const express = (await import("express")).default;
  const { _setTestClient } = await import("../lib/http.js");
  const airportRouter = (await import("../routes/airport.js")).default;
  const { makeLayoverDb, airportRow, sessionRow } = await import("./helpers/fakeLayoverDb.js");

  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as any).port;

  _setTestClient(makeLayoverDb({
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
    ],
    airport_profiles: [airportRow({ traffic_extra_min: trafficExtraMin })],
    layover_sessions: [sessionRow({
      user_id: "user-1",
      departure_time: departureIso,
      arrival_time: new Date(Date.parse(departureIso) - 8 * 3_600_000).toISOString(),
    })],
    layover_events: [], layover_plan_stops: [], trip_plan_items: [],
  }, { users: { "env-token": "user-1" } }), true);

  const body = await new Promise<any>((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path: "/api/airport/sessions/session-1/safety", method: "GET",
        headers: { authorization: "Bearer env-token" } },
      (res) => {
        let raw = ""; res.on("data", (c) => (raw += c));
        res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
      });
    r.on("error", reject); r.end();
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return body;
}

describe("GET /airport/sessions/:id/safety publishes the return forecast", () => {
  /**
   * Both flights leave on the SAME Monday, well inside the day-band
   * (`timeOfDayExtra` is 0 for each), so the only difference the response can
   * show is the new term.
   *
   * THE DAY IS COMPUTED, NOT WRITTEN DOWN. This case is reached over HTTP, and
   * the route hands `Date.now()` to the engine (`routes/airport.ts`). A session
   * whose departure has already passed has no window left, so `usableMinutes`
   * clamps to zero for BOTH sessions — `Math.max(0, ...)` in
   * `LayoverSafetyEngine` — and `rush.usableMinutes < midday.usableMinutes`
   * becomes `0 < 0`, which is false. The envelope test next to it fails the
   * same way.
   *
   * The old fixture said the quiet part out loud: the instants "do not depend
   * on when it runs — except that the session must not already be in the past,
   * which is why the year is fixed ahead". A year fixed ahead is a fuse, not a
   * fix. Pinned to 2027-09-13 both tests were green until that date and armed
   * after it, and the next reader would have moved the year again.
   *
   * `mondayAhead` keeps the two properties the comparison actually needs — a
   * WEEKDAY, because the PEAK factor is weekday-dependent, and a departure
   * comfortably in the future — without naming a day that can expire.
   */
  const DAY = mondayAhead();
  const RUSH = wallTimeToUtc(TZ, `${DAY}T17:00`)!.toISOString();
  const MIDDAY = wallTimeToUtc(TZ, `${DAY}T12:00`)!.toISOString();

  it("the buffer breakdown names the term and the peak session loses usable minutes", async () => {
    const rush = await safetyBody(RUSH, 20);
    const midday = await safetyBody(MIDDAY, 20);

    assert.ok(rush?.breakdown, `no breakdown on the response: ${JSON.stringify(rush).slice(0, 300)}`);
    assert.equal(
      rush.breakdown.timeOfDayExtra, midday.breakdown.timeOfDayExtra,
      "the two hours must share a time-of-day band for this comparison to mean anything",
    );
    assert.ok(
      rush.breakdown.returnTransportExtra > midday.breakdown.returnTransportExtra,
      `peak ${rush.breakdown.returnTransportExtra} vs midday ${midday.breakdown.returnTransportExtra}`,
    );
    assert.ok(
      rush.usableMinutes < midday.usableMinutes,
      `a peak return must cost usable minutes: ${rush.usableMinutes} vs ${midday.usableMinutes}`,
    );
    assert.equal(
      rush.estimates.returnTransport.valueMinutes,
      rush.breakdown.returnTransportExtra,
      "the published estimate and the published term must be the same number",
    );
  });

  it("§8 — the safe envelope contracts when the return conditions worsen", async () => {
    const rush = await safetyBody(RUSH, 45);
    const midday = await safetyBody(MIDDAY, 45);
    assert.ok(rush?.safeEnvelope && midday?.safeEnvelope, "no envelope on the safety response");
    assert.ok(
      rush.safeEnvelope.radiusMetres < midday.safeEnvelope.radiusMetres,
      `the envelope did not contract with the return forecast: ` +
        `${rush.safeEnvelope.radiusMetres} vs ${midday.safeEnvelope.radiusMetres}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.2 PROVENANCE — a sourceRef names the code that produced the number
//
// Found by a mutation that SURVIVED. Neutralising the timezone inside
// `layoverRouting.ts#returnTransportForecast` changed no certified record,
// because that function HAS NO PRODUCTION CALLER: outside the tests, the only
// reference to it anywhere is the sourceRef STRING below. The value is produced
// by `LayoverSafetyEngine`'s own `returnTransportExtra`.
//
// That is not a naming quibble, because the two are not the same function. They
// share the band table but not the JOINT RAMP: `returnTransportExtra` ramps the
// time-of-day and return terms together and then subtracts `timeOfDayExtra`,
// while `returnTransportForecast` does neither. Searched rather than assumed,
// over 24 UTC hours x four layover lengths: they agree everywhere
// `timeOfDayExtra` is 0 — which is why this went unnoticed — and DISAGREE at
// 15:00Z with a 475-minute layover, where the record says 7 and the function its
// sourceRef named says 6.
//
// So the estimate declared, as the origin of its number, a function that neither
// ran nor would have returned that number. The sibling estimate directly above
// it in LayoverFeasibility.ts already follows the right convention
// (`["LayoverSafetyEngine.timeOfDayBand"]`); this one did not.

/** A layover session pinned to an instant, for the §6.2 provenance cases below. */
function returnSession(nowMs: number, layoverMinutes: number): LayoverSession {
  return {
    id: "s", userId: "u", airportId: "a", tripId: null,
    arrivalTime: new Date(nowMs + 5 * 60_000).toISOString(),
    departureTime: new Date(nowMs + layoverMinutes * 60_000).toISOString(),
    boardingTime: null, layoverMinutes, flightType: "international",
    immigrationRequired: true, checkedBags: false, loungeAccess: false, wantsToLeave: true,
    comfortLevel: "moderate", vibeChips: ["food"], manualAirportName: null, manualCity: null,
    manualCountry: null, manualIata: null, canonicalCityId: null, shareCityStatus: false,
    returnReminderAt: null, status: "active",
    createdAt: new Date(nowMs - 60_000).toISOString(),
    updatedAt: new Date(nowMs - 60_000).toISOString(),
  } as unknown as LayoverSession;
}

describe("§6.2 — the return-leg estimate names its real producer", () => {
  it("cites LayoverSafetyEngine.returnTransportExtra, not the uncalled forecast helper", () => {
    const rec = certifySessionFeasibility(
      airportRowToProfile(airportRow({ verified: false })),
      returnSession(Date.UTC(2026, 8, 15, 15, 0, 0), 475),
      { nowMs: Date.UTC(2026, 8, 15, 15, 0, 0) },
    );
    const refs = rec.estimates.returnTransport.sourceRefs;
    assert.ok(
      refs.some((r) => r.includes("returnTransportExtra")),
      `the return-leg estimate does not name its producer; it says ${JSON.stringify(refs)}`,
    );
    assert.ok(
      !refs.some((r) => r.includes("returnTransportForecast")),
      "the estimate still names `returnTransportForecast`, which no production path calls and " +
        "which returns a different number where timeOfDayExtra is non-zero",
    );
  });

  it("and the number it records is the JOINT-RAMP one — the disagreeing configuration, pinned", () => {
    // If someone ever "reconciles" the two by switching the producer to the
    // forecast helper, this fires: 7 is the joint ramp's answer, 6 is the
    // helper's. The case exists so the provenance fix cannot be undone by
    // changing the code to match the old label.
    const at = Date.UTC(2026, 8, 15, 15, 0, 0);
    const rec = certifySessionFeasibility(
      airportRowToProfile(airportRow({ verified: false })),
      returnSession(at, 475),
      { nowMs: at },
    );
    assert.equal(rec.estimates.timeOfDayExtra.valueMinutes, 10, "the configuration that makes the two differ");
    assert.equal(rec.estimates.returnTransport.valueMinutes, 7, "the joint ramp's answer, not the helper's 6");
    assert.equal(
      returnTransportForecast(rec.estimates.trafficExtra.valueMinutes, new Date(rec.deadline.cutoffMs), "Asia/Taipei").extraMinutes,
      6,
      "the helper the old sourceRef named — kept here as the measured contrast, not as a contract",
    );
  });
});
