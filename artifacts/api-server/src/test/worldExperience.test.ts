import test from "node:test";
import assert from "node:assert/strict";
import { inferVibe, inferExperienceState, inferWorldMoment, forecast, rankOpportunity, runInShadow } from "../lib/worldExperienceEngine.js";

const subject = { subjectKind: "experience" as const, subjectId: "00000000-0000-0000-0000-000000000001" };

test("movement remains trajectory and never becomes literal behavior", () => {
  const p = inferVibe({ subject, crowd: "moderate", trajectory: "relocating", coverage: "covered", crowdConfidence: .8 });
  assert.equal(p.value?.label, "mixed");
  assert.equal(p.value?.trajectory, "emerging");
});

test("anomaly is conflicting, not a safety assertion", () => {
  const p = inferExperienceState({ subject, crowd: "busy", anomaly: true, coverage: "covered", crowdConfidence: .8 });
  assert.equal(p.state, "conflicting");
  assert.equal(p.value?.safety, "unknown");
});

test("only an explicit safety constraint can produce a hold", () => {
  const p = rankOpportunity({ subject, action: "visit", reason: "test", confidence: .8, safetyCleared: false, friction: 0, coverage: "covered" });
  assert.equal(p.value?.action, "hold");
  assert.equal(p.truthClass, "constraint");
});

test("actionable opportunity carries the source validity window", () => {
  const p = rankOpportunity({
    subject, action: "visit", reason: "current conditions", confidence: .8,
    safetyCleared: true, friction: .1, coverage: "covered",
    validUntil: "2026-01-01T01:00:00Z",
  });
  assert.equal(p.state, "known");
  assert.equal(p.freshness.validUntil, "2026-01-01T01:00:00Z");
  assert.equal(p.temporal.endsAt, "2026-01-01T01:00:00Z");
});

test("polymorphic subject kinds cannot collide in deterministic projection IDs", () => {
  const place = { subjectKind: "place" as const, subjectId: subject.subjectId };
  const locality = { subjectKind: "locality" as const, subjectId: subject.subjectId };
  const placeProjection = inferVibe({ subject: place, crowd: "busy", coverage: "covered", crowdConfidence: .8 });
  const localityProjection = inferVibe({ subject: locality, crowd: "busy", coverage: "covered", crowdConfidence: .8 });
  assert.notEqual(placeProjection.id, localityProjection.id);
});

test("predictions are distinct from observations", () => {
  const p = forecast({ subject, expected: "busy", probability: .7, startsAt: "2026-01-01T12:00:00Z", coverage: "covered" });
  assert.equal(p.truthClass, "prediction");
  assert.equal(p.provenance.sourceClass, "portava_prediction");
  assert.equal(p.temporal.kind, "forecast");
});

test("world moments are inferred from aggregate state", () => {
  const p = inferWorldMoment({ subject, crowd: "busy", trajectory: "peaking", coverage: "covered", crowdConfidence: .8 });
  assert.equal(p.value?.kind, "peak");
  assert.equal(p.truthClass, "inference");
});

test("no coverage is not quiet", () => {
  const p = inferVibe({ subject, coverage: "no_coverage", crowd: "quiet" });
  assert.equal(p.state, "unknown");
  assert.equal(p.coverage, "no_coverage");
  assert.equal(p.value, null);
});

test("safety outranks opportunity and switching cost is bounded", () => {
  const blocked = rankOpportunity({ subject, action: "go", reason: "peak", confidence: 1, safetyCleared: false, friction: 0, coverage: "covered" });
  assert.equal(blocked.value?.action, "hold");
  const stable = rankOpportunity({ subject, action: "new", reason: "x", confidence: .8, safetyCleared: true, friction: 0, coverage: "covered", currentAction: "old" });
  assert.equal(stable.confidence, .6);
});

test("shadow mode never surfaces a prediction", () => {
  const p = forecast({ subject, expected: "busy", probability: .8, startsAt: "2026-01-01T12:00:00Z", coverage: "covered" });
  const shadow = runInShadow(p, true);
  assert.equal(shadow.value, null);
  assert.equal(shadow.coverage, "no_coverage");
});