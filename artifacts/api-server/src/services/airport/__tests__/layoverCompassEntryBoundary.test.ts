/**
 * census L101 — "Compass **cannot invent or widen** the certified safe
 * envelope, return deadline, visa/entry status, operational state or risk band"
 * census L3  — "Hard safety constraints are deterministic and cannot be
 *               overridden by Compass/LLM output"
 *
 * RESTATED 2026-10-09 under lead ruling L-CL02d. This suite used to drive
 * `enforceCompassEnvelope` — the deny-list that read a MODEL answer and refused
 * one asserting entry permission, a wider risk band, a later deadline or more
 * usable time. L-CL02d deleted the model branch from the layover door, and the
 * deny-list with it: there is no model text on this door to police. The SAME
 * scenarios are kept, as the stronger statement: a model that would have said
 * each of these sentences is never asked, on a session certified `yes`, `no`
 * or `tight`, and the traveller reads the certified text.
 *
 * Why the entry case mattered (kept from the original): `adviseLeaving` emits
 * `ENTRY_NOT_CONFIRMED` whenever the corridor is unread, and a model answering
 * "you won't need a visa for a short visit" contradicts the server's own
 * certified unknown — the one question whose wrong answer ends with a traveller
 * refused at immigration.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverCompassEntryBoundary.test.ts
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

describe("L101 — a sentence asserting entry permission is never produced: no model is asked (L-CL02d)", () => {
  for (const claim of [
    "You won't need a visa for a short visit, so head into the city.",
    "No visa is required for a transit stop like yours.",
    "Visa-free entry applies here, so you're fine to leave.",
    "You are allowed to enter the country on a layover.",
    "Transit passengers can enter without a permit.",
  ]) it(`never asked: ${claim.slice(0, 46)}…`, () => neverAsked(claim));

  // The old guard's "allows" cases: honest sentences are not shown either — the
  // door says only the certified text, so there is no false positive to have.
  for (const ok of [
    "Check your own visa or transit-permit rules before you leave the airport.",
    "There's a night market a short ride from the terminal.",
    "We can't confirm visa or transit-permit requirements for your nationality.",
  ]) it(`never asked, honest or not: ${ok.slice(0, 46)}…`, () => neverAsked(ok));
});

describe("L101/L3 — a sentence talking the risk band, the deadline or the window upward is never produced", () => {
  for (const text of [
    "You have plenty of time — it's safe to leave the airport and see the city.",
    "It is safe to go — you'll easily make it back.",
    "It is not safe to leave the airport on this layover — stay inside the terminal.",
    "Be back by 19:30 and you'll be fine.",
    "That gives you 900 usable minutes.",
    "Stay inside the terminal on this one — there is a good food hall past security.",
  ]) it(`never asked: ${text.slice(0, 46)}…`, () => neverAsked(text));
});
