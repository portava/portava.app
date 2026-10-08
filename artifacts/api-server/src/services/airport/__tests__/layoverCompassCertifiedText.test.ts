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
 *   3. On an explicit yes the certified text LEADS every answer; model
 *      sentences that name a safety topic are dropped; the rest follow it.
 *   4. The gate, the composer and the certified text, directly.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _setTestOpenAI } from "../../../lib/openai.js";
import {
  answerLayoverQuestion,
  confineModelProse,
  certifiedLayoverText,
  deterministicAirportFacts,
  layoverModelMayAnswer,
  namesSafetyTopic,
  questionMentionsLeaving,
  splitSentences,
} from "../LayoverCompassService.js";
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
const YES_SESSION = () => session(600);  // ten hours, corridor permitted — certified `yes`

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

describe("L3-FC-3 — on an explicit yes the certified text leads every answer", () => {
  for (const p of PARAPHRASES) {
    it(`§50.1's paraphrase names a topic and is dropped; the certified text alone remains: ${p}`, async () => {
      const calls = model(p);
      const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: YES_SESSION(), airport: AP, entry: PERMITTED });
      assert.equal(calls.n, 1);
      assert.equal(a.modelConsulted, true);
      assert.ok(!a.answer.includes(p), a.answer);
      assert.equal(a.modelProse.mode, "certified_only");
      assert.equal(a.modelProse.droppedSentences, 1);
      assert.match(a.answer, CERTIFIED_YES_LEAD);
    });
  }

  for (const q of [...VERIFIER_LEAVING_QUESTIONS, ...OTHER_QUESTIONS]) {
    it(`"${q}": the widening prose can only FOLLOW the certified deadline sentence`, async () => {
      model(WIDENING_PROSE);
      const a = await answerLayoverQuestion({} as never, { question: q, session: YES_SESSION(), airport: AP, entry: PERMITTED });
      assert.match(a.answer, CERTIFIED_YES_LEAD, a.answer);
      assert.equal(a.modelProse.mode, "confined");
      assert.equal(a.safetyNote, safetyLabel("safe"));
    });
  }

  it("BY RULING, not a gap: on an explicit yes a sentence the topic vocabulary does not know is shown — after the certified text", async () => {
    for (const p of VERIFIER_PARAPHRASES) {
      model(p);
      const a = await answerLayoverQuestion({} as never, { question: "Where can I eat?", session: YES_SESSION(), airport: AP, entry: PERMITTED });
      assert.match(a.answer, CERTIFIED_YES_LEAD, p);
      if (!namesSafetyTopic(p)) assert.ok(a.answer.endsWith(p), `${p}: ${a.answer}`);
    }
  });

  it("a non-safety answer follows the certified text; a topic sentence beside it is dropped", async () => {
    model("Try the night market for dinner. You have loads of time.");
    const a = await answerLayoverQuestion({} as never, { question: "What should I eat?", session: YES_SESSION(), airport: AP, entry: PERMITTED });
    assert.match(a.answer, CERTIFIED_YES_LEAD);
    assert.ok(a.answer.endsWith("Try the night market for dinner."), a.answer);
    assert.ok(!/loads of time/.test(a.answer));
    assert.equal(a.modelProse.mode, "confined");
    assert.equal(a.modelProse.droppedSentences, 1);
  });

  it("an answer the §12 guard refuses contributes NO sentence, not even a clean one (a model that tried to widen is not trusted for the rest)", async () => {
    model("That gives you 9000 usable minutes. Try the dumplings.");
    const a = await answerLayoverQuestion({} as never, { question: "What should I eat?", session: YES_SESSION(), airport: AP, entry: PERMITTED });
    assert.ok(a.boundaryViolations.some((v) => v.kind === "usable_time_widened"), JSON.stringify(a.boundaryViolations));
    assert.ok(!/dumplings|9000/.test(a.answer), a.answer);
    assert.equal(a.modelProse.mode, "certified_only");
    assert.match(a.answer, CERTIFIED_YES_LEAD);
  });

  it("an unreachable model on an explicit yes leaves the certified text, complete", async () => {
    _setTestOpenAI({ chat: { completions: { create: async () => { throw new Error("upstream 503"); } } } } as never);
    const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: YES_SESSION(), airport: AP, entry: PERMITTED });
    assert.match(a.answer, CERTIFIED_YES_LEAD);
    assert.equal(a.modelProse.mode, "certified_only");
    assert.equal(a.modelConsulted, true);
  });
});

// ── 3. The gate, the composer and the certified text, directly ──────────────

describe("the gate, the composer and the certified text, directly", () => {
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

  it("F2 end to end: a certified-yes snapshot whose usable minutes are NaN gets no model, no 'you can leave', no 'Safe', no 'NaN'", async () => {
    const calls = model("Off you go — the cathedral is a short cab away.");
    const s = YES_SESSION();
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

  it("the composer: below an explicit yes only the certified text, whatever it is handed", () => {
    const r = confineModelProse({ modelText: "Try the dumplings. " + VERIFIER_PARAPHRASES.join(" "), certified: "CERTIFIED.", modelMayAnswer: false });
    assert.equal(r.answer, "CERTIFIED.");
    assert.equal(r.modelProse.mode, "certified_only");
  });

  it("the composer: on an explicit yes the certified text leads, clean sentences follow, topic sentences are dropped", () => {
    assert.deepEqual(confineModelProse({ modelText: "Try the dumplings. Be back by six.", certified: "CERTIFIED.", modelMayAnswer: true }),
      { answer: "CERTIFIED. Try the dumplings.", modelProse: { mode: "confined", droppedSentences: 1 } });
    assert.deepEqual(confineModelProse({ modelText: "Be back by six.", certified: "CERTIFIED.", modelMayAnswer: true }),
      { answer: "CERTIFIED.", modelProse: { mode: "certified_only", droppedSentences: 1 } });
    assert.deepEqual(confineModelProse({ modelText: "", certified: "CERTIFIED.", modelMayAnswer: true }),
      { answer: "CERTIFIED.", modelProse: { mode: "certified_only", droppedSentences: 0 } });
  });

  it("each of the five topics is named by a plain sentence", () => {
    for (const s of [
      "You have twenty minutes.", "Be back by six.", "No visa is needed.", "The security line is short.",
      "It is safe to go.", "Your flight is delayed.", "Head into town.",
    ]) assert.ok(namesSafetyTopic(s), s);
    for (const s of ["Try the dumplings.", "The noodle bar is excellent.", "Ask for the house tea."]) assert.ok(!namesSafetyTopic(s), s);
  });

  it("splits sentences without losing a fragment", () => {
    assert.deepEqual(splitSentences("One. Two! Three"), ["One.", "Two!", "Three"]);
  });

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
