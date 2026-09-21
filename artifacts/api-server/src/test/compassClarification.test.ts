/**
 * census-compass CL-04 — the CLARIFICATION clause.
 *
 * CL-04 asks the Compass row of the Layover spec for four things: tool access
 * to certified context, proactive OpportunityEvents, explanation, and
 * CLARIFICATION. §26.9 closed the first three and recorded the fourth as the
 * one still open: nothing in `compass/` decided whether a layover request was
 * UNDER-DETERMINED, so an unstated fact was answered by guessing rather than by
 * asking.
 *
 * This suite pins the computation, not a prompt instruction:
 *   - `CompassClarification.decideClarification` is pure: certified snapshot +
 *     the facts the caller says were STATED in, one question or none out.
 *   - it NEVER invents the fact it is missing — a missing fact produces a
 *     question, never a value, and a single reading is not an ambiguity;
 *   - when everything required is known it answers "no clarification needed"
 *     rather than manufacturing a question;
 *   - an UNREADABLE layover store is `context_unreadable`, never
 *     `no_live_layover` — the same distinction CL-03 pinned for the snapshot;
 *   - `get_clarifying_question` surfaces it to the model in the same shape as
 *     the other tools in CompassTools.ts.
 *
 * The scorer is NOT a second one: `decideClarification` ranks with
 * `domain/trips/services/TripValueOfInformation.valueOfInformation`, the §12.3
 * value-of-information already used by `questionsWorthAsking`.
 *
 * TEST-FIRST. Written before `CompassClarification.ts` existed and before
 * `get_clarifying_question` was declared; the first run failed at module load
 * ("Cannot find module '../compass/CompassClarification.js'"), which is the
 * right reason — the computation did not exist.
 *
 * Mutation log (each applied ALONE, suite run, source restored):
 *   M1 an unreadable layover store reported as `no_live_layover`        → red
 *   M2 a question manufactured when every required fact is known        → red
 *   M3 the materiality gate dropped (a fact that changes nothing asked) → red
 *   M4 a SINGLE reading accepted as an ambiguity                        → GREEN
 *   M4b the same mutation, after the duplicate guard was collapsed      → red
 *
 * M4 SURVIVED, and is kept here rather than deleted, because what it found is
 * worth more than the mutation: "fewer than two readings is not an ambiguity"
 * was written TWICE in CompassClarification.ts — once as a demotion in
 * `unknownsFor`, once as a `>= 2` re-check in `questionFor`. With the rule in
 * two places, breaking either alone changed no behaviour, so neither site was
 * load-bearing and no test could hold the rule down. The re-check was removed
 * so the demotion is the one place the rule lives, and the identical mutation
 * (M4b) then went red.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassClarification.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideClarification,
  clarificationFactsFromToolArgs,
  CLARIFIABLE_FACTS,
  type ClarificationSnapshot,
} from "../compass/CompassClarification.js";
import {
  COMPASS_TOOL_DEFINITIONS,
  COMPASS_TOOL_NAMES,
  toolGetClarifyingQuestion,
} from "../compass/CompassTools.js";
import { VOI_ASK_THRESHOLD } from "../domain/trips/services/TripValueOfInformation.js";
import { TRAVEL_TIME_UNMEASURED_UNKNOWN } from "../services/airport/LayoverSafetyEngine.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const USER = "aa000000-0000-4000-8000-000000000001";

/** A layover whose landside is OPEN — every required fact can still move it. */
function openSnapshot(over: Partial<ClarificationSnapshot> = {}): ClarificationSnapshot {
  return {
    verdict: "yes",
    returnState: "NORMAL",
    landsideOpen: true,
    landsideClosedReason: null,
    usableMinutes: 240,
    minutesToHardReturn: 300,
    reasonCodes: ["ENTRY_NOT_CONFIRMED"],
    unknowns: ["Visa or transit-permit requirements for your nationality", TRAVEL_TIME_UNMEASURED_UNKNOWN],
    ...over,
  };
}

/** Everything the four clarifiable facts could be, all already stated. */
const ALL_KNOWN = Object.fromEntries(
  CLARIFIABLE_FACTS.map((f) => [f, { state: "known" as const }]),
);

/** A client whose layover_sessions read answers as told (same shape as CL-03's). */
function sessionsDb(mode: "unreadable" | "none") {
  const answer = mode === "unreadable"
    ? { data: null, error: { message: "connection reset", code: "08006" } }
    : { data: null, error: null };
  const b: any = {
    select() { return b; }, eq() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
    maybeSingle() { return Promise.resolve(answer); },
    then(res: any) { res(mode === "unreadable" ? answer : { data: [], error: null }); },
  };
  return { from: () => b } as any;
}

describe("CL-04 — an under-determined layover request is ASKED about, not guessed", () => {
  it("the one question is the decisive one, and it names the fact it resolves", () => {
    const v: any = decideClarification({ snapshot: openSnapshot(), facts: {} });
    assert.equal(v.needed, true, JSON.stringify(v));
    assert.equal(v.fact, "leave_or_stay", "leaving or staying decides everything downstream");
    assert.ok(v.value >= VOI_ASK_THRESHOLD, "asked only above the §12.3 threshold");
    assert.match(String(v.resolves), /landside|leave/i);
    assert.match(String(v.question), /\?$/, "a clarification is a question");
    // The smallest number of questions: exactly one, the rest stay uncertainty.
    assert.equal(typeof v.question, "string");
    assert.ok(Array.isArray(v.representedAsUncertainty));
    assert.ok(!v.representedAsUncertainty.includes("leave_or_stay"));
  });

  it("a fact the user already STATED is never asked about again", () => {
    const v: any = decideClarification({
      snapshot: openSnapshot(),
      facts: { leave_or_stay: { state: "known" } },
    });
    assert.equal(v.needed, true);
    assert.notEqual(v.fact, "leave_or_stay");
    assert.equal(v.fact, "checked_bags", "the next decisive unknown, by value of information");
  });

  it("when everything required is known it says NO clarification is needed — it does not manufacture one", () => {
    const v: any = decideClarification({ snapshot: openSnapshot(), facts: ALL_KNOWN });
    assert.equal(v.needed, false, JSON.stringify(v));
    assert.equal(v.reason, "everything_required_is_known");
    assert.equal(v.question, undefined, "no question text is invented for a complete request");
    assert.equal(v.fact, undefined);
  });

  it("a fact whose answer could not change the advice stays uncertainty — landside closed, nothing to ask", () => {
    const closed = openSnapshot({
      landsideOpen: false,
      landsideClosedReason: "return threshold reached",
      verdict: "stay_airside",
      returnState: "RETURN_NOW",
    });
    const v: any = decideClarification({ snapshot: closed, facts: {} });
    assert.equal(v.needed, false, JSON.stringify(v));
    assert.equal(v.reason, "no_answer_would_change_the_advice");
    assert.deepEqual(
      [...v.representedAsUncertainty].sort(),
      [...CLARIFIABLE_FACTS].sort(),
      "every fact is still unknown — it is just not worth a question",
    );
  });

  it("an AMBIGUOUS fact is asked with the readings the caller supplied, and NO reading it did not", () => {
    const v: any = decideClarification({
      snapshot: openSnapshot(),
      facts: {
        leave_or_stay: { state: "ambiguous", readings: ["stay in the terminal lounge", "go into the city"] },
      },
    });
    assert.equal(v.needed, true);
    assert.equal(v.fact, "leave_or_stay");
    assert.match(v.question, /stay in the terminal lounge/);
    assert.match(v.question, /go into the city/);
    // Neither reading is chosen, and no third one is invented.
    assert.ok(!/assum/i.test(v.question), "a clarification never announces an assumption");
    assert.equal(
      (String(v.question).match(/stay in the terminal lounge|go into the city/g) ?? []).length,
      2,
      "both readings appear exactly once; nothing else is offered as a reading",
    );
  });

  it("a SINGLE reading is not an ambiguity — it falls back to the plain question and is never presented as the answer", () => {
    const one: any = decideClarification({
      snapshot: openSnapshot(),
      facts: { leave_or_stay: { state: "ambiguous", readings: ["go into the city"] } },
    });
    const plain: any = decideClarification({ snapshot: openSnapshot(), facts: {} });
    assert.equal(one.needed, true);
    assert.equal(one.fact, "leave_or_stay");
    assert.equal(one.question, plain.question, "one reading is not two readings; it is simply unstated");
    assert.ok(!String(one.question).includes("go into the city"), "a lone reading must never be echoed as if it were established");
  });

  it("an UNREADABLE layover store is `context_unreadable` — never `no_live_layover`, and never a question", () => {
    const v: any = decideClarification({ snapshot: null, contextUnreadableReason: "layover_sessions_unreadable", facts: {} });
    assert.equal(v.needed, false);
    assert.equal(v.reason, "context_unreadable");
    assert.equal(v.question, undefined);
  });

  it("no live layover is an ANSWER, not a refusal, and asks nothing", () => {
    const v: any = decideClarification({ snapshot: null, facts: {} });
    assert.equal(v.needed, false);
    assert.equal(v.reason, "no_live_layover");
  });

  it("the entry-permission question is asked only when the certified record says entry is NOT confirmed", () => {
    const facts = { leave_or_stay: { state: "known" as const }, checked_bags: { state: "known" as const }, landside_destination: { state: "known" as const } };
    const withCode: any = decideClarification({ snapshot: openSnapshot(), facts });
    assert.equal(withCode.needed, true);
    assert.equal(withCode.fact, "entry_permission");
    const withoutCode: any = decideClarification({ snapshot: openSnapshot({ reasonCodes: [] }), facts });
    assert.equal(withoutCode.needed, false, "no ENTRY_NOT_CONFIRMED ⇒ the answer moves nothing");
    assert.equal(withoutCode.reason, "no_answer_would_change_the_advice");
  });

  it("the destination question is asked only when the record itself says travel time was not measured", () => {
    const facts = { leave_or_stay: { state: "known" as const }, checked_bags: { state: "known" as const }, entry_permission: { state: "known" as const } };
    const unmeasured: any = decideClarification({ snapshot: openSnapshot(), facts });
    assert.equal(unmeasured.fact, "landside_destination");
    const measured: any = decideClarification({ snapshot: openSnapshot({ unknowns: [] }), facts });
    assert.equal(measured.needed, false);
  });
});

describe("CL-04 — the tool the model calls", () => {
  it("get_clarifying_question is declared and dispatchable, and says never to guess", () => {
    assert.ok(COMPASS_TOOL_NAMES.has("get_clarifying_question"));
    const def = COMPASS_TOOL_DEFINITIONS.find((t) => t.function.name === "get_clarifying_question");
    assert.ok(def, "the tool is declared");
    assert.match(def!.function.description, /never (?:guess|invent)/i);
  });

  it("an UNREADABLE session store yields NO question and says why — it is not read as 'nothing to ask'", async () => {
    const r: any = await toolGetClarifyingQuestion(sessionsDb("unreadable"), USER, {});
    assert.equal(r.clarificationNeeded, false);
    assert.equal(r.reason, "context_unreadable");
    assert.equal(r.question, undefined);
  });

  it("no live layover yields no question, as an answer", async () => {
    const r: any = await toolGetClarifyingQuestion(sessionsDb("none"), USER, {});
    assert.equal(r.clarificationNeeded, false);
    assert.equal(r.reason, "no_live_layover");
  });

  it("the tool's args become fact STATES and nothing else — an unknown key is ignored, not believed", () => {
    const facts: any = clarificationFactsFromToolArgs({
      stated: ["leave_or_stay", "not_a_fact"],
      ambiguous: [{ fact: "checked_bags", readings: ["one bag checked through", "one bag to collect"] }],
    });
    assert.deepEqual(facts.leave_or_stay, { state: "known" });
    assert.equal(facts.not_a_fact, undefined, "a key that is not a clarifiable fact is dropped");
    assert.equal(facts.checked_bags.state, "ambiguous");
    assert.deepEqual(facts.checked_bags.readings, ["one bag checked through", "one bag to collect"]);
    // No args at all means nothing was stated — NOT that everything is known.
    assert.deepEqual(clarificationFactsFromToolArgs({}), {});
  });

  it("the tool consumes the ONE certified door and the ONE scorer — no second snapshot, no second VOI", () => {
    const clar = strip(readFileSync(join(SRC, "compass", "CompassClarification.ts"), "utf8"));
    assert.match(clar, /from "\.\.\/domain\/trips\/services\/TripValueOfInformation\.js"/);
    assert.doesNotMatch(clar, /probabilityChangesDecision\s*\*\s*stakes/, "the scoring arithmetic belongs to TripValueOfInformation, not here");
    const tools = strip(readFileSync(join(SRC, "compass", "CompassTools.ts"), "utf8"));
    assert.match(tools, /decideClarification/);
    assert.match(tools, /certifiedLayoverSnapshot\(sc as any, userId\)/);
  });
});
