/**
 * census L101 — "Compass **cannot invent or widen** the certified safe
 * envelope, return deadline, visa/entry status, operational state or risk band"
 * census L3  — "Hard safety constraints are deterministic and cannot be
 *               overridden by Compass/LLM output"
 *
 * §18 built `enforceCompassEnvelope` and closed two of the five nouns: the
 * RETURN DEADLINE and the SAFE ENVELOPE's usable window are both compared
 * against the certified record after the model speaks, and a widening answer is
 * replaced by the deterministic one.
 *
 * Three nouns were left, and the census named the worst of them exactly:
 *
 *     "Visa/entry is not a field at all on main, so a model assertion about it
 *      is unconstrained by anything."
 *
 * That is not a modelling gap, it is a live hazard. `adviseLeaving` emits
 * `ENTRY_NOT_CONFIRMED` on EVERY session on this tree — nothing here reads
 * entry permission — and the standing `unknowns` line is "Visa or transit-permit
 * requirements for your nationality". A language model that answers "you won't
 * need a visa for a short visit" contradicts the server's own certified
 * unknown, on the one question whose wrong answer ends with a traveller refused
 * at immigration.
 *
 * RISK BAND is the other: the certified verdict is `no`, and the model says
 * "you have plenty of time, go ahead". `safetyNote` beside it would still read
 * "Not recommended", so the response contradicted itself.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverCompassEntryBoundary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enforceCompassEnvelope,
  COMPASS_BOUNDARY_KINDS,
} from "../LayoverCompassService.js";

const AIRPORT = { timezone: "Asia/Taipei" };
/** 18:00 Taipei = 10:00 UTC — nowhere near the midnight wrap. */
const HARD_RETURN = new Date(Date.UTC(2026, 8, 20, 10, 0, 0));

const ctx = (over: Partial<{ usableMinutes: number; verdict: "yes" | "tight" | "no" | "stay_airside" }> = {}) => ({
  airport: AIRPORT,
  hardReturnTime: HARD_RETURN,
  usableMinutes: over.usableMinutes ?? 300,
  verdict: over.verdict ?? ("yes" as const),
});

describe("L101 — a model may not assert entry permission this tree has never read", () => {
  const ENTRY_CLAIMS = [
    "You won't need a visa for a short visit, so head into the city.",
    "No visa is required for a transit stop like yours.",
    "Visa-free entry applies here, so you're fine to leave.",
    "You are allowed to enter the country on a layover.",
    "Transit passengers can enter without a permit.",
  ];

  for (const claim of ENTRY_CLAIMS) {
    it(`refuses: ${claim.slice(0, 46)}…`, () => {
      const r = enforceCompassEnvelope(claim, ctx());
      assert.equal(r.ok, false, "an entry assertion must not be published");
      assert.ok(
        r.violations.some((v) => v.kind === "entry_status_asserted"),
        `expected entry_status_asserted, got ${JSON.stringify(r.violations)}`,
      );
    });
  }

  const INNOCENT = [
    "Check your own visa or transit-permit rules before you leave the airport.",
    "You have about 300 usable minutes before you need to be back.",
    "There's a night market a short ride from the terminal.",
    // The server's own standing unknown. A guard that refuses this refuses the
    // truthful sentence and would be switched off within a week.
    "We can't confirm visa or transit-permit requirements for your nationality.",
  ];
  for (const ok of INNOCENT) {
    it(`allows: ${ok.slice(0, 46)}…`, () => {
      const r = enforceCompassEnvelope(ok, ctx());
      assert.ok(
        !r.violations.some((v) => v.kind === "entry_status_asserted"),
        `false positive on an honest sentence: ${JSON.stringify(r.violations)}`,
      );
    });
  }
});

describe("L101/L3 — a model may not talk the certified risk band upward", () => {
  it("refuses a 'safe to leave' answer when the certified verdict is no", () => {
    const r = enforceCompassEnvelope(
      "You have plenty of time — it's safe to leave the airport and see the city.",
      ctx({ verdict: "no", usableMinutes: 10 }),
    );
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === "risk_band_widened"),
      JSON.stringify(r.violations));
  });

  it("refuses it on a tight window too — 'tight' is not 'safe'", () => {
    const r = enforceCompassEnvelope(
      "It is safe to go — you'll easily make it back.",
      ctx({ verdict: "tight", usableMinutes: 60 }),
    );
    assert.ok(r.violations.some((v) => v.kind === "risk_band_widened"));
  });

  it("allows the same sentence when the certified verdict actually is yes", () => {
    const r = enforceCompassEnvelope(
      "You have plenty of time — it's safe to leave the airport and see the city.",
      ctx({ verdict: "yes", usableMinutes: 300 }),
    );
    assert.ok(!r.violations.some((v) => v.kind === "risk_band_widened"),
      "the guard must not refuse an answer that agrees with the record");
  });

  it("allows a REFUSAL on a no verdict — the guard is one-directional", () => {
    const r = enforceCompassEnvelope(
      "It is not safe to leave the airport on this layover — stay inside the terminal.",
      ctx({ verdict: "no", usableMinutes: 10 }),
    );
    assert.deepEqual(r.violations, [], "talking the band DOWN is always allowed");
  });
});

describe("the violation vocabulary is declared, not spelled at the call sites", () => {
  it("names all four kinds and nothing else", () => {
    assert.deepEqual([...COMPASS_BOUNDARY_KINDS].sort(), [
      "entry_status_asserted",
      "return_deadline_widened",
      "risk_band_widened",
      "usable_time_widened",
    ]);
  });

  it("the two §18 checks still hold — this did not replace them", () => {
    const late = enforceCompassEnvelope("Be back by 19:30 and you'll be fine.", ctx());
    assert.ok(late.violations.some((v) => v.kind === "return_deadline_widened"));
    const wide = enforceCompassEnvelope("That gives you 900 usable minutes.", ctx());
    assert.ok(wide.violations.some((v) => v.kind === "usable_time_widened"));
  });
});

// ── Reachability: the PRODUCTION path must hand the guard the certified verdict

describe("answerLayoverQuestion enforces the boundary on a real model answer", () => {
  const AP = {
    id: "ap-1", iataCode: "LAX", name: "Los Angeles International", city: "Los Angeles",
    country: "United States", countryCode: "US", timezone: "America/Los_Angeles",
    lat: 33.94, lng: -118.4, verified: false,
    domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30,
    checkedBagsExtraMin: 15, trafficExtraMin: 20,
  } as any;

  /** A window with no usable time at all — the certified verdict is `no`. */
  function shutSession() {
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

  it("a model answer that widens the risk band is refused and replaced by the certified one", async () => {
    const { _setTestOpenAI } = await import("../../../lib/openai.js");
    const { answerLayoverQuestion } = await import("../LayoverCompassService.js");
    _setTestOpenAI(mockModel("You have plenty of time — it's safe to leave the airport and explore."));
    try {
      const a = await answerLayoverQuestion({} as never, {
        question: "Can I leave the airport?", session: shutSession(), airport: AP,
      });
      assert.ok(
        a.boundaryViolations.some((v) => v.kind === "risk_band_widened"),
        `the certified verdict must reach the guard: ${JSON.stringify(a.boundaryViolations)}`,
      );
      assert.ok(!/plenty of time/i.test(a.answer), "the refused text must not be published");
    } finally {
      _setTestOpenAI(null);
    }
  });

  it("a model answer that asserts entry permission is refused on the same path", async () => {
    const { _setTestOpenAI } = await import("../../../lib/openai.js");
    const { answerLayoverQuestion } = await import("../LayoverCompassService.js");
    _setTestOpenAI(mockModel("You won't need a visa for a short visit, so head into the city."));
    try {
      const a = await answerLayoverQuestion({} as never, {
        question: "Can I leave the airport?", session: shutSession(), airport: AP,
      });
      assert.ok(a.boundaryViolations.some((v) => v.kind === "entry_status_asserted"));
      assert.ok(!/visa/i.test(a.answer), "the refused text must not be published");
    } finally {
      _setTestOpenAI(null);
    }
  });

  it("positive control: an answer inside the envelope is published unchanged", async () => {
    const { _setTestOpenAI } = await import("../../../lib/openai.js");
    const { answerLayoverQuestion } = await import("../LayoverCompassService.js");
    _setTestOpenAI(mockModel("Stay inside the terminal on this one — there is a good food hall past security."));
    try {
      const a = await answerLayoverQuestion({} as never, {
        question: "Can I leave the airport?", session: shutSession(), airport: AP,
      });
      assert.deepEqual(a.boundaryViolations, []);
      assert.match(a.answer, /food hall/);
    } finally {
      _setTestOpenAI(null);
    }
  });
});
