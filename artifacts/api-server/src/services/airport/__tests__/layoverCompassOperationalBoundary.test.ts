/**
 * census L101 — "Compass **cannot invent or widen** the certified safe
 * envelope, return deadline, visa/entry status, OPERATIONAL STATE or risk band"
 * census L3  — "Hard safety constraints are deterministic and cannot be
 *               overridden by Compass/LLM output"
 *
 * RESTATED 2026-10-09 under lead ruling L-CL02d. This suite drove the
 * operational-state half of `enforceCompassEnvelope`: a MODEL sentence claiming
 * a queue, a flight status, a gate or a transfer train (none of which this tree
 * certifies — `liveOperationalState` is null) was refused. L-CL02d deleted the
 * model branch and the deny-list with it. The same claims are kept as the
 * stronger statement: a model that would say each one is never asked, in every
 * certified world, and the traveller reads the certified text — which itself
 * claims no operational state.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverCompassOperationalBoundary.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _setTestOpenAI } from "../../../lib/openai.js";
import { answerLayoverQuestion } from "../LayoverCompassService.js";

const AP = {
  id: "ap-1", iataCode: "LAX", name: "Los Angeles International", city: "Los Angeles",
  country: "United States", countryCode: "US", timezone: "America/Los_Angeles",
  lat: 33.94, lng: -118.4, verified: false,
  domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30,
  checkedBagsExtraMin: 15, trafficExtraMin: 20,
} as any;
const PERMITTED = { state: "permitted", corridor: { passportCountry: "US", destinationCountry: "US" }, status: "visa_free" } as any;

function session(departInMin: number, over: Record<string, unknown> = {}) {
  const t = Date.now();
  return {
    id: "s1", userId: "u1", airportId: "ap-1", tripId: null,
    arrivalTime: new Date(t - 30 * 60_000).toISOString(),
    departureTime: new Date(t + departInMin * 60_000).toISOString(),
    boardingTime: null, layoverMinutes: departInMin + 30, flightType: "international",
    immigrationRequired: true, checkedBags: false, loungeAccess: false, wantsToLeave: true,
    comfortLevel: "moderate", vibeChips: [], manualAirportName: null, manualCity: null,
    manualCountry: null, manualIata: null, canonicalCityId: null, shareCityStatus: false,
    returnReminderAt: null, status: "active", createdAt: "", updatedAt: "", ...over,
  } as any;
}

/** Each certified world the old deny-list was exercised against. */
const WORLDS = [
  { name: "certified yes (live)", s: () => session(600), entry: PERMITTED, lead: /^You have about \d+ minutes of usable time\. You can leave the airport/ },
  { name: "certified yes (ended by status, departure ahead)", s: () => session(600, { status: "completed" }), entry: PERMITTED, lead: /^You have about \d+ minutes of usable time\. You can leave the airport/ },
  { name: "certified no (no usable time)", s: () => session(150), entry: PERMITTED, lead: /^Leaving the airport is not recommended on this layover/ },
  { name: "entry unverified (no corridor read)", s: () => session(600), entry: null, lead: /^Leaving the airport has not been confirmed as possible/ },
];

/** A model double that COUNTS its calls and would say `text`. */
function countingModel(text: string) {
  const calls = { n: 0 };
  _setTestOpenAI({ chat: { completions: { create: async () => { calls.n += 1; return { choices: [{ message: { content: text } }] }; } } } } as any);
  return calls;
}
afterEach(() => _setTestOpenAI(null));

async function neverAsked(text: string) {
  for (const w of WORLDS) {
    const calls = countingModel(text);
    const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: w.s(), airport: AP, entry: w.entry });
    assert.equal(calls.n, 0, `${w.name}: a model was asked on the layover door`);
    assert.equal(a.modelConsulted, false, w.name);
    assert.deepEqual(a.boundaryViolations, [], `${w.name}: nothing was produced, so nothing was refused`);
    assert.ok(!a.answer.includes(text.split(/[.—]/)[0]!.trim()), `${w.name}: the model's words reached the traveller: ${a.answer}`);
    assert.match(a.answer, w.lead, `${w.name}: ${a.answer}`);
  }
}

describe("L101 — an invented operational state is never produced: no model is asked (L-CL02d)", () => {
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
  for (const claim of CLAIMS) it(`never asked: ${claim.slice(0, 52)}…`, () => neverAsked(claim));

  // The old guard's "allows" list: honest or not, no model sentence reaches the
  // traveller, so there is no false positive left to have.
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
  for (const ok of INNOCENT) it(`never asked, honest or not: ${ok.slice(0, 52)}…`, () => neverAsked(ok));

  it("the certified answer itself claims no operational state (no queue, flight, gate or train status)", async () => {
    for (const w of WORLDS) {
      const a = await answerLayoverQuestion({} as never, { question: "Is security quick right now?", session: w.s(), airport: AP, entry: w.entry });
      assert.doesNotMatch(a.answer, /\b(?:queue|line)s?\b[^.]*\b(?:short|quick|moving|long)\b|\bdelayed\b|\bon time\b|\bgate\s+[A-Z]?\d|\bboarding has\b|\b(?:train|skytrain)\b[^.]*\b(?:running|operating)\b/i, `${w.name}: ${a.answer}`);
    }
  });
});
