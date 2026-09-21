/**
 * experienceTruth — the §5.1 truth block and its fail-weak composition.
 *
 * §20: "Inference confidence may only decrease through conflict unless new
 * evidence supports an increase." Composition may never promote: a composite
 * is the weakest of its parts on every axis.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UNKNOWN_TRUTH,
  composeTruth,
  weakestConfidenceBand,
  weakestFreshness,
  type TruthMetadata,
} from "../lib/experienceTruth.js";
import { CONFIDENCE_BANDS, type ConfidenceBand } from "../lib/intelContracts.js";
import { FRESHNESS_STATES, type FreshnessState } from "../lib/mapObjects.js";
import { COVERAGE_BUCKETS, COVERAGE_STRENGTH, TRUTH_CLASSES, TRUTH_CLASS_STRENGTH } from "../lib/truthClass.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_TS = readFileSync(join(SRC, "lib", "experienceTruth.ts"), "utf8");

const block = (over: Partial<TruthMetadata>): TruthMetadata => ({
  truthClass: "observed",
  confidence: "live",
  freshness: "live",
  coverage: "many",
  provenance: ["a"],
  ...over,
});

describe("the floor", () => {
  it("UNKNOWN_TRUTH is unknown on every axis and frozen", () => {
    assert.deepEqual(UNKNOWN_TRUTH, {
      truthClass: "unknown",
      confidence: "unverified",
      freshness: "unknown",
      coverage: "unknown",
      provenance: [],
    });
    assert.ok(Object.isFrozen(UNKNOWN_TRUTH));
  });

  it("an empty composition is the floor, not a plausible default (§20)", () => {
    assert.deepEqual(composeTruth([]), UNKNOWN_TRUTH);
    assert.deepEqual(composeTruth([null, undefined]), UNKNOWN_TRUTH);
  });
});

describe("weakest on every axis", () => {
  it("truth class: a prediction folded into an observation is a prediction", () => {
    const t = composeTruth([block({ truthClass: "observed" }), block({ truthClass: "predicted" })]);
    assert.equal(t.truthClass, "predicted");
  });

  it("confidence: live + provisional → provisional; unrecognised → unverified", () => {
    assert.equal(weakestConfidenceBand(["live", "provisional"]), "provisional");
    assert.equal(weakestConfidenceBand(["strong", "bogus" as ConfidenceBand]), "unverified");
    assert.equal(weakestConfidenceBand([]), "unverified");
  });

  it("freshness: the OLDEST wins, and unknown is the floor", () => {
    assert.equal(weakestFreshness(["live", "stale"]), "stale");
    assert.equal(weakestFreshness(["recent", "historical"]), "historical");
    assert.equal(weakestFreshness(["live", "unknown"]), "unknown");
    assert.equal(weakestFreshness([]), "unknown");
    assert.equal(weakestFreshness(["live", "bogus" as FreshnessState]), "unknown");
  });

  it("coverage: many + few → few; many + unknown → unknown", () => {
    assert.equal(composeTruth([block({ coverage: "many" }), block({ coverage: "few" })]).coverage, "few");
    assert.equal(composeTruth([block({ coverage: "many" }), block({ coverage: "unknown" })]).coverage, "unknown");
  });

  it("provenance is the sorted, deduplicated union", () => {
    const t = composeTruth([block({ provenance: ["b", "a"] }), block({ provenance: ["a", "c"] })]);
    assert.deepEqual(t.provenance, ["a", "b", "c"]);
  });

  it("nulls are skipped, not counted as unknown — an absent part is absent", () => {
    const t = composeTruth([null, block({})]);
    assert.deepEqual(t, block({}));
  });

  it("property: over every pair of classes/bands/coverages the composite is never stronger than either input", () => {
    for (const a of TRUTH_CLASSES) {
      for (const b of TRUTH_CLASSES) {
        const t = composeTruth([block({ truthClass: a }), block({ truthClass: b })]);
        assert.ok(TRUTH_CLASS_STRENGTH[t.truthClass] <= Math.min(TRUTH_CLASS_STRENGTH[a], TRUTH_CLASS_STRENGTH[b]));
      }
    }
    for (const a of CONFIDENCE_BANDS) {
      for (const b of CONFIDENCE_BANDS) {
        const w = weakestConfidenceBand([a, b]);
        assert.ok(CONFIDENCE_BANDS.indexOf(w) <= Math.min(CONFIDENCE_BANDS.indexOf(a), CONFIDENCE_BANDS.indexOf(b)));
      }
    }
    for (const a of COVERAGE_BUCKETS) {
      for (const b of COVERAGE_BUCKETS) {
        const t = composeTruth([block({ coverage: a }), block({ coverage: b })]);
        assert.ok(COVERAGE_STRENGTH[t.coverage] <= Math.min(COVERAGE_STRENGTH[a], COVERAGE_STRENGTH[b]));
      }
    }
    // Freshness: the composite is never fresher than either input.
    const rank = (f: FreshnessState) => (f === "unknown" ? 0 : FRESHNESS_STATES.length - 1 - FRESHNESS_STATES.indexOf(f));
    for (const a of FRESHNESS_STATES) {
      for (const b of FRESHNESS_STATES) {
        assert.ok(rank(weakestFreshness([a, b])) <= Math.min(rank(a), rank(b)), `${a}+${b}`);
      }
    }
  });
});

describe("what the module is not", () => {
  it("defines no ExperienceState shape — the Map's fold owns §5.3's tree", () => {
    assert.doesNotMatch(MODULE_TS, /export (interface|type) ExperienceState\b/);
  });
  it("reads no clock, no database, and carries no safety or user field", () => {
    assert.doesNotMatch(MODULE_TS, /Date\.now|new Date\(/);
    assert.doesNotMatch(MODULE_TS, /supabase|\.from\("|getServiceClient/);
    assert.doesNotMatch(MODULE_TS, /\b(safety|danger|unsafe|userId|viewerId)\b/i);
  });
});

// ── §18.2 temporal envelope (census S110) ────────────────────────────────────
import { temporalIncoherence, type TemporalEnvelope } from "../lib/experienceTruth.js";

const envelope = (over: Partial<TemporalEnvelope> = {}): TemporalEnvelope => ({
  observedAt: "2026-09-07T21:40:00.000Z",
  effectiveFrom: "2026-09-07T21:30:00.000Z",
  effectiveUntil: "2026-09-07T22:00:00.000Z",
  expiresAt: "2026-09-07T23:00:00.000Z",
  freshness: "recent",
  predictedFor: null,
  ...over,
});

describe("§18.2 temporal envelope", () => {
  it("carries all six semantics the spec names", () => {
    const e = envelope();
    assert.deepEqual(Object.keys(e).sort(), ["effectiveFrom", "effectiveUntil", "expiresAt", "freshness", "observedAt", "predictedFor"]);
  });
  it("predictedFor is set IF AND ONLY IF the truth class is predicted", () => {
    assert.equal(temporalIncoherence(envelope(), "observed"), null);
    assert.equal(temporalIncoherence(envelope({ predictedFor: "2026-09-07T23:00:00.000Z" }), "observed"), "predicted_for_without_predicted_class");
    assert.equal(temporalIncoherence(envelope(), "predicted"), "predicted_class_without_predicted_for");
    assert.equal(temporalIncoherence(envelope({ predictedFor: "2026-09-07T23:00:00.000Z" }), "predicted"), null);
  });
  it("an inverted window, an expiry before the window's end, or an unparseable instant is incoherent", () => {
    assert.equal(temporalIncoherence(envelope({ effectiveFrom: "2026-09-07T22:30:00.000Z" }), "observed"), "effective_window_inverted");
    assert.equal(temporalIncoherence(envelope({ expiresAt: "2026-09-07T21:45:00.000Z" }), "observed"), "expires_before_effective_until");
    assert.equal(temporalIncoherence(envelope({ observedAt: "yesterday" }), "observed"), "unparseable_instant");
    assert.equal(temporalIncoherence(null as never, "observed"), "unparseable_instant");
  });
  it("nulls are honest: an envelope with nothing but freshness is coherent", () => {
    assert.equal(temporalIncoherence({ observedAt: null, effectiveFrom: null, effectiveUntil: null, expiresAt: null, freshness: "unknown", predictedFor: null }, "unknown"), null);
  });
});
