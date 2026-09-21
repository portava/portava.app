/**
 * §21.1 — the minimum deterministic scenario matrix, as far as the inputs exist.
 *
 * node:test + node:assert. No DB, no network, no clock: every case fixes the
 * instant and the airport timezone, so the time-of-day buffer term and the
 * overnight test are the same on every machine and at every hour.
 *
 * ── WHAT THIS FILE IS, AND WHAT IT IS NOT ────────────────────────────────────
 * The spec names seven scenarios and census-layover scored six of them
 * NOT-BUILT with one line each ("No such scenario in test/airport.test.ts").
 * This is the matrix. It is NOT a claim that the engine agrees with the spec's
 * expected outcomes — it agrees with two of them and diverges on the rest, and
 * each divergence is named at the case that measures it. A scenario matrix
 * whose cases were written to match whatever the engine already returned would
 * be a matrix that can never report anything.
 *
 * THREE OF THE SEVEN CANNOT BE WRITTEN AT ALL, and the reason is a schema fact
 * rather than an omission:
 *   L222 5h SELF-TRANSFER with re-check friction — there is no self-transfer
 *        and no re-check concept. `layover_sessions` carries `checked_bags
 *        BOOLEAN` and nothing else about baggage handling (census L35).
 *   L224 AIRPORT CHANGE — `airport_change_required` has no column, no field and
 *        no type (census L22).
 *   L229 UNKNOWN BAGGAGE, fail closed if critical — `checked_bags` is a
 *        two-valued boolean, so "unknown" is unrepresentable; there is nothing
 *        to fail closed ON.
 * They are asserted as unrepresentable below rather than left out, so the
 * matrix's own incompleteness is something a test run reports instead of
 * something a reader has to go and check.
 *
 * Run: node --import tsx/esm --test src/test/layoverScenarioMatrix.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adviseLeaving, computeWindow } from "../services/airport/LayoverSafetyEngine.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const HOUR = 3_600_000;
/** 10:00 in Asia/Taipei — outside every time-of-day band at the arrival end. */
const NOW = Date.parse("2026-09-13T02:00:00.000Z");

/** §22's L4-ish rung: a curated airport, admin-set buffers, `verified`. */
function curatedAirport(over: Partial<AirportProfile> = {}): AirportProfile {
  return {
    id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
    country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.0777, lng: 121.2328,
    domesticBufferMin: 60, domesticBufferMax: 90,
    internationalBufferMin: 120, internationalBufferMax: 180,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    verified: true,
    ...over,
  };
}

/**
 * §22's L0 Generic rung as a DIFFERENT AIRPORT MODEL — a slower, unverified
 * airport. This is the variation L220 asks for and the one the census recorded
 * as absent from every test ("no airport-model variation in any test").
 */
function genericAirport(): AirportProfile {
  return curatedAirport({
    id: null, iataCode: "XXX", name: "Generic Intl", verified: false,
    internationalBufferMin: 150, trafficExtraMin: 35,
  });
}

function layover(hours: number, over: Partial<LayoverSession> = {}): LayoverSession {
  return {
    id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + hours * HOUR).toISOString(),
    boardingTime: null, layoverMinutes: hours * 60,
    flightType: "domestic", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: [],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

const run = (a: AirportProfile, s: LayoverSession) => {
  const window = computeWindow(a, s, NOW);
  return { window, advice: adviseLeaving(a, s, window) };
};

// ── L219 ─────────────────────────────────────────────────────────────────────

describe("§21.1 L219 — 2h domestic layover", () => {
  /**
   * THE SPEC EXPECTS `airport-only`. THE ENGINE ANSWERS `too_short`, and this
   * case exists to say so rather than to bless it.
   *
   * 120 minutes nose to nose: 15 min to get off and out, an 86-minute return
   * buffer (60 domestic + 20 traffic + 0 time-of-day at midday + 6 for the
   * return-transport forecast, census L72 — 12:00 Sunday is the weekend
   * SHOULDER band and its factor is ×1.3 over the airport's 20) leaves 19
   * usable minutes, and `computeWindow`'s ladder puts anything under 45 in
   * `too_short`. The two tiers are not the same claim — `airport_only` says
   * "enough time to enjoy the terminal, not enough to leave safely" and
   * `too_short` says "stay near your gate" — so the divergence is a real
   * difference in what a traveller is told, not a naming choice.
   */
  it("is refused a city, at the STRICTER tier than the spec names", () => {
    const { window, advice } = run(curatedAirport(), layover(2));
    assert.equal(window.usableMinutes, 19);
    assert.equal(window.breakdown.totalBuffer, 86);
    assert.equal(window.breakdown.returnTransportExtra, 6);
    assert.equal(window.exitDelayMin, 15);
    assert.equal(advice.verdict, "no");
    // The measured answer. `airport_only` is what §21.1 asks for.
    assert.equal(window.tier, "too_short");
    assert.notEqual(window.tier, "airport_only");
  });

  it("with checked bags the same layover has NO window at all, and says by how much", () => {
    const { window } = run(curatedAirport(), layover(2, { checkedBags: true }));
    assert.equal(window.usableMinutes, 0);
    assert.equal(window.freedomWindow, null);
    // 35 min to get out (15 + 20 for bags) against a 19-minute gap between the
    // deadline and the door: 16 minutes short, and the traveller is told so.
    assert.equal(window.shortfallMinutes, 16);
  });

  it("a 3h domestic layover IS the airport-only rung — the ladder is not stuck", () => {
    const { window, advice } = run(curatedAirport(), layover(3));
    assert.equal(window.tier, "airport_only");
    assert.equal(window.usableMinutes, 79);
    assert.equal(advice.verdict, "tight");
  });
});

// ── L220 ─────────────────────────────────────────────────────────────────────

describe("§21.1 L220 — 4h international, landside 'depending on airport model'", () => {
  const intl = { flightType: "international" as const, immigrationRequired: true };

  /**
   * THE AIRPORT MODEL CHANGES THE NUMBERS AT 4h AND NOT THE ANSWER. Both rungs
   * refuse. That is the half of L220 that is NOT satisfied, and it is asserted
   * rather than described: a test that only checked the curated airport would
   * have reported the same "no" and told a reader nothing about the model.
   */
  it("refuses at BOTH airport models at 4h — the verdict does not yet vary", () => {
    const curated = run(curatedAirport(), layover(4, intl));
    const generic = run(genericAirport(), layover(4, intl));
    assert.equal(curated.advice.verdict, "no");
    assert.equal(generic.advice.verdict, "no");
    // The numbers DO vary, which is what makes the next case possible.
    assert.equal(curated.window.usableMinutes, 19);
    assert.equal(generic.window.usableMinutes, 0);
    // The generic airport states a LARGER ground-transport term (35 vs 20), so
    // the same ×1.3 forecast costs it 11 minutes where the curated one loses 6
    // — the model variation L220 asks for, now visible in a second term.
    assert.equal(generic.window.shortfallMinutes, 31);
    assert.equal(curated.window.shortfallMinutes, null);
  });

  /**
   * AT 5h THE MODEL DECIDES, and this is the case the census recorded as
   * absent. Same session, same clock, same flight: a curated airport yields a
   * landside answer and a generic one refuses.
   */
  it("at 5h the SAME session gets different answers at the two airport models", () => {
    const curated = run(curatedAirport(), layover(5, intl));
    const generic = run(genericAirport(), layover(5, intl));
    assert.equal(curated.window.tier, "airport_only");
    assert.equal(curated.advice.verdict, "tight");
    assert.equal(generic.window.tier, "too_short");
    assert.equal(generic.advice.verdict, "no");
    assert.notEqual(curated.advice.verdict, generic.advice.verdict);
  });

  /**
   * THE OTHER HALF OF L220 IS "VISA ALLOWED", AND IT IS UNREPRESENTABLE. No
   * field of a session or an airport carries entry permission (census L34, L48,
   * L230), so the scenario cannot be parameterised on it and the advice cannot
   * turn on it. What the engine does instead is tell the traveller it does not
   * know — which is the honest shape of the gap, and is pinned here so the
   * sentence cannot quietly disappear.
   */
  it("cannot be parameterised on entry permission, and says so to the traveller", () => {
    const { advice } = run(curatedAirport(), layover(5, intl));
    assert.ok(
      advice.unknowns.some((u) => /visa|transit-permit/i.test(u)),
      "entry permission is unread, so it must at least be disclosed",
    );
    assert.ok(advice.reasonCodes.includes("ENTRY_NOT_CONFIRMED"));
    const sessionKeys = Object.keys(layover(5, intl));
    for (const k of sessionKeys) {
      assert.ok(
        !/entry|visa|permit/i.test(k),
        `a session field named ${k} would make this scenario parameterisable — re-score L220`,
      );
    }
  });
});

// ── L221, L223 ───────────────────────────────────────────────────────────────

describe("§21.1 L221 / L223 — the two rungs that do reach landside", () => {
  it("6h international, curated: landside, with the deadline the CONTRACT would have to carry", () => {
    const { window, advice } = run(
      curatedAirport(), layover(6, { flightType: "international", immigrationRequired: true }),
    );
    assert.equal(window.tier, "quick_city");
    assert.equal(advice.verdict, "yes");
    assert.equal(window.usableMinutes, 139);
    // L221 asks for "landside + RETURN CONTRACT". The deadline exists and is
    // certified; the contract (`layover_return_plans`, census L24) does not, so
    // this asserts the half that is built and claims nothing about the other.
    assert.equal(
      window.hardReturnTime.getTime(),
      NOW + 6 * HOUR - window.breakdown.totalBuffer * 60_000,
    );
  });

  it("an overnight layover crosses the local day and is tiered for sleep", () => {
    const { window } = run(curatedAirport(), layover(20));
    assert.equal(window.overnight, true);
    assert.equal(window.tier, "overnight");
  });
});

// ── The three the schema cannot express ──────────────────────────────────────

describe("§21.1 — the scenarios this schema cannot express", () => {
  const s = layover(5, { flightType: "international", immigrationRequired: true });

  it("L222 self-transfer / re-check: no field carries it", () => {
    for (const k of Object.keys(s)) {
      assert.ok(!/self_?transfer|recheck|re_check/i.test(k), `found ${k} — re-score L222`);
    }
  });

  it("L224 airport change: no field carries it", () => {
    for (const k of [...Object.keys(s), ...Object.keys(curatedAirport())]) {
      assert.ok(!/airport_?change/i.test(k), `found ${k} — re-score L224`);
    }
  });

  it("L229 unknown baggage: `checkedBags` is two-valued, so there is nothing to fail closed on", () => {
    assert.equal(typeof s.checkedBags, "boolean");
    const withBags = run(curatedAirport(), layover(5, { flightType: "international", immigrationRequired: true, checkedBags: true }));
    const without = run(curatedAirport(), s);
    // Both are DECIDED answers. Neither can be "we do not know whether you have
    // bags", which is what §21.1's fail-closed case needs as an input.
    assert.ok(["yes", "tight", "no", "stay_airside"].includes(withBags.advice.verdict));
    assert.ok(["yes", "tight", "no", "stay_airside"].includes(without.advice.verdict));
    assert.notEqual(withBags.window.breakdown.bagsExtra, without.window.breakdown.bagsExtra);
  });
});
