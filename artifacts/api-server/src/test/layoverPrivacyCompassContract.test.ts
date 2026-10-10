/**
 * Layover §12 / §12.1: the Compass boundary on the layover door, and the
 * value-of-information rule.
 *
 * node:test + node:assert/strict. The verdict is the EXIT CODE.
 *
 * ── WHY THIS FILE IS NAMED FOR PRIVACY ──────────────────────────────────────
 * The §12 boundary is a disclosure boundary: nothing may leave the server on top
 * of the certified numbers that the certified record does not support.
 *
 * ── RESTATED 2026-10-09 UNDER LEAD RULING L-CL02d ───────────────────────────
 * This file used to pin `enforceCompassEnvelope` (the deny-list over a MODEL
 * answer) and the twelve §12 tools (`runLayoverTool`). L-CL02d deleted the model
 * branch, the deny-list and the tools from the layover door: it is certified-only
 * by construction. The same scenarios are kept as what is now true — the door's
 * deadline and window are exactly the certified record's, a model that would
 * state a later deadline or a wider window is never asked, and no tool exists
 * to emit one. §12.1 (census L114) is unchanged: Compass still asks at most one
 * question, and only when re-certifying with the answer flipped moves the
 * verdict, the risk band or the window.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverPrivacyCompassContract.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import { certifiedPlanFit } from "../services/airport/LayoverConstraints.js";
import { formatLocalTime } from "../services/airport/AirportTime.js";
import { _setTestOpenAI } from "../lib/openai.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import * as LayoverCompassService from "../services/airport/LayoverCompassService.js";
import {
  answerLayoverQuestion,
  valueOfInformation,
  nextClarifyingQuestion,
  CLARIFIABLE_FIELDS,
  UNREPRESENTABLE_CLARIFICATIONS,
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

/** A clock string `n` minutes after the certified hard return, airport-local. */
function localPlus(minutes: number): string {
  return formatLocalTime(AIRPORT.timezone, new Date(RECORD.deadline.hardReturnTime.getTime() + minutes * 60_000));
}

/** `RECORD`'s session at the same instant, certified with a CONFIRMED border — the only way a gate is open. */
const OPEN_RECORD = certifySessionFeasibility(AIRPORT, SESSION, {
  nowMs: NOW, entry: { state: "permitted", status: "visa_free", corridor: { passportCountry: "GB", destinationCountry: "TW" } },
});

afterEach(() => _setTestOpenAI(null));

/** Ask the door at the fixture's instant (through the certified snapshot), with a model double that counts calls. */
async function askAt(record: typeof RECORD, wouldSay: string) {
  const calls = { n: 0 };
  _setTestOpenAI({ chat: { completions: { create: async () => { calls.n += 1; return { choices: [{ message: { content: wouldSay } }] }; } } } } as never);
  const a = await answerLayoverQuestion({} as never, {
    question: "Can I leave the airport?", session: SESSION, airport: AIRPORT,
    snapshot: { certifiedRecord: record, usableMinutes: record.envelope.usableMinutes, minutesToHardReturn: Math.round((record.deadline.hardReturnTime.getTime() - NOW) / 60_000) } as never,
  });
  return { a, calls: calls.n };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("§12 the door may not widen the certified return deadline (L-CL02d: no model text exists)", () => {
  it("control: the setup really is a same-day, comparable deadline, and the open record names it", async () => {
    assert.equal(OPEN_RECORD.deadline.hardReturnTime.toISOString(), RECORD.deadline.hardReturnTime.toISOString());
    const { a } = await askAt(OPEN_RECORD, "");
    assert.equal(a.certification.verdict, "yes");
    assert.ok(a.answer.includes(HARD_LOCAL), `the certified deadline ${HARD_LOCAL} must be named: ${a.answer}`);
    assert.equal(a.hardReturnTime, RECORD.deadline.hardReturnTime.toISOString());
  });

  for (const minutes of [1, 30, 60, 24 * 60]) {
    it(`a model that would say 'back by ${minutes} min LATER' is never asked, and the later time is nowhere`, async () => {
      const later = localPlus(minutes);
      const { a, calls } = await askAt(OPEN_RECORD, `Be back at security by ${later} and you'll be fine.`);
      assert.equal(calls, 0);
      assert.ok(!a.answer.includes(later) || later === HARD_LOCAL, a.answer);
      assert.deepEqual(a.boundaryViolations, []);
    });
  }
});

describe("§12 the door may not widen the usable window (L-CL02d: no model text exists)", () => {
  it("the certified figure is the one stated", async () => {
    const { a } = await askAt(OPEN_RECORD, "");
    assert.ok(a.answer.includes(`about ${USABLE} minutes of usable time`), a.answer);
  });
  it("a model that would state a LARGER usable figure is never asked, and the figure is nowhere", async () => {
    const { a, calls } = await askAt(OPEN_RECORD, `That gives you ${USABLE + 600} usable minutes.`);
    assert.equal(calls, 0);
    assert.ok(!a.answer.includes(String(USABLE + 600)), a.answer);
  });
});

describe("§12 the twelve deterministic tools are GONE from the layover door (L-CL02d)", () => {
  it("the module exports none of them, nor their schemas or the dispatcher", () => {
    for (const gone of ["runLayoverTool", "LAYOVER_TOOL_NAMES", "LAYOVER_TOOL_SCHEMAS", "runNamedLayoverTool", "enforceCompassEnvelope", "COMPASS_BOUNDARY_KINDS", "operationalStateViolations"]) {
      assert.equal((LayoverCompassService as Record<string, unknown>)[gone], undefined, gone);
    }
  });

  it("NO TOOL CAN WIDEN THE ENVELOPE — none exists, and every deadline and window the door emits is the certified one", async () => {
    for (const record of [RECORD, OPEN_RECORD]) {
      const { a, calls } = await askAt(record, `Be back by ${localPlus(600)}; that gives you 99999 usable minutes.`);
      assert.equal(calls, 0);
      assert.deepEqual(a.toolsConsulted, []);
      const json = JSON.stringify(a);
      for (const m of json.matchAll(/"hardReturnTime":"([^"]+)"/g)) assert.equal(m[1], RECORD.deadline.hardReturnTime.toISOString());
      assert.equal(json.includes("99999"), false);
      assert.equal(json.includes("2099-01-01"), false);
    }
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
    // RESTATED (L-CL02d): the `requestConstraintClarification` tool is gone; the
    // rule it wrapped is asserted directly — an unrepresentable field is never a candidate.
    assert.equal(valueOfInformation(AIRPORT, SESSION, NOW).some((q) => (q.field as string) === "baggageThrough"), false);
  });

  it("a field that would not move the outcome is never a candidate (formerly the requestConstraintClarification tool)", () => {
    for (const q of [...valueOfInformation(AIRPORT, SESSION, NOW), ...valueOfInformation(AIRPORT, session({ departureTime: new Date(NOW + 150 * 60_000).toISOString() }), NOW)]) {
      assert.notEqual(q.field as string, "comfortLevel");
    }
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

  // Only an explicit `yes` names a return deadline ("you can leave … be back at
  // security by"), so the clock is spoken on a PERMITTED corridor. RENAMED
  // 2026-10-09 (V-R8 F4, lead ruling L-CL02d): this case was "no OpenAI key",
  // but the layover door asks no model at all, so a missing key changes
  // nothing; a throwing model double is installed and asserted NEVER called.
  it("the door asks no model: the certified answer names the airport-local deadline and raises no violation", async () => {
    const s = liveSession();
    const entry = { state: "permitted", corridor: { passportCountry: "US", destinationCountry: "US" }, status: "visa_free" } as const;
    let calls = 0;
    _setTestOpenAI({ chat: { completions: { create: async () => { calls += 1; throw new Error("no key"); } } } } as never);
    let answer: Awaited<ReturnType<typeof answerLayoverQuestion>>;
    try {
      answer = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: s, airport: LAX, entry: entry as never });
    } finally {
      _setTestOpenAI(null);
    }
    assert.equal(calls, 0, "L-CL02d: no model is asked on the layover door");
    assert.equal(answer.modelConsulted, false);
    assert.equal(answer.certification.verdict, "yes", "fixture: certified yes");
    assert.equal(answer.involvesLeaving, true);
    const rec = certifySessionFeasibility(LAX, s, { nowMs: Date.now(), entry: entry as never });
    const local = formatLocalTime(LAX.timezone, rec.deadline.hardReturnTime);
    const serverLocale = rec.deadline.hardReturnTime.toLocaleTimeString();
    assert.notEqual(local, serverLocale.slice(0, 5), "control: the two clocks must differ for this airport");
    assert.ok(
      answer.answer.includes(local),
      `answer "${answer.answer}" must name the airport-local deadline ${local}`,
    );
    assert.deepEqual(
      answer.boundaryViolations, [],
      "no model text exists, so nothing violates the §12 boundary",
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

// ═════════════════════════════════════════════════════════════════════════════
// LAY-FIX — the landside gate on a candidate plan. RESTATED (L-CL02d): the
// `simulatePlan` tool is gone; the same candidate sets go through
// `certifiedPlanFit`, the one plan-fit every surface uses.
// ═════════════════════════════════════════════════════════════════════════════

describe("§12 a candidate plan goes through the landside gate, not the clock alone", () => {
  it("FIXTURE: the border moves the verdict and the gate, and not one minute of the window", () => {
    assert.equal(OPEN_RECORD.envelope.usableMinutes, USABLE);
    assert.equal(OPEN_RECORD.deadline.hardReturnTime.toISOString(), RECORD.deadline.hardReturnTime.toISOString());
    assert.equal(OPEN_RECORD.landsideGate.open, true);
    assert.equal(RECORD.verdict, "entry_unverified");
    assert.equal(RECORD.landsideGate.open, false);
  });

  it("the SAME candidate set on a border nobody confirmed does not `fit`, and says it is unconfirmed", () => {
    const unconfirmed = certifiedPlanFit(RECORD, [{ durationMin: 30, travelMin: 10, insideAirport: false }]);
    assert.equal(unconfirmed.fitsWindow, false, "a plan through the city fit the window on a border nobody confirmed");
    assert.equal(unconfirmed.fit, "unconfirmed");
    assert.equal(unconfirmed.clockFit, "fits");
    assert.deepEqual(unconfirmed.landside.cautions, ["entry_unconfirmed"]);
    assert.equal(unconfirmed.neededMin, 50, "the gate withholds the affirmative; it does not move a number");
    assert.equal(certifiedPlanFit(RECORD, [{ durationMin: 30, travelMin: 10 }]).fitsWindow, false, "an omitted insideAirport is landside");
    assert.equal(certifiedPlanFit(RECORD, [{ durationMin: 30, travelMin: 0, insideAirport: true }]).fitsWindow, true);
    assert.equal(certifiedPlanFit(OPEN_RECORD, [{ durationMin: 30, travelMin: 10, insideAirport: false }]).fitsWindow, true, "CONTROL: an open gate fits");
  });
});
