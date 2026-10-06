/**
 * census L101 — "Compass **cannot invent or widen** the certified safe
 * envelope, return deadline, visa/entry status, OPERATIONAL STATE or risk band"
 * census L3  — "Hard safety constraints are deterministic and cannot be
 *               overridden by Compass/LLM output"
 *
 * §19.5 left exactly one of L101's five nouns open:
 *
 *     "Four of L101's five nouns are enforced. The fifth, operational state, is
 *      not: a model that asserts the security queue is short, or that a
 *      terminal transfer is running, is still unconstrained, and there is no
 *      certified operational state to compare it against."
 *
 * That last clause is the whole rule: `getAirportState` publishes
 * `liveOperationalState: null`, there is no flight feed and no queue feed, so
 * ANY present-state claim about a queue, a flight, a gate or a transfer train is
 * invented. The worst of them widen the window without naming a clock time —
 * "your flight is delayed an hour" — which the deadline check cannot see.
 *
 * Asserted on the STATE that matters: whether the model's sentence is published.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverCompassOperationalBoundary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enforceCompassEnvelope } from "../LayoverCompassService.js";

const AIRPORT = { timezone: "Asia/Taipei" };
/** 18:00 Taipei = 10:00 UTC — nowhere near the midnight wrap. */
const HARD_RETURN = new Date(Date.UTC(2026, 8, 20, 10, 0, 0));

const ctx = (verdict: "yes" | "tight" | "no" | "stay_airside" = "yes") => ({
  airport: AIRPORT,
  hardReturnTime: HARD_RETURN,
  usableMinutes: 300,
  verdict,
});

const kinds = (text: string, verdict: "yes" | "tight" | "no" | "stay_airside" = "yes") =>
  enforceCompassEnvelope(text, ctx(verdict)).violations.map((v) => v.kind);

describe("L101 — a model may not invent the airport's operational state", () => {
  const CLAIMS = [
    // queues — each says the traveller needs less time than the buffer assumes
    "The security queue is short right now, so you have extra time in the city.",
    "There's no line at immigration this afternoon.",
    "Lines are moving quickly through passport control today.",
    "Security is quick at this hour, so don't rush back.",
    "Immigration only takes about ten minutes here.",
    "Security takes just 5 minutes, you'll be fine.",
    // flight status — a delay WIDENS the window
    "Your flight is delayed by an hour, so you can stay out longer.",
    "Your connection is on time.",
    "Your flight isn't delayed, so plan around the original time.",
    // gates and boarding
    "Your gate is B12, a short walk from security.",
    "Boarding has started for some flights in your terminal.",
    // transfers
    "The airport express train is running every ten minutes tonight.",
    "The SkyTrain between terminals is operating normally.",
    // crowding
    "The airport is quiet tonight, so security will be a breeze.",
    "Immigration isn't busy right now.",
  ];
  for (const claim of CLAIMS) {
    it(`refuses: ${claim.slice(0, 52)}…`, () => {
      const r = enforceCompassEnvelope(claim, ctx());
      assert.equal(r.ok, false, "an invented operational state must not be published");
      assert.ok(
        r.violations.some((v) => v.kind === "operational_state_asserted"),
        `expected operational_state_asserted, got ${JSON.stringify(r.violations)}`,
      );
      const v = r.violations.find((x) => x.kind === "operational_state_asserted")!;
      assert.match(v.certified, /no certified operational state/);
      assert.ok(v.stated.length > 0 && claim.includes(v.stated.slice(0, 20)), "the violation quotes the sentence");
    });
  }

  // The guard is useless if it fires on honest answers — it gets switched off.
  const INNOCENT = [
    // the server's own deterministic sentences
    "You have about 300 minutes of usable time. You can leave the airport — but make sure you're back at security by 18:00 to catch your flight safely.",
    "With only 20 minutes of usable time after your 120-minute return buffer, I'd recommend staying inside the airport for this one. Grab a meal, relax in a lounge, or browse the shops.",
    // static facts and advice
    "There is a transit hotel in Terminal 2.",
    "Allow time for the security queue when you come back.",
    "Be back at security by 17:30 to be safe.",
    // hedged or general statements claim no present state
    "Security can be slow at peak times, so leave extra room.",
    "The immigration line might be short, but we have no live queue data.",
    "Lines are usually short in the late evening.",
    // `may` is a hedge here, unlike the entry guard: it claims no present state
    "There may be short lines at security later tonight.",
    "Check the departures board — we can't see whether your flight is delayed.",
    "If the train is running, it is the quickest way into town.",
    // a cautious statement is not a widening and carries no state predicate we match
    "Expect queues at immigration on your way back in.",
  ];
  for (const ok of INNOCENT) {
    it(`allows: ${ok.slice(0, 52)}…`, () => {
      assert.ok(
        !kinds(ok).includes("operational_state_asserted"),
        `an honest sentence must not trip the operational guard: ${JSON.stringify(kinds(ok))}`,
      );
    });
  }

  it("is sentence-scoped: a hedge in one sentence does not launder a claim in the next", () => {
    const text =
      "We can't see live queue data for this airport. The security queue is short right now, so take your time.";
    const r = enforceCompassEnvelope(text, ctx());
    const ops = r.violations.filter((v) => v.kind === "operational_state_asserted");
    assert.equal(ops.length, 1, JSON.stringify(r.violations));
    assert.match(ops[0].stated, /security queue is short/);
  });

  it("fires whatever the certified verdict — operational state is never certified on this tree", () => {
    for (const verdict of ["yes", "tight", "no", "stay_airside"] as const) {
      assert.ok(kinds("Your flight is delayed by two hours.", verdict).includes("operational_state_asserted"), verdict);
    }
  });
});

// ── Reachability: the PRODUCTION path must refuse the sentence, not just the helper

describe("answerLayoverQuestion refuses an invented operational state on a real model answer", () => {
  const AP = {
    id: "ap-1", iataCode: "LAX", name: "Los Angeles International", city: "Los Angeles",
    country: "United States", countryCode: "US", timezone: "America/Los_Angeles",
    lat: 33.94, lng: -118.4, verified: false,
    domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30,
    checkedBagsExtraMin: 15, trafficExtraMin: 20,
  } as any;

  function session() {
    const t = Date.now();
    return {
      id: "s1", userId: "u1", airportId: "ap-1", tripId: null,
      arrivalTime: new Date(t - 30 * 60_000).toISOString(),
      departureTime: new Date(t + 150 * 60_000).toISOString(),
      boardingTime: null, layoverMinutes: 180, flightType: "international",
      immigrationRequired: true, checkedBags: false, loungeAccess: false, wantsToLeave: true,
      comfortLevel: "moderate", vibeChips: [], manualAirportName: null, manualCity: null,
      manualCountry: null, manualIata: null, canonicalCityId: null, shareCityStatus: false,
      returnReminderAt: null, status: "active", createdAt: "", updatedAt: "",
    } as any;
  }

  function mockModel(text: string) {
    return {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: text } }] }) } },
    } as any;
  }

  it("a 'your flight is delayed' answer is not published; the certified answer replaces it", async () => {
    const { _setTestOpenAI } = await import("../../../lib/openai.js");
    const { answerLayoverQuestion } = await import("../LayoverCompassService.js");
    _setTestOpenAI(mockModel("Good news: your flight is delayed by an hour, so the queue at security won't matter."));
    try {
      const a = await answerLayoverQuestion({} as never, {
        question: "How long do I have?", session: session(), airport: AP,
      });
      assert.ok(
        a.boundaryViolations.some((v) => v.kind === "operational_state_asserted"),
        `the operational guard must run on the production path: ${JSON.stringify(a.boundaryViolations)}`,
      );
      assert.ok(!/delayed/i.test(a.answer), "the refused text must not be published");
      assert.ok(a.answer.length > 0, "the traveller still gets the certified deterministic answer");
    } finally {
      _setTestOpenAI(null);
    }
  });

  it("positive control: advice about the queue is published unchanged", async () => {
    const { _setTestOpenAI } = await import("../../../lib/openai.js");
    const { answerLayoverQuestion } = await import("../LayoverCompassService.js");
    _setTestOpenAI(mockModel("Stay airside this time and allow time for the security queue before boarding."));
    try {
      const a = await answerLayoverQuestion({} as never, {
        question: "Should I leave?", session: session(), airport: AP,
      });
      assert.deepEqual(a.boundaryViolations, []);
      assert.match(a.answer, /security queue/);
    } finally {
      _setTestOpenAI(null);
    }
  });
});
