/**
 * Compass layover answers: certified server text for the five safety topics —
 * census-layover L3 / L101, built to the lead's 2026-10-06 ruling:
 *
 *   "for the five safety topics, Compass layover answers use deterministic,
 *    certified server text. Model text that touches those topics is replaced
 *    by that text, never shown. AI is not a safety dependency."
 *
 * census-layover §50.1 moved L3 and L101 back to W on four paraphrases that
 * passed the phrase deny-list and would have been PUBLISHED on a session whose
 * certified verdict was `no`. §50.1 also said what `C` needs: an answer composed
 * from certified fields, with model text confined to non-safety content and
 * refused when it names any of the five nouns at all. These cases hold that,
 * through `answerLayoverQuestion` with a stubbed model:
 *
 *   1. §50.1's four sentences, on a `no` session: none is shown; the answer is
 *      the certified text.
 *   2. The same four on a `yes` session: each names a topic and is dropped;
 *      the certified text is what remains.
 *   3. On a `no` session even a sentence naming NO topic is withheld — an
 *      implied invitation ("Off you go, enjoy the evening!") cannot widen a
 *      refused band.
 *   4. Positive controls: on a `yes` session, a non-safety sentence to a
 *      non-leaving question is shown as written; to a leaving question it
 *      follows the certified text.
 *   5. With no model at all, the certified text is the answer.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _setTestOpenAI } from "../../../lib/openai.js";
import {
  answerLayoverQuestion,
  confineModelProse,
  namesSafetyTopic,
  splitSentences,
} from "../LayoverCompassService.js";
import { certifySessionFeasibility } from "../LayoverFeasibility.js";
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

function session(departInMin: number) {
  const t = Date.now();
  return {
    id: "s1", userId: "u1", airportId: "ap-1", tripId: null,
    arrivalTime: new Date(t - 30 * 60_000).toISOString(),
    departureTime: new Date(t + departInMin * 60_000).toISOString(),
    boardingTime: null, layoverMinutes: departInMin + 30, flightType: "international",
    immigrationRequired: true, checkedBags: false, loungeAccess: false, wantsToLeave: true,
    comfortLevel: "moderate", vibeChips: [], manualAirportName: null, manualCity: null,
    manualCountry: null, manualIata: null, canonicalCityId: null, shareCityStatus: false,
    returnReminderAt: null, status: "active", createdAt: "", updatedAt: "",
  } as never;
}
const NO_SESSION = () => session(150);   // usable 0 — certified `no`
const YES_SESSION = () => session(600);  // ten hours, corridor permitted — certified `yes`

function model(text: string) {
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content: text } }] }) } } } as never;
}

const PARAPHRASES = [
  "You've got loads of time, so head into the city.",
  "Lines at passport control are tiny tonight.",
  "No need to rush back, the queues are a breeze.",
  "Your plane leaves late, so stay out longer.",
];

afterEach(() => _setTestOpenAI(null));

describe("precondition: the two sessions are certified as the cases say", () => {
  it("NO_SESSION is `no` and YES_SESSION is `yes`", () => {
    assert.equal(certifySessionFeasibility(AP, { ...(NO_SESSION() as object), id: "s1" } as never, { nowMs: Date.now(), entry: PERMITTED }).verdict, "no");
    assert.equal(certifySessionFeasibility(AP, { ...(YES_SESSION() as object), id: "s1" } as never, { nowMs: Date.now(), entry: PERMITTED }).verdict, "yes");
  });
});

describe("§50.1's four paraphrases are never shown", () => {
  for (const p of PARAPHRASES) {
    it(`on a session certified NO: ${p}`, async () => {
      _setTestOpenAI(model(p));
      const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: NO_SESSION(), airport: AP, entry: PERMITTED });
      assert.ok(!a.answer.includes(p), a.answer);
      assert.equal(a.modelProse.mode, "certified_only");
      assert.match(a.answer, /not recommended|staying inside the airport/);
    });
    it(`on a session certified YES the sentence names a topic and is dropped: ${p}`, async () => {
      _setTestOpenAI(model(p));
      const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: YES_SESSION(), airport: AP, entry: PERMITTED });
      assert.ok(!a.answer.includes(p), a.answer);
      assert.equal(a.modelProse.mode, "confined");
      assert.equal(a.modelProse.droppedSentences, 1);
      assert.match(a.answer, /make sure you're back at security by/);
    });
  }
});

describe("on a session certified NO, no model sentence is shown at all", () => {
  it("an implied invitation that names no topic is withheld too", async () => {
    _setTestOpenAI(model("Off you go, enjoy the evening!"));
    const a = await answerLayoverQuestion({} as never, { question: "What should I do?", session: NO_SESSION(), airport: AP, entry: PERMITTED });
    assert.ok(!/Off you go/.test(a.answer), a.answer);
    assert.equal(a.modelProse.mode, "certified_only");
  });
});

describe("positive controls — what the model may still say", () => {
  it("on a YES session, a non-safety answer to a non-leaving question is shown as written", async () => {
    _setTestOpenAI(model("Try the beef noodle soup at the food court."));
    const a = await answerLayoverQuestion({} as never, { question: "What should I eat?", session: YES_SESSION(), airport: AP, entry: PERMITTED });
    assert.equal(a.answer, "Try the beef noodle soup at the food court.");
    assert.equal(a.modelProse.mode, "model_non_safety");
  });
  it("on a YES session, a leaving question gets the certified text first, then the non-safety sentence; the timing sentence is dropped", async () => {
    _setTestOpenAI(model("Try the night market for dinner. You have loads of time."));
    const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: YES_SESSION(), airport: AP, entry: PERMITTED });
    assert.match(a.answer, /^You have about \d+ minutes of usable time\. You can leave the airport/);
    assert.ok(a.answer.endsWith("Try the night market for dinner."), a.answer);
    assert.ok(!/loads of time/.test(a.answer));
    assert.equal(a.modelProse.droppedSentences, 1);
  });
  it("on a YES session, a leaving question ALWAYS leads with the certified text, even when the model named no topic", async () => {
    _setTestOpenAI(model("Try the night market for dinner."));
    const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: YES_SESSION(), airport: AP, entry: PERMITTED });
    assert.match(a.answer, /^You have about \d+ minutes of usable time\. You can leave the airport/);
    assert.ok(a.answer.endsWith("Try the night market for dinner."), a.answer);
    assert.equal(a.modelProse.mode, "confined");
    assert.equal(a.modelProse.droppedSentences, 0);
  });
  it("with no model at all, the certified text is the answer", async () => {
    const a = await answerLayoverQuestion({} as never, { question: "Can I leave the airport?", session: NO_SESSION(), airport: AP, entry: PERMITTED });
    assert.match(a.answer, /not recommended|staying inside the airport/);
  });
});

describe("the topic test and the composer, directly", () => {
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
  it("a non-yes verdict shows only the certified text whatever the model wrote", () => {
    for (const verdict of ["no", "tight", "entry_unverified", "stay_airside"]) {
      const r = confineModelProse({ modelText: "Try the dumplings.", certified: "CERTIFIED.", verdict, involvesLeaving: false });
      assert.equal(r.answer, "CERTIFIED.", verdict);
    }
  });
});
