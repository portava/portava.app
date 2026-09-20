/**
 * census-compass CX-04 / CPV2-02 — "Predicted, inferred, conflicting, stale and
 * unknown fixtures retain their qualification in tool output, UI and generated
 * explanation." (docs/specs/Portava_Compass_Architecture_Upgrade_v2.md:24)
 *
 * Before this suite a tool result carried a SOURCE class and no TRUTH class,
 * the UI block had no field for one, the explanation never qualified itself,
 * and the grounding envelope policed datum PRESENCE by source class — so a
 * predicted datum reached every surface with its qualification dropped.
 *
 * The table: five classes × three surfaces, one assertion per cell, plus the
 * envelope's fourth check (a bare state over non-observation evidence is
 * flagged; the same state qualified is not), plus the control that an
 * OBSERVED datum passes every surface untouched — without which the guard
 * could pass by qualifying everything.
 *
 * Mutation log (each applied alone, suite run, source restored):
 *   M1 makeConfidence stops stamping truthClass                    → red
 *   M2 pickConfidence drops truthClass                              → red
 *   M3 qualifyWhyThis returns the text unqualified                  → red
 *   M4 the envelope's truth-class check removed                     → red
 *   M5 a qualified sentence still flagged (TRUTH_QUALIFIER ignored) → red
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassTruthClassSurfaces.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeConfidence, type SourceClass } from "../lib/liveIntelligence.js";
import { truthClassOfSourceClass } from "../lib/sourceTruth.js";
import { TRUTH_CLASSES, OBSERVATION_TRUTH_CLASSES, type TruthClass } from "../lib/truthClass.js";
import { TRUTH_WORDS } from "../lib/compassDecision.js";
import { buildUiBlocks } from "../compass/CompassUiBlocks.js";
import { qualifyWhyThis } from "../compass/CompassRecommendationEngine.js";
import { enforceCompassGroundingEnvelope, readGroundingEvidence } from "../compass/CompassGroundingEnvelope.js";

const NON_OBSERVATION: TruthClass[] = ["predicted", "inferred", "conflicting", "stale", "unknown"];

/** A places tool result carrying one place with a declared truth class. */
function placeResult(truthClass: TruthClass, name = "Han Market", id = `p-${name.toLowerCase().replace(/\s+/g, "-")}`) {
  return {
    candidates: [{
      id, name, city: "Da Nang", category: "market",
      confidence: { sourceClass: "historical", truthClass, label: "Historical", checkedAt: new Date().toISOString() },
    }],
  };
}

describe("A. the vocabulary — five non-observation classes, one rule from source to truth", () => {
  it("the five CPV2-02 names are exactly §5.1's non-observation classes", () => {
    assert.deepEqual(NON_OBSERVATION.sort(), [...TRUTH_CLASSES].filter((c) => !OBSERVATION_TRUTH_CLASSES.includes(c)).sort());
  });

  it("the legacy four map through the Wall's ONE rule: a historical or AI class is predicted, unverified reports stay observations", () => {
    assert.equal(truthClassOfSourceClass("historical"), "predicted");
    assert.equal(truthClassOfSourceClass("ai_inference"), "predicted");
    assert.equal(truthClassOfSourceClass("community_reported"), "observed");
    assert.equal(truthClassOfSourceClass("verified_live"), "observed");
    assert.equal(truthClassOfSourceClass("hearsay"), "inferred");
    assert.equal(truthClassOfSourceClass("sponsored"), "inferred");
    assert.equal(truthClassOfSourceClass("nonsense"), "unknown");
    assert.equal(truthClassOfSourceClass(null), "unknown");
  });
});

describe("B. surface 1 — TOOL OUTPUT keeps the class", () => {
  for (const src of ["verified_live", "community_reported", "historical", "ai_inference"] as SourceClass[]) {
    it(`makeConfidence("${src}") stamps truthClass=${truthClassOfSourceClass(src)}`, () => {
      const c = makeConfidence(src);
      assert.equal(c.truthClass, truthClassOfSourceClass(src));
      assert.equal(c.sourceClass, src);
    });
  }
});

describe("C. surface 2 — the UI BLOCK keeps the class, and never invents one", () => {
  const cards = async (result: unknown) =>
    buildUiBlocks(null, { blocks: [{ type: "place_cards", placeIds: ["p-han-market"] }] }, [{ name: "search_places", arguments: {}, result } as any]);
  for (const cls of NON_OBSERVATION) {
    it(`a place whose tool result says ${cls} reaches the client saying ${cls}`, async () => {
      const blocks: any = await cards(placeResult(cls));
      const conf = blocks[0]?.places?.[0]?.confidence;
      assert.ok(conf, `no confidence on the block: ${JSON.stringify(blocks).slice(0, 300)}`);
      assert.equal(conf.truthClass, cls);
    });
  }
  it("an unrecognised truth word is dropped, not coerced", async () => {
    const r: any = placeResult("predicted");
    r.candidates[0].confidence.truthClass = "definitely";
    const blocks: any = await cards(r);
    const conf = blocks[0]?.places?.[0]?.confidence;
    assert.ok(conf);
    assert.equal(conf.truthClass, undefined);
  });
});

describe("D. surface 3 — the GENERATED EXPLANATION keeps the class, in the decision surface's own words", () => {
  for (const cls of NON_OBSERVATION) {
    it(`an explanation over ${cls} evidence says "${TRUTH_WORDS[cls]}"`, () => {
      const t = qualifyWhyThis("Recommended for you: near you.", cls);
      assert.ok(t!.endsWith(`(${TRUTH_WORDS[cls]})`), t!);
    });
  }
  it("an observed or corroborated datum is left untouched, and so is an ABSENT class (nothing hedges by default)", () => {
    assert.equal(qualifyWhyThis("Recommended for you: near you.", "observed"), "Recommended for you: near you.");
    assert.equal(qualifyWhyThis("Recommended for you: near you.", "corroborated"), "Recommended for you: near you.");
    assert.equal(qualifyWhyThis("Recommended for you: near you.", null), "Recommended for you: near you.");
    assert.equal(qualifyWhyThis(null, "predicted"), null);
  });
});

describe("E. the envelope — a state asserted over non-observation evidence must keep its qualification", () => {
  for (const cls of NON_OBSERVATION) {
    it(`${cls}: "Han Market is busy" bare is flagged; "Han Market is predicted/inferred… busy" is not`, () => {
      const evidence = readGroundingEvidence([placeResult(cls)]);
      assert.equal(evidence.truthClass, cls);
      assert.equal(evidence.subjects[0]?.truthClass, cls);
      const bare = enforceCompassGroundingEnvelope("Han Market is busy tonight.", evidence);
      assert.ok(bare.violations.some((v) => v.kind === "truth_class_not_qualified"), JSON.stringify(bare.violations));
      assert.ok(bare.text.includes("Grounding note:"));
      const qualifiedWord = { predicted: "predicted", inferred: "inferred", conflicting: "reports differ", stale: "stale", unknown: "no current evidence" }[cls];
      const qualified = enforceCompassGroundingEnvelope(`Han Market is busy tonight, though that is ${qualifiedWord}.`, evidence);
      assert.ok(!qualified.violations.some((v) => v.kind === "truth_class_not_qualified"), JSON.stringify(qualified.violations));
    });
  }

  it("CONTROL: the same bare sentence over OBSERVED evidence is not flagged for its truth class", () => {
    const evidence = readGroundingEvidence([placeResult("observed")]);
    const r = enforceCompassGroundingEnvelope("Han Market is busy tonight.", evidence);
    assert.ok(!r.violations.some((v) => v.kind === "truth_class_not_qualified"), JSON.stringify(r.violations));
  });

  it("CONTROL: a tool that declared NO class leaves the sentence to the source-class checks — absence is not `unknown`", () => {
    const r: any = placeResult("predicted");
    delete r.candidates[0].confidence.truthClass;
    const evidence = readGroundingEvidence([r]);
    assert.equal(evidence.truthClass, null);
    const res = enforceCompassGroundingEnvelope("Han Market is busy tonight.", evidence);
    assert.ok(!res.violations.some((v) => v.kind === "truth_class_not_qualified"));
  });

  it("per subject (CCL-12): a predicted place and an observed one in one turn — the sentence about the observed one passes, the other is flagged, one covering both is predicted", () => {
    const evidence = readGroundingEvidence([placeResult("observed", "Han Market"), placeResult("predicted", "Dragon Bridge")]);
    const ok = enforceCompassGroundingEnvelope("Han Market is busy right now.", { ...evidence, hasVerifiedLive: true });
    assert.ok(!ok.violations.some((v) => v.kind === "truth_class_not_qualified"));
    const bad = enforceCompassGroundingEnvelope("Dragon Bridge is packed.", evidence);
    assert.ok(bad.violations.some((v) => v.kind === "truth_class_not_qualified"));
    const both = enforceCompassGroundingEnvelope("Han Market and Dragon Bridge are packed.", evidence);
    assert.ok(both.violations.some((v) => v.kind === "truth_class_not_qualified"));
  });

  it("the weakest declared class governs the turn: observed + stale ⇒ stale", () => {
    const evidence = readGroundingEvidence([placeResult("observed", "A Place"), placeResult("stale", "B Place")]);
    assert.equal(evidence.truthClass, "stale");
  });
});
