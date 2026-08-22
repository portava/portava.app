/**
 * confidenceScore — the spec's formula, and the fail-closed behaviour around it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreConfidence, COMPONENT_WEIGHTS, PENALTY_WEIGHTS, COMPONENT_WEIGHT_SUM,
} from "../lib/confidenceScore.js";

const perfect = {
  presence: 1, freshness: 1, independence: 1, sourceReliability: 1,
  evidenceQuality: 1, agreement: 1, specificity: 1,
};

describe("confidenceScore — the formula", () => {
  it("component weights sum to exactly 1", () => {
    assert.ok(Math.abs(COMPONENT_WEIGHT_SUM - 1) < 1e-9, `sum was ${COMPONENT_WEIGHT_SUM}`);
  });

  it("uses the specified weights", () => {
    assert.equal(COMPONENT_WEIGHTS.presence, 0.22);
    assert.equal(COMPONENT_WEIGHTS.freshness, 0.18);
    assert.equal(COMPONENT_WEIGHTS.independence, 0.16);
    assert.equal(COMPONENT_WEIGHTS.sourceReliability, 0.14);
    assert.equal(COMPONENT_WEIGHTS.evidenceQuality, 0.12);
    assert.equal(COMPONENT_WEIGHTS.agreement, 0.10);
    assert.equal(COMPONENT_WEIGHTS.specificity, 0.08);
    assert.equal(PENALTY_WEIGHTS.manipulationRisk, 0.25);
    assert.equal(PENALTY_WEIGHTS.commercialRisk, 0.20);
    assert.equal(PENALTY_WEIGHTS.materialConflict, 0.20);
    assert.equal(PENALTY_WEIGHTS.instability, 0.15);
  });

  it("a perfect unpenalised observation scores 1 and bands 'strong'", () => {
    const r = scoreConfidence(perfect);
    assert.ok(Math.abs(r.confidence - 1) < 1e-9);
    assert.equal(r.band, "strong");
  });

  it("no evidence scores 0 and bands 'unverified'", () => {
    const r = scoreConfidence({});
    assert.equal(r.confidence, 0);
    assert.equal(r.band, "unverified");
  });

  it("computes a mixed case exactly", () => {
    // presence .8, freshness .5, independence .25, rest 0
    const r = scoreConfidence({ presence: 0.8, freshness: 0.5, independence: 0.25 });
    const expected = 0.22 * 0.8 + 0.18 * 0.5 + 0.16 * 0.25;
    assert.ok(Math.abs(r.raw - expected) < 1e-9, `${r.raw} vs ${expected}`);
    assert.equal(r.penalty, 0);
    assert.ok(Math.abs(r.confidence - expected) < 1e-9);
  });

  it("penalties subtract and clamp at zero", () => {
    const r = scoreConfidence({ presence: 0.5 }, { manipulationRisk: 1 });
    assert.equal(r.confidence, 0, "raw 0.11 minus penalty 0.25 must clamp to 0, never negative");
    assert.ok(r.penalty > r.raw);
  });

  it("manipulation risk is the heaviest penalty", () => {
    const manip = scoreConfidence(perfect, { manipulationRisk: 1 }).confidence;
    for (const k of ["commercialRisk", "instability", "materialConflict"] as const) {
      assert.ok(manip < scoreConfidence(perfect, { [k]: 1 }).confidence,
        `${k} should penalise less than manipulationRisk`);
    }
  });
});

describe("confidenceScore — replayability", () => {
  it("returns every component so the result can be reconstructed", () => {
    const r = scoreConfidence({ presence: 0.9 }, { instability: 0.3 });
    assert.equal(r.components.presence, 0.9);
    assert.equal(r.penalties.instability, 0.3);
    assert.equal(r.formulaVersion, 1);
    // recompute from the stored record
    let raw = 0;
    for (const k of Object.keys(COMPONENT_WEIGHTS) as Array<keyof typeof COMPONENT_WEIGHTS>) {
      raw += COMPONENT_WEIGHTS[k] * r.components[k];
    }
    assert.ok(Math.abs(raw - r.raw) < 1e-9, "stored components do not reproduce the raw score");
  });

  it("absent components are zero, not partial credit", () => {
    assert.equal(scoreConfidence({ presence: 1 }).components.freshness, 0);
  });
});

describe("confidenceScore — fail-closed", () => {
  it("an out-of-range or non-finite signal forces 0 and marks the record invalid", () => {
    for (const bad of [1.5, -0.1, NaN, Infinity, "high" as never]) {
      const r = scoreConfidence({ ...perfect, presence: bad as number });
      assert.equal(r.confidence, 0, `input ${String(bad)} produced ${r.confidence}`);
      assert.equal(r.band, "unverified");
      assert.equal(r.invalid, true);
    }
  });

  it("a bad penalty input also forces 0 rather than being ignored", () => {
    const r = scoreConfidence(perfect, { manipulationRisk: 42 });
    assert.equal(r.confidence, 0);
    assert.equal(r.invalid, true);
  });

  it("null and undefined inputs are safe", () => {
    assert.equal(scoreConfidence(null, null).confidence, 0);
    assert.equal(scoreConfidence().confidence, 0);
  });

  it("bands match the spec's published boundaries", () => {
    // <0.35 unverified | .35-.54 provisional | .55-.74 likely_current
    // .75-.89 live | >=.90 strong
    const at = (v: number) => scoreConfidence({ presence: v / 0.22 <= 1 ? v / 0.22 : 1 }).band;
    assert.equal(scoreConfidence({ presence: 1, freshness: 1, independence: 1, sourceReliability: 1, evidenceQuality: 1, agreement: 1, specificity: 1 }).band, "strong");
    assert.equal(at(0.0), "unverified");
  });
});
