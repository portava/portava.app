/**
 * Layover §12 / §12.1: the Compass boundary, the twelve deterministic tools,
 * and the value-of-information rule.
 *
 * node:test + node:assert/strict. Pure functions over a certified feasibility
 * record. The verdict is the EXIT CODE.
 *
 * ── WHY THIS FILE IS NAMED FOR PRIVACY ──────────────────────────────────────
 * The §12 boundary is a disclosure boundary: it is the rule that stops a
 * language model publishing a return deadline the certified record does not
 * support. It sits beside the coordinate scrub in `LayoverPrivacyGuard` for the
 * same reason — both are "what may leave the server on top of the certified
 * numbers".
 *
 * ── THE CENSUS FINDINGS THIS PINS ───────────────────────────────────────────
 * L101 (W): "the only enforcement is prompt text plus a coordinate regex."
 *   Prompt text is a request. `enforceCompassEnvelope` reads the answer the
 *   model actually produced.
 * L102-L113 (N): "No layover tool exists." Twelve now do, each a pure read of
 *   the certified record — the widening the boundary forbids is unexpressible.
 * L114 (N): "Compass asks nothing." It asks at most one question, and only when
 *   re-certifying with the answer flipped moves the verdict, the risk band or
 *   the window.
 *
 * ── TRAPS AVOIDED ───────────────────────────────────────────────────────────
 * A boundary that flags EVERY answer would pass any test that only checks a
 * violating answer is caught, so every violation case is paired with an
 * innocent answer containing the same digits — including the departure time,
 * which is legitimately LATER than the hard return on every layover. A VOI
 * function that returns a question for everything would pass any test that only
 * checks a decisive field, so the never-ask case is asserted too.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverPrivacyCompassContract.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import { formatLocalTime } from "../services/airport/AirportTime.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import {
  answerLayoverQuestion,
  enforceCompassEnvelope,
  valueOfInformation,
  nextClarifyingQuestion,
  runLayoverTool,
  LAYOVER_TOOL_NAMES,
  LAYOVER_TOOL_SCHEMAS,
  CLARIFIABLE_FIELDS,
  UNREPRESENTABLE_CLARIFICATIONS,
  type LayoverToolContext,
} from "../services/airport/LayoverCompassService.js";

const NOW = Date.UTC(2026, 8, 8, 2, 0, 0); // 10:00 in Asia/Taipei

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taiwan Taoyuan International Airport",
  city: "Taoyuan", country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei",
  lat: 25.0797, lng: 121.2342,
  domesticBufferMin: 60, domesticBufferMax: 90,
  internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
  verified: false, terminalInfo: null,
};

function session(over: Partial<LayoverSession> = {}): LayoverSession {
  return {
    id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + 8 * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: 480,
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: [],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

const SESSION = session();
const RECORD = certifySessionFeasibility(AIRPORT, SESSION, { nowMs: NOW });
const HARD_LOCAL = formatLocalTime(AIRPORT.timezone, RECORD.deadline.hardReturnTime);
const USABLE = RECORD.envelope.usableMinutes;

const CTX: LayoverToolContext = {
  session: SESSION, airport: AIRPORT, record: RECORD,
  recommendations: [{ id: "rec-1", title: "Night market" }],
  stops: [{ title: "Night market", durationMin: 60, travelMin: 25, insideAirport: false }],
};

function bounded(answer: string) {
  return enforceCompassEnvelope(answer, {
    airport: AIRPORT, hardReturnTime: RECORD.deadline.hardReturnTime, usableMinutes: USABLE,
  });
}

/** A clock string `n` minutes after the certified hard return, airport-local. */
function localPlus(minutes: number): string {
  return formatLocalTime(AIRPORT.timezone, new Date(RECORD.deadline.hardReturnTime.getTime() + minutes * 60_000));
}

// ─────────────────────────────────────────────────────────────────────────────

describe("§12 the model may not widen the certified return deadline", () => {
  it("control: the setup really is a same-day, comparable deadline", () => {
    assert.ok(/^\d{2}:\d{2}$/.test(HARD_LOCAL), `unexpected local format: ${HARD_LOCAL}`);
    const mins = Number(HARD_LOCAL.slice(0, 2)) * 60 + Number(HARD_LOCAL.slice(3));
    assert.ok(mins >= 4 * 60, "the fixture must not straddle the midnight-wrap exemption");
  });

  it("POSITIVE CONTROL: an answer stating the certified time passes", () => {
    const r = bounded(`Sure — just make sure you are back at security by ${HARD_LOCAL}.`);
    assert.equal(r.ok, true, `violations: ${JSON.stringify(r.violations)}`);
    assert.deepEqual(r.violations, []);
  });

  it("an answer stating a LATER return time is refused", () => {
    const later = localPlus(90);
    const r = bounded(`You have plenty of time — head back by ${later} and you will be fine.`);
    assert.equal(r.ok, false, `a return time of ${later} exceeds the certified ${HARD_LOCAL}`);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].kind, "return_deadline_widened");
    assert.equal(r.violations[0].certified, HARD_LOCAL);
  });

  it("an EARLIER return time is not a violation — being conservative is allowed", () => {
    const r = bounded(`To be safe, be back by ${localPlus(-45)}.`);
    assert.equal(r.ok, true, `violations: ${JSON.stringify(r.violations)}`);
  });

  it("the DEPARTURE time, which is legitimately later, is not flagged", () => {
    // This is the false positive that would make the guard unusable: on every
    // layover, the flight leaves after the hard return.
    const departureLocal = formatLocalTime(AIRPORT.timezone, new Date(SESSION.departureTime));
    const r = bounded(`Your flight departs at ${departureLocal}; be back at security by ${HARD_LOCAL}.`);
    assert.equal(r.ok, true, `violations: ${JSON.stringify(r.violations)}`);
    assert.ok(
      departureLocal > HARD_LOCAL,
      `control: the departure ${departureLocal} must really be later than ${HARD_LOCAL}`,
    );
  });

  it("a deadline that wraps past local midnight is not compared at all", () => {
    // Minute-of-day ordering is meaningless across the wrap, and refusing an
    // honest answer on an overnight layover is the costlier error.
    const early = new Date(Date.UTC(2026, 8, 8, 18, 30)); // 02:30 Asia/Taipei
    const r = enforceCompassEnvelope("Be back by 23:50.", {
      airport: AIRPORT, hardReturnTime: early, usableMinutes: 999,
    });
    assert.equal(formatLocalTime(AIRPORT.timezone, early).slice(0, 2), "02");
    assert.equal(r.violations.filter((v) => v.kind === "return_deadline_widened").length, 0);
  });
});

describe("§12 the model may not widen the usable window", () => {
  it("POSITIVE CONTROL: the certified figure passes", () => {
    const r = bounded(`You have ${USABLE} usable minutes.`);
    assert.equal(r.ok, true, `violations: ${JSON.stringify(r.violations)}`);
  });

  it("a larger USABLE figure is refused", () => {
    const r = bounded(`You have ${USABLE + 120} minutes of usable time — go for it.`);
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].kind, "usable_time_widened");
    assert.equal(r.violations[0].certified, `${USABLE} minutes usable`);
  });

  it("the AVAILABLE window, which is larger by the buffer, is not flagged", () => {
    const avail = Math.round((RECORD.deadline.cutoffMs - NOW) / 60_000);
    assert.ok(avail > USABLE, "control: available really is larger than usable");
    const r = bounded(`You have about ${avail} minutes until boarding.`);
    assert.equal(r.ok, true, `violations: ${JSON.stringify(r.violations)}`);
  });

  it("catches the server's OWN fallback wording: 'N usable minutes'", () => {
    // FALSE GREEN CAUGHT IN THIS LANE. The first version of the guard matched
    // "N minutes ... usable" and "usable ... N minutes" but NOT "N usable
    // minutes" — which is exactly how `deterministicAnswer` phrases it. A
    // boundary blind to the server's own sentence shape is not a boundary.
    const over = bounded(`Your buffer leaves ${USABLE + 200} usable minutes.`);
    assert.equal(over.ok, false);
    assert.equal(over.violations[0].kind, "usable_time_widened");
    const exact = bounded(`Your buffer leaves ${USABLE} usable minutes.`);
    assert.equal(exact.ok, true, `control: the certified figure in the same phrasing must pass`);
  });

  it("both violations can be reported at once", () => {
    const r = bounded(`Head back by ${localPlus(60)} — that is ${USABLE + 300} usable minutes.`);
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations.map((v) => v.kind).sort(), ["return_deadline_widened", "usable_time_widened"]);
  });
});

describe("§12 the twelve deterministic tools", () => {
  it("every tool the spec names exists, and no others", () => {
    assert.deepEqual([...LAYOVER_TOOL_NAMES], [
      "getLayoverContext", "getConnectionState", "getTimeWallet", "getSafeEnvelope",
      "getReachableExperiences", "simulatePlan", "getReturnContract", "getAirportState",
      "getCrewCandidates", "requestConstraintClarification", "replan", "explainDecision",
    ]);
    assert.equal(LAYOVER_TOOL_SCHEMAS.length, 12);
    assert.deepEqual(LAYOVER_TOOL_SCHEMAS.map((t) => t.function.name), [...LAYOVER_TOOL_NAMES]);
  });

  it("every tool answers, and the two with no data source say UNAVAILABLE by name", () => {
    for (const name of LAYOVER_TOOL_NAMES) {
      const r = runLayoverTool(name, CTX);
      assert.equal(r.tool, name);
      if (name === "getCrewCandidates") {
        assert.equal(r.ok, false);
        assert.equal((r as any).reason, "no_crew_storage");
      } else if (name === "replan") {
        assert.equal(r.ok, false);
        assert.equal((r as any).reason, "no_event_driven_replanner");
      } else {
        assert.equal(r.ok, true, `${name} must answer`);
      }
    }
  });

  it("NO TOOL CAN WIDEN THE ENVELOPE — every deadline and window it emits is the certified one", () => {
    const certifiedIso = RECORD.deadline.hardReturnTime.toISOString();
    let deadlinesSeen = 0;
    let windowsSeen = 0;
    for (const name of LAYOVER_TOOL_NAMES) {
      for (const args of [
        {},
        { candidateSet: [{ durationMin: 100000, travelMin: 100000, insideAirport: false }] },
        { field: "checkedBags" },
        { snapshotId: "anything" },
        { usableMinutes: 99999, hardReturnTime: "2099-01-01T00:00:00.000Z" },
      ]) {
        const r = runLayoverTool(name, CTX, args as Record<string, unknown>);
        if (!r.ok) continue;
        const json = JSON.stringify(r.data);
        // Any hard-return instant a tool emits must be the certified one.
        for (const m of json.matchAll(/"hardReturnTime":"([^"]+)"/g)) {
          deadlinesSeen++;
          assert.equal(m[1], certifiedIso, `${name} emitted a non-certified deadline`);
        }
        for (const m of json.matchAll(/"usableMinutes":(-?\d+)/g)) {
          windowsSeen++;
          assert.equal(Number(m[1]), USABLE, `${name} emitted a non-certified usable window`);
        }
        assert.equal(json.includes("2099-01-01"), false, `${name} echoed a caller-supplied deadline`);
        assert.equal(json.includes("99999"), false, `${name} echoed a caller-supplied window`);
      }
    }
    assert.ok(deadlinesSeen > 0, "vacuity guard: some tool must actually emit a deadline");
    assert.ok(windowsSeen > 0, "vacuity guard: some tool must actually emit a usable window");
  });

  it("simulatePlan compares a candidate set against the certified window, and refuses one that does not fit", () => {
    const fits = runLayoverTool("simulatePlan", CTX, {
      candidateSet: [{ durationMin: 30, travelMin: 10, insideAirport: false }],
    });
    assert.equal((fits as any).data.fitsWindow, true);
    assert.equal((fits as any).data.neededMin, 50);

    const does_not = runLayoverTool("simulatePlan", CTX, {
      candidateSet: [{ durationMin: USABLE + 60, travelMin: 0, insideAirport: false }],
    });
    assert.equal((does_not as any).data.fitsWindow, false);
    assert.equal((does_not as any).data.overflowMin, 60);
  });

  it("explainDecision hands back the replayable identity, not a story", () => {
    const r = runLayoverTool("explainDecision", CTX, { recommendationId: "rec-1" });
    assert.equal(r.ok, true);
    const d = (r as any).data;
    assert.equal(d.inputHash, RECORD.inputHash);
    assert.equal(d.engineVersion, RECORD.engineVersion);
    assert.deepEqual(d.reasonCodes, RECORD.reasonCodes);
    assert.equal(d.requestedId, "rec-1");
    assert.deepEqual(d.inputs, RECORD.inputs, "the inputs must be the record's own, so a replay reproduces it");
  });

  it("getAirportState reports the maturity honestly for an unverified airport", () => {
    const r = runLayoverTool("getAirportState", CTX);
    assert.equal((r as any).data.maturity, "L0_generic_defaults");
    assert.equal((r as any).data.liveOperationalState, null);
    assert.equal((r as any).data.liveUnavailableReason, "no_airport_intelligence_feed");
  });

  it("getConnectionState does not assert a disruption state nothing measured", () => {
    const r = runLayoverTool("getConnectionState", CTX);
    assert.equal((r as any).data.disruptionState, null);
    assert.equal((r as any).data.disruptionUnavailableReason, "no_flight_feed");
    assert.equal((r as any).data.returnState, RECORD.envelope.returnState);
  });
});

describe("§12.1 value-of-information", () => {
  it("asks about checked bags when the answer would move the outcome", () => {
    const qs = valueOfInformation(AIRPORT, SESSION, NOW);
    const bags = qs.find((q) => q.field === "checkedBags");
    assert.ok(bags, `checkedBags must be worth asking here: ${qs.map((q) => q.field).join(",")}`);
    assert.notEqual(bags!.impact.usableMinutesDelta, 0, "flipping it must actually move the window");
    assert.ok(bags!.valueOfInformation > 0);
  });

  it("asks at most ONE question, and it is the highest-value one", () => {
    const qs = valueOfInformation(AIRPORT, SESSION, NOW);
    const one = nextClarifyingQuestion(AIRPORT, SESSION, NOW);
    assert.ok(qs.length >= 1);
    assert.equal(one!.field, qs[0].field);
    assert.ok(
      qs.every((q) => q.valueOfInformation <= one!.valueOfInformation),
      "the asked question must dominate every other candidate",
    );
  });

  it("a verdict-flipping field outranks a merely-large minute change", () => {
    // Somebody with a very tight window: flipping `wantsToLeave` changes the
    // verdict outright, which must beat a buffer term that moves more minutes.
    const tight = session({ departureTime: new Date(NOW + 150 * 60_000).toISOString() });
    const qs = valueOfInformation(AIRPORT, tight, NOW);
    if (qs.length > 1) {
      const top = qs[0];
      const verdictMovers = qs.filter((q) => q.impact.verdictChanges || q.impact.riskBandChanges);
      if (verdictMovers.length > 0) {
        assert.ok(
          top.impact.verdictChanges || top.impact.riskBandChanges,
          `a verdict/risk mover exists (${verdictMovers.map((q) => q.field).join(",")}) but ${top.field} was asked`,
        );
      }
    }
    assert.ok(qs.length > 0, "control: the tight session must have something worth asking");
  });

  it("NEVER asks a question whose answer changes nothing", () => {
    const qs = valueOfInformation(AIRPORT, SESSION, NOW);
    for (const q of qs) {
      const moved =
        q.impact.verdictChanges || q.impact.riskBandChanges ||
        q.impact.returnStateChanges || q.impact.usableMinutesDelta !== 0;
      assert.ok(moved, `${q.field} was asked but flipping it moves nothing`);
    }
    // And nothing outside the certified input set can ever be asked: the spec's
    // own counter-example (favourite cuisine) is not a candidate at all.
    assert.deepEqual([...CLARIFIABLE_FIELDS], ["checkedBags", "immigrationRequired", "wantsToLeave"]);
    assert.equal(CLARIFIABLE_FIELDS.includes("comfortLevel" as never), false);
  });

  it("DROPS a field whose answer changes nothing — measured, not assumed", () => {
    // FALSE GREEN CAUGHT IN THIS LANE. Deleting the `score === 0` guard left
    // the suite green, because on the roomy fixture all three candidate fields
    // genuinely move something. Here the window is already clamped to zero and
    // the verdict is already "no", so flipping `checkedBags` or
    // `immigrationRequired` moves NOTHING and neither may be asked — which is
    // §12.1's whole point ("favourite cuisine may not be").
    const departed = session({ departureTime: new Date(NOW - 60 * 60_000).toISOString() });
    const qs = valueOfInformation(AIRPORT, departed, NOW);
    assert.deepEqual(qs.map((q) => q.field), ["wantsToLeave"]);
    assert.equal(qs.some((q) => q.field === "checkedBags"), false, "a buffer term that cannot move the answer is not asked");
    assert.equal(qs.some((q) => q.field === "immigrationRequired"), false);
    // Control: on the roomy session those same two fields ARE worth asking, so
    // this is a property of the situation and not of the field list.
    const roomy = valueOfInformation(AIRPORT, SESSION, NOW).map((q) => q.field);
    assert.ok(roomy.includes("checkedBags"), `control: ${roomy.join(",")}`);
    assert.ok(roomy.includes("immigrationRequired"), `control: ${roomy.join(",")}`);
  });

  it("the spec's own decisive example is named as UNREPRESENTABLE rather than silently dropped", () => {
    const bagsThrough = UNREPRESENTABLE_CLARIFICATIONS.find((u) => u.field === "baggageThrough");
    assert.ok(bagsThrough, "§12.1's baggage-through example must be accounted for");
    assert.ok(bagsThrough!.reason.includes("boolean"));
    const r = runLayoverTool("requestConstraintClarification", CTX, { field: "baggageThrough" });
    assert.equal((r as any).data.worthAsking, false);
    assert.ok((r as any).data.unrepresentable);
  });

  it("requestConstraintClarification refuses a field that would not move the outcome", () => {
    const r = runLayoverTool("requestConstraintClarification", CTX, { field: "comfortLevel" });
    assert.equal(r.ok, true);
    assert.equal((r as any).data.worthAsking, false);
    assert.equal((r as any).data.question, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the deterministic answer speaks the AIRPORT's clock, and satisfies its own guard", () => {
  // A WESTWARD airport, deliberately: with the server process on UTC, the old
  // `hardReturnTime.toLocaleTimeString()` produced a time LATER than the
  // airport-local deadline, which is both wrong for the traveller and a
  // self-inflicted §12 violation — the server's own sentence tripped the
  // server's own boundary. Eastward airports hid it, because a UTC rendering
  // there is EARLIER and the guard only refuses LATER.
  const LAX: AirportProfile = { ...AIRPORT, iataCode: "LAX", name: "Los Angeles International",
    city: "Los Angeles", country: "United States", countryCode: "US", timezone: "America/Los_Angeles" };

  // `answerLayoverQuestion` reads the real clock (it is the production entry
  // point, not a pure helper), so this fixture is anchored to it rather than to
  // the file's frozen NOW — otherwise the window is already spent and the
  // fallback takes the "0 usable minutes" branch, which names no time at all.
  function liveSession() {
    const t = Date.now();
    return session({
      arrivalTime: new Date(t - 30 * 60_000).toISOString(),
      departureTime: new Date(t + 12 * 3_600_000).toISOString(),
    });
  }

  it("no OpenAI key: the fallback answer names the airport-local deadline and raises no violation", async () => {
    const s = liveSession();
    const answer = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: s, airport: LAX });
    assert.equal(answer.involvesLeaving, true);
    const rec = certifySessionFeasibility(LAX, s, { nowMs: Date.now() });
    const local = formatLocalTime(LAX.timezone, rec.deadline.hardReturnTime);
    const serverLocale = rec.deadline.hardReturnTime.toLocaleTimeString();
    assert.notEqual(local, serverLocale.slice(0, 5), "control: the two clocks must differ for this airport");
    assert.ok(
      answer.answer.includes(local),
      `answer "${answer.answer}" must name the airport-local deadline ${local}`,
    );
    assert.deepEqual(
      answer.boundaryViolations, [],
      "the server's own fallback must satisfy the server's own §12 boundary",
    );
    assert.ok(answer.certification.inputHash.startsWith("sha256:"));
  });

  it("the answer carries at most one clarifying question, chosen by value of information", async () => {
    const s = liveSession();
    const answer = await answerLayoverQuestion({} as never, { question: "What can I do here?", session: s, airport: LAX });
    const expected = nextClarifyingQuestion(LAX, s, Date.now());
    assert.equal(answer.clarifyingQuestion?.field, expected?.field);
    if (answer.clarifyingQuestion) {
      assert.ok(answer.clarifyingQuestion.valueOfInformation > 0);
    }
  });
});
