/**
 * Sensing §6 / §18.1 — the CONTEXT KERNEL's nine contexts (census-sensing S55)
 * and the OPPORTUNITY stage over it (S56, S46).
 *
 * Every rule is pinned on its own: the nine contexts are the spec's nine; an
 * unsupplied context is UNKNOWN and says so; safety is DERIVED from the world
 * reading and a caller cannot declare it; a suppressed subject yields no
 * opportunity at any relevance; a subject that produced none says WHY, and
 * "could not look" is a different why from "nothing to act on"; the projection
 * carries the evidence's own truth and window and NO world value; and a surface
 * projection is a subset, never a new field.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KERNEL_CONTEXTS,
  assembleContextKernel,
  dayPartOf,
  deriveSafetyContext,
  localHourFrom,
  unknownContexts,
  type AssembleKernelInput,
  type SubjectWorldContext,
} from "../lib/contextKernel.js";
import {
  BASE_RELEVANCE,
  KIND_OF_DECISION,
  OPPORTUNITY_KINDS,
  SURFACE_FIELDS,
  UNKNOWN_INTENT_FACTOR,
  buildOpportunities,
  opportunityWorldValueKeys,
  projectForSurface,
} from "../lib/opportunityEngine.js";
import { RELEVANCE_WEIGHT } from "../lib/attentionEngine.js";
import { buildCrowdState, envelopeTemporal } from "../lib/crowdState.js";
import { buildForecastState } from "../lib/forecastState.js";
import { truthOfEnvelopes } from "../lib/liveEnvelopeTruth.js";
import { isEmergingInfluenceEligible, isLiveConstraintEligible } from "../compass/CompassLiveConstraints.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-09-12T20:00:00.000Z");
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let seq = 0;
function env(over: Partial<LiveClaimEnvelope> = {}): LiveClaimEnvelope {
  seq += 1;
  return {
    id: `snap-${seq}`,
    claimType: "crowd.level",
    value: { level: "busy" },
    confidence: 0.85,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "few",
    observedAt: iso(-3),
    validUntil: iso(27),
    state: "live",
    conflictState: "none",
    conflict: null,
    ...over,
  };
}
const level = (l: string, over: Partial<LiveClaimEnvelope> = {}) => env({ claimType: "crowd.level", value: { level: l }, ...over });
const traj = (t: string, over: Partial<LiveClaimEnvelope> = {}) => env({ claimType: "crowd.trajectory", value: { trajectory: t }, ...over });

/** The same shape lib/contextKernelRead builds, without the database. */
function world(subjectId: string, envelopes: LiveClaimEnvelope[], readable = true): SubjectWorldContext {
  const crowd = buildCrowdState({ envelopes, qualifies: isLiveConstraintEligible }, NOW);
  const f = buildForecastState({ crowd, horizonMinutes: 60, calibration: null }, NOW);
  const usable = envelopes.filter((e) => isLiveConstraintEligible(e, NOW) || isEmergingInfluenceEligible(e, NOW));
  return {
    subjectId,
    readable,
    crowd,
    forecast: f.forecast,
    forecastRefused: f.refused,
    envelopes,
    truth: truthOfEnvelopes(usable, NOW),
    evidenceWindow: envelopeTemporal(usable, NOW),
  };
}

function kernel(over: Partial<AssembleKernelInput> = {}) {
  const subjects = over.subjects ?? [world(A, [level("busy"), traj("building")])];
  const etaMinutesBySubject: Record<string, number | null> = {};
  for (const s of subjects) etaMinutesBySubject[s.subjectId] = 10;
  return assembleContextKernel(
    {
      user: { intent: "social", queueToleranceMinutes: null, relevance: "saved" },
      spatial: { viewerPositionKnown: true, etaMinutesBySubject },
      attention: { available: true, deliveredInWindow: 0, budgetPerWindow: 3, seenIds: [] },
      ...over,
      subjects,
    },
    NOW,
  );
}

describe("ContextKernel — §18.1's nine", () => {
  it("is the spec's nine names, in the spec's order, and every one is present on the kernel", () => {
    assert.deepEqual(
      [...KERNEL_CONTEXTS],
      ["user", "temporal", "spatial", "trip", "social", "experience", "world", "safety", "attention"],
    );
    const k = kernel();
    for (const name of KERNEL_CONTEXTS) assert.ok(name in k, `${name} context is assembled`);
  });

  it("an unsupplied context is null and is REPORTED as unknown — never 'no trip', never 'alone'", () => {
    const k = kernel();
    assert.equal(k.trip, null);
    assert.equal(k.social, null);
    assert.equal(k.experience, null);
    assert.deepEqual(unknownContexts(k), ["trip", "social", "experience"]);
    const withTrip = kernel({ trip: { onTrip: true, dayIndex: 2, totalDays: 5, nextStopSubjectId: A } });
    assert.deepEqual(unknownContexts(withTrip), ["social", "experience"]);
  });

  it("local time comes from a DECLARED offset; without one the hour and the day part are null", () => {
    assert.equal(localHourFrom(NOW, null), null);
    assert.equal(localHourFrom(NOW, 9 * 60), 5, "20:00 UTC + 9h");
    assert.equal(localHourFrom(NOW, 15 * 60), null, "an impossible offset is refused, not clamped");
    assert.equal(dayPartOf(null), null);
    assert.equal(dayPartOf(3), "night", "before dawn is night, not early morning");
    assert.equal(dayPartOf(5), "early_morning");
    assert.equal(dayPartOf(14), "afternoon");
    assert.equal(dayPartOf(19), "evening");
    assert.equal(dayPartOf(23), "night");
    const k = kernel();
    assert.equal(k.temporal.localHour, null);
    assert.equal(k.temporal.dayPart, null);
    assert.equal(k.temporal.nowIso, iso(0));
  });

  it("SAFETY is derived from the world reading — a caller cannot declare a subject safe or unsafe", () => {
    const suppressed = world(A, [level("unsafe_density")]);
    const ordinary = world(B, [level("busy")]);
    assert.deepEqual(deriveSafetyContext([suppressed, ordinary]), {
      suppressedSubjectIds: [A],
      reasonBySubject: { [A]: "unsafe_density_reading" },
    });
    const k = kernel({ subjects: [suppressed, ordinary] });
    assert.deepEqual([...k.safety.suppressedSubjectIds], [A]);
    const code = readFileSync(join(SRC, "lib", "contextKernel.ts"), "utf8");
    assert.doesNotMatch(code, /input\.safety/, "the kernel takes no safety input at all");
  });

  it("carries no viewer id and no coordinate", () => {
    const k = kernel();
    const json = JSON.stringify(k);
    assert.doesNotMatch(json, /latitude|longitude|"lat"|"lng"|userId|profileId/);
    const code = readFileSync(join(SRC, "lib", "contextKernel.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /userId|viewerId|profileId|latitude|longitude/);
  });
});

describe("OpportunityStage — what becomes an opportunity", () => {
  it("a live reading that says GO NOW is a go_now opportunity with the live_reading reason", () => {
    const { opportunities, refusals } = buildOpportunities(kernel(), NOW);
    assert.equal(opportunities.length, 1);
    assert.deepEqual(refusals, []);
    const o = opportunities[0]!;
    assert.equal(o.kind, "go_now");
    assert.equal(o.decision, "GO_NOW");
    assert.ok(o.reasons.includes("live_reading"));
    assert.equal(o.reachable, true);
  });

  it("only four decisions are opportunities; WAIT, SKIP and STAY are refusals with the decision's own reasons", () => {
    assert.deepEqual(Object.keys(KIND_OF_DECISION).sort(), ["GO_NOW", "GO_SOON", "RETURN", "SWITCH"]);
    assert.deepEqual([...OPPORTUNITY_KINDS].sort(), ["go_now", "opening_window", "return_window", "switch_now"]);
    const quiet = buildOpportunities(kernel({ subjects: [world(A, [])] }), NOW);
    assert.deepEqual(quiet.opportunities, []);
    assert.equal(quiet.refusals[0]!.reason, "no_opportunity");
    assert.equal(quiet.refusals[0]!.decision, "WAIT");
    assert.ok(quiet.refusals[0]!.decisionReasons.includes("no_live_evidence"));
  });

  it("'could not look' is a DIFFERENT refusal from 'nothing to act on'", () => {
    const unreadable = buildOpportunities(kernel({ subjects: [world(A, [], false)] }), NOW);
    assert.deepEqual(unreadable.opportunities, []);
    assert.equal(unreadable.refusals[0]!.reason, "live_intelligence_unavailable");
    assert.ok(unreadable.refusals[0]!.decisionReasons.includes("live_intelligence_unavailable"));
  });

  it("an emerging, building subject is an opening_window carrying the emerging claim's own window", () => {
    const emerging = world(A, [
      traj("building", { state: "emerging", band: "likely_current", validUntil: iso(45) }),
      level("quiet", { state: "emerging", band: "likely_current", validUntil: iso(45) }),
    ]);
    const { opportunities } = buildOpportunities(kernel({ subjects: [emerging] }), NOW);
    const o = opportunities[0]!;
    assert.equal(o.kind, "opening_window");
    assert.equal(o.decision, "GO_SOON");
    assert.ok(o.reasons.includes("forecast_window"));
    assert.equal(o.window.effectiveUntil, iso(45), "the window is the evidence's, not the clock's");
    assert.equal(o.truth.confidence, "likely_current", "the emerging claim's own band");
  });
});

describe("OpportunityStage — safety outranks opportunity (§20)", () => {
  it("a suppressed subject yields NO opportunity at any relevance, and says so", () => {
    const unsafe = world(A, [level("unsafe_density"), traj("building")]);
    for (const relevance of ["saved", "trip_stop", "followed", "nearby", "none"] as const) {
      const k = kernel({ subjects: [unsafe], user: { intent: "high_energy", queueToleranceMinutes: null, relevance } });
      const { opportunities, refusals } = buildOpportunities(k, NOW);
      assert.deepEqual(opportunities, [], `no opportunity at relevance=${relevance}`);
      assert.deepEqual(refusals, [{ subjectId: A, reason: "safety_suppressed", decision: null, decisionReasons: [] }]);
    }
  });
  it("the suppressed subject is removed BEFORE ranking — a safe subject beside it is unaffected", () => {
    const k = kernel({ subjects: [world(A, [level("unsafe_density")]), world(B, [level("busy"), traj("building")])] });
    const { opportunities, refusals } = buildOpportunities(k, NOW);
    assert.deepEqual(opportunities.map((o) => o.subjectId), [B]);
    assert.deepEqual(refusals.map((r) => r.subjectId), [A]);
  });
});

describe("OpportunityStage — relevance is user-specific, and the world is untouched", () => {
  it("the relevance label moves it, through the Attention Engine's own weights", () => {
    const saved = buildOpportunities(kernel(), NOW).opportunities[0]!;
    const none = buildOpportunities(
      kernel({ user: { intent: "social", queueToleranceMinutes: null, relevance: "none" } }),
      NOW,
    ).opportunities[0]!;
    assert.ok(saved.relevance > none.relevance, "a saved place outranks an unrelated one");
    assert.ok(RELEVANCE_WEIGHT.saved > RELEVANCE_WEIGHT.none);
    assert.ok(saved.relevance <= BASE_RELEVANCE.go_now * RELEVANCE_WEIGHT.saved);
  });

  it("an undeclared intent is an absence, not a preference the engine invents", () => {
    const k = kernel({ user: { intent: null, queueToleranceMinutes: null, relevance: "saved" } });
    const o = buildOpportunities(k, NOW).opportunities[0]!;
    assert.ok(o.reasons.includes("intent_unknown"));
    assert.equal(o.relevance, BASE_RELEVANCE.go_now * RELEVANCE_WEIGHT.saved * UNKNOWN_INTENT_FACTOR);
  });

  it("an unknown ETA is an unknown interception, stated and discounted — never assumed reachable", () => {
    const k = kernel();
    const noEta = { ...k, spatial: { viewerPositionKnown: false, etaMinutesBySubject: {} } };
    const o = buildOpportunities(noEta, NOW).opportunities[0]!;
    assert.equal(o.reachable, null);
    assert.ok(o.reasons.includes("interception_unknown"));
  });

  it("ordering is deterministic: relevance descending, then subject id", () => {
    const k = kernel({ subjects: [world(C, [level("busy"), traj("building")]), world(B, [level("busy"), traj("building")])] });
    const ids = buildOpportunities(k, NOW).opportunities.map((o) => o.subjectId);
    assert.deepEqual(ids, [B, C]);
  });

  it("the projection carries the evidence's truth and window and NO world value", () => {
    const { opportunities } = buildOpportunities(kernel(), NOW);
    const o = opportunities[0]!;
    assert.deepEqual(o.truth, kernel().world.subjects[0]!.truth);
    assert.equal(o.window.observedAt, iso(-3));
    assert.deepEqual(opportunityWorldValueKeys(opportunities), []);
    const json = JSON.stringify(opportunities);
    assert.doesNotMatch(json, /"busy"|"building"|density|trajectory/);
  });

  it("the guard finds a world value when one is planted — it is not a vacuous check", () => {
    const planted = [{ subjectId: A, kind: "go_now", density: "packed" }];
    assert.deepEqual(opportunityWorldValueKeys(planted), ["0.density"]);
    assert.deepEqual(opportunityWorldValueKeys([{ subjectId: A, nested: { forecast: { level: "busy" } } }]).sort(), [
      "0.nested.forecast",
      "0.nested.forecast.level",
    ]);
  });
});

describe("Feature-specific projections", () => {
  it("every surface's field list is a SUBSET of the projection — a surface can drop, never add", () => {
    const o = buildOpportunities(kernel(), NOW).opportunities[0]!;
    const full = new Set(Object.keys(o));
    for (const [surface, fields] of Object.entries(SURFACE_FIELDS)) {
      for (const f of fields) assert.ok(full.has(f as string), `${surface}.${String(f)} exists on the projection`);
    }
  });
  it("the map gets four fields and no reasons; compass gets the decision it owns", () => {
    const os = buildOpportunities(kernel(), NOW).opportunities;
    assert.deepEqual(Object.keys(projectForSurface(os, "map")[0]!), ["subjectId", "kind", "relevance", "truth"]);
    assert.ok("decision" in projectForSurface(os, "compass")[0]!);
    assert.ok(!("decision" in projectForSurface(os, "wall")[0]!));
    for (const surface of ["map", "discovery", "wall", "home", "compass"] as const) {
      const p = projectForSurface(os, surface)[0]! as Record<string, unknown>;
      for (const [k, v] of Object.entries(p)) assert.deepEqual(v, (os[0] as unknown as Record<string, unknown>)[k], `${surface}.${k} is copied, not computed`);
    }
  });
  it("the stage is pure: no clock of its own and no database", () => {
    const code = readFileSync(join(SRC, "lib", "opportunityEngine.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /Date\.now\(|new Date\(\)/);
    assert.doesNotMatch(code, /supabase|getServiceClient|sc\.from\(/);
  });
});
