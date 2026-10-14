/**
 * census-layover §75 — ONE definition of usable time: the certified record's envelope.
 *
 * Verifier V-717 (finding F-A) measured two definitions of "usable minutes" for one layover:
 *   - `assess` rated a card against the deadline minus NOW;
 *   - the certified record (`computeWindow`) certifies the deadline minus the LATER of now and the
 *     earliest instant the traveller can be landside (arrival + immigration/bags exit).
 * Three hours before arrival those were 463 and 218 minutes, so a 230-minute out-and-back was rated
 * `safe` while the record the card cites forbids it. Spec §6 names the record's chain (scheduled
 * connection − deplane − immigration − baggage − exit friction − … = usable experience time) and
 * calls that service "the safety authority"; §2.1 forbids duplicate time-budget logic. So `assess`
 * now rates against the record it is handed, and certifies NOTHING without one.
 *
 * The same pre-arrival error had two siblings, swept and fixed here:
 *   - the AIRSIDE branch compared a dwell with the deadline minus now, so a 60-minute sleep pod was
 *     "safe" on a 60-minute connection booked three hours ahead. That one is reachable TODAY (airside
 *     dwells are stated); the producer case below drives it.
 *   - Compass, with no snapshot (the production path: `layover_snapshot_consumers_enabled` is absent
 *     from the production flag snapshot, so OFF), told the traveller "about N minutes of usable time"
 *     with N = deadline − now − buffer.
 *
 * Nothing here writes "measured" (the provenance tripwire in layoverTravelTimeProvenance.test.ts):
 * stated legs are `traveller_stated` or carry no source at all.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/layoverUsableTimeOneDefinition.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { generateRecommendations } from "../services/airport/LayoverRecommendationService.js";
import { certifySessionFeasibility, type LandsideProbe, type LayoverFeasibilityRecord } from "../services/airport/LayoverFeasibility.js";
import * as Engine from "../services/airport/LayoverSafetyEngine.js";
import { answerLayoverQuestion } from "../services/airport/LayoverCompassService.js";
import { checkRecommendationContract } from "../services/airport/layoverContractMonitor.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";
import type { EntryEligibility } from "../services/airport/layoverEntryGate.js";

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

/** 10:00 in Asia/Taipei — a fixed instant, so the time-of-day terms are the same on every machine. */
const NOW = Date.parse("2026-09-13T02:00:00.000Z");
const MIN = 60_000;

const PERMITTED: EntryEligibility = {
  state: "permitted", corridor: { passportCountry: "US", destinationCountry: "TW" }, status: "visa_free",
} as EntryEligibility;

/** A session that lands `arriveInMin` from NOW and leaves `layoverMin` after landing. */
function session(arriveInMin: number, layoverMin: number, over: Partial<LayoverSession> = {}): LayoverSession {
  const arrival = NOW + arriveInMin * MIN;
  return {
    id: "session-usable", userId: "user-1", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(arrival).toISOString(),
    departureTime: new Date(arrival + layoverMin * MIN).toISOString(),
    boardingTime: null, layoverMinutes: layoverMin,
    flightType: "international", immigrationRequired: true, checkedBags: true,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

const certify = (s: LayoverSession, nowMs = NOW, probe: LandsideProbe | null = null): LayoverFeasibilityRecord =>
  certifySessionFeasibility(AIRPORT, s, { nowMs, entry: PERMITTED, landsideProbe: probe });

/**
 * The OLD arithmetic, written out ONLY as a witness of what `main` rated against: the deadline
 * minus NOW, less the buffer, charging nothing for the time before the traveller is landside.
 */
const clockUsable = (rec: LayoverFeasibilityRecord, nowMs = NOW) =>
  Math.max(0, Math.round((rec.deadline.cutoffMs - nowMs) / MIN) - rec.deadline.breakdown.totalBuffer);

const certifies = (r: Engine.SafetyRating) => r === "safe" || r === "possible_but_risky";

/** A landside card a traveller STATED both terms of; verified, so only the window decides. */
const stated = (travelTimeMin: number, activityTimeMin: number) =>
  ({ title: `out ${travelTimeMin}+${activityTimeMin}`, travelTimeMin, activityTimeMin, insideAirport: false, verified: true });

// ═══════════════════════════════════════════════════════════════════════════
// F-A — before arrival, the card and the record must read the SAME window
// ═══════════════════════════════════════════════════════════════════════════

describe("F-A — a pre-arrival session is rated against the record's usable minutes, not the clock's", () => {
  const s = session(180, 480); // lands in 3 h, 8 h connection, immigration + checked bags

  it("PRECONDITION: three hours before arrival the clock overstates the record by at least those three hours", () => {
    const rec = certify(s);
    assert.ok(rec.envelope.usableMinutes > 90, `fixture drifted: record usable ${rec.envelope.usableMinutes}`);
    assert.ok(clockUsable(rec) - rec.envelope.usableMinutes >= 180,
      `clock ${clockUsable(rec)} vs record ${rec.envelope.usableMinutes}: the two definitions must differ by the pre-landside time`);
  });

  it("the record's OWN landside rating never certifies an out-and-back its own envelope forbids", () => {
    const usable = certify(s).envelope.usableMinutes;
    // 30 min each way (no unverified-distance caution applies) and a dwell that overruns the
    // record by 20 minutes, while leaving the clock's figure 20+ minutes of slack: main said `safe`.
    const dwell = usable + 20 - 60;
    const rec = certify(s, NOW, { title: "probe", travelTimeMin: 30, activityTimeMin: dwell, travelTimeSource: "traveller_stated" });
    assert.ok(clockUsable(rec) - (60 + dwell) >= 20, "precondition: the clock's arithmetic would have certified this card");
    assert.ok(rec.landside, "the probe was rated");
    assert.notEqual(rec.landside.rating, "safe", `rated safe: ${60 + dwell} min out-and-back against ${rec.envelope.usableMinutes} certified`);
    assert.equal(rec.landside.rating, "not_recommended");
    assert.equal(rec.landside.usableMinutes, rec.envelope.usableMinutes, "one record, one usable figure");
    assert.equal(rec.landside.warningReason, `You'd need ${60 + dwell} min but only have ${rec.envelope.usableMinutes} min usable.`);
  });

  it("rankActivities — the recommendation service's call — rates against the record it is handed", () => {
    const rec = certify(s);
    const [ranked] = Engine.rankActivities(AIRPORT, s, [stated(30, rec.envelope.usableMinutes + 20 - 60)], NOW, rec);
    assert.ok(ranked);
    assert.equal(ranked.assessment.rating, "not_recommended", `rated ${ranked.assessment.rating}`);
    assert.equal(ranked.assessment.usableMinutes, rec.envelope.usableMinutes);
    // The deadline and buffer are still the record's — the reuse #717's monitor pins is unchanged.
    assert.equal(ranked.assessment.hardReturnTime.getTime(), rec.deadline.hardReturnTime.getTime());
    assert.equal(ranked.assessment.returnBufferMin, rec.deadline.breakdown.totalBuffer);
  });

  it("a card that FITS the record is still certified — the fix refuses what overruns, not everything", () => {
    const rec = certify(s);
    const [ranked] = Engine.rankActivities(AIRPORT, s, [stated(20, rec.envelope.usableMinutes - 40 - 30)], NOW, rec);
    assert.ok(ranked);
    assert.equal(ranked.assessment.rating, "safe", `${ranked.assessment.rating}: ${ranked.assessment.warningReason}`);
  });
});

describe("SWEEP — no card certifies more than the record's usable minutes, before or after landing (L216's EXCEEDS_CERTIFIED_WINDOW)", () => {
  const ARRIVALS = [-240, -90, -46, -20, 0, 30, 65, 120, 180, 300];
  const LAYOVERS = [180, 360, 540];
  const FLIGHTS: Array<Partial<LayoverSession>> = [
    { flightType: "domestic", immigrationRequired: false, checkedBags: false },
    { flightType: "international", immigrationRequired: true, checkedBags: true },
  ];
  const LEGS = [5, 15, 30];
  const DWELLS = [30, 60, 120, 240];

  it("through the record's own probe AND through rankActivities, at every instant", () => {
    let certified = 0;
    let oldWouldHaveExceeded = 0;
    for (const arrive of ARRIVALS) for (const layover of LAYOVERS) for (const flight of FLIGHTS) {
      const s = session(arrive, layover, flight);
      const rec = certify(s);
      const usable = rec.envelope.usableMinutes;
      const ranked = Engine.rankActivities(AIRPORT, s, LEGS.flatMap((l) => DWELLS.map((d) => stated(l, d))), NOW, rec);
      for (const r of ranked) {
        const outAndBack = 2 * r.travelTimeMin + r.activityTimeMin;
        if (certifies(r.assessment.rating)) {
          certified++;
          assert.ok(outAndBack <= usable,
            `arrive ${arrive}, ${layover} min, ${flight.flightType}: "${r.title}" rated ${r.assessment.rating} for ${outAndBack} min against ${usable} certified`);
        }
        if (outAndBack > usable && clockUsable(rec) - outAndBack >= 20) oldWouldHaveExceeded++;
        assert.equal(r.assessment.usableMinutes, usable);
      }
      for (const l of LEGS) for (const d of DWELLS) {
        const probed = certify(s, NOW, { title: "p", travelTimeMin: l, activityTimeMin: d, travelTimeSource: "traveller_stated" });
        if (probed.landside && certifies(probed.landside.rating)) {
          assert.ok(2 * l + d <= probed.envelope.usableMinutes,
            `arrive ${arrive}: the record's probe certified ${2 * l + d} min against its own ${probed.envelope.usableMinutes}`);
        }
      }
    }
    assert.ok(certified > 20, `positive control: only ${certified} cards certified — the sweep would prove nothing`);
    assert.ok(oldWouldHaveExceeded > 20, `positive control: the old arithmetic exceeded the record only ${oldWouldHaveExceeded} times`);
  });

  it("L216's own monitor reads ZERO violations on the engine's ratings — the generator no longer trips its own metric", () => {
    // The verifier's characterisation, swept: rate with the record, check with the record. On main a
    // pre-arrival session put EXCEEDS_CERTIFIED_WINDOW on the engine's own `safe` card.
    let checked = 0;
    let certifiedCards = 0;
    for (const arrive of ARRIVALS) for (const layover of LAYOVERS) for (const flight of FLIGHTS) {
      const s = session(arrive, layover, flight);
      const rec = certify(s);
      const ranked = Engine.rankActivities(AIRPORT, s, [
        ...LEGS.flatMap((l) => DWELLS.map((d) => stated(l, d))),
        { title: "pod", travelTimeMin: 0, activityTimeMin: 60, insideAirport: true },
      ], NOW, rec);
      const rows = ranked.map((r) => ({
        safety_rating: r.assessment.rating, travel_time_min: r.travelTimeMin, activity_time_min: r.activityTimeMin,
        return_buffer_min: r.assessment.returnBufferMin, hard_return_time: r.assessment.hardReturnTime.toISOString(),
        inside_airport: r.insideAirport,
      }));
      const result = checkRecommendationContract({
        sessionId: s.id, record: rec, rows, keys: rows.map((_, i) => `k${i}`), bands: new Map(), stampSnapshotId: null,
      });
      checked += result.checked;
      certifiedCards += rows.filter((r) => !r.inside_airport && certifies(r.safety_rating)).length;
      // A closed gate is the one check this synthetic list may trip: it ranks landside cards the
      // generator's §9.1 gate would never have fetched. Every other check must read zero.
      const { LANDSIDE_PAST_CLOSED_GATE: _closedGate, ...rest } = result.byCheck;
      assert.deepEqual(rest, {}, `arrive ${arrive}, ${layover} min, ${flight.flightType}: ${JSON.stringify(result.byCheck)}`);
      assert.equal(result.byCheck.EXCEEDS_CERTIFIED_WINDOW ?? 0, 0, `arrive ${arrive}, ${layover} min: the engine's own rating exceeded its record`);
    }
    assert.ok(checked > 500 && certifiedCards > 20, `positive control: ${checked} rows checked, ${certifiedCards} landside cards certified`);
  });

  it("once the traveller can be landside, the two definitions COINCIDE — nobody already out loses a card", () => {
    let compared = 0;
    for (const flight of FLIGHTS) for (const layover of LAYOVERS) {
      // Landed 2 h ago: past every exit delay (at most 65 min), and before the hard return.
      const rec = certify(session(-120, layover, flight));
      if (rec.envelope.usableMinutes <= 0) continue;
      assert.equal(rec.envelope.usableMinutes, clockUsable(rec), `${flight.flightType} ${layover}`);
      compared++;
    }
    assert.ok(compared >= 3, `positive control: compared ${compared}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AIRSIDE — the layover itself, not the hours before landing (reachable today)
// ═══════════════════════════════════════════════════════════════════════════

describe("airside — a dwell is rated against the layover's own span, clipped to now", () => {
  // A 60-minute domestic connection, booked three hours before landing.
  const short = () => session(180, 60, { flightType: "domestic", immigrationRequired: false, checkedBags: false });

  it("THE PRODUCER: a 60-minute sleep pod on a 60-minute connection is not `safe`, however early the traveller asks", async () => {
    const r = await generateRecommendations(makeLayoverDb({
      discovery_places: [], layover_recommendations: [], layover_plan_stops: [], layover_events: [],
    }), AIRPORT, short(), NOW);
    if (!r.ok) assert.fail(r.message);
    const airside = r.recommendations.filter((c: any) => c.insideAirport);
    assert.ok(airside.length >= 3, `positive control: ${airside.length} airside cards`);
    const pod = airside.find((c: any) => c.activityTimeMin === 60);
    assert.ok(pod, "positive control: the 60-minute rest card");
    assert.notEqual(pod.safetyRating, "safe", "a 60-minute dwell on a 60-minute connection was rated safe");
    for (const c of airside) {
      if (c.safetyRating === "safe") assert.ok((c.activityTimeMin ?? Number.POSITIVE_INFINITY) + 15 <= 60, `"${c.title}" (${c.activityTimeMin} min) rated safe on a 60-minute connection`);
    }
    // ...and a dwell the connection does hold is still offered as safe.
    assert.ok(airside.some((c: any) => c.safetyRating === "safe"), "every airside card was downgraded");
  });

  it("CONTROL: at touchdown the rating is the one the clock always gave", () => {
    const pod = { title: "pod", travelTimeMin: 0, activityTimeMin: 60, insideAirport: true };
    const early = short();
    const atTouchdown = session(0, 60, { flightType: "domestic", immigrationRequired: false, checkedBags: false });
    const a = Engine.assess(AIRPORT, early, pod, NOW, certify(early));
    const b = Engine.assess(AIRPORT, atTouchdown, pod, NOW, certify(atTouchdown));
    assert.equal(a.rating, "possible_but_risky");
    assert.equal(b.rating, a.rating, "three hours early and at touchdown are the same 60-minute layover");
    const lounge = Engine.assess(AIRPORT, early, { ...pod, activityTimeMin: 30 }, NOW, certify(early));
    assert.equal(lounge.rating, "safe");
  });

  it("late in the layover the CLOCK still clips the span: 10 minutes left is not the 60 the connection had", () => {
    const late = session(-50, 60, { flightType: "domestic", immigrationRequired: false, checkedBags: false });
    const lounge = Engine.assess(AIRPORT, late, { title: "lounge", travelTimeMin: 0, activityTimeMin: 30, insideAirport: true }, NOW, certify(late));
    assert.equal(lounge.rating, "possible_but_risky", "a 30-minute dwell with 10 minutes to the cutoff");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FAIL CLOSED — no record, an unreadable one, or another instant's: nothing certified
// ═══════════════════════════════════════════════════════════════════════════

describe("fail closed — without a readable record for THIS instant, nothing is certified", () => {
  const s = session(-120, 540); // landed two hours ago, seven hours left: every card fits
  const fits = stated(15, 60);
  const lounge = { title: "lounge", travelTimeMin: 0, activityTimeMin: 30, insideAirport: true };

  it("PRECONDITION: with the record both cards are safe", () => {
    const rec = certify(s);
    assert.equal(Engine.assess(AIRPORT, s, fits, NOW, rec).rating, "safe");
    assert.equal(Engine.assess(AIRPORT, s, lounge, NOW, rec).rating, "safe");
  });

  it("no record: assess certifies nothing — landside or airside — and says why", () => {
    for (const c of [fits, lounge]) {
      const a = Engine.assess(AIRPORT, s, c, NOW);
      assert.equal(a.rating, "not_recommended", `"${c.title}" rated ${a.rating} with no certified record`);
      assert.equal(a.warningReason, (Engine as any).UNCERTIFIED_WINDOW_WARNING);
      assert.equal(a.usableMinutes, 0, "no record, no certified usable minute");
    }
    assert.equal(typeof (Engine as any).UNCERTIFIED_WINDOW_WARNING, "string");
  });

  it("no record: rankActivities has no fallback derivation to certify with", () => {
    for (const r of Engine.rankActivities(AIRPORT, s, [fits, lounge], NOW)) {
      assert.ok(!certifies(r.assessment.rating), `"${r.title}" rated ${r.assessment.rating}`);
    }
  });

  it("a record certified at ANOTHER instant — earlier or later — is not this instant's record", () => {
    for (const other of [certify(s, NOW - 2 * 3_600_000), certify(s, NOW + 2 * 3_600_000), certify(s, NOW + 1)]) {
      assert.equal(Engine.assess(AIRPORT, s, fits, NOW, other).rating, "not_recommended", `record at ${other.computedAt}`);
      assert.equal(Engine.assess(AIRPORT, s, lounge, NOW, other).rating, "not_recommended", `record at ${other.computedAt}`);
    }
  });

  it("an unreadable record — no deadline, a non-finite cutoff, usable or total — certifies nothing", () => {
    const rec = certify(s);
    const broken: unknown[] = [
      { ...rec, envelope: { ...rec.envelope, usableMinutes: Number.NaN } },
      { ...rec, envelope: { ...rec.envelope, usableMinutes: Number.POSITIVE_INFINITY } },
      { ...rec, envelope: { ...rec.envelope, totalMinutes: Number.NaN } },
      { ...rec, envelope: { ...rec.envelope, usableMinutes: -5 } },
      { ...rec, deadline: undefined }, { ...rec, deadline: { ...rec.deadline, cutoffMs: Number.NaN } }, { ...rec, deadline: { ...rec.deadline, cutoffMs: undefined } }, // a non-finite cutoff: airside min(NaN, total) once rated every card safe
      { ...rec, envelope: undefined },
      { ...rec, inputs: undefined },
    ];
    for (const b of broken) {
      for (const c of [fits, lounge]) {
        const a = Engine.assess(AIRPORT, s, c, NOW, b as never);
        assert.equal(a.rating, "not_recommended", `"${c.title}" certified on ${JSON.stringify(b, (k, v) => (k === "inputs" || k === "estimates" || k === "freedomWindow" ? undefined : v)).slice(0, 160)}`);
      }
    }
  });

  it("L293 still holds WITH a record: an unstated leg is never certified, and says so", () => {
    const a = Engine.assess(AIRPORT, s, { title: "x", travelTimeMin: null, activityTimeMin: 60, insideAirport: false, verified: true }, NOW, certify(s));
    assert.equal(a.rating, "not_recommended");
    assert.equal(a.warningReason, Engine.UNMEASURED_TRAVEL_WARNING);
  });

  it("a traveller staying airside is still answered airport_only when the record is readable", () => {
    const stay = session(-120, 540, { wantsToLeave: false });
    assert.equal(Engine.assess(AIRPORT, stay, fits, NOW, certify(stay)).rating, "airport_only");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPASS — with no snapshot, the figure it speaks is the record's
// ═══════════════════════════════════════════════════════════════════════════

describe("Compass with no snapshot speaks the record's usable minutes", () => {
  it("three hours before landing, 'about N minutes of usable time' is the record's N, not the clock's", async () => {
    const s = session(180, 600, { flightType: "international", immigrationRequired: true, checkedBags: false });
    const rec = certify(s);
    assert.equal(rec.verdict, "yes", `precondition: an explicit yes (got ${rec.verdict})`);
    assert.notEqual(clockUsable(rec), rec.envelope.usableMinutes, "precondition: the two figures differ");
    const answer = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: s, airport: AIRPORT, entry: PERMITTED, nowMs: NOW });
    assert.match(answer.answer, new RegExp(`about ${rec.envelope.usableMinutes} minutes of usable time`));
    assert.doesNotMatch(answer.answer, new RegExp(`about ${clockUsable(rec)} minutes of usable time`));
  });
});
