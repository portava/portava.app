/**
 * Sensing §10 / §11 — the Compass decision engine (census-sensing S78, S80, S86).
 *
 * Every rule is pinned on its own so a mutation of one cannot hide behind
 * another: safety outranks everything; no live evidence is WAIT, never GO;
 * "could not look" is a different WAIT from "saw nothing"; an emerging,
 * building candidate is GO SOON; friction; intent conflict; peak interception
 * against the earliest horizon; RETURN; the switching cost and the dwell that
 * raises a known current value; and the grounded sentence that can never say
 * what everyone is doing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPASS_DECISIONS,
  SWITCHING_COST,
  DEFAULT_QUEUE_TOLERANCE_MINUTES,
  decideCompass,
  experienceValue,
  currentExperienceValue,
  interceptPeak,
  summariseLiveState,
  type DecisionInput,
} from "../lib/compassDecision.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-09-12T20:00:00.000Z");
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
const crowd = (level: string, over: Partial<LiveClaimEnvelope> = {}) => env({ value: { level }, ...over });
const subject = (subjectId: string, envelopes: LiveClaimEnvelope[], readable = true) => ({ subjectId, envelopes, readable });
const decide = (over: Partial<DecisionInput>) =>
  decideCompass({ candidate: subject(A, [crowd("busy")]), etaMinutes: 10, intent: "social", ...over }, NOW);

describe("vocabulary", () => {
  it("is §10's seven decisions, verbatim", () => {
    assert.deepEqual([...COMPASS_DECISIONS], ["GO_NOW", "GO_SOON", "WAIT", "STAY", "SWITCH", "SKIP", "RETURN"]);
  });
  it("reads no clock and no database", () => {
    const code = readFileSync(join(SRC, "lib", "compassDecision.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /Date\.now\(|new Date\(\)/);
    assert.doesNotMatch(code, /supabase|getServiceClient|\.from\(/);
  });
});

describe("1. safety outranks opportunity", () => {
  it("a Live unsafe_density candidate is SKIP for every viewer, whatever the intent, ETA or current experience", () => {
    for (const intent of ["quiet", "social", "high_energy", "explore", null] as const) {
      const r = decide({ candidate: subject(A, [crowd("unsafe_density")]), intent, etaMinutes: 1, current: { ...subject(B, [crowd("dead")]), sinceMinutes: 5 } });
      assert.equal(r.decision, "SKIP");
      assert.deepEqual(r.reasons, ["safety_outranks_opportunity"]);
      assert.match(r.summary, /safety reading outranks/);
    }
  });
  it("an unsafe_density claim that is NOT Live-qualified does not count as a reading at all", () => {
    const r = decide({ candidate: subject(A, [crowd("unsafe_density", { state: "emerging", band: "provisional" })]) });
    assert.notEqual(r.decision, "SKIP");
    assert.equal(r.candidate.unsafe, false);
  });
});

describe("2. already here", () => {
  it("the candidate being the current subject is STAY", () => {
    const r = decide({ current: { ...subject(A, [crowd("busy")]), sinceMinutes: 10 } });
    assert.equal(r.decision, "STAY");
    assert.deepEqual(r.reasons, ["already_here"]);
  });
});

describe("3. no live evidence ≠ quiet", () => {
  it("nothing served, gates open: WAIT with no_live_evidence — never GO", () => {
    const r = decide({ candidate: subject(A, []) });
    assert.equal(r.decision, "WAIT");
    assert.deepEqual(r.reasons, ["no_live_evidence"]);
    assert.equal(r.grounding.truthClass, "unknown");
    assert.match(r.summary, /No current crowd reading \(no current evidence\)/);
  });
  it("the read was refused: WAIT with a DIFFERENT reason — could not look ≠ saw nothing", () => {
    const r = decide({ candidate: subject(A, [], false) });
    assert.equal(r.decision, "WAIT");
    assert.deepEqual(r.reasons, ["live_intelligence_unavailable"]);
  });
  it("only a typical / stale / predicted claim: still WAIT, and the grounding says what it rests on", () => {
    const r = decide({ candidate: subject(A, [crowd("busy", { state: "typical", band: "provisional", sourceClass: "historical_pattern" })]) });
    assert.equal(r.decision, "WAIT");
    assert.equal(r.grounding.truthClass, "predicted");
  });
  it("emerging AND building: GO SOON, labelled below the live floor", () => {
    const r = decide({
      candidate: subject(A, [
        crowd("moderate", { state: "emerging", band: "likely_current" }),
        env({ claimType: "crowd.trajectory", value: { trajectory: "building" }, state: "emerging", band: "likely_current" }),
      ]),
    });
    assert.equal(r.decision, "GO_SOON");
    assert.deepEqual(r.reasons, ["building_not_yet_live"]);
    assert.match(r.summary, /building, below the live floor/);
  });
  it("emerging without a building trajectory is WAIT", () => {
    const r = decide({ candidate: subject(A, [crowd("moderate", { state: "emerging", band: "likely_current" })]) });
    assert.equal(r.decision, "WAIT");
  });
});

describe("4. friction", () => {
  it("walk-in refused is SKIP", () => {
    const r = decide({ candidate: subject(A, [crowd("busy"), env({ claimType: "access.walk_in", value: { accepted: false } })]) });
    assert.equal(r.decision, "SKIP");
    assert.deepEqual(r.reasons, ["walk_in_refused"]);
  });
  it("a queue past the tolerance is WAIT; within a wider tolerance it is not", () => {
    const cand = subject(A, [crowd("busy"), env({ claimType: "queue.wait", value: { minMinutes: DEFAULT_QUEUE_TOLERANCE_MINUTES + 15, maxMinutes: null } })]);
    assert.equal(decide({ candidate: cand }).decision, "WAIT");
    assert.deepEqual(decide({ candidate: cand }).reasons, ["queue_exceeds_tolerance"]);
    assert.equal(decide({ candidate: cand, queueToleranceMinutes: 60 }).decision, "GO_NOW");
  });
});

describe("5. intent compatibility — busy ≠ good", () => {
  it("packed is SKIP for a viewer who wants quiet, and GO NOW for one who wants high energy", () => {
    const cand = subject(A, [crowd("packed")]);
    assert.equal(decide({ candidate: cand, intent: "quiet" }).decision, "SKIP");
    assert.deepEqual(decide({ candidate: cand, intent: "quiet" }).reasons, ["intent_conflict"]);
    assert.equal(decide({ candidate: cand, intent: "high_energy" }).decision, "GO_NOW");
  });
  it("experience value is intent-relative and unknown without an intent", () => {
    const busy = summariseLiveState(subject(A, [crowd("busy")]), NOW);
    assert.equal(experienceValue(busy, null), null);
    assert.equal(experienceValue(busy, "explore"), null);
    assert.equal(experienceValue(busy, "quiet"), 0.2);
    assert.equal(experienceValue(busy, "social"), 1);
    const quiet = summariseLiveState(subject(A, [crowd("quiet")]), NOW);
    assert.equal(experienceValue(quiet, "quiet"), 1);
    assert.equal(experienceValue(quiet, "social"), 0.3);
    const none = summariseLiveState(subject(A, []), NOW);
    assert.equal(experienceValue(none, "social"), null, "no reading, no value — not zero");
  });
});

describe("6. peak interception (§11)", () => {
  it("arrival after the earliest horizon is WAIT; before it, the margin is reported", () => {
    const late = decide({ etaMinutes: 40 }); // horizon +27 min
    assert.equal(late.decision, "WAIT");
    assert.deepEqual(late.reasons, ["window_may_decay_before_arrival"]);
    assert.equal(late.interception.reachable, false);
    assert.equal(late.interception.marginMinutes, -13);
    assert.match(late.summary, /13 min past its horizon/);
    const early = decide({ etaMinutes: 10 });
    assert.equal(early.decision, "GO_NOW");
    assert.equal(early.interception.reachable, true);
    assert.equal(early.interception.marginMinutes, 17);
  });
  it("the horizon is the EARLIEST of the qualifying claims", () => {
    const cand = subject(A, [crowd("busy", { validUntil: iso(50) }), env({ claimType: "vibe.state", value: { state: "social" }, validUntil: iso(12) })]);
    const r = decide({ candidate: cand, etaMinutes: 15 });
    assert.equal(r.decision, "WAIT");
    assert.equal(r.interception.horizonAt, iso(12));
  });
  it("a TTL shorter than validUntil tightens the horizon", () => {
    const r = decide({ etaMinutes: 10, ttlSecondsFor: () => 5 * 60 }); // observed −3 min + 5 min = +2 min
    assert.equal(r.decision, "WAIT");
    assert.equal(r.interception.horizonAt, iso(2));
  });
  it("an unknown ETA is an unknown interception, stated — never assumed reachable", () => {
    const r = decide({ etaMinutes: null });
    assert.equal(r.decision, "GO_NOW");
    assert.ok(r.reasons.includes("interception_unknown"));
    assert.equal(r.interception.reachable, null);
    assert.equal(r.interception.marginMinutes, null);
    assert.deepEqual(interceptPeak(null, iso(10), NOW).reachable, null);
    assert.deepEqual(interceptPeak(5, null, NOW).reachable, null);
  });
});

describe("7. RETURN", () => {
  it("a place the viewer left earlier, favourable now, is RETURN", () => {
    const r = decide({ returnSubjectId: A });
    assert.equal(r.decision, "RETURN");
    assert.deepEqual(r.reasons, ["left_earlier_now_favourable"]);
  });
  it("but not when it is unfavourable for the intent", () => {
    const r = decide({ candidate: subject(A, [crowd("quiet")]), returnSubjectId: A, intent: "social" }); // 0.3 < 0.5
    assert.notEqual(r.decision, "RETURN");
  });
});

describe("8. switching cost (§10)", () => {
  const busyCurrent = (since: number | null) => ({ ...subject(B, [crowd("busy")]), sinceMinutes: since });
  it("a candidate not better than the current experience by more than the cost is STAY", () => {
    const r = decide({ candidate: subject(A, [crowd("moderate")]), current: busyCurrent(10) }); // 0.7 vs 1.0
    assert.equal(r.decision, "STAY");
    assert.deepEqual(r.reasons, ["switching_cost_not_exceeded"]);
    assert.equal(r.switchingCost.applied, true);
    assert.equal(r.switchingCost.cost, SWITCHING_COST);
    assert.match(r.summary, /not clearly worse/);
  });
  it("a candidate better by more than the cost is SWITCH", () => {
    const r = decide({ candidate: subject(A, [crowd("busy")]), current: { ...subject(B, [crowd("quiet")]), sinceMinutes: 10 } }); // 1.0 vs 0.3
    assert.equal(r.decision, "SWITCH");
    assert.deepEqual(r.reasons, ["better_by_more_than_switching_cost"]);
  });
  it("dwell raises a KNOWN current value: an hour at a moderate place turns a SWITCH into a STAY", () => {
    const cand = subject(A, [crowd("busy")]); // 1.0 for social
    const fresh = decide({ candidate: cand, current: { ...subject(B, [crowd("moderate")]), sinceMinutes: 0 } }); // 0.7 → diff 0.3
    assert.equal(fresh.decision, "SWITCH");
    const settled = decide({ candidate: cand, current: { ...subject(B, [crowd("moderate")]), sinceMinutes: 60 } }); // 0.79 → diff 0.21
    assert.equal(settled.decision, "STAY");
    const value = currentExperienceValue(summariseLiveState(subject(B, [crowd("moderate")]), NOW), "social", 60);
    assert.ok(value !== null && value > 0.7 && value < 0.8);
  });
  it("dwell creates no value: with no intent the current value stays unknown and the engine will not tell the viewer to leave", () => {
    const r = decide({ candidate: subject(A, [crowd("busy")]), current: busyCurrent(120), intent: null });
    assert.equal(r.decision, "STAY");
    assert.deepEqual(r.reasons, ["current_value_unknown"]);
    assert.equal(r.switchingCost.applied, false);
    assert.equal(r.switchingCost.currentValue, null);
    assert.equal(currentExperienceValue(summariseLiveState(subject(B, [crowd("busy")]), NOW), null, 120), null);
  });
  it("a current experience with no live reading is unknown too — the engine does not fabricate its value", () => {
    const r = decide({ current: { ...subject(B, []), sinceMinutes: 30 } });
    assert.equal(r.decision, "STAY");
    assert.deepEqual(r.reasons, ["current_value_unknown"]);
  });
});

describe("9. GO NOW, and the grounding on every decision", () => {
  it("live, reachable, compatible, nowhere to leave: GO NOW with observed grounding", () => {
    const r = decide({});
    assert.equal(r.decision, "GO_NOW");
    assert.deepEqual(r.reasons, ["live_reachable_compatible"]);
    assert.equal(r.grounding.truthClass, "observed");
    assert.equal(r.grounding.confidence, "live");
    assert.equal(r.grounding.coverage, "few");
    assert.deepEqual(r.candidate.claimRefs, r.candidate.claimRefs.filter((id) => id.startsWith("snap-")));
  });
  it("several independent reporters make it corroborated; a material conflict makes it conflicting — weakest on every axis", () => {
    const many = decide({ candidate: subject(A, [crowd("busy", { sourceCountBucket: "several" })]) });
    assert.equal(many.grounding.truthClass, "corroborated");
    // A materially conflicting vibe beside a corroborated crowd: the conflict is
    // not a reading, so it neither backs the decision nor is described.
    const mixed = decide({ candidate: subject(A, [crowd("busy", { sourceCountBucket: "several" }), env({ claimType: "vibe.state", value: { state: "social" }, conflictState: "material", band: "live" })]) });
    assert.equal(mixed.decision, "GO_NOW");
    assert.equal(mixed.grounding.truthClass, "corroborated");
    assert.equal(mixed.candidate.vibe, null);
    assert.doesNotMatch(mixed.summary, /Vibe reported/);
  });
  it("a sponsored claim is Live-qualified and NOT a reading: promotional claim ≠ observed reality (§2) — WAIT, with its own reason", () => {
    const s = summariseLiveState(subject(A, [crowd("packed", { sourceClass: "sponsored" })]), NOW);
    assert.equal(s.live, false);
    assert.equal(s.liveNonObservational, true);
    assert.equal(s.crowdLevel, null);
    assert.equal(s.truth.truthClass, "inferred", "the grounding says why it is not a reading");
    const r = decide({ candidate: subject(A, [crowd("busy", { sourceClass: "sponsored" })]), intent: "social" });
    assert.equal(r.decision, "WAIT");
    assert.deepEqual(r.reasons, ["evidence_not_observational"]);
    assert.match(r.summary, /not an observation/);
  });
  it("a materially conflicting claim is not a reading either — reports differ ≠ live (§10)", () => {
    const r = decide({ candidate: subject(A, [crowd("busy", { conflictState: "material" })]) });
    assert.equal(r.decision, "WAIT");
    assert.deepEqual(r.reasons, ["evidence_not_observational"]);
    assert.equal(r.grounding.truthClass, "conflicting");
  });
  it("an official update IS an observation and backs a decision, though never consensus", () => {
    const r = decide({ candidate: subject(A, [crowd("busy", { sourceClass: "official_signed", sourceCountBucket: null })]) });
    assert.equal(r.decision, "GO_NOW");
    assert.equal(r.grounding.truthClass, "observed");
    assert.equal(r.grounding.coverage, "unknown");
  });
});

describe("language is grounded in structured truth (§10)", () => {
  it("a vibe is described only when Live-qualified, and only as reported", () => {
    const live = decide({ candidate: subject(A, [crowd("busy"), env({ claimType: "vibe.state", value: { state: "going_off" } })]) });
    assert.match(live.summary, /Vibe reported as going off\./);
    const emerging = decide({ candidate: subject(A, [crowd("busy"), env({ claimType: "vibe.state", value: { state: "going_off" }, state: "emerging", band: "provisional" })]) });
    assert.doesNotMatch(emerging.summary, /going off/);
  });
  it("no sentence the engine can produce says what everyone is doing", () => {
    const inputs: Partial<DecisionInput>[] = [
      {},
      { candidate: subject(A, [crowd("packed"), env({ claimType: "vibe.state", value: { state: "going_off" } })]), intent: "high_energy" },
      { candidate: subject(A, []) },
      { candidate: subject(A, [crowd("unsafe_density")]) },
      { etaMinutes: 90 },
      { current: { ...subject(B, [crowd("busy")]), sinceMinutes: 60 } },
    ];
    for (const i of inputs) {
      const s = decide(i).summary;
      assert.doesNotMatch(s, /everyone|dancing|is dancing|people are/i, s);
      assert.match(s, /observed|corroborated|inferred|predicted|reports differ|stale|no current evidence/, "the truth class is always in the sentence");
    }
  });
});
