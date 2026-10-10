/**
 * Compass layover answers: certified server text for the five safety topics —
 * census-layover L3 / L101.
 *
 * Two lead rulings bind this suite:
 *
 *   2026-10-06 (L3/L101): "for the five safety topics, Compass layover answers
 *     use deterministic, certified server text. Model text that touches those
 *     topics is replaced by that text, never shown. AI is not a safety
 *     dependency."
 *
 *   L3-FC-3 (2026-10-07; supersedes L3-FC's airside allowlist for this door and
 *     for /compass/ask): "on a live layover whose certified verdict is not an
 *     explicit yes, every question gets certified text + deterministic airport
 *     facts only; no model (incl. intent classifier). Model answers only when
 *     verdict is an explicit yes, certified text leading."
 *
 * What these cases hold, through `answerLayoverQuestion` with a stubbed model
 * that COUNTS its calls:
 *
 *   1. Below an explicit yes — `no`, `tight`, `entry_unverified`,
 *      `stay_airside` — the model is NEVER CALLED, whatever the question: §50.1's
 *      paraphrases, the verifier's widening prose and sixteen leaving
 *      phrasings, airside questions and nonsense alike. The answer is the
 *      certified text and the deterministic airport facts, and it is the SAME
 *      answer for every question (the question is not read).
 *   2. Below an explicit yes the certified text never says "you can leave the
 *      airport" — it used to on `tight`, `entry_unverified` and `stay_airside`
 *      whenever 30+ usable minutes remained, because only `no` was a refusal.
 *   3. RESTATED 2026-10-09 under lead ruling L-CL02d: there is no model on this
 *      door at all. Every scenario that used to drive a model answer on an
 *      explicit yes — §50.1's paraphrases, the widening prose, a throwing model,
 *      a guard-refused model, every session status — now pins that the model is
 *      NEVER called and the answer is the certified text + airport facts.
 *   4. L-CL02c: what "live" means (status-live OR clock-live, fail closed).
 *   5. The gate and the certified text, directly.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _setTestOpenAI } from "../../../lib/openai.js";
import {
  answerLayoverQuestion,
  certifiedLayoverText,
  deterministicAirportFacts,
  layoverModelMayAnswer,
  questionMentionsLeaving,
} from "../LayoverCompassService.js";
import { layoverSessionIsLiveAt } from "../LayoverSessionService.js";
import * as LayoverCompassService from "../LayoverCompassService.js";
import { certifySessionFeasibility } from "../LayoverFeasibility.js";
import { landsideStatusOf } from "../LayoverConstraints.js";
import { safetyLabel } from "../LayoverSafetyEngine.js";
import type { EntryEligibility } from "../layoverEntryGate.js";

const AP = {
  id: "ap-1", iataCode: "LAX", name: "Los Angeles International", city: "Los Angeles",
  country: "United States", countryCode: "US", timezone: "America/Los_Angeles",
  lat: 33.94, lng: -118.4, verified: true,
  domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30,
  checkedBagsExtraMin: 15, trafficExtraMin: 20,
} as never;

const PERMITTED: EntryEligibility = {
  state: "permitted", corridor: { passportCountry: "US", destinationCountry: "US" }, status: "visa_free",
};

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
  } as never;
}
const NO_SESSION = () => session(150);   // usable 0 — certified `no`
const YES_SESSION = () => session(600);  // ten hours, corridor permitted — certified `yes`, and LIVE (status active)
/**
 * L-CL02a (2026-10-08): on a LIVE layover the explicit yes is certified-only too,
 * so the model path is reachable only on an ENDED session. The explicit-yes
 * machinery below (confinement, §12 guard, unreachable model) is pinned there;
 * the live cases are in the L-CL02a block.
 */
const ENDED_YES_SESSION = () => session(600, { status: "completed" }); // ended by status, departure ahead: LIVE by L-CL02c

/**
 * Every certified state below an explicit yes, as (session, entry) pairs. The
 * precondition suite proves each certifies what its name says.
 */
const NOT_YES: Array<{ name: string; verdict: string; session: () => never; entry: EntryEligibility | null }> = [
  { name: "no (no usable time)", verdict: "no", session: NO_SESSION, entry: PERMITTED },
  { name: "tight (48–93 usable minutes)", verdict: "tight", session: () => session(270), entry: PERMITTED },
  { name: "entry_unverified (no corridor read)", verdict: "entry_unverified", session: YES_SESSION, entry: null },
  { name: "stay_airside (the traveller chose to stay)", verdict: "stay_airside", session: () => session(600, { wantsToLeave: false }), entry: PERMITTED },
  { name: "no (corridor refused)", verdict: "no", session: YES_SESSION, entry: { state: "refused", status: "visa_required", corridor: { passportCountry: "US", destinationCountry: "US" } } as EntryEligibility },
];

/** A model double that counts its calls and always answers `text`. */
function model(text: string) {
  const calls = { n: 0 };
  _setTestOpenAI({ chat: { completions: { create: async () => { calls.n += 1; return { choices: [{ message: { content: text } }] }; } } } } as never);
  return calls;
}

const PARAPHRASES = [
  "You've got loads of time, so head into the city.",
  "Lines at passport control are tiny tonight.",
  "No need to rush back, the queues are a breeze.",
  "Your plane leaves late, so stay out longer.",
];

/** The wave-2 verifier's paraphrases (F2): five of these walked past the topic vocabulary. */
const VERIFIER_PARAPHRASES = [
  "You've got ample margin to venture beyond the terminal.",
  "Comfortable cushion — a stroll to the harbour is doable.",
  "Your connection is generous; the museum next door is worth it.",
  "No need to stress, the cathedral is a short cab away.",
  "Breathing room is good; grab lunch in the neighbourhood across the road.",
  "The old quarter is lovely this evening.",
  "A tram ride gets you to the river promenade.",
  "Treat yourself to the harbour seafood.",
];

/** The second verification's sixteen leaving phrasings, verbatim. */
const VERIFIER_LEAVING_QUESTIONS = [
  "Can I leave the airport?", "May I leave the airport?", "Is it safe to leave?", "Can we leave?",
  "Leaving the airport — good idea?", "Is there time to see the city?", "Should I head downtown?",
  "Is a quick trip to the old town doable?", "Can I make it to the harbour and back?", "Worth going into town?",
  "Do I have enough time for the night market?", "Could I pop out for a bit?", "Any chance of seeing the cathedral?",
  "Is Hollywood reachable from here?", "Should I stay airside?", "Is landside worth it?",
];
/** Questions the superseded allowlist called airside, and phrasings nobody listed. */
const OTHER_QUESTIONS = ["Where can I eat?", "Where is the lounge?", "How far is my gate?", "Thoughts?", "Is the weather nice?", ""];
const WIDENING_PROSE = "You've got ample margin to venture beyond the terminal. The cathedral is a short cab away.";
const CERTIFIED_YES_LEAD = /^You have about \d+ minutes of usable time\. You can leave the airport — but make sure you're back at security by [^.]+ to catch your flight safely\./;

afterEach(() => _setTestOpenAI(null));

describe("precondition: every session certifies what the cases say", () => {
  it("ENDED_YES_SESSION certifies the same explicit yes (status does not move the verdict)", () => {
    const r = certifySessionFeasibility(AP, ENDED_YES_SESSION(), { nowMs: Date.now(), entry: PERMITTED });
    assert.equal(r.verdict, "yes");
    assert.equal(layoverModelMayAnswer(r, r.envelope.usableMinutes), true);
  });
  it("YES_SESSION is an explicit yes (verdict yes, landside gate open, 30+ usable minutes)", () => {
    const r = certifySessionFeasibility(AP, { ...(YES_SESSION() as object), id: "s1" } as never, { nowMs: Date.now(), entry: PERMITTED });
    assert.equal(r.verdict, "yes");
    assert.equal(landsideStatusOf(r), "open");
    assert.equal(layoverModelMayAnswer(r, r.envelope.usableMinutes), true);
  });
  for (const c of NOT_YES) {
    it(`${c.name} certifies ${c.verdict} and is not an explicit yes`, () => {
      const r = certifySessionFeasibility(AP, c.session(), { nowMs: Date.now(), entry: c.entry });
      assert.equal(r.verdict, c.verdict);
      assert.equal(layoverModelMayAnswer(r, r.envelope.usableMinutes), false);
    });
  }
});

// ── 1. Below an explicit yes: no model, certified text + airport facts ───────

describe("L3-FC-3 — below an explicit yes the model is never called, whatever the question", () => {
  for (const c of NOT_YES) {
    it(`${c.name}: every question — leaving, airside, unknown, empty — gets one certified answer and no model call`, async () => {
      const calls = model(WIDENING_PROSE);
      const answers = new Set<string>();
      for (const q of [...VERIFIER_LEAVING_QUESTIONS, ...OTHER_QUESTIONS]) {
        const a = await answerLayoverQuestion({} as never, { question: q, session: c.session(), airport: AP, entry: c.entry });
        assert.equal(a.modelConsulted, false, q);
        assert.equal(a.modelProse.mode, "certified_only", q);
        assert.equal(a.modelProse.droppedSentences, 0, q);
        assert.deepEqual(a.toolsConsulted, [], q);
        assert.deepEqual(a.boundaryViolations, [], q);
        assert.ok(!/ample margin|cathedral/.test(a.answer), `${q}: ${a.answer}`);
        assert.doesNotMatch(a.answer, /you can leave the airport/i, q);
        assert.match(a.answer, /You're at Los Angeles International \(LAX\), with about \d+ minutes until boarding; your required return buffer is \d+ minutes\.$/, q);
        answers.add(a.answer.replace(/\d+ minutes until boarding/, "N minutes until boarding"));
      }
      assert.equal(calls.n, 0, "L3-FC-3: no completion may be requested below an explicit yes");
      assert.equal(answers.size, 1, `the question must not change the answer: ${[...answers].join(" | ")}`);
    });
  }

  for (const p of [...PARAPHRASES, ...VERIFIER_PARAPHRASES, "Off you go, enjoy the evening!"]) {
    it(`on a session certified NO, the model is not asked and its words cannot appear: ${p}`, async () => {
      const calls = model(p);
      const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: NO_SESSION(), airport: AP, entry: PERMITTED });
      assert.equal(calls.n, 0);
      assert.ok(!a.answer.includes(p), a.answer);
      assert.match(a.answer, /^Leaving the airport is not recommended on this layover — the certified check for it says no\./);
    });
  }

  // Lane L's verifier read main's copy of this door, where a model FAILURE or a
  // refused answer fell back to a sentence gated only on verdict === "no" and
  // said "You can leave the airport" on stay_airside / tight / entry_unverified.
  // That fallback is gone on this branch; these two cases pin that it stays gone.
  it("the FALLBACK paths below an explicit yes: a throwing model and a guard-refused model are never reached, and nothing says 'you can leave'", async () => {
    for (const c of NOT_YES) {
      for (const behaviour of ["throws", "widens"] as const) {
        const calls = { n: 0 };
        _setTestOpenAI({ chat: { completions: { create: async () => {
          calls.n += 1;
          if (behaviour === "throws") throw new Error("upstream 503");
          return { choices: [{ message: { content: "That gives you 9000 usable minutes, so go." } }] };
        } } } } as never);
        const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: c.session(), airport: AP, entry: c.entry });
        assert.equal(calls.n, 0, `${c.name}/${behaviour}: the model must not be reached`);
        assert.doesNotMatch(a.answer, /you can leave the airport/i, `${c.name}/${behaviour}: ${a.answer}`);
        assert.notEqual(a.safetyNote, safetyLabel("safe"), `${c.name}/${behaviour}`);
      }
    }
  });

  it("structurally (L-CL02d): ONE 'You can leave the airport' sentence, past the gate; NO model client, NO tool loop, NO model call in this file", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../LayoverCompassService.ts"), "utf8");
    assert.equal(src.match(/You can leave the airport/g)?.length, 1, "a second 'you can leave' sentence is a second, ungated path");
    const textFn = src.slice(src.indexOf("export function certifiedLayoverText("), src.indexOf("export function deterministicAirportFacts("));
    assert.ok(textFn.indexOf("if (!layoverModelMayAnswer(record, usableMin)) {") >= 0 && textFn.indexOf("if (!layoverModelMayAnswer(record, usableMin)) {") < textFn.indexOf("You can leave the airport"), "the sentence must sit past the gate");
    assert.doesNotMatch(src, /function deterministicAnswer\(/, "the old verdict==='no'-only fallback must not return");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const forbidden of [/lib\/openai/, /getOpenAI/, /runModelWithTools/, /chat\.completions/, /tool_choice/, /runLayoverTool/, /LAYOVER_TOOL_SCHEMAS/]) {
      assert.doesNotMatch(code, forbidden, `L-CL02d: ${forbidden} is back on the layover door`);
    }
    for (const gone of ["runLayoverTool", "LAYOVER_TOOL_SCHEMAS", "LAYOVER_TOOL_NAMES", "confineModelProse", "enforceCompassEnvelope", "namesSafetyTopic"]) {
      assert.equal((LayoverCompassService as Record<string, unknown>)[gone], undefined, `${gone} is exported again`);
    }
  });

  it("each not-yes state has its own certified sentence, and its note matches it", async () => {
    const want: Record<string, { text: RegExp; note: string }> = {
      "no (no usable time)": { text: /^Leaving the airport is not recommended on this layover/, note: safetyLabel("not_recommended") },
      "tight (48–93 usable minutes)": { text: /^Leaving the airport has not been confirmed as possible on this layover \(your time window is tight\)\./, note: safetyLabel("possible_but_risky") },
      "entry_unverified (no corridor read)": { text: /^Leaving the airport has not been confirmed as possible on this layover \(entry to the country could not be confirmed\)\./, note: safetyLabel("possible_but_risky") },
      "stay_airside (the traveller chose to stay)": { text: /^You chose to stay at the airport for this layover, so leaving it is not part of the plan\./, note: safetyLabel("airport_only") },
      "no (corridor refused)": { text: /^Leaving the airport is not recommended on this layover/, note: safetyLabel("not_recommended") },
    };
    for (const c of NOT_YES) {
      const a = await answerLayoverQuestion({} as never, { question: "What should I do?", session: c.session(), airport: AP, entry: c.entry });
      assert.match(a.answer, want[c.name]!.text, c.name);
      assert.equal(a.safetyNote, want[c.name]!.note, c.name);
    }
  });

  it("with no model at all, the certified text is the answer", async () => {
    const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: NO_SESSION(), airport: AP, entry: PERMITTED });
    assert.match(a.answer, /not recommended|staying inside the airport/);
  });
});

// ── 2. On an explicit yes: the model answers, the certified text leads ──────

describe("L-CL02d — the explicit yes, every session status: the model is NEVER called, whatever the question", () => {
  for (const status of ["active", "returning", "some_future_status", "completed", "cancelled", "expired"]) {
    it(`status ${status} (departure ahead): every question gets the certified yes text + airport facts, 0 model calls, 0 tools`, async () => {
      const calls = model(WIDENING_PROSE);
      const answers = new Set<string>();
      for (const q of [...VERIFIER_LEAVING_QUESTIONS, ...OTHER_QUESTIONS]) {
        const a = await answerLayoverQuestion({} as never, { question: q, session: session(600, { status }), airport: AP, entry: PERMITTED });
        assert.match(a.answer, CERTIFIED_YES_LEAD, `${q}: ${a.answer}`);
        assert.ok(!/cathedral|venture/.test(a.answer), a.answer);
        assert.equal(a.modelConsulted, false, q);
        assert.deepEqual(a.modelProse, { mode: "certified_only", droppedSentences: 0 }, q);
        assert.deepEqual(a.toolsConsulted, [], q);
        assert.deepEqual(a.boundaryViolations, [], q);
        assert.equal(a.safetyNote, safetyLabel("safe"), q);
        answers.add(a.answer.replace(/\d+ minutes/g, "N minutes"));
      }
      assert.equal(calls.n, 0, "a model was called on the layover door");
      assert.equal(answers.size, 1, "the question changed the answer");
    });
  }

  // The scenarios that used to drive a model answer on an explicit yes (formerly
  // "the certified text leads every answer"), restated: each model text is
  // handed to a counting double that is never asked, and never appears.
  for (const p of [...PARAPHRASES, ...VERIFIER_PARAPHRASES, WIDENING_PROSE, "Try the night market for dinner. You have loads of time.", "That gives you 9000 usable minutes. Try the dumplings.", "You won't need a visa for a short visit, so head into the city."]) {
    it(`a model that would say "${p.slice(0, 50)}…" is never asked, on a live and on an ended-by-status yes`, async () => {
      for (const s of [YES_SESSION(), ENDED_YES_SESSION()]) {
        const calls = model(p);
        const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: s, airport: AP, entry: PERMITTED });
        assert.equal(calls.n, 0);
        assert.ok(!a.answer.includes(p.split(".")[0]!), a.answer);
        assert.match(a.answer, CERTIFIED_YES_LEAD);
      }
    });
  }

  it("a THROWING model on an explicit yes is never reached; the certified text is complete without it", async () => {
    let calls = 0;
    _setTestOpenAI({ chat: { completions: { create: async () => { calls += 1; throw new Error("upstream 503"); } } } } as never);
    const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: ENDED_YES_SESSION(), airport: AP, entry: PERMITTED });
    assert.equal(calls, 0);
    assert.match(a.answer, CERTIFIED_YES_LEAD);
    assert.equal(a.modelConsulted, false);
  });

  it("§12.1 / L114 still holds on the certified-only answer: the clarifying question is computed and returned", async () => {
    // immigration unknown-in-effect: flipping it moves the outcome on a tight window
    const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: session(330), airport: AP, entry: PERMITTED });
    assert.ok(a.clarifyingQuestion !== null, JSON.stringify(a));
    assert.equal(a.modelConsulted, false);
  });
});

// ── 4. L-CL02c: what "live" means ───────────────────────────────────────────

describe("L-CL02c — layoverSessionIsLiveAt (LayoverSessionService, shared with lane L): LIVE if the status is not ended OR the departure is ahead OR unknown (fail closed)", () => {
  const now = Date.now();
  const at = (status: string, departureTime: unknown) => ({ status, departureTime } as never);
  it("cancelled with the departure still ahead is LIVE (the traveller who tapped cancel is still mid-layover)", () => {
    assert.equal(layoverSessionIsLiveAt(at("cancelled", new Date(now + 60_000).toISOString()), now), true);
  });
  it("cancelled / completed / expired with the departure passed are ENDED", () => {
    for (const st of ["cancelled", "completed", "expired"]) assert.equal(layoverSessionIsLiveAt(at(st, new Date(now - 60_000).toISOString()), now), false, st);
  });
  it("an ended status with a MISSING or UNREADABLE departure is LIVE", () => {
    for (const d of [null, undefined, "", "not a date", "2026-13-45T99:99:99Z"]) assert.equal(layoverSessionIsLiveAt(at("completed", d), now), true, String(d));
  });
  it("strict `>`: an ended status whose departure is exactly now is ENDED (the same truth table as lane L's layoverSessionIsLiveAt)", () => {
    assert.equal(layoverSessionIsLiveAt(at("cancelled", new Date(now).toISOString()), now), false);
    assert.equal(layoverSessionIsLiveAt(at("cancelled", new Date(now + 1).toISOString()), now), true);
  });
  it("a live or unknown status is LIVE whatever the clock", () => {
    for (const st of ["active", "returning", "", "unknown"]) assert.equal(layoverSessionIsLiveAt(at(st, new Date(now - 86_400_000).toISOString()), now), true, st);
  });
  it("cancelled + departure passed: the answer is the ENDED path — it certifies no, says no, and still asks no model", async () => {
    const calls = model(WIDENING_PROSE);
    const s = session(-60, { status: "cancelled" });
    assert.equal(layoverSessionIsLiveAt(s as never, Date.now()), false, "fixture: ended");
    const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: s, airport: AP, entry: PERMITTED });
    assert.equal(a.certification.verdict, "no");
    assert.match(a.answer, /^Leaving the airport is not recommended on this layover/);
    assert.equal(calls.n, 0);
  });
});

// ── 5. The gate and the certified text, directly ──────────────

describe("the gate and the certified text, directly", () => {
  const gate = (verdict: string, status: "open" | "caution" | "closed", cautions: string[] = []) =>
    ({ verdict, landsideGate: { open: status === "open", status, closedBy: status === "closed" ? ["insufficient_time"] : [], cautions } }) as never;

  it("layoverModelMayAnswer is true ONLY for verdict yes + an open gate + 30 usable minutes", () => {
    assert.equal(layoverModelMayAnswer(gate("yes", "open"), 30), true);
    assert.equal(layoverModelMayAnswer(gate("yes", "open"), 29), false, "under 30 usable minutes");
    assert.equal(layoverModelMayAnswer(gate("yes", "caution", ["tight_window"]), 300), false, "a yes whose gate is not open");
    assert.equal(layoverModelMayAnswer(gate("yes", "closed"), 300), false, "a yes whose gate is closed");
    for (const v of ["no", "tight", "entry_unverified", "stay_airside", "maybe", ""]) {
      assert.equal(layoverModelMayAnswer(gate(v, "open"), 300), false, v);
    }
  });

  it("the certified text says 'you can leave' only on an explicit yes", () => {
    const at = { usableMin: 300, bufferMin: 170, hardReturnLocal: "6:00 PM" };
    assert.match(certifiedLayoverText({ record: gate("yes", "open"), ...at }), /^You have about 300 minutes of usable time\. You can leave the airport — but make sure you're back at security by 6:00 PM/);
    for (const [v, st, c] of [["no", "closed", []], ["tight", "caution", ["tight_window"]], ["entry_unverified", "caution", ["entry_unconfirmed"]], ["stay_airside", "closed", []], ["yes", "caution", []], ["yes", "closed", []], ["unknown_verdict", "open", []]] as const) {
      const t = certifiedLayoverText({ record: gate(v, st, [...c]), ...at });
      assert.doesNotMatch(t, /you can leave the airport/i, `${v}/${st}`);
      assert.doesNotMatch(t, /6:00 PM/, `${v}/${st}: no return deadline below an explicit yes`);
    }
    assert.match(certifiedLayoverText({ record: gate("yes", "open"), ...at, usableMin: 20 }), /^With only 20 minutes of usable time/);
  });

  it("F2: an UNKNOWN usable window (NaN, undefined) never says 'you can leave' and is never 'Safe' — the text and the note go through the gate", () => {
    for (const u of [Number.NaN, undefined as unknown as number, Number.POSITIVE_INFINITY * 0]) {
      assert.equal(layoverModelMayAnswer(gate("yes", "open"), u), false, String(u));
      const t = certifiedLayoverText({ record: gate("yes", "open"), usableMin: u, bufferMin: 170, hardReturnLocal: "6:00 PM" });
      assert.doesNotMatch(t, /you can leave the airport/i, String(u));
      assert.doesNotMatch(t, /NaN|undefined/, String(u));
      assert.match(t, /^Your usable time on this layover could not be confirmed\./, String(u));
    }
  });

  it("F-W2: a NON-FINITE window (Infinity, 1e308 * 10) is no window either — gate closed, no 'you can leave', not 'Safe', no 'Infinity'", async () => {
    for (const u of [Number.POSITIVE_INFINITY, 1e308 * 10, Number.NEGATIVE_INFINITY]) {
      assert.equal(layoverModelMayAnswer(gate("yes", "open"), u), false, String(u));
      const t = certifiedLayoverText({ record: gate("yes", "open"), usableMin: u, bufferMin: 170, hardReturnLocal: "6:00 PM" });
      assert.doesNotMatch(t, /you can leave the airport/i, String(u));
      assert.doesNotMatch(t, /Infinity/, String(u));
    }
    const s = ENDED_YES_SESSION();
    const rec = certifySessionFeasibility(AP, s, { nowMs: Date.now(), entry: PERMITTED });
    const calls = model("Off you go.");
    const a = await answerLayoverQuestion({} as never, {
      question: "Can I leave the airport?", session: s, airport: AP, entry: PERMITTED,
      snapshot: { certifiedRecord: rec, usableMinutes: Number.POSITIVE_INFINITY, minutesToHardReturn: 300 } as never,
    });
    assert.equal(calls.n, 0);
    assert.doesNotMatch(a.answer, /you can leave the airport|Infinity/i, a.answer);
    assert.equal(a.safetyNote, safetyLabel("not_recommended"));
    // and the finite edge still opens: exactly 30 is a window
    assert.equal(layoverModelMayAnswer(gate("yes", "open"), 30), true);
  });

  it("F2 end to end: a certified-yes snapshot whose usable minutes are NaN gets no model, no 'you can leave', no 'Safe', no 'NaN'", async () => {
    const calls = model("Off you go — the cathedral is a short cab away.");
    const s = ENDED_YES_SESSION();
    const rec = certifySessionFeasibility(AP, s, { nowMs: Date.now(), entry: PERMITTED });
    assert.equal(rec.verdict, "yes", "fixture: certified yes");
    for (const bad of [Number.NaN, undefined]) {
      const a = await answerLayoverQuestion({} as never, {
        question: "Can I leave the airport?", session: s, airport: AP, entry: PERMITTED,
        snapshot: { certifiedRecord: rec, usableMinutes: bad, minutesToHardReturn: bad } as never,
      });
      assert.equal(a.modelConsulted, false, String(bad));
      assert.doesNotMatch(a.answer, /you can leave the airport/i, a.answer);
      assert.doesNotMatch(a.answer, /NaN|undefined/, a.answer);
      assert.notEqual(a.safetyNote, safetyLabel("safe"), String(bad));
      assert.equal(a.safetyNote, safetyLabel("not_recommended"), String(bad));
    }
    assert.equal(calls.n, 0);
  });

  it("an unknown caution code is not spelled out to the traveller", () => {
    const t = certifiedLayoverText({ record: gate("tight", "caution", ["some_future_code"]), usableMin: 60, bufferMin: 170, hardReturnLocal: "6:00 PM" });
    assert.match(t, /^Leaving the airport has not been confirmed as possible on this layover\. /);
    assert.ok(!t.includes("some_future_code"));
  });

  it("the airport facts are the profile's name and code and the record's figures, nothing else", () => {
    assert.equal(
      deterministicAirportFacts({ airport: { name: "Los Angeles International", iataCode: "LAX" }, availMin: 240, bufferMin: 170 }),
      "You're at Los Angeles International (LAX), with about 240 minutes until boarding; your required return buffer is 170 minutes.",
    );
  });

  // The composer (`confineModelProse`), the five-topic test (`namesSafetyTopic`)
  // and `splitSentences` filtered MODEL prose; L-CL02d deleted them with the
  // model branch (no model text exists on this door). Their absence is pinned by
  // the structural case in §1.

  it("`involvesLeaving` is a label: it marks the verifier's leaving phrasings it knows, and decides nothing shown", async () => {
    assert.equal(questionMentionsLeaving("Can I leave the airport?"), true);
    assert.equal(questionMentionsLeaving("Where can I eat?"), false);
    // The same not-yes session answers a labelled and an unlabelled question identically.
    const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: NO_SESSION(), airport: AP, entry: PERMITTED });
    const b = await answerLayoverQuestion({} as never, { question: "Where can I eat?", session: NO_SESSION(), airport: AP, entry: PERMITTED });
    assert.notEqual(a.involvesLeaving, b.involvesLeaving);
    assert.equal(a.answer.replace(/\d+ minutes until/, ""), b.answer.replace(/\d+ minutes until/, ""));
    assert.equal(a.safetyNote, b.safetyNote);
  });
});
