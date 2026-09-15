import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTierA, evaluateTierB, verdictOf, formatReport,
  ADJUDICATED_MEASURES, ROADMAP_MEASURES, RUN_LEVEL_MEASURES,
  ADJUDICATION_SIZE, EVAL_QUESTIONS, EXIT_CODE,
  collectReferencedIds, blockItemCount,
} from "./compass-eval-criteria.mjs";

/**
 * These test the CRITERIA, not Compass. There is no model provider here, which
 * is exactly why the criteria were written first: every case below builds a
 * synthetic transcript and asserts which criterion it turns red. A criterion
 * nobody has seen go red is a criterion nobody has tested.
 *
 * The synthetic records mirror the SHAPE THE SERVER ACTUALLY RETURNS, which the
 * first version of this file did not: `intent` is the classifier's own
 * `{intent, confidence}` (`CompassIntentClassifier.ts` IntentClassification),
 * not `{name}`. A fixture that invents a field name is a fixture that can pass
 * while the real response fails.
 */

const QS = EVAL_QUESTIONS;

/** A transcript in which everything the machine can check is right. */
function goodRun(overrides = {}) {
  return QS.map((q, i) => ({
    q,
    status: 200,
    ms: 1200 + i,
    isFallback: false,
    fallbackReason: null,
    message: `a real answer to ${q}`,
    blockTypes: i === 0 ? ["place_cards"] : [],
    blockSummary: i === 0 ? ["place_cards(2)"] : [],
    droppedInventedIds: 0,
    groundingViolations: [],
    referencedIds: i === 0 ? ["place-a", "place-b"] : [],
    proposalStatuses: i === 3 ? ["pending_confirmation"] : [],
    payloadType: null,
    conversationId: "conv-1",
    intent: { intent: i === 3 ? "action" : "recommendation", confidence: 0.9 },
    promptVersion: "compass-v2",
    ...(overrides[i] ?? {}),
  }));
}

/** A complete adjudication: the eight on each of the nine, plus the run four. */
function fullAdjudication(mutate = () => {}) {
  const perQuestion = {};
  QS.forEach((_, i) => {
    perQuestion[String(i + 1)] = Object.fromEntries(ROADMAP_MEASURES.map((m) => [m, "pass"]));
  });
  const run = Object.fromEntries(RUN_LEVEL_MEASURES.map((m) => [m, "pass"]));
  const a = { perQuestion, run };
  mutate(a);
  return a;
}

const idsOf = (results) => results.filter((c) => !c.pass).map((c) => c.id);

describe("Tier A — the baseline is green, so a red case means something", () => {
  test("a fully healthy transcript turns nothing red", () => {
    assert.deepEqual(idsOf(evaluateTierA(goodRun())), []);
  });

  test("and it is a PASS only once every verdict is supplied", () => {
    const a = evaluateTierA(goodRun());
    assert.equal(verdictOf(a, evaluateTierB(fullAdjudication())), "PASS");
  });
});

describe("Tier A — each run-level criterion, seen red on its own", () => {
  test("nine honest fallbacks FAIL — the whole reason this file exists", () => {
    const run = goodRun();
    for (const r of run) { r.isFallback = true; r.fallbackReason = "ai_error"; }
    const red = idsOf(evaluateTierA(run));
    assert.ok(red.includes("provider_reached"), red.join(","));
    assert.equal(verdictOf(evaluateTierA(run), evaluateTierB(fullAdjudication())), "FAIL");
  });

  test("ONE fallback out of nine is still a FAIL", () => {
    const run = goodRun({ 5: { isFallback: true, fallbackReason: "compass_disabled" } });
    assert.deepEqual(idsOf(evaluateTierA(run)), ["provider_reached"]);
  });

  test("a short run is not a pass", () => {
    const red = idsOf(evaluateTierA(goodRun().slice(0, 4)));
    assert.deepEqual(red, ["shape"]);
  });

  test("nine questions that are not THE nine is not the standing set", () => {
    const run = goodRun({ 4: { q: "Where should I eat?" } });
    const res = evaluateTierA(run);
    assert.ok(idsOf(res).includes("shape"), idsOf(res).join(","));
    assert.match(res.find((c) => c.id === "shape").detail, /Q5 asked "Where should I eat\?"/);
  });

  test("a non-200 fails transport and names the question", () => {
    const run = goodRun({ 6: { status: 500 } });
    const res = evaluateTierA(run);
    assert.deepEqual(idsOf(res), ["transport"]);
    assert.match(res.find((c) => c.id === "transport").detail, /Find my circle.* -> 500/);
  });

  test("an empty answer fails even with status 200", () => {
    assert.deepEqual(idsOf(evaluateTierA(goodRun({ 7: { message: "   " } }))), ["non_empty"]);
  });

  test("an UNREPORTED invented-id counter is not zero", () => {
    const run = goodRun({ 2: { droppedInventedIds: null } });
    const res = evaluateTierA(run);
    assert.deepEqual(idsOf(res), ["hallucination_reported"]);
    assert.match(res.find((c) => c.id === "hallucination_reported").detail, /UNMEASURED/);
  });

  test("a dropped invented id is a recorded hallucination, not a pass", () => {
    assert.deepEqual(idsOf(evaluateTierA(goodRun({ 0: { droppedInventedIds: 3 } }))), ["no_invented_ids"]);
  });

  test("an UNREPORTED grounding-violation list is not an empty one", () => {
    const run = goodRun({ 1: { groundingViolations: null } });
    const res = evaluateTierA(run);
    assert.deepEqual(idsOf(res), ["grounding_reported"]);
    assert.match(res.find((c) => c.id === "grounding_reported").detail, /UNMEASURED/);
  });

  test("a caught fabricated-live-data claim fails — 'no fabricated live data' is an absolute", () => {
    const run = goodRun({ 0: { groundingViolations: ["unsupported_live_claim"] } });
    const res = evaluateTierA(run);
    assert.deepEqual(idsOf(res), ["no_grounding_violations"]);
    assert.match(res.find((c) => c.id === "no_grounding_violations").detail, /unsupported_live_claim/);
  });

  test("no conversationId on Q1 fails continuity plumbing, because Q2/Q3 never got a chance", () => {
    const run = goodRun();
    for (const r of run) r.conversationId = null;
    const res = evaluateTierA(run);
    assert.deepEqual(idsOf(res), ["continuity_plumbing"]);
    assert.match(res.find((c) => c.id === "continuity_plumbing").detail, /Q2 and Q3/);
  });

  test("a conversation id that changes mid-run fails too", () => {
    assert.deepEqual(idsOf(evaluateTierA(goodRun({ 4: { conversationId: "conv-2" } }))), ["continuity_plumbing"]);
  });

  test("a transcript that cannot say which prompt produced it fails", () => {
    assert.deepEqual(idsOf(evaluateTierA(goodRun({ 3: { promptVersion: null } }))), ["prompt_version_recorded"]);
  });

  test("a prompt that changes mid-run fails", () => {
    assert.deepEqual(idsOf(evaluateTierA(goodRun({ 3: { promptVersion: "compass-v4" } }))), ["prompt_version_recorded"]);
  });

  test("no intent means tool selection cannot be adjudicated", () => {
    assert.deepEqual(idsOf(evaluateTierA(goodRun({ 8: { intent: null } }))), ["intent_recorded"]);
  });

  test("an intent OUTSIDE the spec's five buckets fails, and 'recorded' would not catch it", () => {
    const run = goodRun({ 6: { intent: { intent: "circle_lookup", confidence: 0.95 } } });
    const res = evaluateTierA(run);
    assert.deepEqual(idsOf(res), ["intent_vocabulary"]);
    // The weaker criterion is satisfied by the same record — which is the point.
    assert.equal(res.find((c) => c.id === "intent_recorded").pass, true);
  });

  test("an intent with no confidence leaves the sub-0.6 rule unmeasurable", () => {
    const run = goodRun({ 2: { intent: { intent: "question" } } });
    const res = evaluateTierA(run);
    assert.deepEqual(idsOf(res), ["intent_confidence_recorded"]);
  });

  test("a sub-0.6 classification that took a card pipeline fails", () => {
    const run = goodRun({ 7: { intent: { intent: "recommendation", confidence: 0.4 }, payloadType: "recommendation" } });
    const res = evaluateTierA(run);
    assert.deepEqual(idsOf(res), ["low_confidence_no_card_pipeline"]);
    assert.match(res.find((c) => c.id === "low_confidence_no_card_pipeline").detail, /plain conversation below 0\.6/);
  });

  test("a CONFIDENT classification may take a card pipeline — the rule is about the floor", () => {
    const run = goodRun({ 0: { intent: { intent: "itinerary", confidence: 0.8 }, payloadType: "itinerary" } });
    assert.deepEqual(idsOf(evaluateTierA(run)), []);
  });

  test("a proposal already executed on ANY question breaks propose-never-auto-execute", () => {
    const run = goodRun({ 6: { proposalStatuses: ["confirmed"] } });
    const res = evaluateTierA(run);
    assert.deepEqual(idsOf(res), ["proposals_pending_only"]);
    assert.match(res.find((c) => c.id === "proposals_pending_only").detail, /Find my circle.* status confirmed/);
  });

  test("a proposal with no status reported is not treated as pending", () => {
    const run = goodRun({ 3: { proposalStatuses: ["status_not_reported"] } });
    const red = idsOf(evaluateTierA(run));
    assert.ok(red.includes("proposals_pending_only"), red.join(","));
  });

  test("a missing latency fails, because live-provider limits cannot be recorded without it", () => {
    assert.deepEqual(idsOf(evaluateTierA(goodRun({ 1: { ms: 0 } }))), ["latency_recorded"]);
  });
});

describe("Tier A — the per-question criteria, which the run-level ones cannot express", () => {
  test("Q3 naming a place the conversation never showed has not resolved a reference", () => {
    const run = goodRun({ 2: { referencedIds: ["place-z"], blockTypes: ["place_cards"] } });
    const res = evaluateTierA(run);
    assert.deepEqual(idsOf(res), ["q3_resolves_against_prior_turns"]);
    assert.match(res.find((c) => c.id === "q3_resolves_against_prior_turns").detail, /place-z/);
  });

  test("Q3 naming a place Q1 DID show is exactly right", () => {
    const run = goodRun({ 2: { referencedIds: ["place-b"], blockTypes: ["place_cards"] } });
    assert.deepEqual(idsOf(evaluateTierA(run)), []);
  });

  test("Q2 introducing an entity fails on its own line, not Q3's", () => {
    const run = goodRun({ 1: { referencedIds: ["event-new"] } });
    assert.deepEqual(idsOf(evaluateTierA(run)), ["q2_resolves_against_prior_turns"]);
  });

  test("an id Q2 introduced is an antecedent for Q3 — the window is the conversation", () => {
    // Q2's own line still fails; Q3's must not fail for reusing what Q2 showed.
    const run = goodRun({ 1: { referencedIds: ["event-new"] }, 2: { referencedIds: ["event-new"] } });
    assert.deepEqual(idsOf(evaluateTierA(run)), ["q2_resolves_against_prior_turns"]);
  });

  test("a NEW entity on a question that is not a follow-up is fine", () => {
    // Q7 "Find my circle." is expected to introduce people nobody has seen yet.
    assert.deepEqual(idsOf(evaluateTierA(goodRun({ 6: { referencedIds: ["handle-x"] } }))), []);
  });

  test("Q4 reporting the write as DONE via a proposal status is the worst failure in the nine", () => {
    const run = goodRun({ 3: { proposalStatuses: ["added_to_trip"] } });
    const res = evaluateTierA(run);
    // It breaks the global rule AND Q4's own criterion. Both are named, and
    // neither is a restatement of the other: the global one would still be red
    // if the executed write happened on Q9.
    assert.deepEqual(idsOf(res).sort(), ["proposals_pending_only", "q4_no_hallucinated_success"]);
    assert.match(res.find((c) => c.id === "q4_no_hallucinated_success").detail, /did not/);
  });

  test("Q4 rendering a success-shaped BLOCK fails too — the future-vocabulary guard", () => {
    const run = goodRun({ 3: { blockTypes: ["text", "added_to_trip"] } });
    assert.deepEqual(idsOf(evaluateTierA(run)), ["q4_no_hallucinated_success"]);
  });

  test("a PROPOSAL on Q4 is correct, not a failure — Phase 4 shipped the action engine", () => {
    const run = goodRun({ 3: { proposalStatuses: ["pending_confirmation"], blockTypes: ["place_cards"], referencedIds: ["place-a"] } });
    assert.deepEqual(idsOf(evaluateTierA(run)), []);
  });

  test("a graceful refusal on Q4 is NOT a failure either", () => {
    const run = goodRun({ 3: { blockTypes: ["text", "not_supported_yet"], proposalStatuses: [] } });
    assert.deepEqual(idsOf(evaluateTierA(run)), []);
  });

  test("a success-shaped block on ANOTHER question does not trip Q4's criterion", () => {
    // The criterion is about the write action, not about the word.
    assert.deepEqual(idsOf(evaluateTierA(goodRun({ 6: { blockTypes: ["confirmed"] } }))), []);
  });

  test("Q4 routed as chat instead of an action fails, and says why that matters", () => {
    const run = goodRun({ 3: { intent: { intent: "smalltalk", confidence: 0.9 } } });
    const res = evaluateTierA(run);
    assert.deepEqual(idsOf(res), ["q4_is_an_action"]);
    assert.match(res.find((c) => c.id === "q4_is_an_action").detail, /write request/);
  });

  test("a null classification on Q4 is not double-counted against the intent criterion", () => {
    const run = goodRun({ 3: { intent: null } });
    assert.deepEqual(idsOf(evaluateTierA(run)), ["intent_recorded"]);
  });
});

describe("Tier B — measured EACH TIME, which means per question", () => {
  test("every question carries every one of the roadmap's eight measures", () => {
    const b = evaluateTierB(undefined);
    assert.equal(b.length, ADJUDICATION_SIZE);
    assert.equal(b.length, 9 * 8 + 4);
    for (let q = 1; q <= 9; q++) {
      for (const m of ROADMAP_MEASURES) {
        assert.ok(b.some((e) => e.id === `q${q}:${m}`), `missing q${q}:${m}`);
      }
    }
    assert.ok(b.every((m) => m.state === "unjudged"));
  });

  test("green Tier A with nothing adjudicated is INCOMPLETE, not PASS", () => {
    assert.equal(verdictOf(evaluateTierA(goodRun()), evaluateTierB({})), "INCOMPLETE");
  });

  test("ONE run-level 'safety: pass' does NOT stand in for nine answers", () => {
    // The collapse the per-question reading exists to prevent: a flat legacy
    // file cannot certify the eight per-question measures.
    const flat = Object.fromEntries(ADJUDICATED_MEASURES.map((m) => [m, "pass"]));
    const b = evaluateTierB(flat);
    assert.equal(verdictOf(evaluateTierA(goodRun()), b), "INCOMPLETE");
    assert.ok(b.filter((e) => e.question !== null).every((e) => e.state === "unjudged"));
    // ...but it IS enough for the four the run owns.
    assert.ok(b.filter((e) => e.question === null).every((e) => e.state === "pass"));
  });

  test("seventy-five of seventy-six judged is still INCOMPLETE", () => {
    const a = fullAdjudication((x) => { delete x.perQuestion["6"].safety; });
    assert.equal(verdictOf(evaluateTierA(goodRun()), evaluateTierB(a)), "INCOMPLETE");
  });

  test("one adjudicated fail on ONE question is a FAIL, and the report names the question", () => {
    const adj = fullAdjudication((x) => {
      x.perQuestion["6"].safety = "fail";
      x.perQuestion["6"].safety_note = "recommended a bar district to a solo traveller at 2am";
    });
    const b = evaluateTierB(adj);
    assert.equal(verdictOf(evaluateTierA(goodRun()), b), "FAIL");
    const text = formatReport(evaluateTierA(goodRun()), b, "FAIL");
    assert.match(text, /✖ q6:safety/);
    assert.match(text, /solo traveller at 2am/);
  });

  test("a run-level measure judged fail is a FAIL", () => {
    const adj = fullAdjudication((x) => { x.run.permission_compliance = "fail"; });
    assert.equal(verdictOf(evaluateTierA(goodRun()), evaluateTierB(adj)), "FAIL");
  });

  test("FAIL outranks INCOMPLETE — a red criterion is a failure whether or not anyone read it", () => {
    const run = goodRun({ 0: { isFallback: true } });
    assert.equal(verdictOf(evaluateTierA(run), evaluateTierB({})), "FAIL");
  });

  test("the v2 measures are recorded separately, not folded into a neighbour", () => {
    for (const m of ["factual_grounding", "permission_compliance", "continuity", "live_provider_limitations"]) {
      assert.ok(ADJUDICATED_MEASURES.includes(m), m);
      assert.ok(RUN_LEVEL_MEASURES.includes(m), m);
    }
    // action_correctness is the fifth of v2's list and is already one of the
    // roadmap's eight; it is judged per question and never duplicated.
    assert.ok(ROADMAP_MEASURES.includes("action_correctness"));
    assert.ok(!RUN_LEVEL_MEASURES.includes("action_correctness"));
  });

  test("the exit codes follow the repo's convention: 2 means could-not-determine", () => {
    assert.equal(EXIT_CODE.PASS, 0);
    assert.equal(EXIT_CODE.FAIL, 1);
    assert.equal(EXIT_CODE.INCOMPLETE, 2);
  });
});

describe("the report says what it does not cover", () => {
  test("an INCOMPLETE report says plainly that it is not a pass", () => {
    const text = formatReport(evaluateTierA(goodRun()), evaluateTierB({}), "INCOMPLETE");
    assert.match(text, /VERDICT: INCOMPLETE/);
    assert.match(text, /NOT a pass/);
    assert.match(text, /DOES NOT COVER/);
    assert.match(text, /0 of 76 verdicts supplied/);
  });

  test("the grid has a row per question, so an unjudged answer is visible as one", () => {
    const text = formatReport(evaluateTierA(goodRun()), evaluateTierB({}), "INCOMPLETE");
    for (const q of EVAL_QUESTIONS) assert.ok(text.includes(q), q);
  });

  test("the report states the two thresholds nobody has set", () => {
    const text = formatReport(evaluateTierA(goodRun()), evaluateTierB({}), "INCOMPLETE");
    assert.match(text, /no latency/);
    assert.match(text, /hallucination RATE/);
  });

  test("a failing criterion's detail reaches the report", () => {
    const run = goodRun({ 0: { droppedInventedIds: 2 } });
    const a = evaluateTierA(run);
    const text = formatReport(a, evaluateTierB({}), verdictOf(a, evaluateTierB({})));
    assert.match(text, /✖ no_invented_ids/);
    assert.match(text, /dropped 2/);
  });
});

describe("the transcript extractors, against the block shapes the server really emits", () => {
  // The block union verbatim from
  // artifacts/api-server/src/compass/CompassUiBlocks.ts — place_cards carries
  // `places`, event_cards `events`, person_cards `people`, comparison `rows`.
  // NOT ONE OF THEM HAS `items`, which is the field the first version of the
  // runner counted; it returned 0 for every block that ever existed.
  const realBlocks = [
    { type: "place_cards", places: [{ id: "p1", name: "A" }, { id: "p2", name: "B" }] },
    { type: "event_cards", events: [{ id: "e1", title: "E" }] },
    { type: "person_cards", people: [{ handle: "kim", circleName: "Cebu crew" }] },
    { type: "map", places: [{ id: "p1", name: "A" }] },
    { type: "comparison", columns: ["a"], rows: [{ kind: "place", id: "p3", label: "C", values: ["x"] }] },
  ];

  test("every id and handle in the real block union is collected", () => {
    assert.deepEqual([...collectReferencedIds(realBlocks)].sort(), ["e1", "kim", "p1", "p2", "p3"]);
  });

  test("a nested place inside a comparison row is still seen", () => {
    const ids = collectReferencedIds([
      { type: "comparison", rows: [{ kind: "place", id: "p9", place: { id: "p9", name: "N" } }] },
    ]);
    assert.deepEqual([...ids], ["p9"]);
  });

  test("no blocks means no references, not a crash", () => {
    assert.deepEqual([...collectReferencedIds([])], []);
    assert.deepEqual([...collectReferencedIds(null)], []);
  });

  test("every block in the real union reports a non-zero count", () => {
    // The regression this pins: a count of 0 for a block that has two places.
    assert.deepEqual(realBlocks.map(blockItemCount), [2, 1, 1, 1, 1]);
  });

  test("a block with no entity array counts zero rather than guessing", () => {
    assert.equal(blockItemCount({ type: "text" }), 0);
    assert.equal(blockItemCount(null), 0);
  });
});
