/**
 * §11.1 step 5 — the action universe stops charging an unmeasured leg zero.
 *
 * ── THE THIRD PLACE, NAMED BY §16.8 AND LEFT THERE ───────────────────────────
 * Census §16.8 item 4, verbatim: *"`ReplanCandidate` / `candidatesFromStops`
 * still reads `Number(s.travelMin ?? 0)`. Opened and left: it consumes
 * `layover_plan_stops`, whose write boundary L47 already closed, so no unstated
 * landside leg can reach it on a row written after `eb70ab3b2`. Legacy rows
 * can. It is the same laundering in a third place."*
 *
 * `candidateFits` is §6.1's invariant evaluated per candidate —
 * `round + activity <= usableMinutes`, where `round` is the outbound leg
 * doubled. Handed a landside stop whose leg nobody stated, it charged 0 for the
 * journey out AND 0 for the journey back and reported the stop as FITTING the
 * certified window. That answer then reaches a traveller: `feasibleCandidateIds`
 * is what `candidatesGained` / `candidatesLost` are diffed from, and those are
 * rendered by `LayoverFlightChangeCard` after a flight-time edit.
 *
 * L47's `C` rests on the write boundary holding for every row that reaches this
 * code. That is an argument about which rows exist, not about what the code
 * does, and this file closes the gap by making the code refuse the value rather
 * than by trusting the table.
 *
 * ── WHAT THIS PINS ───────────────────────────────────────────────────────────
 * 1. A LANDSIDE zero is an ABSENCE and cannot be certified as fitting.
 * 2. An AIRSIDE zero is a FACT and is unchanged — the negative control, and the
 *    one that would fail if the fix were "treat every zero as unknown".
 * 3. The exclusion is NAMED (`unmeasuredCandidateIds`), not silently folded
 *    into "does not fit": a plan nobody measured and a plan that overflows are
 *    different answers, which is L47's own three-valued rule.
 * 4. A STATED leg still decides on arithmetic, in both directions.
 *
 * FALSE GREENS CONSIDERED. Every case asserts `feasibleCandidateIds` as an
 * exact array rather than a membership, so a fix that dropped every candidate
 * would fail case 2. The unmeasured cases are paired with stated ones over the
 * same window, so a `candidateFits` hard-wired to `false` fails case 4.
 *
 * Run: node --import tsx/esm --test src/test/layoverReplanCandidateLegs.test.ts
 *
 * ── MUTATION LOG ─────────────────────────────────────────────────────────────
 * Recorded in §17.4 of docs/architecture/census-layover.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  actionUniverseOf,
  candidateFits,
  type ReplanCandidate,
} from "../services/airport/LayoverEventReplanner.js";
import { candidatesFromStops } from "../services/airport/LayoverReplanService.js";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import { airportRowToProfile } from "../services/airport/AirportProfileService.js";
import { airportRow } from "./helpers/fakeLayoverDb.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const AIRPORT = airportRowToProfile(airportRow());

function session(): LayoverSession {
  const now = Date.now();
  return {
    id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(now + 5 * 60_000).toISOString(),
    departureTime: new Date(now + 12 * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: 715,
    flightType: "international", immigrationRequired: true, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: [],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null,
    status: "active",
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
  } as LayoverSession;
}

const record = () => certifySessionFeasibility(AIRPORT, session(), { nowMs: Date.now() });

/** A `layover_plan_stops` row as `loadStops` hands it to the replanner. */
function stop(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "stop-1", durationMin: 30, travelMin: 20, insideAirport: false, ...over };
}

describe("candidatesFromStops — a stored zero is not automatically a journey", () => {
  it("a LANDSIDE stop with travelMin 0 carries no travel time at all", () => {
    const [c] = candidatesFromStops([stop({ travelMin: 0 })]);
    assert.equal(c!.travelTimeMin, null, "a landside zero was read back as a zero-minute journey");
  });

  it("an AIRSIDE stop with travelMin 0 carries a real zero — it is a fact", () => {
    const [c] = candidatesFromStops([stop({ id: "lounge", travelMin: 0, insideAirport: true })]);
    assert.equal(c!.travelTimeMin, 0);
    assert.equal(c!.insideAirport, true);
  });

  it("a stop with no duration carries no duration, rather than zero minutes", () => {
    const [c] = candidatesFromStops([stop({ durationMin: 0 })]);
    assert.equal(c!.activityTimeMin, null);
  });

  it("a stated leg survives unchanged", () => {
    const [c] = candidatesFromStops([stop({ travelMin: 45, durationMin: 90 })]);
    assert.equal(c!.travelTimeMin, 45);
    assert.equal(c!.activityTimeMin, 90);
  });
});

describe("candidateFits — a lower bound can refuse, never certify (§6.1)", () => {
  it("an unmeasured landside leg is NOT reported as fitting", () => {
    const r = record();
    const c: ReplanCandidate = { id: "market", travelTimeMin: null, activityTimeMin: 60, insideAirport: false };
    assert.equal(
      candidateFits(r, c), false,
      "a stop whose journey nobody measured was certified as fitting the window",
    );
  });

  it("an unmeasured DWELL is not reported as fitting either", () => {
    const r = record();
    const c: ReplanCandidate = { id: "market", travelTimeMin: 10, activityTimeMin: null, insideAirport: false };
    assert.equal(candidateFits(r, c), false);
  });

  it("an airside stop with a 0 leg still fits on arithmetic — the negative control", () => {
    const r = record();
    const c: ReplanCandidate = { id: "lounge", travelTimeMin: 0, activityTimeMin: 60, insideAirport: true };
    assert.equal(candidateFits(r, c), true);
  });

  it("a stated landside leg still decides on arithmetic, both ways", () => {
    const r = record();
    const usable = r.envelope.usableMinutes;
    assert.ok(usable > 80, `fixture window too small to test both directions: ${usable}`);
    const fits: ReplanCandidate = { id: "near", travelTimeMin: 10, activityTimeMin: 30, insideAirport: false };
    const over: ReplanCandidate = { id: "far", travelTimeMin: usable, activityTimeMin: 30, insideAirport: false };
    assert.equal(candidateFits(r, fits), true);
    assert.equal(candidateFits(r, over), false);
  });
});

describe("actionUniverseOf — unmeasured is NAMED, not folded into 'does not fit'", () => {
  it("the three outcomes are three lists", () => {
    const r = record();
    const universe = actionUniverseOf(r, [
      { id: "lounge", travelTimeMin: 0, activityTimeMin: 60, insideAirport: true },
      { id: "near", travelTimeMin: 10, activityTimeMin: 30, insideAirport: false },
      { id: "unmeasured", travelTimeMin: null, activityTimeMin: 30, insideAirport: false },
      { id: "over", travelTimeMin: r.envelope.usableMinutes, activityTimeMin: 30, insideAirport: false },
    ]);
    assert.deepEqual(universe.feasibleCandidateIds, ["lounge", "near"]);
    assert.deepEqual(
      universe.unmeasuredCandidateIds, ["unmeasured"],
      "an unmeasured stop is indistinguishable from one that overflows",
    );
  });
});
