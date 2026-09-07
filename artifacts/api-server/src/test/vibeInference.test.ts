/**
 * vibeInference — S4's mutation/property tests, as the spec asks for them:
 * "mutation/property test rapid-movement≠dancing and no-coverage≠quiet".
 *
 * Every invariant here is one the module's header names. Each was hand-reverted
 * once to confirm the assertion fails without it (recorded in the report).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VIBE_CONTRADICTED_DANCE_CEILING,
  VIBE_INFERENCE_VERSION,
  VIBE_MAX_LIKELIHOOD,
  inferVibe,
  inferredConfidenceBand,
  type VibeFeatureInput,
} from "../lib/vibeInference.js";
import { CONFIDENCE_BANDS, MIN_BAND_FOR_LIVE_STATE } from "../lib/intelContracts.js";
import { COVERAGE_BUCKETS } from "../lib/truthClass.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_TS = readFileSync(join(SRC, "lib", "vibeInference.ts"), "utf8");

const NOW = Date.UTC(2026, 8, 7, 22, 0, 0);

function features(over: Partial<VibeFeatureInput> = {}): VibeFeatureInput {
  return {
    motionEnergy: 0.5,
    periodicity: 0.5,
    boundedMovement: true,
    dwellBucket: 2,
    arrivalVelocity: 0.5,
    departureVelocity: 0.5,
    coverage: "several",
    venueContext: null,
    observedAt: NOW - 60_000,
    ...over,
  };
}

function state(over: Partial<VibeFeatureInput> = {}) {
  const r = inferVibe(features(over), NOW);
  assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.state;
}

describe("rapid movement ≠ dancing", () => {
  it("high energy with arrhythmic motion cannot be dancing, even in a nightclub", () => {
    const s = state({ motionEnergy: 0.95, periodicity: 0.1, boundedMovement: true, venueContext: "nightlife" });
    assert.ok(s.danceLikelihood !== null && s.danceLikelihood <= VIBE_CONTRADICTED_DANCE_CEILING, String(s.danceLikelihood));
  });

  it("high energy with UNBOUNDED movement (transit) cannot be dancing, even with rhythm", () => {
    const s = state({ motionEnergy: 0.95, periodicity: 0.9, boundedMovement: false, venueContext: "nightlife" });
    assert.ok(s.danceLikelihood !== null && s.danceLikelihood <= VIBE_CONTRADICTED_DANCE_CEILING, String(s.danceLikelihood));
  });

  it("unknown periodicity or boundedness ⇒ dance likelihood is NULL, not a number", () => {
    assert.equal(state({ motionEnergy: 0.95, periodicity: null }).danceLikelihood, null);
    assert.equal(state({ motionEnergy: 0.95, boundedMovement: null }).danceLikelihood, null);
    assert.equal(state({ motionEnergy: null }).danceLikelihood, null);
  });

  it("periodic, bounded, dwelling motion in a nightclub DOES raise it — but never to certainty", () => {
    const s = state({ motionEnergy: 0.9, periodicity: 0.9, boundedMovement: true, dwellBucket: 4, venueContext: "nightlife" });
    assert.ok(s.danceLikelihood !== null && s.danceLikelihood >= 0.5, String(s.danceLikelihood));
    assert.ok(s.danceLikelihood <= VIBE_MAX_LIKELIHOOD);
    assert.ok(VIBE_MAX_LIKELIHOOD < 1);
  });

  it("context is not evidence: nightclub alone, with no motion evidence, raises nothing", () => {
    const s = state({ motionEnergy: null, periodicity: null, boundedMovement: null, venueContext: "nightlife" });
    assert.equal(s.danceLikelihood, null);
    assert.equal(s.energy, null);
    assert.deepEqual([...s.contextTags], ["nightlife"]); // the tag is context, not a behaviour claim
  });
});

describe("no coverage ≠ quiet", () => {
  it("coverage unknown ⇒ every output null, truth class unknown, no tags — never a zero", () => {
    const s = state({ coverage: "unknown", motionEnergy: 0.9, periodicity: 0.9, venueContext: "nightlife" });
    assert.equal(s.energy, null);
    assert.equal(s.sociality, null);
    assert.equal(s.danceLikelihood, null);
    assert.equal(s.volatility, null);
    assert.equal(s.momentum, null);
    assert.deepEqual([...s.contextTags], []);
    assert.equal(s.truth.truthClass, "unknown");
    assert.equal(s.truth.coverage, "unknown");
    assert.equal(s.truth.confidence, "unverified");
  });
});

describe("inference ≠ observation", () => {
  it("the truth class is ALWAYS inferred when anything was inferred", () => {
    for (const coverage of COVERAGE_BUCKETS.filter((c) => c !== "unknown")) {
      assert.equal(state({ coverage }).truth.truthClass, "inferred", coverage);
    }
  });

  it("the confidence band can never reach the live floor, whatever the coverage", () => {
    for (const coverage of COVERAGE_BUCKETS) {
      const band = inferredConfidenceBand(coverage);
      assert.ok(CONFIDENCE_BANDS.indexOf(band) < CONFIDENCE_BANDS.indexOf(MIN_BAND_FOR_LIVE_STATE), `${coverage} → ${band}`);
      const s = state({ coverage });
      assert.ok(CONFIDENCE_BANDS.indexOf(s.truth.confidence) < CONFIDENCE_BANDS.indexOf(MIN_BAND_FOR_LIVE_STATE));
    }
  });

  it("provenance names the inference version, so a recalibration is a lineage change", () => {
    assert.deepEqual([...state().truth.provenance], [VIBE_INFERENCE_VERSION]);
  });

  it("a future observation instant is not fresh — freshness unknown, never live", () => {
    assert.equal(state({ observedAt: NOW + 10 * 60_000 }).truth.freshness, "unknown");
    assert.equal(state({ observedAt: NOW - 60_000 }).truth.freshness, "live");
  });
});

describe("acoustic needs its own permission", () => {
  it("an acoustic feature without the permission flag is REFUSED, not ignored", () => {
    const r = inferVibe(features({ acousticEnergy: 0.7 }), NOW);
    assert.deepEqual(r, { ok: false, reason: "acoustic_without_permission" });
    const r2 = inferVibe(features({ acousticEnergy: 0.7, acousticPermissionGranted: false }), NOW);
    assert.deepEqual(r2, { ok: false, reason: "acoustic_without_permission" });
  });

  it("with the permission it blends into energy", () => {
    const without = state({ motionEnergy: 0.2 }).energy;
    const withA = state({ motionEnergy: 0.2, acousticEnergy: 0.8, acousticPermissionGranted: true }).energy;
    assert.ok(without !== null && withA !== null && withA > without);
  });
});

describe("bounds and refusals", () => {
  it("no output ever exceeds the ceiling, over a grid of inputs", () => {
    const grid = [0, 0.25, 0.5, 0.75, 1];
    for (const m of grid) for (const p of grid) for (const a of grid) for (const d of grid) {
      for (const bounded of [true, false]) for (const dwell of [0, 2, 4]) {
        const s = state({ motionEnergy: m, periodicity: p, arrivalVelocity: a, departureVelocity: d, boundedMovement: bounded, dwellBucket: dwell, venueContext: "nightlife", coverage: "many" });
        for (const k of ["energy", "sociality", "danceLikelihood", "volatility"] as const) {
          const v = s[k];
          if (v !== null) assert.ok(v >= 0 && v <= VIBE_MAX_LIKELIHOOD, `${k}=${v}`);
        }
        if (s.momentum !== null) assert.ok(s.momentum >= -1 && s.momentum <= 1);
      }
    }
  });

  it("momentum and volatility need BOTH velocities", () => {
    assert.equal(state({ arrivalVelocity: null }).momentum, null);
    assert.equal(state({ departureVelocity: null }).volatility, null);
    assert.equal(state({ arrivalVelocity: 0.9, departureVelocity: 0.1 }).momentum, 0.8);
  });

  it("malformed inputs are refused with the field named", () => {
    assert.deepEqual(inferVibe(features({ motionEnergy: 1.5 }), NOW), { ok: false, reason: "invalid_input", field: "motionEnergy" });
    assert.deepEqual(inferVibe(features({ dwellBucket: 7 }), NOW), { ok: false, reason: "invalid_input", field: "dwellBucket" });
    assert.deepEqual(inferVibe(features({ coverage: "lots" as never }), NOW), { ok: false, reason: "invalid_input", field: "coverage" });
    assert.deepEqual(inferVibe(null as never, NOW), { ok: false, reason: "input_required" });
  });

  it("the module reads no clock and no database, and is named to avoid intelContracts.VibeState", () => {
    assert.doesNotMatch(MODULE_TS, /Date\.now|new Date\(/);
    assert.doesNotMatch(MODULE_TS, /supabase|\.from\(|getServiceClient/);
    assert.doesNotMatch(MODULE_TS, /export (interface|type) VibeState\b/);
  });
});
