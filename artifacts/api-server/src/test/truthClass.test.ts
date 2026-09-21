/**
 * truthClass — the shared §5.1 vocabulary and its fail-weak combinator.
 *
 * Sensing §5.1: OBSERVED · CORROBORATED · INFERRED · PREDICTED · CONFLICTING ·
 * STALE · UNKNOWN. The Wall (lib/wallProjection.WallTruthClass) and the Map
 * (lib/mapObjects.TRUTH_CLASSES) each carry a copy; this file asserts all
 * three agree value-for-value so the vocabulary cannot drift into three.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COVERAGE_BUCKETS,
  COVERAGE_STRENGTH,
  OBSERVATION_TRUTH_CLASSES,
  TRUTH_CLASSES,
  TRUTH_CLASS_STRENGTH,
  isCoverageBucket,
  isTruthClass,
  truthClassMayRenderAsObservation,
  weakestCoverage,
  weakestTruthClass,
  type CoverageBucket,
  type TruthClass,
} from "../lib/truthClass.js";
import { NON_OBSERVATION_TRUTH_CLASSES as WALL_NON_OBSERVATION } from "../lib/wallProjection.js";
import * as mapObjects from "../lib/mapObjects.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_TS = readFileSync(join(SRC, "lib", "truthClass.ts"), "utf8");

const SPEC_51 = ["observed", "corroborated", "inferred", "predicted", "conflicting", "stale", "unknown"];

describe("§5.1 vocabulary", () => {
  it("is exactly the spec's seven classes, verbatim", () => {
    assert.deepEqual([...TRUTH_CLASSES], SPEC_51);
  });

  it("CORROBORATED is representable — the class census S48 found nowhere", () => {
    assert.ok(isTruthClass("corroborated"));
  });

  it("strength is a strict total order with unknown at the floor and corroborated at the ceiling", () => {
    const ranks = TRUTH_CLASSES.map((c) => TRUTH_CLASS_STRENGTH[c]);
    assert.equal(new Set(ranks).size, ranks.length, "two classes share a rank");
    assert.equal(Math.min(...ranks), TRUTH_CLASS_STRENGTH.unknown);
    assert.equal(Math.max(...ranks), TRUTH_CLASS_STRENGTH.corroborated);
    assert.ok(TRUTH_CLASS_STRENGTH.predicted < TRUTH_CLASS_STRENGTH.inferred);
    assert.ok(TRUTH_CLASS_STRENGTH.inferred < TRUTH_CLASS_STRENGTH.observed);
    assert.ok(TRUTH_CLASS_STRENGTH.conflicting < TRUTH_CLASS_STRENGTH.predicted, "a material conflict may never back a Live label (§10)");
  });

  it("only observed and corroborated may render as an observation", () => {
    assert.deepEqual([...OBSERVATION_TRUTH_CLASSES], ["observed", "corroborated"]);
    for (const c of TRUTH_CLASSES) {
      assert.equal(truthClassMayRenderAsObservation(c), c === "observed" || c === "corroborated", c);
    }
    assert.equal(truthClassMayRenderAsObservation(null), false);
    assert.equal(truthClassMayRenderAsObservation(undefined), false);
  });

  it("the module reads no clock and no database — vocabulary only", () => {
    assert.doesNotMatch(MODULE_TS, /Date\.now|new Date\(/);
    assert.doesNotMatch(MODULE_TS, /supabase|\.from\(|getServiceClient/);
    // The only import is type-only, so nothing runs at load time.
    const imports = MODULE_TS.match(/^import .*$/gm) ?? [];
    for (const line of imports) assert.match(line, /^import type /, line);
  });
});

describe("weakestTruthClass — composition is fail-weak", () => {
  it("prediction folded into observation yields prediction, never observation", () => {
    assert.equal(weakestTruthClass(["observed", "predicted"]), "predicted");
    assert.equal(weakestTruthClass(["corroborated", "inferred", "observed"]), "inferred");
  });

  it("an empty, null or unrecognised input is the floor", () => {
    assert.equal(weakestTruthClass([]), "unknown");
    assert.equal(weakestTruthClass([null, undefined]), "unknown");
    assert.equal(weakestTruthClass(["observed", "bogus" as TruthClass]), "unknown");
  });

  it("property: the result is never stronger than any input (every pair)", () => {
    for (const a of TRUTH_CLASSES) {
      for (const b of TRUTH_CLASSES) {
        const w = weakestTruthClass([a, b]);
        assert.ok(TRUTH_CLASS_STRENGTH[w] <= TRUTH_CLASS_STRENGTH[a], `${a}+${b} → ${w}`);
        assert.ok(TRUTH_CLASS_STRENGTH[w] <= TRUTH_CLASS_STRENGTH[b], `${a}+${b} → ${w}`);
      }
    }
  });
});

describe("coverage", () => {
  it("has no 'none' — no coverage ≠ quiet is unrepresentable-if-violated", () => {
    assert.deepEqual([...COVERAGE_BUCKETS], ["few", "several", "many", "unknown"]);
    assert.equal(isCoverageBucket("none"), false);
    assert.equal(COVERAGE_STRENGTH.unknown, 0);
  });

  it("weakestCoverage is the least of its inputs; unknown is the floor", () => {
    assert.equal(weakestCoverage(["many", "few"]), "few");
    assert.equal(weakestCoverage(["many", "unknown"]), "unknown");
    assert.equal(weakestCoverage([]), "unknown");
    assert.equal(weakestCoverage(["several", "bogus" as CoverageBucket]), "unknown");
  });
});

describe("alignment with the other two copies of the vocabulary", () => {
  it("every Wall non-observation class is one of ours, and our observation set is the stricter of the two", () => {
    for (const c of WALL_NON_OBSERVATION) assert.ok(isTruthClass(c), `Wall lists unknown class ${c}`);
    const ourNonObservation = TRUTH_CLASSES.filter((c) => !OBSERVATION_TRUTH_CLASSES.includes(c));
    for (const c of WALL_NON_OBSERVATION) assert.ok(ourNonObservation.includes(c), `Wall refuses ${c}; we permit it`);
    // The one recorded divergence: the Wall's list omits `conflicting`, so the
    // Wall would render a materially conflicting fact as an observation. Ours
    // refuses it. This assertion pins that the divergence is exactly that one
    // value, so a later reconciliation (either direction) is a visible change.
    const diff = ourNonObservation.filter((c) => !WALL_NON_OBSERVATION.includes(c));
    assert.deepEqual(diff, ["conflicting"]);
  });

  it("the Map's runtime copy, when present, is value-for-value identical", (t) => {
    const mapTruth = (mapObjects as Record<string, unknown>)["TRUTH_CLASSES"];
    const mapCoverage = (mapObjects as Record<string, unknown>)["COVERAGE_STATES"];
    if (!Array.isArray(mapTruth) || !Array.isArray(mapCoverage)) {
      t.diagnostic("lib/mapObjects does not (yet) export TRUTH_CLASSES / COVERAGE_STATES — Map copy not checked");
      return;
    }
    assert.deepEqual([...mapTruth].sort(), [...TRUTH_CLASSES].sort());
    assert.deepEqual([...mapCoverage].sort(), [...COVERAGE_BUCKETS].sort());
  });
});
