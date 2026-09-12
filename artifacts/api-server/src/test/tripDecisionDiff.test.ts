/**
 * Trips spec §23.1 scenario corpus and §24 decision-diff CI, in-process.
 * census-trips TR409 (the corpus + harness), TR410 (the four report classes),
 * TR433 (scenario tests across engines).
 *
 *   1. the corpus reaches every engine the harness knows, and two runs of the
 *      same tree are byte-identical;
 *   2. the tree agrees with golden.json — the same contract CI enforces, so a
 *      changed decision fails here before it fails there;
 *   3. each of §24's report classes is produced by the mutation that should
 *      produce it: a flipped trigger is a changed decision with conservatism
 *      moving; a conflict the golden lacks is a NEW CONFLICT; a scenario
 *      replaced wholesale is a LARGE diff; an added or removed scenario is
 *      reported as such;
 *   4. the golden cannot be written without a note.
 *
 * Run: node --import tsx/esm --test src/test/tripDecisionDiff.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { tripScenarioCorpus } from "../scenarios/trips/corpus.js";
import { DECISION_ENGINES, canonicalJson, conservatismScore, enginesExercised, runTripScenarioCorpus, type ScenarioDecisions } from "../scenarios/trips/run.js";
import { LARGE_DIFF_RATIO, diffDecisions, flattenLeaves, formatReport } from "../scenarios/trips/diff.js";
import { GOLDEN_PATH, readGolden, writeGolden } from "../scenarios/trips/golden.js";

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("§23.1 the corpus", () => {
  it("eight scenarios with unique ids and spec references, reaching every engine the harness records", () => {
    const corpus = tripScenarioCorpus();
    assert.ok(corpus.length >= 8, `${corpus.length} scenarios`);
    assert.equal(new Set(corpus.map((s) => s.id)).size, corpus.length, "ids are unique");
    for (const s of corpus) assert.ok(s.spec.length >= 1 && s.spec.every((x) => x.startsWith("§")), `${s.id} cites the spec`);
    const reached = new Set(runTripScenarioCorpus().flatMap(enginesExercised));
    assert.deepEqual([...DECISION_ENGINES].filter((e) => !reached.has(e)), [], "every engine has at least one scenario");
  });
  it("deterministic: two runs of the same tree are the same bytes", () => {
    const a = canonicalJson(runTripScenarioCorpus());
    const b = canonicalJson(runTripScenarioCorpus());
    assert.equal(a, b);
  });
  it("the §23 scenarios decide what their tests assert: the flight delay moves the museum and proposes it; the rain cancels the walk with its booking and adds the museum; the safety event suppresses discovery and interrupts", () => {
    const byId = new Map(runTripScenarioCorpus().map((d) => [d.scenario, d]));
    const flight = byId.get("flight_delay_on_arrival")!;
    assert.equal(flight.triggers!.find((t) => t.kind === "tight_arrival")!.fired, true);
    assert.ok(flight.replan!.entries.some((e) => e.planId === "museum" && e.op === "move" && e.sharedMutation));
    assert.deepEqual(flight.replan!.proposals, ["museum"]);
    const rain = byId.get("rain_invalidates_tour")!;
    assert.equal(rain.triggers!.find((t) => t.kind === "weather_sensitive")!.fired, true);
    assert.deepEqual(rain.compile!.opportunity!.removed.map((r) => r.candidateId), ["tour"]);
    assert.equal(rain.compile!.opportunity!.significance, "high");
    const cancel = rain.replan!.entries.find((e) => e.planId === "walk")!;
    assert.equal(cancel.op, "cancel"); assert.equal(rain.replan!.requiresUserConfirmation, true);
    assert.ok(rain.replan!.entries.some((e) => e.op === "add" && e.experienceId?.endsWith(":museum")));
    const safety = byId.get("safety_event")!;
    assert.equal(safety.health.priority.mode, "SAFETY_EVENT"); assert.equal(safety.health.priority.suppression.discovery, true);
    assert.equal(safety.pulse!.kept.length, 0); assert.equal(safety.pulse!.dropped.length, 2);
    assert.equal(safety.attention.find((a) => a.kind === "safety_alert")!.level, "INTERRUPT");
    assert.equal(safety.attention.find((a) => a.kind === "opportunity_added")!.level, "PASSIVE");
    const conflict = byId.get("no_time_to_travel")!;
    assert.ok(conflict.freedom!.conflicts.some((c) => c.kind === "NO_TIME_TO_TRAVEL"), JSON.stringify(conflict.freedom!.conflicts));
    assert.ok(conflict.planOverlaps.length >= 1);
    assert.equal(conflict.impact![0].feasibility, "INFEASIBLE");
    const meet = byId.get("nightlife_crew_meetup")!;
    // bo's train back at FAR pulls the least-burden point toward him: the station or the café, never a refused venue
    assert.ok(["cafe", "station"].includes(meet.meeting!.recommended!), meet.meeting!.recommended ?? "none");
    const refusals = Object.fromEntries(meet.meeting!.refused.map((x) => [x.candidateId, x.refusals]));
    assert.deepEqual(refusals.hotel, ["PRIVATE_ANCHOR"]); assert.deepEqual(refusals.closed, ["VENUE_CLOSED"]); assert.deepEqual(refusals.tiny, ["PARTY_EXCEEDS_CAPACITY"]);
    assert.deepEqual(refusals.mall, ["VENUE_UNSUITABLE"]); assert.deepEqual(refusals.stairs, ["ACCESSIBILITY_UNMET"]);
    assert.deepEqual(meet.meeting!.unplaced.map((u) => u.userId), ["dee"]);
    assert.equal(meet.triggers!.find((t) => t.kind === "crew_transport_mismatch")!.fired, true);
    const closed = byId.get("closed_venue_uncertain_hours")!;
    const verdict = Object.fromEntries(closed.compile!.before.experiences.map((e) => [e.candidateId, e.verdict]));
    assert.equal(verdict["early-closer"], "NOT_EXECUTABLE"); assert.equal(verdict["unknown-hours"], "UNCERTAIN"); assert.equal(verdict["cafe"], "EXECUTABLE");
    assert.ok(closed.compile!.questions, "§12.3 asked");
  });
});

describe("§24 the golden contract", () => {
  it("golden.json exists and the tree agrees with it (a changed decision fails here before CI)", () => {
    assert.ok(existsSync(GOLDEN_PATH), `no golden at ${GOLDEN_PATH}: pnpm -s check:trip-decision-diff -- --update --note "…"`);
    const golden = readGolden()!;
    assert.ok(golden.note.trim().length >= 12, "the golden carries its reason");
    const report = diffDecisions(golden.decisions, runTripScenarioCorpus());
    assert.ok(report.ok, "\n" + formatReport(report));
  });
  it("the golden cannot be written without a note", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "trip-golden-"));
    const file = path.join(dir, "golden.json");
    assert.throws(() => writeGolden(runTripScenarioCorpus(), "   ", null, file), /needs a note/);
    assert.equal(existsSync(file), false);
    writeGolden(runTripScenarioCorpus(), "a test-only golden, never committed", "abc1234", file);
    const back = readGolden(file)!;
    assert.equal(back.head, "abc1234"); assert.equal(back.decisions.length, tripScenarioCorpus().length);
  });
});

describe("§24 the four report classes, each produced by the mutation that should produce it", () => {
  const actual = runTripScenarioCorpus();
  const mutated = (edit: (g: ScenarioDecisions[]) => void): ScenarioDecisions[] => { const g = clone(actual); edit(g); return g; };
  const find = (list: ScenarioDecisions[], id: string): ScenarioDecisions => list.find((d) => d.scenario === id)!;

  it("changed decision + conservatism: a trigger the golden says did NOT fire, firing in the tree, is one changed leaf and conservatism INCREASED; the reverse is DECREASED", () => {
    const golden = mutated((g) => { find(g, "flight_delay_on_arrival").triggers!.find((t) => t.kind === "tight_arrival")!.fired = false; });
    const r = diffDecisions(golden, actual);
    assert.equal(r.ok, false); assert.deepEqual(r.changedScenarios, ["flight_delay_on_arrival"]);
    const s = r.scenarios.find((x) => x.scenario === "flight_delay_on_arrival")!;
    assert.equal(s.changes.length, 1); assert.match(s.changes[0].path, /triggers\[\d+\]\.fired$/); assert.equal(s.changes[0].before, false); assert.equal(s.changes[0].after, true);
    assert.equal(s.conservatism.direction, "increased"); assert.deepEqual(r.conservatismIncreased, ["flight_delay_on_arrival"]); assert.equal(s.large, false);
    const reverse = diffDecisions(actual, golden);
    assert.deepEqual(reverse.conservatismDecreased, ["flight_delay_on_arrival"]);
    assert.match(formatReport(r), /flight_delay_on_arrival: CHANGED — 1\/\d+ leaves .*conservatism \d+ → \d+ \(increased\)/);
  });
  it("new conflict: a conflict the golden lacks and the tree asserts is named as NEW CONFLICT; removed from the tree it is 'resolved'", () => {
    const golden = mutated((g) => { const d = find(g, "no_time_to_travel"); d.freedom!.conflicts = []; d.planOverlaps = []; });
    const r = diffDecisions(golden, actual);
    const s = r.scenarios.find((x) => x.scenario === "no_time_to_travel")!;
    assert.ok(s.newConflicts.some((k) => k.startsWith("NO_TIME_TO_TRAVEL:")), JSON.stringify(s.newConflicts));
    assert.ok(s.newConflicts.some((k) => k.startsWith("PLAN_OVERLAP:")));
    assert.ok(r.newConflicts.every((c) => c.scenario === "no_time_to_travel"));
    assert.equal(s.conservatism.direction, "increased");
    assert.match(formatReport(r), /NEW CONFLICT\s+NO_TIME_TO_TRAVEL:/);
    const reverse = diffDecisions(actual, golden);
    assert.ok(reverse.scenarios.find((x) => x.scenario === "no_time_to_travel")!.resolvedConflicts.length >= 2);
  });
  it("large diff: a scenario whose decisions were replaced wholesale crosses the ratio and is reported as LARGE; a one-leaf change is not", () => {
    const golden = mutated((g) => { const d = find(g, "booked_dinner_cancellation"); d.impact = []; d.urgency = []; d.replan = null; });
    const r = diffDecisions(golden, actual);
    const s = r.scenarios.find((x) => x.scenario === "booked_dinner_cancellation")!;
    assert.ok(s.changeRatio > LARGE_DIFF_RATIO, `${s.changeRatio}`); assert.equal(s.large, true); assert.deepEqual(r.largeUnexplained, ["booked_dinner_cancellation"]);
    assert.match(formatReport(r), /booked_dinner_cancellation: CHANGED .* LARGE DIFF/);
  });
  it("added and removed scenarios are reported, and both count as large", () => {
    const golden = mutated((g) => { g.splice(g.findIndex((d) => d.scenario === "safety_event"), 1); g.push({ ...clone(find(g, "solo_city_day")), scenario: "retired_scenario" }); });
    const r = diffDecisions(golden, actual);
    assert.equal(r.scenarios.find((x) => x.scenario === "safety_event")!.status, "added");
    assert.equal(r.scenarios.find((x) => x.scenario === "retired_scenario")!.status, "removed");
    assert.deepEqual([...r.largeUnexplained].sort(), ["retired_scenario", "safety_event"]);
  });
  it("the leaf flattener counts empty containers as leaves, so [] → [x] is a change and not a silence", () => {
    assert.deepEqual([...flattenLeaves({ a: [], b: { c: 1 } }).entries()], [["$.a", "[]"], ["$.b.c", 1]]);
    const r = diffDecisions([{ ...clone(actual[0]), urgency: [] }], [actual[0]]);
    assert.ok(r.scenarios[0].changes.some((c) => c.path === "$.urgency" && c.before === "[]"));
  });
  it("conservatism counts every 'no' once and is monotone in them", () => {
    const d = find(actual, "no_time_to_travel");
    const fewer = clone(d); fewer.freedom!.conflicts = []; fewer.planOverlaps = [];
    assert.ok(conservatismScore(d) > conservatismScore(fewer));
  });
});
